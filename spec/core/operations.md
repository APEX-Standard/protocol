# APEX Protocol — Operational Semantics

**Version:** `0.1.0-alpha`  
**Status:** Draft  
**Last Updated:** 2026-03-27

---

## Purpose

Trading viability depends on operational behavior, not only payload shape. This document defines the runtime rules that agent implementations and brokers should align on during alpha.

It covers:

- freshness and staleness
- sequencing and gap handling
- replay and reconnect behavior
- session health
- autonomous runtime halting rules

---

## 1. Freshness Classes

Execution-critical APEX resources fall into three freshness classes.

### 1.1 Market Fast

Examples:

- quote
- order book
- trade flow
- short-horizon features

Requirements:

- must include `timestamp` or `as_of`
- must include `stale_after_ms`
- should update frequently enough to reflect current execution conditions

### 1.2 Market Slow

Examples:

- completed candles
- slower derived features
- instrument metadata caches

Requirements:

- must include `as_of`
- must include `stale_after_ms` if relied upon for autonomous decisions

### 1.3 Account / Risk

Examples:

- account summary
- positions
- orders
- risk state

Requirements:

- must include `as_of`
- must include `stale_after_ms`
- should be treated as execution-critical when autonomous order entry is enabled

---

## 2. Staleness Rules

A resource is stale when:

- current_time > resource_timestamp + stale_after_ms

Autonomous runtimes should halt new order submission when any execution-critical resource is stale.

Minimum execution-critical set:

- quote
- features
- account summary
- positions
- orders
- risk

---

## 3. Sequencing Rules

For execution-critical realtime resources:

- `sequence` must be monotonic within the resource stream
- clients must retain the last observed `sequence`
- if a newly read resource has a lower `sequence` than the last accepted value, the client should treat it as invalid or replayed out of order unless replay mode is explicitly active

### 3.1 Gap Detection

A gap exists when:

- the client expects a contiguous progression and the observed `sequence` skips ahead unexpectedly
- the server documents a stricter gap definition and the client can detect it deterministically

For alpha, exact sequence arithmetic may remain implementation-specific, but clients must still be able to detect discontinuity.

---

## 4. Reconnect And Replay

Implementations should document one of the following reconnect modes:

- `no_replay`
- `session_replay`
- `best_effort_replay`
- `guaranteed_replay`

For alpha HTTP/SSE interoperability, replay applies to server-initiated notifications first. Resource state remains the canonical rebuild path even when notification replay is available.

### 4.1 No Replay

After reconnect:

- the client must discard prior freshness assumptions
- the client must re-read all execution-critical resources
- autonomous execution should remain paused until the new baseline is established

### 4.2 Session Replay

Session-scoped replay using SSE event IDs as cursors with acknowledgment-driven retention and gap fill.

- Server assigns a monotonic integer `id` to every SSE event within a session.
- Client reconnects with `Last-Event-ID` header containing the last received event ID.
- Server replays execution-critical events (`required` classification) after that ID, collapsing ephemeral events (`elide` classification) into `gap_fill` markers. Then continues streaming.
- If `Last-Event-ID` is outside the event log (evicted or unknown), server sends `notifications/apex.session.replay_failed` and streams new events only.
- Client must treat replay failure as a sequence discontinuity: discard cached state, re-read all resources, re-establish baseline.
- Client must re-read all resources after any reconnect, regardless of replay success. The replay provides execution history, not current state.

#### Replay Classification

Notifications classified `required` carry unique execution data that the agent cannot reconstruct from current resource state (fills, rejections, kill switch events). Notifications classified `elide` are ephemeral — their information is superseded by the current resource state that the agent re-reads on reconnect.

#### Acknowledgment-Driven Retention

The agent advances the server's retention cursor by calling `apex.session.acknowledge` with the last fully processed event ID. The server discards events at or before the acknowledged ID.

- Agents must acknowledge periodically to allow the server to reclaim storage.
- Servers enforce a maximum retention limit (event count, time window, or both) as a safety cap. When the limit is exceeded, the oldest unacknowledged events are evicted.
- The maximum retention limit is documented in `apex.session.capabilities` under `realtime_contract`.

This model is inspired by the FIX protocol's message store, sequence reset, and gap fill mechanisms. The agent controls the retention lifecycle. Replay delivers only execution-critical events. Ephemeral state is rebuilt from current resources.

### 4.3 Replay Modes (Best-Effort And Guaranteed)

If replay beyond session scope is supported, implementations should document:

- retention window
- replay ordering guarantees
- whether replay includes only notifications or also resource versions
- how the client supplies the replay cursor

`best_effort_replay` may lose events under load or across restarts. `guaranteed_replay` requires durable event persistence and must not lose events within the documented retention window.

### 4.4 HTTP/SSE Replay Cursor

For HTTP/SSE transports, the recommended replay cursor is the SSE `Last-Event-ID` header.

Implementations that support replay should:

- attach `id:` to SSE events
- treat the SSE event ID as an opaque monotonic cursor within a session
- replay missed server notifications after reconnect when `Last-Event-ID` is supplied and still retained
- fail deterministically when the cursor is outside the retention window

### 4.5 Replay Failure

If replay cannot be satisfied:

- the server should respond with a deterministic error or explicit reset signal — for `session_replay`, this is the `notifications/apex.session.replay_failed` notification sent as the first event on the new SSE stream
- the client should discard continuity assumptions
- the client should rebuild state from execution-critical resources before resuming autonomous order flow

---

## 5. Session Health

Session health should be evaluated from:

- heartbeat responsiveness
- subscription delivery continuity
- freshness of execution-critical resources
- authentication validity

Recommended health states:

- `ok`
- `degraded`
- `paused`
- `halted`

---

## 6. Autonomous Runtime Halt Conditions

Autonomous order entry should halt when any of the following occurs:

- quote state is stale
- account/risk state is stale
- sequence continuity is broken for execution-critical resources
- reconnect occurs without a successful state rebuild
- kill switch becomes active
- broker reports the instrument as non-tradeable
- market-hours gating disallows new orders

---

## 7. Audit Expectations

Autonomous runtimes should record:

- input resource URIs used for each decision
- latest accepted sequences for those resources
- freshness timestamps observed
- resulting tool call and broker response
- any runtime refusal reason

This is not just a compliance aid. It is necessary for debugging real trading behavior.

---

## 8. Recommended Capability Advertisement

Implementations should advertise operationally important facts in capabilities:

```json
{
  "realtime_contract": {
    "transport_mode": "streamable_http",
    "reconnect_mode": "session_replay",
    "max_retention_events": 10000,
    "quote_freshness_ms": 1000,
    "account_freshness_ms": 2000
  }
}
```

For implementations using `best_effort_replay` or `guaranteed_replay`, use the corresponding `reconnect_mode` value and adjust `max_retention_events` and `max_retention_seconds` to document the retention window.

This does not replace resource-level metadata. It complements it.
