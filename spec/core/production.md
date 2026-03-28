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

- Support MCP Streamable HTTP for remote sessions.
- Support server-to-client SSE delivery for realtime notifications.
- Document replay behavior across reconnects.
- Expose enough metadata for clients to detect stale state and sequence discontinuity.

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
- `apex.market.quote`
- `apex.market.snapshot`
- `apex.market.details`
- `apex.risk.check`
- `apex.risk.limits`
- `apex.session.heartbeat`
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

### 1.6 Mandatory Sequencing Behavior

- Sequences must be monotonic within each realtime resource stream.
- Notifications referring to a realtime resource must carry the current `sequence`.
- Clients must be able to detect gaps deterministically.
- The server must document whether replay is supported.

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
