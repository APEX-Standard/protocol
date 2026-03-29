# APEX Protocol — Production Capability Profiles

**Version:** `0.1.0-alpha`  
**Status:** Draft — production-targeting guidance  
**Last Updated:** 2026-03-27

---

## Purpose

The core specification defines the protocol surface. This document defines the production capability profiles that an implementation must satisfy to claim serious realtime or autonomous trading support.

These profiles are intentionally narrower than the full protocol. Their job is to answer a practical question:

> "What exact subset must a broker and runtime implement for production trading to be viable?"

---

## Profiles

APEX defines two production capability profiles:

- `APEX Production Realtime`
- `APEX Production Autonomous`

An implementation may satisfy `Production Realtime` without satisfying `Production Autonomous`. `Production Autonomous` implies `Production Realtime`.

---

## 1. APEX Production Realtime

An implementation claiming `APEX Production Realtime` must satisfy all of the following.

### 1.1 Transport

- Support remote MCP over HTTP.
- Support server-to-client SSE delivery for realtime notifications.
- The recommended transport for alpha is **MCP Streamable HTTP** on a single `/mcp` endpoint (POST for JSON-RPC requests, GET for the SSE notification stream, DELETE for session teardown). Session identity is carried via the `Mcp-Session-Id` response/request header.
- As an alternative for alpha interoperability, implementations may use the older MCP HTTP+SSE compatibility transport if Streamable HTTP is not yet available.
- Document replay behavior across reconnects.
- Expose enough metadata for clients to detect stale state and sequence discontinuity.

### 1.1.1 Replay, Acknowledgment, and Gap Fill

Production Realtime implementations must maintain a per-session event log used with SSE event IDs and the `Last-Event-ID` header for reconnect replay.

- Every event pushed to the SSE stream must carry a monotonic integer `id` (transmitted as a string per the SSE spec).
- On reconnect, the client sends `Last-Event-ID` with the last received event ID; the server replays events from the log using the classification and gap fill rules below.
- If the requested `Last-Event-ID` is outside the log (evicted or unknown), the server sends `notifications/apex.session.replay_failed` as the first event on the new stream and continues with live events only.
- Event log scope is per session. Each `Mcp-Session-Id` has its own log. The log is discarded on session teardown (DELETE) or server shutdown.

#### Replay Classification

Each notification type is classified for replay:

| Classification | Notification Types | Replay Behavior |
|---|---|---|
| `required` | `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`, `apex.risk.kill_switch_engaged` | Replayed with original event IDs |
| `elide` | `notifications/resources/updated`, `apex.market.candle_closed` | Collapsed into `gap_fill` markers |

During replay, the server:

1. Walks the event log from the cursor.
2. Sends all `required` events with their original IDs.
3. Collapses consecutive `elide` events into a single `notifications/apex.session.gap_fill` notification: `{ "elided_count": N, "from_id": "first_skipped", "to_id": "last_skipped" }`.
4. After replay completes, transitions to live streaming (all events, no classification).

The agent must re-read all resources after reconnect regardless of whether gap fill markers are present. The replay delivers execution history (fills, rejections, kill switch events) that cannot be reconstructed from current resource state.

#### Acknowledgment

The agent controls event retention by calling `apex.session.acknowledge` with the last processed event ID. The server discards all events at or before the acknowledged ID.

- Agents must call `apex.session.acknowledge` periodically (recommended: every 30 seconds or after each decision cycle) to allow the server to reclaim storage.
- If the agent never acknowledges, the server retains all events subject to its maximum retention limit.

#### Maximum Retention

Servers enforce a maximum retention limit to bound storage growth when the agent has not acknowledged. The limit is expressed as a maximum event count, a maximum time window, or both. When the limit is exceeded, the server evicts the oldest unacknowledged events.

- The maximum retention limit must be documented in the `realtime_contract` section of `apex.session.capabilities` via `max_retention_events` and `max_retention_seconds`.
- Reference implementations use an in-memory event log with a default maximum of 10000 events.

#### Storage

The event log storage mechanism is an implementation choice. In-memory buffers, file-based sequential logs (as in FIX), durable queues, or any storage that preserves event ordering and supports cursor-based replay. File-based or durable storage enables replay to survive server restarts.

### 1.2 Mandatory Tools

- `apex.session.authenticate`
- `apex.session.capabilities`
- `apex.account.summary`
- `apex.account.positions`
- `apex.account.orders`
- `apex.order.place`
- `apex.order.modify`
- `apex.order.cancel`
- `apex.order.status`
- `apex.position.close`
- `apex.market.quote`
- `apex.market.snapshot`
- `apex.market.details`
- `apex.risk.check`
- `apex.risk.limits`
- `apex.session.heartbeat`
- `apex.session.acknowledge`
- `apex.account.history`
- `apex.market.search`

### 1.3 Mandatory Realtime Resources

- `apex://market/quote/{instrument_id}`
- `apex://market/candles/{instrument_id}?timeframe=M1&limit=200`
- `apex://market/candles/{instrument_id}?timeframe=M5&limit=200`
- `apex://market/candles/{instrument_id}?timeframe=H1&limit=200`
- `apex://market/features/{instrument_id}`
- `apex://account/summary/{account_id}`
- `apex://account/positions/{account_id}`
- `apex://account/orders/{account_id}`
- `apex://account/fills/{account_id}`
- `apex://account/risk/{account_id}`

### 1.4 Mandatory Resource Properties

Every execution-relevant realtime resource must include:

- freshness timestamp: `timestamp` or `as_of`
- monotonically increasing `sequence`
- freshness limit: `stale_after_ms` or a documented equivalent

### 1.5 Mandatory Notifications

- `notifications/resources/updated`
- `notifications/apex.order.filled`
- `notifications/apex.order.partially_filled`
- `notifications/apex.order.rejected`
- `notifications/apex.market.candle_closed`
- `notifications/apex.risk.kill_switch_engaged`
- `notifications/apex.session.gap_fill`
- `notifications/apex.session.replay_failed`

Notification payloads should include:

- stable event identifier: `event_id`
- event timestamp: `timestamp`
- current resource or account `sequence` where applicable
- enough identifiers to correlate the event back to the affected order, fill, account, or resource

### 1.6 Mandatory Sequencing Behavior

- Sequences must be monotonic within each realtime resource stream.
- Notifications referring to a realtime resource must carry the current `sequence`.
- Clients must be able to detect gaps deterministically.
- The server must document its reconnect mode: `no_replay`, `session_replay`, `best_effort_replay`, or `guaranteed_replay`. See [`operations.md`](./operations.md) Section 4 for definitions.
- If replay is supported (any mode other than `no_replay`), notification events must have stable replay ordering within a session.

### 1.7 Mandatory Feature Minimums

The feature resource must expose:

- quote state: `bid`, `ask`, `mid`, `spread`
- short-horizon returns with at least three windows including `1m`
- realized volatility with at least `1m` and `5m`
- regime label and confidence
- liquidity score
- expected slippage estimate

---

## 2. APEX Production Autonomous

An implementation claiming `APEX Production Autonomous` must satisfy all `Production Realtime` requirements plus the following.

### 2.1 Mandatory Decision Context

- Expose `apex://agent/decision-context/{instrument_id}`.
- Decision context must reference quote, feature, candle, account summary, positions, orders, and risk resources.
- Decision context must be stable enough for direct use by agent runtimes without broker-specific prompt shaping.

### 2.2 Mandatory Autonomous Controls

The broker and runtime must expose and enforce:

- kill switch state
- maximum position size
- maximum open orders
- daily loss status
- restricted instruments
- market-hours gating
- stale-data rejection
- sequence-gap rejection
- rate-limit rejection

### 2.3 Mandatory Runtime Refusals

Autonomous order entry must be rejected when:

- quote state is stale
- account/risk state is stale
- sequence continuity is broken for any execution-critical resource
- kill switch is active
- instrument is restricted or non-tradeable
- hard broker risk limits are exceeded

### 2.4 Mandatory Execution Event Semantics

Order lifecycle and fill events must have stable payloads matching the normative schemas in [`schemas/`](./schemas/).

At minimum:

- every fill event must identify the originating order
- every fill event must include fill quantity and fill price
- partial fill and final fill must be distinguishable
- duplicate event handling must be possible using stable IDs plus sequence

### 2.5 Mandatory Operational Documentation

The implementation must document:

- replay retention window
- replay scope: per session, per account, or global
- freshness limits by resource type
- whether timestamps reflect event time or processing time
- supported autonomous controls
- any broker-specific hard stops not represented in the baseline spec

---

## 3. Compliance Language

An implementation must not claim `APEX Production Realtime` or `APEX Production Autonomous` unless it satisfies the corresponding requirements in this document.

Recommended capability advertisement format in `apex.session.capabilities`:

```json
{
  "production_profiles": {
    "realtime": true,
    "autonomous": false
  }
}
```

If an implementation exposes `autonomous: true`, it should also advertise any material limitations such as:

- reduced replay retention
- approval-required mode
- restricted asset classes
- delayed market data

---

## 4. Relationship To Conformance

The executable alpha conformance harness currently validates the tool baseline only.

To reach production-grade interoperability, a future conformance harness should validate:

- resource availability
- subscription/update behavior
- freshness metadata
- sequence gap handling
- fill/order notification schema compliance
- stale-state rejection for autonomous execution

See [../../conformance/production-checklist.md](../../conformance/production-checklist.md) for the current production test matrix.

Supporting alpha hardening documents:

- [`stability.md`](./stability.md)
- [`execution-semantics.md`](./execution-semantics.md)
- [`operations.md`](./operations.md)
