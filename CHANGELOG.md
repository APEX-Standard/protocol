# Changelog

All notable changes to the APEX Protocol are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
APEX uses [Semantic Versioning](https://semver.org/) with an `-alpha` pre-release suffix.
During `0.x` alpha, minor version bumps may include breaking changes (see
[`docs/version-stability-design.md`](docs/version-stability-design.md)).

## [0.2.0-alpha] — 2026-05-30

### Changed (BREAKING — wire encoding)

- **All money / price / rate / P&L / margin / quantity fields changed from JSON `number`
  (IEEE-754 double) to string-encoded decimal** (JSON `string` matching
  `^-?[0-9]+(\.[0-9]+)?$` — optional sign, no exponent, no thousands separators).
  Precision remains broker/instrument-defined. See
  [RFC-0001](governance/rfcs/RFC-0001-string-decimal-encoding.md) and the migration note
  in [`docs/version-stability-design.md`](docs/version-stability-design.md).

  ```json
  // before (0.1.0-alpha)
  { "bid": 1.08745, "balance": 10000.00, "quantity": 100000, "fill_price": 1.0875 }
  // after (0.2.0-alpha)
  { "bid": "1.08745", "balance": "10000.00", "quantity": "100000", "fill_price": "1.0875" }
  ```

  - **Affected:** prices (`bid`, `ask`, `mid`, `spread`, `open`/`high`/`low`/`close`,
    `open_price`, `current_price`, `limit_price`, `stop_price`, `fill_price`,
    `average_fill_price`, `pip_size`), money (`balance`, `equity`, `*_margin`,
    `unrealised_pnl`, `realised_pnl_today`, `total_unrealised_pnl`, `commission`,
    `commission_per_lot`, `daily_loss_*`, profile rollover/funding/financing amounts,
    `pip_value`, `point_value`, exposure values, transfer/conversion `amount`),
    financial rates/percentages (`margin_level_pct`, `margin_call_level_pct`,
    `stop_out_level_pct`, `margin_rate_pct`, `current_rate`, `predicted_rate`,
    `overnight_financing_rate`, `distance_pct`, `typical_spread_pips`), and quantities
    (`quantity`, `filled_quantity`, `remaining_quantity`, `fill_quantity`,
    `max_position_size`, `min_quantity`, `max_quantity`, `quantity_step`, `net_units`).
  - **Unchanged** (still `number`/`integer`): integer counts (`sequence`,
    `stale_after_ms`, `max_open_orders`, `limit`, `leverage`, `lot_size`,
    `contract_size`, `funding_interval_hours`, `countdown_seconds`, `*_ms`), booleans,
    enums, IDs, ISO-8601 timestamps, and non-monetary analytics (`volume`, `returns`,
    `volatility`, `confidence`, `liquidity_score`, `expected_slippage_bps`,
    order-book/flow signals).

- JSON Schemas (`spec/core/schemas/*.json`): affected fields now `"type": "string"` with
  the decimal `pattern`; numeric range keywords removed from those fields. Each schema
  document defines two reusable `$defs` — `decimal` (`^-?[0-9]+(\.[0-9]+)?$`) and
  `decimal_nonneg` (`^[0-9]+(\.[0-9]+)?$`) — and every field `$ref`s one of them.
- Non-negative decimal fields (spread, quantities, position sizes, used/available margin
  level percentages) validate against `^[0-9]+(\.[0-9]+)?$` (no leading sign); signed fields
  (balances, P&L, prices, daily-loss, commission) keep `^-?...`. Prices remain signed to
  permit negative-settling instruments.
- Spec prose and examples (`spec/core/README.md`, `spec/profiles/*.md`,
  `spec/registry/README.md`, `docs/schema-design.md`, `docs/quantity-design.md`) updated
  to show quoted decimal strings.
- Reference implementations (Go, TypeScript, Rust, Java): affected wire fields are now
  serialized as decimal strings. The reference servers compute internally in native
  numeric types and format to string-decimal at the serialization boundary (string-field
  approach); production brokers should compute in an exact decimal type.
- Conformance suite: fixtures use quoted decimals; validators assert string-decimal.
- Version bumped `0.1.0-alpha` → `0.2.0-alpha` across the spec, docs, capability manifest
  examples, and reference-implementation `serverInfo`/`apex_version`.

## [0.1.0-alpha]

- Initial alpha: Layer 1 Core (session, account, orders, market data, risk), FX/CFD/Crypto
  profiles, realtime resources + notifications, replay with gap fill, and the conformance
  harness. Monetary values were JSON `number` (changed in 0.2.0-alpha, above).
