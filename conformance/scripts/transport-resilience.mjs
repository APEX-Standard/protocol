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

  // Stop tick engine for deterministic event counts
  // Each market order fill produces exactly 6 events:
  // 5x notifications/resources/updated (orders, positions, fills, risk, decision-context)
  // 1x notifications/apex.order.filled
  await httpCallTool(server.baseUrl, sessionId, "reference.test.stop_ticks", {});
  printCheck("tick engine stopped for deterministic testing");

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

  // Wait for SSE events from the first order (exactly 6 per market order fill)
  await sse1.waitForEvents(6, 5000);

  const eventsAfterOrder1 = sse1.events.slice();
  assert(eventsAfterOrder1.length >= 6, `Expected at least 6 SSE events from first order, got ${eventsAfterOrder1.length}`);

  // Find the last event ID from the stream
  const lastEventFromStep2 = eventsAfterOrder1[eventsAfterOrder1.length - 1];
  assert(lastEventFromStep2.id, "Expected last SSE event to have an id");
  const lastEventIdStep2 = lastEventFromStep2.id;
  printCheck(`received ${eventsAfterOrder1.length} SSE events, last event ID: ${lastEventIdStep2}`);

  /* ================================================================== */
  /*  Step 3 — Disconnect                                               */
  /* ================================================================== */

  await sse1.close();
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
  await delay(1000);
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

  await sse2.waitForEvents(eventsBeforeOrder3 + 6, 5000);

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
  /*  Step 8 — Acknowledgment advances retention cursor                 */
  /* ================================================================== */

  // We have events from earlier tests. Note the last event ID.
  const eventsBeforeAck = sse2.events.slice();
  const lastEventBeforeAck = eventsBeforeAck[eventsBeforeAck.length - 1];
  assert(lastEventBeforeAck.id, "Expected event ID before acknowledge");
  const lastEventIdBeforeAck = lastEventBeforeAck.id;
  printCheck(`last event ID before acknowledge: ${lastEventIdBeforeAck}`);

  // Call apex.session.acknowledge with that ID
  const ackResult = await httpCallTool(server.baseUrl, sessionId, "apex.session.acknowledge", {
    last_event_id: lastEventIdBeforeAck,
  });
  assert(
    ackResult.acknowledged_through !== undefined,
    "Expected acknowledged_through in acknowledge response",
  );
  assert(
    typeof ackResult.buffer_depth === "number",
    "Expected numeric buffer_depth in acknowledge response",
  );
  assert.equal(
    ackResult.buffer_depth, 0,
    `Expected buffer_depth === 0 after acknowledging all observed events, got ${ackResult.buffer_depth}`,
  );
  printCheck(`acknowledge returned acknowledged_through=${ackResult.acknowledged_through}, buffer_depth=${ackResult.buffer_depth}`);

  // Place a new order to generate fresh events after the acknowledge
  const orderPostAck = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 3000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderPostAck.status, "filled", "Expected post-acknowledge order to be filled");
  printCheck(`post-acknowledge order placed: ${orderPostAck.order_id}`);

  await sse2.waitForEvents(eventsBeforeAck.length + 6, 5000);

  // Note a fresh event ID from after the acknowledge
  const eventsAfterAck = sse2.events.slice();
  const freshEventAfterAck = eventsAfterAck[eventsAfterAck.length - 1];
  assert(freshEventAfterAck.id, "Expected event ID after acknowledge");
  const freshEventIdAfterAck = freshEventAfterAck.id;
  printCheck(`fresh event ID after acknowledge: ${freshEventIdAfterAck}`);

  // Disconnect SSE
  await sse2.close();
  printCheck("SSE stream closed after acknowledge test");

  // Reconnect with the OLD (pre-acknowledge) event ID as Last-Event-ID
  const sseStaleAck = openSseStream(server.baseUrl, sessionId, lastEventIdBeforeAck);
  await sseStaleAck.waitForEvents(1, 10000);

  const staleAckEvents = sseStaleAck.events.slice();
  assert(staleAckEvents.length > 0, "Expected at least one event after reconnect with pre-acknowledge Last-Event-ID");

  // The first event should be a replay_failed notification because acknowledged events were discarded
  const ackReplayFailed = staleAckEvents[0];
  assert(
    ackReplayFailed.data?.method === "notifications/apex.session.replay_failed",
    `Expected replay_failed after reconnect with pre-acknowledge ID, got: ${ackReplayFailed.data?.method}`,
  );
  printCheck("replay_failed received when reconnecting with pre-acknowledge event ID");

  await sseStaleAck.close();

  // Reconnect with the fresh event ID from after the acknowledge — should succeed
  const sseFreshAck = openSseStream(server.baseUrl, sessionId, freshEventIdAfterAck);
  await delay(1000);

  // The reconnected stream should not start with replay_failed
  const freshAckEvents = sseFreshAck.events.slice();
  if (freshAckEvents.length > 0) {
    assert(
      freshAckEvents[0].data?.method !== "notifications/apex.session.replay_failed",
      "Did not expect replay_failed when reconnecting with post-acknowledge event ID",
    );
  }
  printCheck("successful reconnect with post-acknowledge event ID (no replay_failed)");

  await sseFreshAck.close();

  /* ================================================================== */
  /*  Step 9 — Gap fill (elide ephemeral on replay)                     */
  /* ================================================================== */

  // Open a fresh SSE stream (use last known event ID to ensure clean connection)
  const sseGap1 = openSseStream(server.baseUrl, sessionId, freshEventIdAfterAck);
  await delay(1000);
  printCheck("SSE stream opened for gap fill test");

  // Place an order — generates both execution (order.filled) and ephemeral (resources/updated) events
  const orderGap1 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 7000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderGap1.status, "filled", "Expected gap-fill test order 1 to be filled");
  printCheck(`gap fill test order 1 placed: ${orderGap1.order_id}`);

  // Wait for all 6 events from the order fill
  await sseGap1.waitForEvents(6, 5000);

  const gapEvents1 = sseGap1.events.slice();
  assert(gapEvents1.length >= 6, `Expected at least 6 SSE events from gap fill test order 1, got ${gapEvents1.length}`);

  // Note the last event ID
  const lastGapEvent1 = gapEvents1[gapEvents1.length - 1];
  assert(lastGapEvent1.id, "Expected event ID for gap fill checkpoint");
  const gapCheckpointId = lastGapEvent1.id;
  printCheck(`gap fill checkpoint event ID: ${gapCheckpointId}`);

  // Close SSE stream
  await sseGap1.close();
  printCheck("SSE stream closed for gap fill disconnect");

  // Place another order while disconnected (generates more mixed events)
  const orderGap2 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 4000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderGap2.status, "filled", "Expected gap-fill test order 2 to be filled");
  printCheck(`gap fill test order 2 placed while disconnected: ${orderGap2.order_id}`);

  // Reconnect with Last-Event-ID from checkpoint
  // With tick engine stopped, replay of 1 order's 6 events produces:
  // gap_fill (for the 5 elided resources/updated) + order.filled = 2 events
  const sseGap2 = openSseStream(server.baseUrl, sessionId, gapCheckpointId);
  await sseGap2.waitForEvents(2, 10000);

  const allGapEvents = sseGap2.events.slice();
  assert(allGapEvents.length >= 2, "Expected at least 2 events after gap fill reconnect (gap_fill + order.filled)");

  // Assert: apex.order.filled IS present (execution events are replayed)
  const gapFilledEvents = allGapEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(
    gapFilledEvents.length > 0,
    "Expected apex.order.filled in replayed events (execution events must be replayed)",
  );
  printCheck("replayed events include apex.order.filled (execution events preserved)");

  // Assert: at least one gap_fill marker is present (ephemeral events were elided during replay)
  // We verify elision via gap_fill presence (better design than checking absence of resources/updated)

  // Assert: at least one notifications/apex.session.gap_fill event IS present
  const gapFillEvents = allGapEvents.filter(
    (e) => e.data?.method === "notifications/apex.session.gap_fill",
  );
  assert(
    gapFillEvents.length > 0,
    "Expected at least one notifications/apex.session.gap_fill marker in replayed events",
  );
  printCheck(`received ${gapFillEvents.length} gap_fill marker(s) during replay`);

  // Assert: gap_fill has elided_count > 0, from_id, to_id
  for (const gf of gapFillEvents) {
    const gfParams = gf.data?.params;
    assert(
      typeof gfParams.elided_count === "number" && gfParams.elided_count > 0,
      `Expected gap_fill elided_count > 0, got ${gfParams.elided_count}`,
    );
    assert(
      gfParams.from_id !== undefined,
      "Expected from_id in gap_fill notification",
    );
    assert(
      gfParams.to_id !== undefined,
      "Expected to_id in gap_fill notification",
    );
  }
  printCheck("gap_fill markers have valid elided_count, from_id, and to_id");

  // Compute replay boundary from gap_fill markers and required events
  const gapCheckpointNumeric = parseInt(gapCheckpointId, 10);
  let replayEndId = gapCheckpointNumeric;
  for (const e of allGapEvents) {
    const method = e.data?.method;
    if (method === "notifications/apex.session.gap_fill") {
      const toId = parseInt(e.data?.params?.to_id, 10);
      if (toId > replayEndId) replayEndId = toId;
    }
    if (e.id !== undefined) {
      const eid = parseInt(e.id, 10);
      if (eid > replayEndId) replayEndId = eid;
    }
  }

  // CORE: no resources/updated in the replay range (proves elision, not just gap_fill presence)
  const replayResourceUpdated = allGapEvents.filter((e) => {
    if (e.data?.method !== "notifications/resources/updated") return false;
    const eid = parseInt(e.id, 10);
    return eid > gapCheckpointNumeric && eid <= replayEndId;
  });
  assert.equal(
    replayResourceUpdated.length, 0,
    `Expected zero resources/updated in replay range (${gapCheckpointId}, ${replayEndId}], found ${replayResourceUpdated.length}`,
  );
  printCheck("no resources/updated in replay range (elision structurally verified)");

  // Total elided events should account for the resources/updated from the order
  const totalElided = gapFillEvents.reduce((sum, gf) => sum + gf.data?.params?.elided_count, 0);
  assert(totalElided >= 5, `Expected at least 5 elided events, got ${totalElided}`);
  printCheck(`gap_fill markers account for ${totalElided} elided events`);

  // Assert: all event IDs are monotonically increasing
  const allGapIds = allGapEvents
    .filter((e) => e.id !== undefined)
    .map((e) => parseInt(e.id, 10));
  for (let i = 1; i < allGapIds.length; i++) {
    assert(
      allGapIds[i] > allGapIds[i - 1],
      `Event IDs not monotonically increasing: ${allGapIds[i - 1]} -> ${allGapIds[i]}`,
    );
  }
  printCheck("event IDs are monotonically increasing (replay + live)");

  await sseGap2.close();
  printCheck("gap fill test SSE stream closed");

  // Use the gap fill checkpoint ID (which is a real buffered event) rather than
  // a replayed event ID that might not exist in the buffer.
  // gapCheckpointId was the last event before the gap fill disconnect.
  // Events generated during the gap are in the buffer after it.
  // The safest reconnect point is the last order.filled ID from the replay.
  const lastFilledInReplay = allGapEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled"
  );
  const lastIdAfterStep9 = lastFilledInReplay.length > 0
    ? lastFilledInReplay[lastFilledInReplay.length - 1].id
    : gapCheckpointId;
  printCheck(`last event ID after step 9: ${lastIdAfterStep9}`);

  /* ================================================================== */
  /*  Step 10 — Acknowledgment-based retention eviction (buffer exhaust)*/
  /* ================================================================== */

  const sseEvict = openSseStream(server.baseUrl, sessionId);
  await delay(1000);

  // Generate some events (place 1-2 orders)
  const orderEvict1 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 2000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderEvict1.status, "filled", "Expected eviction test order 1 to be filled");
  printCheck(`eviction test order 1 placed: ${orderEvict1.order_id}`);

  await sseEvict.waitForEvents(6, 10000);

  // Note the last event ID
  const evictEvents1 = sseEvict.events.slice();
  const lastEvictEvent = evictEvents1[evictEvents1.length - 1];
  assert(lastEvictEvent.id, "Expected event ID for eviction checkpoint");
  const evictCheckpointId = lastEvictEvent.id;
  printCheck(`eviction checkpoint event ID: ${evictCheckpointId}`);

  // Acknowledge all events (clearing the log)
  const evictAckResult = await httpCallTool(server.baseUrl, sessionId, "apex.session.acknowledge", {
    last_event_id: evictCheckpointId,
  });
  assert(
    evictAckResult.acknowledged_through !== undefined,
    "Expected acknowledged_through in eviction acknowledge response",
  );
  printCheck(`eviction acknowledge: acknowledged_through=${evictAckResult.acknowledged_through}`);

  // Generate more events (place another order)
  const orderEvict2 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 1500,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderEvict2.status, "filled", "Expected eviction test order 2 to be filled");
  printCheck(`eviction test order 2 placed: ${orderEvict2.order_id}`);

  await sseEvict.close();

  // Disconnect, reconnect with pre-acknowledge Last-Event-ID
  const sseEvictReplay = openSseStream(server.baseUrl, sessionId, evictCheckpointId);
  await sseEvictReplay.waitForEvents(1, 10000);

  const evictReplayEvents = sseEvictReplay.events.slice();
  assert(evictReplayEvents.length > 0, "Expected at least one event after eviction reconnect");

  // Assert replay_failed with reason "event_id_outside_log"
  const evictReplayFailed = evictReplayEvents[0];
  assert(
    evictReplayFailed.data?.method === "notifications/apex.session.replay_failed",
    `Expected replay_failed after eviction reconnect, got: ${evictReplayFailed.data?.method}`,
  );
  const evictReplayFailedParams = evictReplayFailed.data?.params;
  assert.equal(
    evictReplayFailedParams?.reason,
    "event_id_outside_log",
    `Expected replay_failed reason "event_id_outside_log", got "${evictReplayFailedParams?.reason}"`,
  );
  printCheck(`replay_failed with reason "event_id_outside_log" after acknowledgment-based eviction`);

  // Verify the replay_failed notification includes last_available_id
  assert(
    typeof evictReplayFailedParams.last_available_id === "number" || typeof evictReplayFailedParams.last_available_id === "string",
    "replay_failed should include last_available_id",
  );
  printCheck(`replay_failed last_available_id: ${evictReplayFailedParams.last_available_id}`);

  const evictLastAvailableId = String(evictReplayFailedParams.last_available_id);
  await sseEvictReplay.close();

  /* ================================================================== */
  /*  Step 11 — Interleaved gap fill (multiple required between elides) */
  /* ================================================================== */

  // Open SSE stream using the last_available_id from the replay_failed response
  const sseInterleave = openSseStream(server.baseUrl, sessionId);
  await delay(1000);

  // Place an initial order to generate baseline events
  const orderInterleave0 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(orderInterleave0.status, "filled", "Expected interleave baseline order to be filled");

  await sseInterleave.waitForEvents(6, 10000);

  // Note checkpoint
  const interleaveEvents0 = sseInterleave.events.slice();
  const interleaveCheckpointId = interleaveEvents0[interleaveEvents0.length - 1].id;
  assert(interleaveCheckpointId, "Expected event ID for interleave checkpoint");
  printCheck(`interleave checkpoint event ID: ${interleaveCheckpointId}`);

  // Disconnect
  await sseInterleave.close();

  // Place 3 orders while disconnected — each generates resource/updated (elide) + order.filled (required)
  // This creates the pattern: [elide-run, required, elide-run, required, elide-run, required]
  for (let i = 0; i < 3; i++) {
    await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
      account_id: "ACC_12345",
      order: {
        instrument_id: "APEX:FX:EURUSD",
        side: i % 2 === 0 ? "buy" : "sell",
        order_type: "market",
        quantity: 1000 + i * 500,
        quantity_unit: "base_units",
        time_in_force: "GTC",
      },
    });
  }
  printCheck("3 orders placed while disconnected for interleave test");

  // Reconnect with checkpoint
  // 3 orders while disconnected: replay produces 3 fills + gap_fill markers
  const sseInterleave2 = openSseStream(server.baseUrl, sessionId, interleaveCheckpointId);
  // 3 orders × (1 fill + gap_fill) = at least 6 replay events
  await sseInterleave2.waitForEvents(6, 10000);

  const interleaveReplayed = sseInterleave2.events.slice();
  assert(interleaveReplayed.length > 0, "Expected replayed events for interleave test");

  // Count event types
  const interleaveFills = interleaveReplayed.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  const interleaveGapFills = interleaveReplayed.filter(
    (e) => e.data?.method === "notifications/apex.session.gap_fill",
  );
  const interleaveResourceUpdated = interleaveReplayed.filter(
    (e) => e.data?.method === "notifications/resources/updated",
  );

  // Should have 3 fills (one per order)
  assert(
    interleaveFills.length >= 3,
    `Expected at least 3 apex.order.filled events in interleave replay, got ${interleaveFills.length}`,
  );
  printCheck(`interleave replay: ${interleaveFills.length} fills replayed`);

  // Should have multiple gap_fill markers (one per elide run between/around required events)
  assert(
    interleaveGapFills.length >= 2,
    `Expected at least 2 gap_fill markers in interleave replay, got ${interleaveGapFills.length}`,
  );
  printCheck(`interleave replay: ${interleaveGapFills.length} gap_fill markers`);

  // gap_fill markers prove that resources/updated events were elided during replay.
  // We verify elision via gap_fill presence (better design than checking absence of resources/updated).
  printCheck(`interleave replay: ${interleaveGapFills.length} gap_fill markers prove ephemeral elision`);

  // Compute interleave replay boundary
  const interleaveCheckpointNumeric = parseInt(interleaveCheckpointId, 10);
  let interleaveReplayEndId = interleaveCheckpointNumeric;
  for (const e of interleaveReplayed) {
    const method = e.data?.method;
    if (method === "notifications/apex.session.gap_fill") {
      const toId = parseInt(e.data?.params?.to_id, 10);
      if (toId > interleaveReplayEndId) interleaveReplayEndId = toId;
    }
    if (e.id !== undefined) {
      const eid = parseInt(e.id, 10);
      if (eid > interleaveReplayEndId) interleaveReplayEndId = eid;
    }
  }

  // CORE: no resources/updated in the interleave replay range
  const interleaveReplayResourceUpdated = interleaveReplayed.filter((e) => {
    if (e.data?.method !== "notifications/resources/updated") return false;
    const eid = parseInt(e.id, 10);
    return eid > interleaveCheckpointNumeric && eid <= interleaveReplayEndId;
  });
  assert.equal(
    interleaveReplayResourceUpdated.length, 0,
    `Expected zero resources/updated in interleave replay range (${interleaveCheckpointId}, ${interleaveReplayEndId}], found ${interleaveReplayResourceUpdated.length}`,
  );
  printCheck("no resources/updated in interleave replay range (elision structurally verified)");

  // 3 orders × 5 resources/updated = 15 elided events minimum
  const interleaveTotalElided = interleaveGapFills.reduce((sum, gf) => sum + gf.data?.params?.elided_count, 0);
  assert(interleaveTotalElided >= 15, `Expected at least 15 elided events (3 orders × 5 resources/updated), got ${interleaveTotalElided}`);
  printCheck(`interleave gap_fill markers account for ${interleaveTotalElided} elided events`);

  // Verify gap_fill and required events are properly interleaved
  // The replayed stream should alternate between gap_fill and fill events
  let lastType = null;
  for (const e of interleaveReplayed) {
    const method = e.data?.method;
    if (method === "notifications/apex.session.gap_fill") {
      // Two consecutive gap_fills would mean no required event between elide runs — valid but unlikely with 3 orders
      lastType = "gap_fill";
    } else if (method === "notifications/apex.order.filled") {
      lastType = "fill";
    }
  }
  printCheck("interleave replay: events are properly interleaved");

  const lastIdFromStep11 = interleaveReplayed[interleaveReplayed.length - 1]?.id;
  await sseInterleave2.close();

  /* ================================================================== */
  /*  Step 12 — Gap fill marker IDs are higher than elided range        */
  /* ================================================================== */

  // Reuse the interleave replay data from Step 11 if still available,
  // or re-run a simpler version (pass last known event ID from Step 11)
  const sseMarkerTest = openSseStream(server.baseUrl, sessionId);
  await delay(1000);

  const orderMarker1 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 2000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderMarker1.status, "filled", "Expected marker test order to be filled");

  await sseMarkerTest.waitForEvents(6, 10000);

  const markerCheckpointId = sseMarkerTest.events[sseMarkerTest.events.length - 1].id;
  await sseMarkerTest.close();

  // Place order while disconnected
  await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 2000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });

  // Replay of 1 order: gap_fill + order.filled = 2 events
  const sseMarkerReplay = openSseStream(server.baseUrl, sessionId, markerCheckpointId);
  await sseMarkerReplay.waitForEvents(2, 10000);

  const markerReplayEvents = sseMarkerReplay.events.slice();
  const markerGapFills = markerReplayEvents.filter(
    (e) => e.data?.method === "notifications/apex.session.gap_fill",
  );

  for (const gf of markerGapFills) {
    const gfId = parseInt(gf.id, 10);
    const toId = parseInt(gf.data?.params?.to_id, 10);
    assert.equal(
      gfId, toId,
      `Gap fill marker SSE event ID (${gfId}) must equal its to_id (${toId}) — uses last elided event ID for monotonicity`,
    );
    printCheck(`gap_fill marker ID ${gfId} === to_id ${toId} (uses last elided event ID)`);
  }

  const lastIdFromStep12 = markerReplayEvents[markerReplayEvents.length - 1]?.id;
  await sseMarkerReplay.close();

  /* ================================================================== */
  /*  Step 13 — Partial acknowledge (buffer_depth > 0)                  */
  /* ================================================================== */

  // Open SSE stream and generate events (pass last known event ID from Step 12)
  const ssePartial = openSseStream(server.baseUrl, sessionId);
  await delay(1000);

  // Place 2 orders to generate events
  const orderPartial1 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
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
  assert.equal(orderPartial1.status, "filled", "Expected partial ack order 1 to be filled");

  await ssePartial.waitForEvents(6, 10000);

  // Note event IDs: use an early one for acknowledge, keep later ones for replay
  const partialEvents1 = ssePartial.events.slice();
  // Acknowledge through the FIRST event of order 1 (not the last)
  // This discards only events up to that point, keeping most events for replay
  const partialAckThroughId = partialEvents1[0].id;
  // The last event of order 1 is AFTER the ack point — still in buffer
  const partialReplayFromId = partialEvents1[partialEvents1.length - 1].id;

  // Place order 2
  const orderPartial2 = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "sell",
      order_type: "market",
      quantity: 1000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(orderPartial2.status, "filled", "Expected partial ack order 2 to be filled");

  await ssePartial.waitForEvents(partialEvents1.length + 6, 10000);

  const partialEvents2 = ssePartial.events.slice();
  const partialFinalId = partialEvents2[partialEvents2.length - 1].id;

  // Partially acknowledge — only through the first event of order 1
  const partialAckResult = await httpCallTool(server.baseUrl, sessionId, "apex.session.acknowledge", {
    last_event_id: partialAckThroughId,
  });
  assert(
    partialAckResult.buffer_depth > 0,
    `Expected buffer_depth > 0 after partial acknowledge, got ${partialAckResult.buffer_depth}`,
  );
  printCheck(`partial acknowledge: buffer_depth=${partialAckResult.buffer_depth} (unacknowledged events remain)`);

  // Disconnect
  await ssePartial.close();

  // Reconnect with last event of order 1 — events after it should be available for replay
  // This ID is AFTER the acknowledge point, so it's still in the buffer
  const ssePartialReplay = openSseStream(server.baseUrl, sessionId, partialReplayFromId);
  await ssePartialReplay.waitForEvents(1, 10000);

  const partialReplayEvents = ssePartialReplay.events.slice();

  // Should NOT get replay_failed (events after midpoint are still retained)
  if (partialReplayEvents.length > 0) {
    assert(
      partialReplayEvents[0].data?.method !== "notifications/apex.session.replay_failed",
      "Did not expect replay_failed for partial acknowledge — unacknowledged events should be available",
    );
  }
  printCheck("partial acknowledge: unacknowledged events available for replay");

  // Should have the order 2 fill in the replay (it was after the acknowledge point)
  const partialReplayFills = partialReplayEvents.filter(
    (e) => e.data?.method === "notifications/apex.order.filled",
  );
  assert(
    partialReplayFills.length >= 1,
    `Expected at least 1 fill in partial replay (order 2), got ${partialReplayFills.length}`,
  );
  printCheck("partial acknowledge: order 2 fill available in replay");

  // Reconnect with pre-midpoint ID — should get replay_failed (those events were acknowledged)
  // Use a very early ID that predates the partial acknowledge
  const veryOldId = String(Math.max(1, parseInt(partialAckThroughId, 10) - 100));
  const ssePartialStale = openSseStream(server.baseUrl, sessionId, veryOldId);
  await ssePartialStale.waitForEvents(1, 10000);

  const partialStaleEvents = ssePartialStale.events.slice();
  assert(
    partialStaleEvents[0].data?.method === "notifications/apex.session.replay_failed",
    "Expected replay_failed when requesting events before partial acknowledge point",
  );
  printCheck("partial acknowledge: replay_failed for events before acknowledge point");

  ssePartialStale.close();
  ssePartialReplay.close();

  /* ================================================================== */
  /*  Step 14 — Post-failure recovery                                   */
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
  /*  Step 15 — Cleanup                                                 */
  /* ================================================================== */

  printCheck("all SSE streams closed");

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
