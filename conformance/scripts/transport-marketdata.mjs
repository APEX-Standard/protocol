import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  httpCallTool,
  httpInitialize,
  httpPost,
  httpSubscribe,
  openSseStream,
  printCheck,
  resolveTarget,
  startHttpTarget,
  stopHttpServer,
} from "./common.mjs";

const QUOTE_URI = "apex://market/quote/APEX:FX:EURUSD";
const CANDLE_M1_URI = "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200";
const FEATURES_URI = "apex://market/features/APEX:FX:EURUSD";

let rpcId = 100;
function nextId() {
  return rpcId++;
}

async function readResource(baseUrl, sessionId, uri) {
  const { json } = await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "resources/read",
    params: { uri },
  });
  assert(json, `Expected JSON response for resources/read ${uri}`);
  assert(!json.error, `JSON-RPC error from resources/read ${uri}: ${JSON.stringify(json.error)}`);
  assert(json.result?.contents?.[0]?.text, `Expected contents[0].text in resources/read response for ${uri}`);
  return JSON.parse(json.result.contents[0].text);
}

const target = resolveTarget(process.argv.slice(2));
let server;

try {
  /* ------------------------------------------------------------------ */
  /*  1. Setup: spawn server, initialize, authenticate                   */
  /* ------------------------------------------------------------------ */

  server = await startHttpTarget(target, { verbose: target.verbose });
  printCheck(`HTTP server started on ${server.baseUrl}`);

  const { sessionId } = await httpInitialize(server.baseUrl);
  assert(sessionId, "Expected session ID from initialize");
  printCheck(`initialize returned session ${sessionId.slice(0, 8)}...`);

  const authResult = await httpCallTool(server.baseUrl, sessionId, "apex.session.authenticate", {
    token: "valid-token-12345",
    token_type: "jwt",
  });
  assert(authResult.session_id, "Expected session_id in auth response");
  printCheck("authenticated successfully (tick engine should now be running)");

  /* ------------------------------------------------------------------ */
  /*  2. Subscribe to quote and candle M1 resources; open SSE stream     */
  /* ------------------------------------------------------------------ */

  await httpSubscribe(server.baseUrl, sessionId, QUOTE_URI);
  printCheck("subscribed to quote resource");

  await httpSubscribe(server.baseUrl, sessionId, CANDLE_M1_URI);
  printCheck("subscribed to candle M1 resource");

  const sse = openSseStream(server.baseUrl, sessionId);
  await delay(200);
  printCheck("SSE stream opened");

  /* ------------------------------------------------------------------ */
  /*  3. Wait for ticks (~6 seconds = 3 tick cycles at 2s each)          */
  /* ------------------------------------------------------------------ */

  printCheck("waiting ~6 seconds for tick events...");
  await delay(6000);

  /* ------------------------------------------------------------------ */
  /*  4. Verify quote updates                                            */
  /* ------------------------------------------------------------------ */

  // 4a. Check SSE events for quote resource/updated notifications
  const quoteUpdatedEvents = sse.events.filter(
    (e) =>
      e.data?.method === "notifications/resources/updated" &&
      e.data?.params?.uri === QUOTE_URI,
  );
  assert(
    quoteUpdatedEvents.length >= 2,
    `Expected at least 2 quote resource/updated SSE events, got ${quoteUpdatedEvents.length}`,
  );
  printCheck(`received ${quoteUpdatedEvents.length} quote resource/updated SSE events (>= 2)`);

  // 4b. Read quote resource twice with ~2.5s gap — verify something changed
  //     The tick engine bumps sequence numbers on each tick; price values or
  //     the timestamp should differ between reads.
  const quote1 = await readResource(server.baseUrl, sessionId, QUOTE_URI);
  assert.equal(typeof quote1.bid, "number", "quote1.bid must be a number");
  assert.equal(typeof quote1.ask, "number", "quote1.ask must be a number");
  assert.equal(typeof quote1.mid, "number", "quote1.mid must be a number");
  printCheck(`quote read #1: bid=${quote1.bid} ask=${quote1.ask} mid=${quote1.mid} seq=${quote1.sequence}`);

  await delay(2500);

  const quote2 = await readResource(server.baseUrl, sessionId, QUOTE_URI);
  assert.equal(typeof quote2.bid, "number", "quote2.bid must be a number");
  assert.equal(typeof quote2.ask, "number", "quote2.ask must be a number");
  assert.equal(typeof quote2.mid, "number", "quote2.mid must be a number");
  printCheck(`quote read #2: bid=${quote2.bid} ask=${quote2.ask} mid=${quote2.mid} seq=${quote2.sequence}`);

  const quoteChanged =
    quote1.bid !== quote2.bid ||
    quote1.ask !== quote2.ask ||
    quote1.mid !== quote2.mid ||
    quote1.timestamp !== quote2.timestamp ||
    quote1.sequence !== quote2.sequence;
  assert(quoteChanged, "Expected quote values, timestamp, or sequence to differ between two reads separated by ~2.5s");
  printCheck("quote resource changed between reads (live tick engine confirmed)");

  /* ------------------------------------------------------------------ */
  /*  5. Force candle close                                              */
  /* ------------------------------------------------------------------ */

  const eventsBeforeForce = sse.events.length;

  const closeResult = await httpCallTool(
    server.baseUrl,
    sessionId,
    "reference.test.force_candle_close",
    { timeframe: "M1" },
  );
  assert.equal(closeResult.closed, true, "Expected closed=true from force_candle_close");
  assert.equal(closeResult.timeframe, "M1", "Expected timeframe=M1 from force_candle_close");
  printCheck("force_candle_close returned { closed: true, timeframe: M1 }");

  // Wait for SSE events to arrive
  await delay(1000);

  /* ------------------------------------------------------------------ */
  /*  6. Verify candle close notification                                */
  /* ------------------------------------------------------------------ */

  const candleClosedEvents = sse.events.filter(
    (e) => e.data?.method === "notifications/apex.market.candle_closed",
  );
  assert(
    candleClosedEvents.length > 0,
    `Expected at least one candle_closed notification, got ${candleClosedEvents.length}`,
  );
  printCheck(`received ${candleClosedEvents.length} candle_closed notification(s) via SSE`);

  // Verify the notification envelope
  const candleNotif = candleClosedEvents[candleClosedEvents.length - 1].data.params;
  assert(candleNotif.event_id, "Expected event_id in candle_closed notification");
  assert(candleNotif.event_type, "Expected event_type in candle_closed notification");
  assert.equal(
    candleNotif.instrument_id,
    "APEX:FX:EURUSD",
    "Expected instrument_id = APEX:FX:EURUSD in candle_closed notification",
  );
  assert(candleNotif.timestamp, "Expected timestamp in candle_closed notification");
  assert(candleNotif.payload, "Expected payload in candle_closed notification");
  printCheck("candle_closed notification has correct envelope (event_id, event_type, instrument_id, timestamp, payload)");

  // Verify the payload contains OHLCV data
  const candlePayload = candleNotif.payload;
  assert.equal(candlePayload.timeframe, "M1", "Expected payload.timeframe = M1");
  assert.equal(typeof candlePayload.open, "number", "payload.open must be a number");
  assert.equal(typeof candlePayload.high, "number", "payload.high must be a number");
  assert.equal(typeof candlePayload.low, "number", "payload.low must be a number");
  assert.equal(typeof candlePayload.close, "number", "payload.close must be a number");
  assert.equal(typeof candlePayload.volume, "number", "payload.volume must be a number");
  printCheck(
    `candle_closed payload: O=${candlePayload.open} H=${candlePayload.high} L=${candlePayload.low} C=${candlePayload.close} V=${candlePayload.volume}`,
  );

  // Check complete flag if present (some implementations may omit it)
  if ("complete" in candlePayload) {
    assert.equal(candlePayload.complete, true, "Expected payload.complete = true");
    printCheck("candle_closed payload.complete = true");
  } else {
    printCheck("candle_closed payload does not include 'complete' field (optional)");
  }

  /* ------------------------------------------------------------------ */
  /*  7. Verify features resource                                        */
  /* ------------------------------------------------------------------ */

  const features = await readResource(server.baseUrl, sessionId, FEATURES_URI);
  assert(features.returns, "Expected returns object in features resource");
  assert.equal(
    typeof features.returns.r_1m,
    "number",
    `Expected returns.r_1m to be a number, got ${typeof features.returns.r_1m}`,
  );
  printCheck(`features.returns.r_1m = ${features.returns.r_1m} (is a number)`);

  // Bonus: verify the features resource also has other expected fields
  assert(features.instrument_id, "Expected instrument_id in features resource");
  assert(features.as_of, "Expected as_of in features resource");
  printCheck("features resource has expected structure (instrument_id, as_of, returns)");

  /* ------------------------------------------------------------------ */
  /*  8. Cleanup                                                         */
  /* ------------------------------------------------------------------ */

  await sse.close();
  printCheck("SSE stream closed");

  console.log(`\nTransport market data test passed for ${target.label}`);
} catch (error) {
  if (server) {
    const stderr = server.getStderr();
    if (stderr) {
      process.stderr.write("\n[server stderr]\n");
      process.stderr.write(`${stderr}\n`);
    }
  }
  throw error;
} finally {
  await stopHttpServer(server);
}
