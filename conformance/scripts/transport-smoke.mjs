import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  extractPayload,
  httpCallTool,
  httpInitialize,
  httpPost,
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
  server = await spawnHttpServer(target.label, { verbose: target.verbose });
  printCheck(`HTTP server started on ${server.baseUrl}`);

  /* -- Initialize ---------------------------------------------------- */

  const { sessionId, response: initResponse } = await httpInitialize(server.baseUrl);
  assert(sessionId, "Expected session ID from initialize");
  assert(initResponse.result, "Expected result in initialize response");
  printCheck(`initialize returned session ${sessionId.slice(0, 8)}...`);

  /* -- Authenticate -------------------------------------------------- */

  const authResult = await httpCallTool(server.baseUrl, sessionId, "apex.session.authenticate", {
    token: "valid-token-12345",
    token_type: "jwt",
  });
  assert(authResult.session_id, "Expected session_id in auth response");
  assert(authResult.account_id, "Expected account_id in auth response");
  printCheck("authenticated successfully over HTTP");

  /* -- Capabilities -------------------------------------------------- */

  const caps = await httpCallTool(server.baseUrl, sessionId, "apex.session.capabilities", {});
  assert.equal(
    caps.realtime_contract?.transport_mode,
    "streamable_http",
    "Expected transport_mode === streamable_http",
  );
  assert.equal(
    caps.realtime_contract?.reconnect_mode,
    "session_replay",
    "Expected reconnect_mode === session_replay",
  );
  printCheck("capabilities report streamable_http transport with session_replay");

  // Validate acknowledgment-driven retention capabilities
  assert(
    typeof caps.realtime_contract?.max_retention_events === "number" &&
      caps.realtime_contract.max_retention_events > 0,
    `Expected max_retention_events > 0, got ${caps.realtime_contract?.max_retention_events}`,
  );
  assert(
    typeof caps.realtime_contract?.max_retention_seconds === "number" &&
      caps.realtime_contract.max_retention_seconds >= 0,
    `Expected max_retention_seconds >= 0, got ${caps.realtime_contract?.max_retention_seconds}`,
  );
  printCheck(
    `retention caps: max_retention_events=${caps.realtime_contract.max_retention_events}, max_retention_seconds=${caps.realtime_contract.max_retention_seconds}`,
  );

  // Validate apex.session.acknowledge is in the tools list
  const toolsListResponse = await httpPost(server.baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: 50,
    method: "tools/list",
    params: {},
  });
  const toolsList = (toolsListResponse.json?.result?.tools ?? []).map((t) => t.name);
  assert(
    toolsList.includes("apex.session.acknowledge"),
    `Expected apex.session.acknowledge in tools list, got: ${toolsList.filter(t => t.includes("session")).join(", ")}`,
  );
  printCheck("apex.session.acknowledge is present in tools list");

  // Validate notifications/apex.session.gap_fill is in notification types
  const notificationTypes = caps.realtime_contract?.notifications ?? [];
  assert(
    notificationTypes.includes("notifications/apex.session.gap_fill"),
    `Expected notifications/apex.session.gap_fill in notification types, got: ${JSON.stringify(notificationTypes)}`,
  );
  printCheck("notifications/apex.session.gap_fill is in notification types");

  /* -- Open SSE stream ----------------------------------------------- */

  const sse = openSseStream(server.baseUrl, sessionId);
  // Give the stream a moment to connect
  await delay(200);
  printCheck("SSE stream opened");

  /* -- Subscribe to orders resource ---------------------------------- */

  await httpSubscribe(server.baseUrl, sessionId, "apex://account/orders/ACC_12345");
  printCheck("subscribed to orders resource");

  /* -- Place a market order ------------------------------------------ */

  const orderResult = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(orderResult.status, "filled", "Expected market order to be filled");
  assert(orderResult.order_id, "Expected order_id in order result");
  printCheck("market order placed and filled over HTTP");

  /* -- Wait for SSE events ------------------------------------------- */

  await delay(1000);

  const sseEvents = sse.events;
  assert(sseEvents.length > 0, `Expected at least one SSE event, got ${sseEvents.length}`);

  // Check for notifications/resources/updated
  const resourceUpdated = sseEvents.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );
  assert(resourceUpdated.length > 0, "Expected at least one notifications/resources/updated SSE event");
  printCheck("received notifications/resources/updated via SSE");

  // Check for notifications/apex.order.filled
  const orderFilled = sseEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(orderFilled.length > 0, "Expected at least one notifications/apex.order.filled SSE event");
  printCheck("received notifications/apex.order.filled via SSE");

  // Verify all SSE events have numeric id fields
  for (const evt of sseEvents) {
    if (evt.id !== undefined) {
      const numericId = Number(evt.id);
      assert(!Number.isNaN(numericId), `Expected numeric SSE event id, got: ${evt.id}`);
    }
  }
  printCheck("all SSE events have numeric id fields");

  // Verify the apex.order.filled notification envelope
  const filledNotif = orderFilled[0].data.params;
  assert(filledNotif.event_id, "Expected event_id in order.filled notification");
  assert(filledNotif.event_type, "Expected event_type in order.filled notification");
  assert(filledNotif.timestamp, "Expected timestamp in order.filled notification");
  assert(typeof filledNotif.sequence === "number", "Expected numeric sequence in order.filled notification");
  assert(filledNotif.resource_uri, "Expected resource_uri in order.filled notification");
  assert(filledNotif.payload?.order_id, "Expected payload.order_id in order.filled notification");
  printCheck("order.filled notification has correct envelope structure");

  /* -- Kill switch --------------------------------------------------- */

  await httpCallTool(server.baseUrl, sessionId, "reference.test.set_realtime_state", {
    kill_switch_active: true,
  });
  printCheck("activated kill switch");

  await delay(500);

  const killSwitchEvents = sse.events.filter(
    (e) => e.data?.method === "notifications/apex.risk.kill_switch_engaged",
  );
  assert(
    killSwitchEvents.length > 0,
    "Expected notifications/apex.risk.kill_switch_engaged SSE event after kill switch activation",
  );
  printCheck("received kill_switch_engaged notification via SSE");

  /* -- Bogus session ID ---------------------------------------------- */

  const bogusResult = await httpPost(server.baseUrl, "bogus-session-id-does-not-exist", {
    jsonrpc: "2.0",
    id: 9999,
    method: "tools/list",
    params: {},
  });
  assert.equal(bogusResult.status, 404, `Expected 404 status for bogus session ID, got ${bogusResult.status}`);
  printCheck("bogus session ID rejected with HTTP 404");

  /* -- Missing session header --------------------------------------- */

  const missingHeaderResult = await httpPost(server.baseUrl, null, {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/list",
  });
  assert.equal(missingHeaderResult.status, 400, `Expected 400 status for missing session header, got ${missingHeaderResult.status}`);
  printCheck("missing session header rejected with HTTP 400");

  /* -- Cleanup ------------------------------------------------------- */

  sse.close();
  printCheck("SSE stream closed");

  console.log(`Transport smoke passed for ${target.label}`);
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
