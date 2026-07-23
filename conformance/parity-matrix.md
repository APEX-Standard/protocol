# APEX Alpha Reference Parity Matrix

**Version:** `0.3.0-alpha`  
**Last Updated:** 2026-07-23

This document records the current parity status of the bundled reference implementations:

- TypeScript
- Go
- Rust
- Java

The matrix reflects the **current alpha protocol surface** and the **current executable conformance harness**. It does not claim parity for future or unimplemented protocol areas.

> **Wire encoding (0.2.0-alpha):** All monetary, price, rate, P&L, margin, and quantity fields are string-encoded decimals (`^-?[0-9]+(\.[0-9]+)?$`), not JSON numbers. The harness asserts this (`assertDecimalString` in `scripts/common.mjs`, plus JSON-Schema validation against `spec/core/schemas/`), and all four reference implementations emit and pass it. See [RFC-0001](../governance/rfcs/RFC-0001-string-decimal-encoding.md).

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
| `apex.session.acknowledge` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.summary` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.positions` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.orders` | Yes | Yes | Yes | Yes | Yes |
| `apex.account.history` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.place` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.modify` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.cancel` | Yes | Yes | Yes | Yes | Yes |
| `apex.order.status` | Yes | Yes | Yes | Yes | Yes |
| `apex.market.quote` | Yes | Yes | Yes | Yes | Yes |
| `apex.market.snapshot` | Yes | Yes | Yes | Yes | Yes |
| `apex.market.search` | Yes | Yes | Yes | Yes | Yes |
| `apex.market.details` | Yes | Yes | Yes | Yes | Yes |
| `apex.risk.check` | Yes | Yes | Yes | Yes | Yes |
| `apex.risk.limits` | Yes | Yes | Yes | Yes | Yes |
| `apex.position.close` | Yes | Yes | Yes | Yes | Yes |
| `apex.fx.rollover` | Yes | Yes | Yes | Yes | Yes |
| `apex.fx.exposure` | Yes | Yes | Yes | Yes | Yes |
| `apex.fx.conversion` | Yes | Yes | Yes | Yes | Yes |
| `apex.cfd.corporate_actions` | Yes | Yes | Yes | Yes | smoke |
| `apex.cfd.dividend_adjustment` | Yes | Yes | Yes | Yes | smoke |
| `apex.crypto.funding_rate` | Yes | Yes | Yes | Yes | smoke |
| `apex.crypto.liquidation_estimate` | Yes | Yes | Yes | Yes | smoke |
| `apex.crypto.transfer` | Yes | Yes | Yes | Yes | smoke |
| `apex.futures.contract_chain` | Yes | Yes | Yes | Yes | smoke |
| `apex.futures.margin_schedule` | Yes | Yes | Yes | Yes | smoke |
| `resources/list` | Yes | Yes | Yes | Yes | Yes |
| `resources/read` | Yes | Yes | Yes | Yes | Yes |
| `resources/subscribe` | Yes | Yes | Yes | Yes | Yes |
| `resources/unsubscribe` | Yes | Yes | Yes | Yes | Yes |
| `notifications/resources/updated` | Yes | Yes | Yes | Yes | Yes |
| Reference fault injection tool | Yes | Yes | Yes | Yes | Yes |
| Negative validation: missing required fields | Yes | Yes | Yes | Yes | Yes |
| Negative validation: unknown instrument | Yes | Yes | Yes | Yes | Yes |
| Negative validation: futures root-targeted order rejected (in-band `APEX_4010` asserted) | Yes | Yes | Yes | Yes | smoke |

---

## Consumer Divergence — Vestry Engine (consumer #1 / determinism reference)

Vestry Engine is the first external **consumer** implementation (not a bundled
reference) — an auditable B-book FX/CFD **prop-firm** paper-trading engine. It
conforms to the alpha Core + the FX/CFD/crypto Layer-2 surface, but its product
model is deliberately narrower than the generic reference broker, so part of the
bundled `smoke.mjs` suite is **out of model by design** (not a parity gap). This
row records that divergence so the standard documents it rather than implying a
failure.

| Capability | Vestry | Notes |
| --- | --- | --- |
| Core Layer-1 (`apex.session/account/order/market/risk/position.*`) | Yes | Full, over the recorded determinism engine |
| `apex.fx.rollover` / `apex.fx.exposure` / `apex.fx.conversion` | Yes | Over D70 rollover / netting projection / D88 USD-hub Mid |
| `apex.cfd.corporate_actions` | Yes (empty) | Degenerate — synthetic CFDs have none; returns `[]` |
| `apex.crypto.funding_rate` | Yes (**SPOT shape**) | Projects the CFD single-benchmark daily financing for `APEX:CRYPTO:SPOT:*`; `funding_interval_hours = 24`, `index_price == mark_price`. **NOT** the generic `PERP` funding (no 8h interval / perpetual basis). |
| `apex.crypto.liquidation_estimate` | **No (out of model)** | CFD margin-call/stop-out model — no per-position isolated-margin perpetual liquidation |
| `apex.crypto.transfer` | **No (out of model)** | Single-currency paper ledger — no spot/futures wallets |
| `apex.cfd.dividend_adjustment` | **No (out of model)** | Synthetic CFDs pass through no dividends |
| `apex.futures.contract_chain` / `apex.futures.margin_schedule` | **No (out of model)** | Spot/CFD prop engine — no listed futures product |
| Vendor `vestry.prop.*` (`scorecard` / `challenge.status` / `challenge.config`) + `profile_data.prop` | Yes | The Vestry-authored prop-eval Layer-2 profile (vendor namespace `vestry`, `prop` profile `0.1-draft`); destined for an APEX first-class `prop` profile on second-adopter validation |
| Realtime / transport (resources, notifications, SSE replay) | Pending | Vestry's APEX Production-Realtime layer is a separate slice (not yet built) |

The out-of-model tools are **not registered** in Vestry's capabilities manifest
(a call returns method-not-found), which is the intended signal that
perpetual-futures / wallet / dividend semantics are absent from a prop-firm
broker. This suggests a future protocol direction: a capability-gated smoke that
skips tools a broker does not advertise, so a conformant broker need not
implement product semantics outside its market.

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
| Replay-capable reconnect contract | Yes | Yes | Yes | Yes | Yes |
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
| Heartbeat latency SLA (avg < 500ms, max < 1000ms) | Yes | Yes | Yes | Yes | Yes |
| Concurrent order handling | Yes | Yes | Yes | Yes | Yes |

---

## Transport Capability Matrix

| Capability | TypeScript | Go | Rust | Java | Executably Verified |
| --- | --- | --- | --- | --- | --- |
| HTTP/SSE transport (default `8888`, override with `--http <port>`) | Yes | Yes | Yes | Yes | Yes |
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
| `apex_version` in initialize `serverInfo` | Yes | Yes | Yes | Yes | Yes |
| Session rejection (bogus ID → 404) | Yes | Yes | Yes | Yes | Yes |
| `apex.session.acknowledge` | Yes | Yes | Yes | Yes | transport-resilience |
| Acknowledgment-driven retention | Yes | Yes | Yes | Yes | transport-resilience |
| Gap fill (elide ephemeral on replay) | Yes | Yes | Yes | Yes | transport-resilience |
| `gap_fill` notification | Yes | Yes | Yes | Yes | transport-resilience |

---

## Notes

- The parity claim is intentionally scoped to the **alpha spec and current conformance coverage**.
- The futures profile's mandatory *expired-contract exclusion from `apex.market.search` defaults* is **not yet executably verified** — the reference search index contains no futures instruments. The same applies to futures `profile_data` on positions/`apex.market.details` and whole-contract quantity enforcement: the references' position and instrument surface is FX-only, so these mandatory items are documented, not harness-enforced. `include_expired` semantics on `apex.futures.contract_chain` ARE smoke-verified (expired ESU26 returned only on request, marked `inactive`).
- **Known divergence — order-input quantity typing:** the spec and RFC-0001 define order `quantity` as a string-decimal on the wire, but all four references currently accept only JSON numbers on order *input* (the `0.2.0-alpha` migration covered outputs, not order-entry inputs). The smoke harness therefore deliberately sends numeric quantities. To be fixed in a future pass; until then, string-decimal order quantities are rejected by the references with a type error.
- The references do not enforce the offset-type *convention* rejection described in the core prose (`pips` on futures / `ticks` on FX-style instruments) — input schemas accept the full core enum and handlers apply no per-instrument convention check. Mock-level looseness; real implementations must enforce it.
- The reconnect contract is `session_replay` with acknowledgment-driven retention (max 10000 events) and gap fill for ephemeral event elision during replay.
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
