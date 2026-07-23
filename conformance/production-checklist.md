# APEX Production Conformance Checklist

**Version:** `0.3.0-alpha`  
**Status:** Draft  
**Last Updated:** 2026-03-27

---

## Purpose

The executable harness in this repository currently validates the alpha tool baseline. This checklist defines the additional requirements that should be validated before an implementation claims production-grade realtime or autonomous trading support.

Use this document together with:

- [Core Spec](../spec/core/README.md)
- [Production Capability Profiles](../spec/core/production.md)
- [Normative Schemas](../spec/core/schemas/)

---

## Capability Claims

### Production Realtime

A broker may claim `APEX Production Realtime` only if all items in Sections 1-5 pass.

### Production Autonomous

A broker may claim `APEX Production Autonomous` only if all items in Sections 1-7 pass.

---

## 1. Realtime Transport

- Streamable HTTP is supported for remote MCP sessions.
- SSE server-to-client updates function over a long-lived connection.
- Disconnect and reconnect behavior is documented.
- Replay semantics are documented.
- Acknowledgment-driven event log is implemented (`apex.session.acknowledge` advances the retention cursor).
- Retention windows are documented and honored (`max_retention_events`, `max_retention_seconds`).
- During replay, execution events (fills, rejections, kill switch) are replayed faithfully.
- During replay, ephemeral events (`notifications/resources/updated`, `candle_closed`) are collapsed into `notifications/apex.session.gap_fill` markers.
- `replay_failed` with reason `"event_id_outside_log"` is emitted when requested events have been evicted.

---

## 2. Resource Availability

- Quote resources exist for supported instruments.
- Candle resources exist for `M1`, `M5`, and `H1`.
- Feature resources exist for supported instruments.
- Account summary, positions, orders, and risk resources exist for authenticated accounts.
- Decision context resources exist for supported instruments if `Production Autonomous` is claimed.

---

## 3. Resource Schema Compliance

- Quote resources validate against `quote.resource.schema.json`.
- Candle resources validate against `candle.resource.schema.json`.
- Feature resources validate against `feature.resource.schema.json`.
- Decision context resources validate against `decision-context.resource.schema.json`.
- Order lifecycle payloads validate against `order-event.schema.json`.
- Fill payloads validate against `fill-event.schema.json`.
- Account summary resources validate against `account-summary.resource.schema.json`.
- Positions resources validate against `positions.resource.schema.json`.
- Orders resources validate against `orders.resource.schema.json`.
- Risk resources validate against `risk.resource.schema.json`.
- Fills resources validate against `fills.resource.schema.json`.

---

## 4. Freshness And Sequencing

- Each execution-critical realtime resource includes timestamp/as_of.
- Each execution-critical realtime resource includes a monotonic `sequence`.
- Each execution-critical realtime resource includes `stale_after_ms` or documented equivalent.
- Sequence gaps are detectable by clients.
- Gap recovery behavior is deterministic and documented.
- Stale resources are rejected by autonomous runtime before order submission.

---

## 5. Notification Behavior

- `notifications/resources/updated` is emitted for subscribed resource changes.
- `notifications/apex.order.filled` is emitted on full fills.
- `notifications/apex.order.partially_filled` is emitted when applicable.
- `notifications/apex.order.rejected` is emitted on order rejection.
- `notifications/apex.market.candle_closed` is emitted on candle close.
- `notifications/apex.risk.kill_switch_engaged` is emitted when the broker enters a hard-stop state.
- `notifications/apex.session.gap_fill` is emitted during replay to indicate elided ephemeral events (with `elided_count`, `from_id`, `to_id`).

---

## 6. Autonomous Controls

Required for `Production Autonomous`.

- Kill switch is surfaced in risk state and enforced by order flow.
- Restricted instruments are surfaced and enforced.
- Maximum position size is surfaced and enforced.
- Maximum open orders is surfaced and enforced.
- Daily loss hard-stop is surfaced and enforced.
- Stale-data rejection is surfaced and enforced.
- Sequence-gap rejection is surfaced and enforced.
- Market-hours gating is surfaced and enforced.

---

## 7. Runtime Decision Safety

Required for `Production Autonomous`.

- Autonomous decisions are made from maintained structured state, not raw market text streams.
- Runtime halts autonomous execution when quote state becomes stale.
- Runtime halts autonomous execution when account/risk state becomes stale.
- Runtime halts autonomous execution when sequence continuity is broken for execution-critical resources.
- Runtime can correlate fill events back to orders deterministically.

---

## Current Executable Test Coverage

The reference harness now executes:

- resource subscription smoke test
- schema validation for quote, candle (M1, M5, H1), feature, decision-context, account summary, positions, orders, fills, and risk resources
- schema validation against normative order-event and fill-event schemas
- replay-capable reconnect baseline checks
- stale quote and stale risk order rejection checks
- injected sequence gap detection and sequence-gap rejection checks
- partial fill lifecycle and event schema validation
- kill switch order rejection checks
- HTTP/SSE transport connection and session management (19 mandatory tools including `apex.session.acknowledge`)
- SSE notification delivery (`notifications/resources/updated` and APEX notifications)
- SSE reconnect with `Last-Event-ID` replay
- Acknowledgment-driven retention (`apex.session.acknowledge` advances cursor, evicts acknowledged events)
- Gap fill during replay (ephemeral events elided, `notifications/apex.session.gap_fill` markers emitted)
- Acknowledgment-based eviction and `replay_failed` with reason `"event_id_outside_log"`
- Post-failure recovery after replay failure
- Live market data streaming (quote updates, candle close via `force_candle_close`)
- Session rejection for invalid session IDs (bogus ID returns 404)
- Capability validation for `max_retention_events`, `max_retention_seconds`, and `notifications/apex.session.gap_fill`

## Recommended Future Executable Tests

- quote freshness timeout test (wall-clock staleness detection)
- candle close notification wall-clock timing precision test
