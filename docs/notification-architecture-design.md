# APEX Protocol — Notification Architecture Design

**Version:** `0.3.0-alpha`

---

## Overview

Notifications are the primary interface for change in APEX. The agent does not poll. It subscribes and reacts.

When a quote moves, a fill lands, an order is rejected, a candle closes, or the kill switch fires, the broker tells the agent through a notification. The agent classifies the notification, updates its state, and decides what to do. This is the fundamental loop: subscribe, receive, classify, act.

APEX defines two families of notifications. The first is the MCP-standard `notifications/resources/updated` — a generic signal that a subscribed resource changed, carrying no data beyond the URI. The second is the APEX-specific `notifications/apex.*` family — semantic events that carry structured payloads describing exactly what happened. Both families flow over the same SSE stream, share the same monotonic event ID space, and participate in the same replay and gap fill mechanics described in [replay-design.md](./replay-design.md).

The two families exist because they solve different problems. Resource invalidation tells the agent "something changed, go look." Execution events tell the agent "this specific thing happened, here are the facts." The agent needs both: the first to maintain current state, the second to maintain execution history.

---

## The Two Notification Families

### MCP-Standard Resource Invalidation

`notifications/resources/updated` is part of the MCP specification. It carries one field: the URI of the resource that changed.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "apex://market/quote/APEX:FX:EURUSD"
  }
}
```

The notification says nothing about what changed. The bid might have moved. The spread might have widened. The market might have closed. The agent does not know until it re-reads the resource. This is level-triggered invalidation — the notification is a signal, not a payload.

Resource invalidation is the workhorse of state maintenance. In a typical session, the vast majority of notifications are `notifications/resources/updated` for quotes, positions, orders, risk, and features. The agent's runtime maintains a local cache. On each notification, it re-reads the affected resource, checks the `sequence` for gaps, checks `stale_after_ms` for freshness, and updates the cache. The model never sees these notifications directly — the runtime handles them.

Resource invalidation covers:

- Quote updates (bid/ask/mid/spread changes)
- Candle resource updates (new forming bar, completed bar added)
- Feature updates (derived metrics recomputed)
- Position changes (new position, modified exposure)
- Order state transitions (accepted, working, filled, cancelled)
- Fill history additions
- Risk state changes (margin, daily loss, kill switch state)
- Account summary updates (balance, equity, margin level)

### APEX-Specific Execution Events

`notifications/apex.*` notifications are APEX-defined. They carry structured payloads with specific facts that the agent cannot reconstruct from current resource state.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.order.filled",
  "params": {
    "event_id": "evt_a1b2c3d4",
    "event_type": "notifications/apex.order.filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.123Z",
    "sequence": 42,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08755",
      "fill_quantity": "100000",
      "commission": "-0.5",
      "position_id": "pos_001"
    }
  }
}
```

This notification says exactly what happened: order `ord_abc123` filled at 1.08755 for 100,000 units, the commission was -0.5, and the resulting position is `pos_001`. The agent does not need to re-read the fills resource to learn these facts — the notification carries them. It should still re-read to confirm, but the notification itself is the authoritative execution record.

### Why Both Are Needed

A fill changes multiple resources simultaneously. When a buy order fills:

1. The orders resource changes (order status moves to `filled`)
2. The fills resource changes (new fill record)
3. The positions resource changes (new or modified position)
4. The risk resource changes (margin utilization, daily P&L)
5. The account summary changes (balance, equity)

The broker emits `notifications/resources/updated` for each affected resource. The agent re-reads each one. But none of these resource reads tell the agent "you got filled at 1.08755." The positions resource says "you have 100,000 EURUSD." The fills resource has the fill record, but the agent does not know which fill is new without comparing against its cached state. The `notifications/apex.order.filled` notification closes this gap — it is the event that says "this happened, right now, at this price."

Without resource invalidation, the agent would not know to re-read affected resources. Without execution events, the agent would not know the specific facts of what happened. The two families are complementary: resource invalidation maintains state, execution events record history.

---

## The Notification Envelope

Every APEX-specific notification follows a standard envelope structure defined in [`schemas/notification-envelope.schema.json`](../spec/core/schemas/notification-envelope.schema.json). The envelope is the `params` object within the JSON-RPC notification.

### Envelope Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `event_id` | string | Yes | Stable unique identifier for this event within the session |
| `event_type` | string | Yes | The APEX notification type, e.g. `notifications/apex.order.filled` |
| `account_id` | string | Conditional | Account associated with this event; null for market events and session events |
| `instrument_id` | string | Conditional | Instrument associated with this event; null for account-wide and session events |
| `resource_uri` | string | Conditional | The canonical resource that should be refreshed; null when no single resource applies |
| `timestamp` | ISO 8601 | Yes | When the event occurred (broker event time or broker processing time; servers must document which) |
| `sequence` | integer | Yes | Monotonic sequence for the referenced resource stream; null for session-level events |
| `payload` | object | Yes | Event-type-specific data |

### Why Each Field Exists

**`event_id`** enables deduplication. If a replay delivers event `evt_a1b2c3d4` and the agent already processed it before the disconnect, it can skip it. The ID must be unique within the session — not globally, not across sessions, just within the event log that a single `Mcp-Session-Id` scopes.

**`event_type`** mirrors the JSON-RPC `method` field. This seems redundant until you consider transports that strip the JSON-RPC wrapper. An agent consuming `params` as a standalone payload — extracted from a message queue, stored in a database, forwarded to a downstream service — still needs the event type for routing. Agents processing the full JSON-RPC envelope can use `method` instead. Both fields always agree.

**`account_id`** and **`instrument_id`** scope the event. A fill applies to an account and an instrument. A kill switch applies to an account but not a specific instrument. A replay failure applies to neither — it is a session-level event. The nullability of these fields communicates scope without requiring the agent to parse the event type.

**`resource_uri`** links the notification to the resource the agent should refresh. A fill notification points to `apex://account/fills/ACC_12345`. A rejection points to `apex://account/orders/ACC_12345`. A kill switch event points to `apex://account/risk/ACC_12345`. This is the bridge between the execution event family and the resource invalidation family — the notification carries the facts, and then tells the agent where to re-read for the updated state.

**`timestamp`** anchors the event in time. Whether it reflects broker event time or broker processing time is an implementation choice the server must document (per [production.md](../spec/core/production.md) Section 2.5). The agent uses timestamps for audit, not for ordering — ordering comes from `sequence` and SSE event IDs.

**`sequence`** ties the notification to the resource stream it affects. When a fill notification carries `sequence: 42` and references `apex://account/fills/ACC_12345`, the agent knows the fills resource is at least at sequence 42. If the agent's cached fills resource is at sequence 40, it knows two updates happened. If `sequence` is null (as for `replay_failed` and `gap_fill`), the notification is session-level and does not reference any specific resource stream.

**`payload`** carries the event-specific data. Its shape varies by `event_type`. The seven mandatory notification types have normative payload schemas defined in the spec.

---

## The Seven Mandatory Notifications

Production Realtime implementations must emit these seven notification types. They cover the minimum set of events an agent needs to trade autonomously through network disruptions: execution facts (fills, rejections), system events (kill switch, candle close), and replay meta-events (replay failed, gap fill).

### Summary Table

| Notification | Category | Trigger | `account_id` | `instrument_id` | `resource_uri` |
|---|---|---|---|---|---|
| `apex.order.filled` | Execution | Order fills completely | Yes | Yes | `apex://account/fills/{account_id}` |
| `apex.order.partially_filled` | Execution | Order partially fills | Yes | Yes | `apex://account/fills/{account_id}` |
| `apex.order.rejected` | Execution | Order is rejected | Yes | Yes | `apex://account/orders/{account_id}` |
| `apex.market.candle_closed` | Market | Candle bar completes on wall-clock boundary | null | Yes | `apex://market/candles/{instrument_id}?timeframe=...` |
| `apex.risk.kill_switch_engaged` | Risk | Kill switch activates | Yes | null | `apex://account/risk/{account_id}` |
| `apex.session.replay_failed` | Session | Reconnect replay cannot be satisfied | null | null | null |
| `apex.session.gap_fill` | Session | Consecutive ephemeral events elided during replay | null | null | null |

### `notifications/apex.order.filled`

A complete fill. The order's entire quantity has been executed. This is a terminal state — the order will not generate further fill events.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.order.filled",
  "params": {
    "event_id": "evt_a1b2c3d4",
    "event_type": "notifications/apex.order.filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.123Z",
    "sequence": 42,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08755",
      "fill_quantity": "100000",
      "commission": "-0.5",
      "position_id": "pos_001"
    }
  }
}
```

The `fill_price` is the execution price — what the agent actually got, not what it asked for. For a market order, this is the liquidity provider's price at execution time. For a limit order, this is at or better than the limit price. The `position_id` links the fill to the resulting position, enabling the agent to correlate fills with position state.

This is the FIX ExecutionReport with `ExecType=Fill` (`150=F`). In FIX, the execution report is the single most important message in the protocol — it is the definitive record that a trade happened. `apex.order.filled` serves the same purpose.

### `notifications/apex.order.partially_filled`

A partial fill. Some quantity was executed, but the order remains working for the remainder.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.order.partially_filled",
  "params": {
    "event_id": "evt_b2c3d4e5",
    "event_type": "notifications/apex.order.partially_filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.456Z",
    "sequence": 43,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08760",
      "fill_quantity": "50000",
      "remaining_quantity": "50000"
    }
  }
}
```

The `remaining_quantity` tells the agent how much is still working. A large order might partially fill multiple times at different prices — each partial fill is a separate notification with its own `fill_price` and `fill_quantity`. The sequence of partial fills matters: the first fill at 1.08760 and the second fill at 1.08770 are two distinct facts. The agent cannot reconstruct this sequence from the current positions resource, which only shows the aggregate.

### `notifications/apex.order.rejected`

The broker refused the order. It will not be executed.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.order.rejected",
  "params": {
    "event_id": "evt_c3d4e5f6",
    "event_type": "notifications/apex.order.rejected",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/orders/ACC_12345",
    "timestamp": "2026-03-27T14:30:01.000Z",
    "sequence": 44,
    "payload": {
      "order_id": "ord_def456",
      "code": "STALE_QUOTE",
      "reason": "Quote data is stale; order rejected"
    }
  }
}
```

The `code` is machine-routable: `STALE_QUOTE`, `KILL_SWITCH_ACTIVE`, `RISK_LIMIT_EXCEEDED`, `INSTRUMENT_NOT_TRADEABLE`, `RATE_LIMITED`, `INSUFFICIENT_MARGIN`. The `reason` is human-readable context. The agent uses `code` for programmatic response (retry on transient failures, halt on hard stops) and `reason` for logging and audit.

Rejections are execution-critical because the agent needs to know its intent was not fulfilled. If the agent placed a hedging order and that order was rejected, the agent has an unhedged position. Without the rejection notification, the agent might assume the hedge is in place and make further decisions based on a false premise.

### `notifications/apex.market.candle_closed`

A candle bar completed on a wall-clock boundary. The bar is now immutable — it will not change.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.market.candle_closed",
  "params": {
    "event_id": "evt_d4e5f6g7",
    "event_type": "notifications/apex.market.candle_closed",
    "account_id": null,
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
    "timestamp": "2026-03-27T14:31:00.000Z",
    "sequence": 45,
    "payload": {
      "instrument_id": "APEX:FX:EURUSD",
      "timeframe": "M1",
      "open": "1.08750",
      "high": "1.08780",
      "low": "1.08740",
      "close": "1.08765",
      "volume": 1500000,
      "complete": true
    }
  }
}
```

The `complete: true` flag is definitive — this bar will not be revised. The agent can update its candle cache, recompute any indicators that depend on the latest closed bar, and decide whether the candle close is a decision trigger (see Section 8: Decision Triggers). The `account_id` is null because candle closes are market events, not account events.

Candle closes are a recommended decision trigger class (see the spec Section 6.15). Many trading strategies are candle-driven: "on M1 close, evaluate entry conditions." The notification gives the agent the completed bar's OHLCV directly, before the agent re-reads the candle resource.

### `notifications/apex.risk.kill_switch_engaged`

The kill switch activated. All autonomous trading must stop immediately.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.risk.kill_switch_engaged",
  "params": {
    "event_id": "evt_e5f6g7h8",
    "event_type": "notifications/apex.risk.kill_switch_engaged",
    "account_id": "ACC_12345",
    "instrument_id": null,
    "resource_uri": "apex://account/risk/ACC_12345",
    "timestamp": "2026-03-27T14:32:00.000Z",
    "sequence": 46,
    "payload": {
      "account_id": "ACC_12345",
      "reason": "Daily loss limit exceeded"
    }
  }
}
```

The `instrument_id` is null because the kill switch is account-wide — it halts trading across all instruments. The `reason` tells the agent why: daily loss limit, manual operator action, margin call, or a broker-specific condition. The agent must halt immediately, not after it finishes the current decision cycle.

This is the financial equivalent of a circuit breaker tripping. In physical trading infrastructure, a kill switch is a hardware button that disables all electronic order flow. In APEX, it is a software control that the broker can trigger and the agent must respect.

### `notifications/apex.session.replay_failed`

The server cannot replay from the agent's requested cursor.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.replay_failed",
  "params": {
    "event_id": "evt_f6g7h8i9",
    "event_type": "notifications/apex.session.replay_failed",
    "account_id": null,
    "instrument_id": null,
    "resource_uri": null,
    "timestamp": "2026-03-27T14:33:00.000Z",
    "sequence": null,
    "payload": {
      "reason": "event_id_outside_event_log",
      "last_available_id": 502
    }
  }
}
```

All scoping fields are null — this is a session-level event, not tied to any account, instrument, or resource. The `sequence` is null because replay failure is not part of any resource stream. The `last_available_id` tells the agent the oldest event the server still has, which is useful for diagnostics but does not help with recovery.

The agent must treat this as a full discontinuity: discard all cached state, re-read every resource from scratch, reconcile by comparing pre-disconnect state against current state, and re-establish execution baselines before resuming. With acknowledgment-driven retention, this only occurs when the server's maximum retention limit is exceeded with unacknowledged events — see [replay-design.md](./replay-design.md) for the full mechanics.

### `notifications/apex.session.gap_fill`

Consecutive ephemeral notifications were collapsed during replay.

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.gap_fill",
  "params": {
    "elided_count": 47,
    "from_id": "473",
    "to_id": "519"
  }
}
```

Gap fill notifications use a simplified structure — they are not wrapped in the full event envelope because they are meta-notifications about the replay mechanism itself, not about trading events. The `from_id` and `to_id` define the range of elided SSE event IDs. The `elided_count` tells the agent how many events were collapsed. The gap fill marker's SSE event ID equals its `to_id` field, preserving monotonic ordering in the stream.

Gap fills are the APEX equivalent of FIX SequenceReset-GapFill: "these messages existed, they were administrative/ephemeral, and you don't need them — here's a placeholder so the sequence numbers still add up." The agent's only obligation is to acknowledge that the range was elided and continue processing subsequent events.

---

## Replay Classification

Every notification type carries an implicit replay classification that determines how the server handles it during reconnect replay. This classification is the same policy described in [replay-design.md](./replay-design.md), applied here as a notification-level property.

### The Core Question

Can the agent reconstruct this information from current resource state?

If yes, the notification is `elide` — the current resource supersedes whatever the notification carried. There is no point replaying a quote update from 30 seconds ago when the agent is about to re-read the current quote.

If no, the notification is `required` — the information is a historical fact that only existed in this notification. A fill at a specific price, a rejection with a specific reason, a kill switch activation at a specific time. These facts are gone if the notification is not replayed.

### Normative Classification Table

| Classification | Notification Types | Replay Behavior |
|---|---|---|
| `required` | `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`, `apex.risk.kill_switch_engaged` | Replayed with original event IDs on reconnect |
| `elide` | `notifications/resources/updated`, `apex.market.candle_closed` | Collapsed into `apex.session.gap_fill` markers |
| Always sent | `apex.session.replay_failed`, `apex.session.gap_fill` | Meta-notifications about the replay mechanism itself |

### Why Candle Closes Are Elided

This might seem counterintuitive. A candle close carries OHLCV data — isn't that a historical fact? It is, but it is a reconstructable one. The completed candle is permanently available in the candle resource. When the agent re-reads `apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200` after reconnect, the closed bar is there. Replaying the close notification would be redundant — the agent would process the OHLCV data from the notification and then read the same data from the resource.

Fills are different. The fills resource contains all recent fills, but the agent does not know which fills are new without comparing against its pre-disconnect state. The fill notification eliminates this ambiguity — it is the definitive signal that "this fill happened during the gap."

### Replay Walk-Through

The agent disconnects at event 472. During the gap, 47 events occur: 40 quote updates, one candle close, one fill, and five resource updates triggered by the fill. On reconnect:

```
gap_fill:          { elided_count: 41, from_id: "473", to_id: "513" }
apex.order.filled: { order_id: "ord_abc123", fill_price: 1.0847, ... }   <- original ID 514
gap_fill:          { elided_count: 5,  from_id: "515", to_id: "519" }
```

Three events instead of 47. The agent gets the fill — the one thing it cannot reconstruct — and knows that everything else was ephemeral state that the resource re-reads will provide fresh.

---

## Recommended Notifications

Beyond the seven mandatory types, the spec recommends additional notifications for richer agent workflows. These are not required for Production Realtime compliance, but they enable more nuanced agent behavior.

| Notification | Trigger | Use Case |
|---|---|---|
| `apex.market.quote_moved` | Significant quote change (broker-defined threshold) | Alert-driven strategies that act on price moves, not on every tick |
| `apex.market.regime_changed` | Regime classification shifts (e.g., trending to mean-reverting) | Strategy rotation — the agent switches models based on market conditions |
| `apex.market.volatility_spike` | Realized or implied volatility exceeds a threshold | Risk-off triggers, position sizing adjustments, spread monitoring |
| `apex.order.accepted` | Order acknowledged by the venue | Confirmation that the order entered the book; useful for latency tracking |
| `apex.order.cancelled` | Order cancelled (by agent, by broker, by exchange) | Cleanup — the agent can remove the order from its working set |
| `apex.risk.limit_warning` | A risk metric approaches a hard limit | Pre-emptive action — the agent can reduce exposure before the kill switch fires |

Recommended notifications follow the same envelope structure as mandatory notifications. They participate in the same SSE event ID stream and event log. Their replay classification is implementation-specific — a broker might classify `apex.order.cancelled` as `required` (the agent needs to know an order was cancelled during the gap) or `elide` (the current orders resource shows no such order). The spec does not mandate a classification for recommended notifications.

---

## Cross-Resource Ordering

APEX does not guarantee cross-resource ordering. This is the most important caveat in the notification architecture.

### The Problem

When an order fills, the broker updates multiple resources and emits multiple notifications. The fill notification, the orders resource update, the positions resource update, the fills resource update, the risk resource update — these all refer to the same underlying event. But they arrive as separate SSE events with separate IDs. The SSE stream is ordered — event 480 always arrives before event 481 — but the order in which the broker emits them is implementation-specific.

One broker might emit:

```
480: notifications/apex.order.filled
481: notifications/resources/updated (orders)
482: notifications/resources/updated (positions)
483: notifications/resources/updated (fills)
484: notifications/resources/updated (risk)
```

Another might emit:

```
480: notifications/resources/updated (orders)
481: notifications/resources/updated (fills)
482: notifications/apex.order.filled
483: notifications/resources/updated (positions)
484: notifications/resources/updated (risk)
```

Both are valid. The spec says: "Notification delivery order within a session's SSE stream is deterministic, but no causal ordering is guaranteed across notifications referencing different resource streams."

### The Scenario

The agent receives `notifications/apex.order.filled` and immediately reads the positions resource. The positions resource has not been updated yet — the fill event arrived before the positions resource update notification. The agent reads the positions resource and sees no position. A naive agent might conclude the fill did not produce a position. A correct agent knows that the positions resource may lag the fill notification by one or more event cycles.

### Correct Agent Behavior

1. **Process the fill notification.** Record the fill facts: order ID, fill price, fill quantity, position ID.
2. **Wait for the resource updates.** The positions, orders, fills, and risk resource update notifications will arrive shortly.
3. **Re-read affected resources.** On each resource update notification, re-read the resource and check that the sequence advanced.
4. **Reconcile.** If the positions resource now shows a position matching the fill's `position_id`, the agent's state is consistent. If not, wait for the next update cycle.
5. **Use resource timestamps and sequences for temporal reasoning, not notification arrival order.** The positions resource at sequence 47 with timestamp `14:30:00.200Z` is the authoritative state, regardless of when the notification arrived relative to the fill event.

This is the same problem that exists in every event-driven system with multiple state projections. A Kafka consumer reading from two topic partitions cannot assume that offset 100 on partition A happened before offset 100 on partition B. A microservice receiving events from two queues cannot assume causal ordering across queues. APEX is explicit about this: each resource stream is ordered within itself, but no ordering is guaranteed across streams.

---

## Decision Triggers

Notifications are not just state maintenance signals — they are decision triggers. The spec (Section 6.15) recommends that production agent-native runtimes trigger decision evaluation on a bounded set of semantically meaningful events rather than on every feed update.

### The Decision Flow

```
notification → classify → act
```

**Classify:** What kind of notification is this?

- **Resource invalidation** (`notifications/resources/updated`) — Update the cache. Check freshness and sequence. If the resource is a decision trigger (e.g., features updated), potentially invoke the model.
- **Execution event** (`apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`) — Record the execution fact. Reconcile state. Potentially invoke the model to decide what to do next (scale in, hedge, exit).
- **System event** (`apex.risk.kill_switch_engaged`) — Halt immediately. No model consultation needed. This is a deterministic control.
- **Market event** (`apex.market.candle_closed`) — Update candle cache. If candle close is a strategy trigger, invoke the model for decision evaluation.
- **Meta-event** (`apex.session.replay_failed`, `apex.session.gap_fill`) — Trigger recovery flows. For replay failure, discard all state and rebuild from scratch. For gap fill, acknowledge the elided range and continue.

### Recommended Trigger Classes

The spec recommends these trigger classes for production runtimes:

| Trigger | Notification | Agent Response |
|---|---|---|
| Candle close | `apex.market.candle_closed` | Re-evaluate strategy, check entry/exit conditions |
| Fill or partial fill | `apex.order.filled`, `apex.order.partially_filled` | Update position tracking, evaluate scaling/hedging |
| Order rejection | `apex.order.rejected` | Evaluate retry, check risk state, potentially halt |
| Kill switch | `apex.risk.kill_switch_engaged` | Halt all autonomous execution immediately |
| Regime change | `apex.market.regime_changed` (recommended) | Re-evaluate strategy suitability for current conditions |
| Volatility spike | `apex.market.volatility_spike` (recommended) | Reduce position size, widen stops, pause entries |
| Scheduled interval | Runtime timer | Periodic state review independent of market events |

The critical distinction: resource update notifications trigger re-reads and cache updates, but they do not necessarily trigger model consultation. A quote update is important for freshness — the runtime must keep the cache current — but consulting the model on every tick is the tool-polling problem described in [resource-tool-design.md](./resource-tool-design.md). The model should be invoked on meaningful events: candle closes, fills, rejections, regime shifts, and scheduled intervals. The runtime decides what is meaningful. The model decides what to do about it.

---

## Notification Delivery Guarantees

### What APEX Guarantees

**Ordered within the SSE stream.** SSE event IDs are monotonic integers. Event 481 always arrives after event 480. Within a single connection, delivery order is deterministic.

**Replayable on reconnect for `required` events.** Fills, rejections, and kill switch events are replayed with their original event IDs when the agent reconnects with `Last-Event-ID`. This guarantee holds as long as the events are within the server's retention window (bounded by acknowledgment and max retention).

**Unique event IDs within the session.** Every event in the SSE stream has a unique monotonic ID. Every APEX-specific notification has a unique `event_id` in its envelope. The agent can use either for deduplication.

### What APEX Does Not Guarantee

**At-most-once per connection.** During a single SSE connection, each event is sent once. If the connection drops mid-event, the event may be lost on that connection. On reconnect, replay will re-deliver `required` events. `elide` events that were lost are gone — the agent re-reads the resources instead.

**Coalesced resource updates.** The server may merge multiple resource changes into a single `notifications/resources/updated`. If a quote changed 50 times in one second, the agent might receive 5 notifications. The agent does not know it missed 45 intermediate states — and it does not need to, because the current resource state supersedes all intermediates. The `sequence` field on the resource reveals that intermediate updates were coalesced.

**No guaranteed delivery for `elide` events.** Resource updates and candle closes are fire-and-forget. If lost (connection drop, server coalescing, replay elision), the agent recovers by re-reading the resource. This is by design — these notifications are triggers for re-reads, not authoritative data.

### The Re-Read Imperative

Notifications are triggers, not sources of truth. The authoritative state lives in the resources.

Even for execution events with full payloads, the agent should re-read the referenced resource to confirm. The fill notification says "fill at 1.08755." The fills resource shows the same fill. The positions resource shows the resulting position. When all three agree, the agent's state is consistent. If the notification and the resource disagree, the resource wins.

This is the same pattern used in webhook systems: the webhook tells you "something happened," and you call back to the API to get the authoritative state. GitHub webhooks carry a payload, but any serious consumer verifies by calling the GitHub API. Stripe webhooks recommend re-fetching the object. APEX follows the same principle: the notification is a signal, the resource is the truth.

---

## Parallels

The APEX notification architecture combines patterns from several established systems. None of these parallels are cosmetic — each reflects a design decision with a specific rationale.

| Established System | APEX Parallel | What They Share |
|---|---|---|
| **FIX ExecutionReport** | `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected` | The execution report is FIX's most important message — it records that a trade happened. APEX's execution notifications serve the same purpose: definitive records of fills and rejections that must be replayed on reconnect and cannot be reconstructed from current state. |
| **Kafka topic partitions** | Per-resource sequence streams | Kafka guarantees ordering within a partition but not across partitions. APEX guarantees ordering within a resource stream but not across resource streams. Both require the consumer to reconcile cross-stream state explicitly. |
| **Database triggers** | Notification-driven state propagation | A database trigger fires after a row changes, invoking downstream logic. APEX notifications fire after resource state changes, invoking agent re-reads and decision evaluation. Both are event-driven propagation of state changes to interested consumers. |
| **Webhook systems** | Notification-then-re-fetch pattern | GitHub, Stripe, and Shopify webhooks carry payloads but recommend re-fetching the object from the API. APEX notifications carry payloads (for execution events) and URIs (for resource invalidation) but recommend re-reading the resource. The notification is the trigger; the API is the truth. |
| **Redis Pub/Sub** | Fire-and-forget with reconnect recovery | Redis Pub/Sub delivers messages to connected subscribers. If a subscriber is disconnected, messages are lost. APEX resource update notifications behave the same way — lost during a gap, recovered by re-reading resources on reconnect. Execution notifications have stronger guarantees (replay), like Redis Streams vs Redis Pub/Sub. |
| **DOM events** | Classification and delegation | Browser DOM events are classified (bubbling vs capturing) and delegated to handlers based on type. APEX notifications are classified (required vs elide) and routed to handlers based on family (resource invalidation vs execution event vs meta-event). The classification determines both delivery semantics and replay behavior. |

---

## Cross-References

- [replay-design.md](./replay-design.md) — Replay classification, gap fill mechanics, acknowledgment-driven retention, the FIX parallel
- [transport-design.md](./transport-design.md) — SSE stream mechanics, reconnect flow, the three HTTP verbs, session identity
- [resource-tool-design.md](./resource-tool-design.md) — The three interaction primitives (tools, resources, notifications), subscription semantics, the prompt cost argument
- [sequence-design.md](./sequence-design.md) — Per-resource sequence counters, gap detection, coalescing vs gaps, sequence vs SSE event IDs
- [freshness-design.md](./freshness-design.md) — Staleness equation, the execution-critical set, the halt decision, `stale_after_ms` semantics
