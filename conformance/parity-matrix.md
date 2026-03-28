# APEX Alpha Reference Parity Matrix

**Version:** `0.1.0-alpha`  
**Last Updated:** 2026-03-27

This document records the current parity status of the bundled reference implementations:

- TypeScript
- Go
- Rust
- Java

The matrix reflects the **current alpha protocol surface** and the **current executable conformance harness**. It does not claim parity for future or unimplemented protocol areas.

---

## Current Verdict

All four reference implementations are currently:

- feature-complete for the exercised alpha surface
- behaviorally aligned for the exercised alpha surface
- green on the same executable conformance suites:
  - `verify:alpha`
  - `verify:production`
  - `verify:transport`
  - `verify:all`

---

## Capability Matrix

| Capability | TypeScript | Go | Rust | Java | Executably Verified |
| --- | --- | --- | --- | --- | --- |
| `apex.session.authenticate` | Yes | Yes | Yes | Yes | Yes |
| `apex.session.capabilities` | Yes | Yes | Yes | Yes | Yes |
| `apex.session.heartbeat` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.summary` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.positions` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.orders` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.history` | Yes | Yes | Yes | Yes | Tool listed |
| `apex.order.place` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.modify` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.cancel` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.status` | Yes | Yes | Yes | Yes | Tool listed |
| `apex.market.quote` | Yes | Yes | Yes | Yes | Yes |
| `apex.market.snapshot` | Yes | Yes | Yes | Yes | Tool listed |
| `apex.market.search` | Yes | Yes | Yes | Yes | Tool listed |
| `apex.market.details` | Yes | Yes | Yes | Yes | Yes |
| `apex.risk.check` | Yes | Yes | Yes | Yes | Yes |
| `apex.risk.limits` | Yes | Yes | Yes | Yes | Yes |
| `resources/list` | Yes | Yes | Yes | Yes | Yes |
| `resources/read` | Yes | Yes | Yes | Yes | Yes |
| `resources/subscribe` | Yes | Yes | Yes | Yes | Yes |
| `resources/unsubscribe` | Yes | Yes | Yes | Yes | Yes |
| `notifications/resources/updated` | Yes | Yes | Yes | Yes | Yes |
| Reference fault injection tool | Yes | Yes | Yes | Yes | Yes |

---

## Realtime Resource Matrix

| Resource | TypeScript | Go | Rust | Java | Schema-Validated |
| --- | --- | --- | --- | --- | --- |
| Quote | Yes | Yes | Yes | Yes | Yes |
| Candles `M1` | Yes | Yes | Yes | Yes | Yes |
| Candles `M5` | Yes | Yes | Yes | Yes | Yes |
| Candles `H1` | Yes | Yes | Yes | Yes | Yes |
| Features | Yes | Yes | Yes | Yes | Yes |
| Account summary | Yes | Yes | Yes | Yes | Yes |
| Positions | Yes | Yes | Yes | Yes | Yes |
| Orders | Yes | Yes | Yes | Yes | Yes |
| Fills | Yes | Yes | Yes | Yes | Indirectly via fill-event validation |
| Risk | Yes | Yes | Yes | Yes | Yes |
| Decision context | Yes | Yes | Yes | Yes | Yes |

---

## Resilience And Trading-State Matrix

| Behavior | TypeScript | Go | Rust | Java | Executably Verified |
| --- | --- | --- | --- | --- | --- |
| Reconnect baseline with `no_replay` contract | Yes | Yes | Yes | Yes | Yes |
| Stale quote rejection | Yes | Yes | Yes | Yes | Yes |
| Stale risk rejection | Yes | Yes | Yes | Yes | Yes |
| Kill-switch surfaced in risk state | Yes | Yes | Yes | Yes | Yes |
| Kill-switch surfaced in decision context | Yes | Yes | Yes | Yes | Yes |
| Kill-switch order rejection | Yes | Yes | Yes | Yes | Yes |
| Sequence-gap injection | Yes | Yes | Yes | Yes | Yes |
| Detectable sequence gaps on resources | Yes | Yes | Yes | Yes | Yes |
| Sequence-gap order rejection | Yes | Yes | Yes | Yes | Yes |
| Deterministic partial-fill-next-order behavior | Yes | Yes | Yes | Yes | Yes |
| Normalized order-event schema compliance | Yes | Yes | Yes | Yes | Yes |
| Normalized fill-event schema compliance | Yes | Yes | Yes | Yes | Yes |

---

## Transport Capability Matrix

| Capability | TypeScript | Go | Rust | Java | Executably Verified |
| --- | --- | --- | --- | --- | --- |
| HTTP/SSE transport (`--http <port>`) | Yes | Yes | Yes | Yes | Yes |
| Session management (`Mcp-Session-Id`) | Yes | Yes | Yes | Yes | Yes |
| SSE event IDs (monotonic integers) | Yes | Yes | Yes | Yes | Yes |
| Replay via `Last-Event-ID` | Yes | Yes | Yes | Yes | Yes |
| Replay failure notification | Yes | Yes | Yes | Yes | Yes |
| `notifications/apex.order.filled` | Yes | Yes | Yes | Yes | Yes |
| `notifications/apex.order.partially_filled` | Yes | Yes | Yes | Yes | Yes |
| `notifications/apex.order.rejected` | Yes | Yes | Yes | Yes | Yes |
| `notifications/apex.market.candle_closed` | Yes | Yes | Yes | Yes | Yes |
| `notifications/apex.risk.kill_switch_engaged` | Yes | Yes | Yes | Yes | Yes |
| Tick engine (2s quote updates) | Yes | Yes | Yes | Yes | Yes |
| `force_candle_close` test tool | Yes | Yes | Yes | Yes | Yes |
| Session rejection (bogus ID → 404) | Yes | Yes | Yes | Yes | Yes |

---

## Notes

- The parity claim is intentionally scoped to the **alpha spec and current conformance coverage**.
- In stdio mode, the reconnect contract is `no_replay`. In HTTP mode, the reconnect contract is `session_replay` with a 1000-event ring buffer.
- Order and fill schema validation is performed against normalized event payloads derived from the orders and fills resources.
- The references are protocol-complete for alpha, but they are still reference servers, not real broker/exchange integrations.

---

## Evidence

Parity is currently enforced by these executable scripts:

- [smoke.mjs](./scripts/smoke.mjs)
- [dry-run.mjs](./scripts/dry-run.mjs)
- [production-smoke.mjs](./scripts/production-smoke.mjs)
- [production-resilience.mjs](./scripts/production-resilience.mjs)
- [transport-smoke.mjs](./scripts/transport-smoke.mjs)
- [transport-resilience.mjs](./scripts/transport-resilience.mjs)
- [transport-marketdata.mjs](./scripts/transport-marketdata.mjs)

Convenience entry points:

- `npm run verify:alpha`
- `npm run verify:production`
- `npm run verify:transport`
- `npm run verify:all`
