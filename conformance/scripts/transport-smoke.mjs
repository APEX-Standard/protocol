import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  extractPayload,
  httpCallTool,
  httpInitialize,
  httpPost,
  httpSubscribe,
  httpUnsubscribe,
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

  // Check apex_version in server info
  const serverInfo = initResponse.result?.serverInfo;
  assert(
    serverInfo?.apex_version,
    `Expected apex_version in serverInfo, got: ${JSON.stringify(serverInfo)}`,
  );
  printCheck(`server reports apex_version: ${serverInfo.apex_version}`);

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

  /* -- Subscribe to all order-affected resources ---------------------- */

  await httpSubscribe(server.baseUrl, sessionId, "apex://account/orders/ACC_12345");
  await httpSubscribe(server.baseUrl, sessionId, "apex://account/positions/ACC_12345");
  await httpSubscribe(server.baseUrl, sessionId, "apex://account/fills/ACC_12345");
  await httpSubscribe(server.baseUrl, sessionId, "apex://account/risk/ACC_12345");
  await httpSubscribe(server.baseUrl, sessionId, "apex://agent/decision-context/APEX:FX:EURUSD");
  printCheck("subscribed to all order-affected resources");

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

  /* -- Order rejected while kill switch active (SSE) ----------------- */

  const rejectedOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 1000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  // The order should be rejected (kill switch active)
  assert(
    rejectedOrder.error?.code === "APEX_4023" || rejectedOrder.status === "rejected",
    "Expected order rejected with kill switch active",
  );

  // Check SSE stream for the rejected notification
  await delay(500);
  const rejectedEvents = sse.events.filter(
    (e) => e.data?.method === "notifications/apex.order.rejected",
  );
  // Note: rejected notification may or may not be emitted depending on implementation
  // (some impls reject at the tool level without emitting a notification)
  if (rejectedEvents.length > 0) {
    const rejParams = rejectedEvents[0].data?.params;
    assert(rejParams?.event_id, "rejected notification should have event_id");
    assert(
      rejParams?.event_type === "apex.order.rejected" || rejParams?.event_type === "notifications/apex.order.rejected",
      `rejected notification event_type should be apex.order.rejected, got ${rejParams?.event_type}`,
    );
    printCheck("received apex.order.rejected notification via SSE");
  } else {
    printCheck("order rejected at tool level (no SSE notification — implementation choice)");
  }

  /* -- Partial fill over SSE ----------------------------------------- */

  // Reset kill switch so orders can proceed
  await httpCallTool(server.baseUrl, sessionId, "reference.test.set_realtime_state", {
    kill_switch_active: false,
  });

  // Set the partial-fill flag so the next market order is partially filled
  await httpCallTool(server.baseUrl, sessionId, "reference.test.set_realtime_state", {
    partial_fill_next_order: true,
  });

  const partialOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(partialOrder.status, "partially_filled", "Expected market order to be partially_filled");
  assert(partialOrder.order_id, "Expected order_id in partial fill result");
  printCheck("market order partially filled over HTTP");

  await delay(500);

  const partialFillEvents = sse.events.filter(
    (e) => e.data?.method === "notifications/apex.order.partially_filled",
  );
  assert(
    partialFillEvents.length > 0,
    "Expected at least one notifications/apex.order.partially_filled SSE event",
  );

  const pfParams = partialFillEvents[0].data?.params;
  assert(pfParams?.event_id, "partially_filled notification should have event_id");
  assert(
    pfParams?.event_type === "apex.order.partially_filled" || pfParams?.event_type === "notifications/apex.order.partially_filled",
    `partially_filled notification event_type should be apex.order.partially_filled, got ${pfParams?.event_type}`,
  );
  assert(pfParams?.timestamp, "partially_filled notification should have timestamp");
  assert(typeof pfParams?.sequence === "number", "partially_filled notification should have numeric sequence");
  assert(pfParams?.resource_uri, "partially_filled notification should have resource_uri");
  assert(pfParams?.payload?.order_id, "partially_filled notification should have payload.order_id");
  printCheck("received apex.order.partially_filled notification via SSE with correct envelope");

  /* -- Subscription filtering (negative test) ------------------------- */

  // Unsubscribe from everything except orders
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://account/positions/ACC_12345");
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://account/fills/ACC_12345");
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://account/risk/ACC_12345");
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://agent/decision-context/APEX:FX:EURUSD");

  // Record event count before the next order
  const eventsBeforeFilter = sse.events.length;

  // Place another order to trigger resource updates
  const filterOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(filterOrder.status, "filled", "Expected filter-test order to be filled");

  await delay(1000);

  // Collect only the new events since the filter-test order
  const filterEvents = sse.events.slice(eventsBeforeFilter);

  // Resource updates should ONLY contain the orders URI
  const resourceUpdatesAfterFilter = filterEvents.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );
  for (const evt of resourceUpdatesAfterFilter) {
    const uri = evt.data?.params?.uri;
    assert.equal(
      uri,
      "apex://account/orders/ACC_12345",
      `Expected only orders resource update, got: ${uri}`,
    );
  }
  assert(
    resourceUpdatesAfterFilter.length > 0,
    "Expected at least one orders resource update after filtering",
  );

  // The APEX notification (order.filled) should still arrive — it is not a resource update
  const filledAfterFilter = filterEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(
    filledAfterFilter.length > 0,
    "Expected order.filled APEX notification even after unsubscribing from non-orders resources",
  );
  printCheck("subscription filtering: only subscribed resources notified");

  /* -- Subscribe to nothing, get no resource updates ----------------- */

  // Unsubscribe from the remaining orders subscription
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://account/orders/ACC_12345");

  const eventsBeforeNoSub = sse.events.length;

  const noSubOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(noSubOrder.status, "filled", "Expected no-sub order to be filled");

  await delay(1000);

  const noSubEvents = sse.events.slice(eventsBeforeNoSub);
  const noSubResourceUpdates = noSubEvents.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );
  assert.equal(
    noSubResourceUpdates.length,
    0,
    `Expected zero resource updates with no subscriptions, got ${noSubResourceUpdates.length}: ${noSubResourceUpdates.map(e => e.data?.params?.uri).join(", ")}`,
  );

  // APEX domain notification (order.filled) should still arrive
  const noSubFilled = noSubEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(noSubFilled.length > 0, "Expected order.filled even with zero subscriptions");
  printCheck("zero subscriptions: no resource updates, APEX notifications still arrive");

  /* -- Subscribe mid-session ----------------------------------------- */

  // Subscribe to just fills, place order, verify fills updates arrive
  await httpSubscribe(server.baseUrl, sessionId, "apex://account/fills/ACC_12345");

  const eventsBeforeMidSub = sse.events.length;

  const midSubOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(midSubOrder.status, "filled");

  await delay(1000);

  const midSubEvents = sse.events.slice(eventsBeforeMidSub);
  const midSubResourceUpdates = midSubEvents.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );
  // Should only contain fills URI
  for (const evt of midSubResourceUpdates) {
    assert.equal(
      evt.data?.params?.uri,
      "apex://account/fills/ACC_12345",
      `Expected only fills resource update after mid-session subscribe, got: ${evt.data?.params?.uri}`,
    );
  }
  assert(midSubResourceUpdates.length > 0, "Expected fills resource update after mid-session subscribe");
  printCheck("mid-session subscribe: new subscription produces updates immediately");

  /* -- Duplicate subscribe does not cause double notifications ------- */

  // Subscribe to fills again (duplicate)
  await httpSubscribe(server.baseUrl, sessionId, "apex://account/fills/ACC_12345");

  const eventsBeforeDup = sse.events.length;

  const dupOrder = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(dupOrder.status, "filled");

  await delay(1000);

  const dupEvents = sse.events.slice(eventsBeforeDup);
  const dupResourceUpdates = dupEvents.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );
  // Should still be exactly 1 fills update, not 2
  assert.equal(
    dupResourceUpdates.length,
    1,
    `Expected exactly 1 fills resource update (no duplicates from double subscribe), got ${dupResourceUpdates.length}`,
  );
  printCheck("duplicate subscribe: no double notifications");

  // Clean up subscription
  await httpUnsubscribe(server.baseUrl, sessionId, "apex://account/fills/ACC_12345");

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
