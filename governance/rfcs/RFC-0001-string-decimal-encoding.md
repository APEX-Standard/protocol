# RFC-0001: String-Decimal Encoding for Monetary, Price, Rate, and Quantity Fields

**Status:** Accepted
**Author(s):** APEX TAC
**Created:** 2026-05-30
**Target Version:** 0.2.0-alpha

---

## Summary

Change every monetary, price, rate, P&L, margin, and quantity value in APEX from a JSON `number` (IEEE-754 double) to a **string-encoded decimal** — a JSON `string` matching `^-?[0-9]+(\.[0-9]+)?$` (optional sign, no exponent, no thousands separators). Example: `"bid": "1.08745"`, `"balance": "10000.00"`, `"quantity": "100000"`.

## Motivation

- **Doubles cannot represent decimal prices exactly.** `1.08745` has no exact IEEE-754 representation. A protocol used for trading and audit must carry exact, reproducible decimal values; binary floats silently introduce representation error that compounds across P&L, margin, and fill arithmetic.
- **FIX — APEX's stated analogy — uses ASCII string decimals on the wire**, never binary floats, precisely so prices are exact and reproducible. APEX-as-written (v0.1.0-alpha) contradicted the standard it claims lineage from.
- **It is cheap now and effectively unfixable later.** At `0.1-alpha`, almost no broker has hardened around `number` typing. Once `number` ships into broker implementations and is frozen as a `1.0.0` compatibility guarantee, it cannot be changed without a major-version break and an ecosystem-wide migration.

The cost of *not* doing this is a financial protocol that cannot guarantee the exactness of the very values it exists to transmit.

## Proposal

For every field that is money, a price (or price increment), a financial rate/percentage, P&L, margin, or a quantity:

- JSON Schema `type` becomes `"string"` with a decimal `pattern`. Each schema document defines two reusable `$defs` and every field `$ref`s one of them:
  - `decimal` — `^-?[0-9]+(\\.[0-9]+)?$` (signed): balances, P&L, prices, daily-loss, commission.
  - `decimal_nonneg` — `^[0-9]+(\\.[0-9]+)?$` (no leading sign): spread, quantities (`quantity`, `filled_quantity`, `remaining_quantity`, `fill_quantity`), position sizes (`max_position_size`), `used_margin`, and level percentages (`margin_level_pct`, `margin_call_level_pct`, `stop_out_level_pct`). A field is `decimal_nonneg` only where a negative value is definitionally impossible.
  - **Prices remain signed** (`bid`/`ask`/`mid`, OHLC, `*_price`, `stop_loss`/`take_profit`) to permit negative-settling instruments (e.g. WTI crude settled at -$37 in April 2020); spread is the only price-derived field that is provably non-negative (it is ask − bid).
- Numeric range keywords (`minimum`, `exclusiveMinimum`, `maximum`) are dropped, since they do not apply to strings; the decimal `pattern` is the validator (sign-restriction included).
- Nullable fields become `{ "anyOf": [ {"$ref": "#/$defs/decimal"}, {"type": "null"} ] }`.
- Meaning, units, and precision are unchanged — only the wire encoding changes. Precision stays broker/instrument-defined.

**Explicitly unchanged** (remain JSON `number`/`integer`): genuine integer counts (`sequence`, `stale_after_ms`, `max_open_orders`, `limit`, `leverage`, `lot_size`, `contract_size`, `*_ms`), booleans, enums, IDs, ISO-8601 timestamps, and non-monetary analytics (`volume`, `returns`, `volatility`, `confidence`, `liquidity_score`, `expected_slippage_bps`, order-book/flow signals).

**Impact on existing implementations.** This is a breaking wire change (`incompatible` label). Producers must emit quoted decimals; consumers must parse strings into an exact decimal type. Negotiated via `apex_version` at the MCP `initialize` handshake.

**Migration path.** See the full before/after and producer/consumer guidance in [`docs/version-stability-design.md`](../../docs/version-stability-design.md) (Migration Note — `0.1.0-alpha` → `0.2.0-alpha`) and [`CHANGELOG.md`](../../CHANGELOG.md).

## Alternatives Considered

- **Keep `number`, document a recommended precision.** Rejected: does not solve representation error; doubles still cannot hold `1.08745` exactly.
- **Integer minor units (e.g. cents / pips as integers).** Rejected: scale varies by instrument (FX 5dp, JPY pairs 3dp, crypto 8dp), forcing a per-instrument scale field and brittle arithmetic; string-decimal keeps precision broker/instrument-defined without a scale channel.
- **Decimal128 / typed binary decimal.** Rejected: not natively representable in JSON; would require a non-standard encoding and defeat human-readability.

## Open Questions

None outstanding. The borderline analytics fields (`volume`, `returns`, `volatility`, `confidence`, `liquidity_score`, `expected_slippage_bps`) were resolved as **remain `number`** — they are unitless model/statistical outputs, not exact-money values.

## References

- [`docs/schema-design.md`](../../docs/schema-design.md) — schema evolution rules, type guarantee
- [`docs/version-stability-design.md`](../../docs/version-stability-design.md) — migration note, version negotiation
- [`spec/core/stability.md`](../../spec/core/stability.md) — Section 4 schema evolution rules
- FIX Protocol `Price` / `Qty` field types (ASCII decimal on the wire)
