# APEX Protocol — Reference Flows

**Version:** `0.3.0-alpha`

---

## 1. Realtime Bootstrap Flow

1. Connect to the broker MCP server.
2. Call `apex.session.authenticate`.
3. Call `apex.session.capabilities`.
4. Read `resources/list`.
5. Subscribe to quote, candles, features, positions, orders, and risk.
6. Read each subscribed resource once to establish the baseline cache.
7. Begin decisioning only after freshness and sequence baselines are established.

---

## 2. Order Placement Flow

1. Runtime validates current cached state is fresh.
2. Runtime performs `apex.risk.check`.
3. Model produces intent.
4. Runtime translates intent into `apex.order.place`.
5. Broker returns order result.
6. Runtime receives `notifications/resources/updated`.
7. Runtime re-reads affected resources.
8. Runtime updates local order/account state.

---

## 3. Resting Order Update Flow

1. Runtime places a resting limit order.
2. Broker exposes the order through `apex://account/orders/{account_id}`.
3. Runtime subscribes to orders resource updates.
4. If the order is modified or cancelled, the broker updates state first.
5. Broker emits `notifications/resources/updated`.
6. Runtime re-reads the orders resource and reconciles sequence progression.

---

## 4. Reconnect Without Replay Flow

1. Transport reconnect occurs.
2. Runtime pauses autonomous execution.
3. Runtime clears freshness assumptions.
4. Runtime re-subscribes to execution-critical resources.
5. Runtime re-reads the baseline state.
6. Runtime resumes only after state passes freshness and continuity checks.

---

## 5. Autonomous Refusal Flow

1. Runtime sees stale quote or stale risk state.
2. Runtime does not call the model for execution.
3. Runtime records refusal reason.
4. Runtime waits for fresh state.
5. Runtime resumes only after the halt condition clears.

---

## 6. Partial Fill Lifecycle

1. Agent places a market order via `apex.order.place`
2. Broker fills half the quantity — returns `status: "partially_filled"`, `fill_quantity: N/2`
3. Server emits `notifications/resources/updated` for orders, fills, positions, risk
4. Agent reads `apex://account/orders/{account_id}` — sees order with `remaining_quantity: N/2`
5. Agent reads `apex://account/fills/{account_id}` — sees the partial fill event
6. Broker fills the remaining quantity — second fill event
7. Server emits `notifications/resources/updated` again
8. Agent reads updated orders resource — order now `status: "filled"`, `remaining_quantity: 0`

---

## 7. SSE Reconnect and Replay

1. Agent's SSE connection drops (network interruption, timeout)
2. Agent sends GET `/mcp` with `Mcp-Session-Id` and `Last-Event-ID` headers
3. Server looks up session, walks event log from cursor
4. Server replays execution-critical events (fills, rejections, kill switch) with original IDs
5. Server collapses consecutive ephemeral events (resource updates, candle closes) into `gap_fill` markers
6. Server transitions to live streaming (all events, no classification)
7. Agent processes replayed execution events, reconciles what happened during the gap
8. Agent re-reads all resources to rebuild current state
9. Agent calls `apex.session.acknowledge` with the last processed event ID
10. Agent re-establishes execution baseline before resuming autonomous trading
11. If `Last-Event-ID` is outside the event log, server sends `replay_failed` instead — agent discards all cached state and rebuilds from scratch
