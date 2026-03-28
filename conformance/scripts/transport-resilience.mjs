import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  extractPayload,
  httpCallTool,
  httpInitialize,
  httpSubscribe,
  openSseStream,
  printCheck,
  resolveTarget,
  spawnHttpServer,
  stopHttpServer,
} from "./common.mjs";

const target = resolveTarget(process.argv.slice(2));
let server;

try {
  /* ================================================================== */
  /*  Step 1 — Setup                                                    */
  /* ================================================================== */

  server = await spawnHttpServer(target.label, { verbose: target.verbose });
  printCheck(`HTTP server started on ${server.baseUrl}`);

  const { sessionId } = await httpInitialize(server.baseUrl);
  assert(sessionId, "Expected session ID from initialize");
  printCheck(`initialized session ${sessionId.slice(0, 8)}...`);

  await httpCallTool(server.baseUrl, sessionId, "apex.session.authenticate", {
    token: "valid-token-12345",
    token_type: "jwt",
  });
  printCheck("authenticated");

  const sse1 = openSseStream(server.baseUrl, sessionId);
  await delay(300);
  printCheck("SSE stream opened");

  await httpSubscribe(server.baseUrl, sessionId, "apex://account/orders/ACC_12345");
  printCheck("subscribed to orders resource");

  /* ================================================================== */
  /*  Step 2 — Generate events (first order)                            */
  /* ================================================================== */

  const order1 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 10000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(order1.status, "filled", "Expected first market order to be filled");
  printCheck(`first order placed: ${order1.order_id}`);

  // Wait for SSE events from the first order
  await sse1.waitForEvents(1, 5000);
  await delay(500);

  const eventsAfterOrder1 = sse1.events.slice();
  assert(eventsAfterOrder1.length > 0, "Expected SSE events from first order");

  // Find the last event ID from the stream
  const lastEventFromStep2 = eventsAfterOrder1[eventsAfterOrder1.length - 1];
  assert(lastEventFromStep2.id, "Expected last SSE event to have an id");
  const lastEventIdStep2 = lastEventFromStep2.id;
  printCheck(`received ${eventsAfterOrder1.length} SSE events, last event ID: ${lastEventIdStep2}`);

  /* ================================================================== */
  /*  Step 3 — Disconnect                                               */
  /* ================================================================== */

  sse1.close();
  await delay(200);
  printCheck("SSE stream closed (simulating disconnect)");

  /* ================================================================== */
  /*  Step 4 — Generate events while disconnected                       */
  /* ================================================================== */

  const order2 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 5000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(order2.status, "filled", "Expected second market order to be filled");
  printCheck(`second order placed while disconnected: ${order2.order_id}`);

  /* ================================================================== */
  /*  Step 5 — Reconnect with replay (Last-Event-ID)                    */
  /* ================================================================== */

  const sse2 = openSseStream(server.baseUrl, sessionId, lastEventIdStep2);
  await delay(1500);
  printCheck(`reconnected SSE stream with Last-Event-ID: ${lastEventIdStep2}`);

  /* ================================================================== */
  /*  Step 6 — Verify replay                                            */
  /* ================================================================== */

  const replayedEvents = sse2.events.slice();
  assert(replayedEvents.length > 0, "Expected replayed events after reconnect");

  // Replayed events should include notifications from the order placed while disconnected
  const replayedOrderFilled = replayedEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(
    replayedOrderFilled.length > 0,
    "Expected replayed events to include order.filled notification from disconnected order",
  );
  printCheck("replayed events include order.filled from disconnected period");

  // Verify monotonically increasing IDs
  const replayedIds = replayedEvents
    .filter((e) => e.id !== undefined)
    .map((e) => parseInt(e.id, 10));
  for (let i = 1; i < replayedIds.length; i++) {
    assert(
      replayedIds[i] > replayedIds[i - 1],
      `SSE event IDs not monotonically increasing: ${replayedIds[i - 1]} -> ${replayedIds[i]}`,
    );
  }
  printCheck("replayed event IDs are monotonically increasing");

  // All replayed event IDs should be greater than the Last-Event-ID we sent
  const lastEventIdNumeric = parseInt(lastEventIdStep2, 10);
  for (const id of replayedIds) {
    assert(
      id > lastEventIdNumeric,
      `Replayed event ID ${id} is not greater than Last-Event-ID ${lastEventIdNumeric}`,
    );
  }
  printCheck(`all replayed event IDs are > Last-Event-ID (${lastEventIdStep2})`);

  /* ================================================================== */
  /*  Step 7 — Verify continued streaming after reconnect               */
  /* ================================================================== */

  const eventsBeforeOrder3 = sse2.events.length;

  const order3 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 8000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(order3.status, "filled", "Expected third market order to be filled");
  printCheck(`third order placed after reconnect: ${order3.order_id}`);

  await sse2.waitForEvents(eventsBeforeOrder3 + 1, 5000);
  await delay(500);

  const newEvents = sse2.events.slice(eventsBeforeOrder3);
  assert(newEvents.length > 0, "Expected new SSE events after placing third order on reconnected stream");

  const newOrderFilled = newEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(
    newOrderFilled.length > 0,
    "Expected new order.filled notification on reconnected stream",
  );
  printCheck("new events arrive on reconnected stream (continued streaming works)");

  /* ================================================================== */
  /*  Step 8 — Buffer exhaustion test                                   */
  /* ================================================================== */

  // Note the current last event ID before flooding
  const eventsBeforeFlood = sse2.events.slice();
  const lastEventBeforeFlood = eventsBeforeFlood[eventsBeforeFlood.length - 1];
  assert(lastEventBeforeFlood.id, "Expected event ID before flood");
  const lastEventIdBeforeFlood = lastEventBeforeFlood.id;
  printCheck(`last event ID before buffer flood: ${lastEventIdBeforeFlood}`);

  // Close the SSE stream before flooding
  sse2.close();
  await delay(300);
  printCheck("SSE stream closed before buffer flood");

  // Place ~200 rapid orders to exceed the 1000-event replay buffer.
  // Each order generates ~6 events (5 resource updates + 1 order.filled),
  // so 200 * 6 = ~1200 events, exceeding the 1000-event buffer.
  printCheck("placing ~200 rapid orders to exhaust replay buffer...");

  for (let i = 0; i < 200; i++) {
    await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
      account_id: "ACC_12345",
      order: {
        instrument_id: "APEX:FX:EURUSD",
        side: i % 2 === 0 ? "buy" : "sell",
        order_type: "market",
        quantity: 1000,
        quantity_unit: "base_units",
        time_in_force: "GTC",
      },
    });
  }
  printCheck("200 rapid orders placed");

  // Reconnect with the stale event ID from before the flood.
  // The server's replay buffer should have evicted events around that ID.
  const sse3 = openSseStream(server.baseUrl, sessionId, lastEventIdBeforeFlood);

  // Wait for at least one event (the replay_failed notification)
  await sse3.waitForEvents(1, 10000);

  const exhaustionEvents = sse3.events.slice();
  assert(exhaustionEvents.length > 0, "Expected at least one event after reconnect with stale Last-Event-ID");

  // The first event should be a replay_failed notification
  const replayFailedEvent = exhaustionEvents[0];
  assert(
    replayFailedEvent.data?.method === "notifications/apex.session.replay_failed",
    `Expected first event to be notifications/apex.session.replay_failed, got: ${replayFailedEvent.data?.method}`,
  );
  printCheck("replay_failed notification received as first event after buffer exhaustion");

  // Verify the replay_failed notification has a reason field
  const replayFailedParams = replayFailedEvent.data?.params;
  assert(
    replayFailedParams?.reason,
    "Expected reason field in replay_failed notification",
  );
  printCheck(`replay_failed reason: "${replayFailedParams.reason}"`);

  // Verify the replay_failed notification includes last_available_id
  assert(
    typeof replayFailedParams.last_available_id === "number" || typeof replayFailedParams.last_available_id === "string",
    "replay_failed should include last_available_id",
  );
  printCheck(`replay_failed last_available_id: ${replayFailedParams.last_available_id}`);

  /* ================================================================== */
  /*  Step 9 — Post-failure recovery                                    */
  /* ================================================================== */

  const accountSummary = await httpCallTool(
    server.baseUrl,
    sessionId,
    "apex.account.summary",
    { account_id: "ACC_12345" },
  );
  assert(accountSummary.account_id, "Expected account_id in summary after replay failure");
  assert(accountSummary.balance !== undefined, "Expected balance in account summary");
  printCheck("server still works after replay failure (account.summary returned valid response)");

  /* ================================================================== */
  /*  Step 10 — Cleanup                                                 */
  /* ================================================================== */

  sse3.close();
  printCheck("SSE stream closed");

  console.log(`\nTransport resilience passed for ${target.label}`);
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
  stopHttpServer(server);
}
