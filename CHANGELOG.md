# Changelog

All notable changes to the APEX Protocol are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
APEX uses [Semantic Versioning](https://semver.org/) with an `-alpha` pre-release suffix.
During `0.x` alpha, minor version bumps may include breaking changes (see
[`docs/version-stability-design.md`](docs/version-stability-design.md)).

## [0.3.0-alpha] — 2026-07-23

### Added

- **Futures asset class** — new Layer 2 **Futures Profile**
  ([`spec/profiles/futures.md`](spec/profiles/futures.md)) for exchange-listed futures
  on regulated derivatives venues. The profile is implementation-neutral — any futures
  trading firm can implement it as written. Brokers declare
  `"futures"` in `apex.session.capabilities`. Adding a profile is a compatible change
  per [`spec/core/stability.md`](spec/core/stability.md) §3.1.
  - Introduces the top-level `APEX:FUT:` asset-class namespace (matching ISO
    10962 CFI category `F` and FIX `SecurityType` `FUT`): contract roots
    (`APEX:FUT:ES`) for registry metadata and continuous series, dated
    contracts (`APEX:FUT:ESZ26` — month code + two-digit year) for trading.
    The `APEX:DERIV:` umbrella reserved in `0.1.0-alpha` is retired unpopulated
    (no compatibility impact); `APEX:OPT:` is reserved for a future options
    profile. See RFC-0002 Alternatives Considered.
  - Position `profile_data`: contract identity/expiry (`contract_month`,
    `expiration_date`, `first_notice_date`, `days_to_expiration`, `settlement_type`),
    contract spec (`tick_size`, `tick_value`, `contract_size`), and two-tier margin
    (`initial_margin`, `maintenance_margin`, `day_trading_margin`).
  - New tools: `apex.futures.contract_chain` (mandatory) and
    `apex.futures.margin_schedule` (recommended).
  - Registry ([`spec/registry/README.md`](spec/registry/README.md)): futures entry
    example and seed registry of 16 major contract roots (e-minis, micros, energy,
    metals, rates, FX, crypto).
  - Governance: [RFC-0002](governance/rfcs/RFC-0002-futures-profile.md) (Accepted)
    records the proposal, alternatives considered, and design rationale.
  - Reference implementations (TypeScript, Go, Rust, Java): both futures tools
    registered with aligned E-mini S&P 500 mock data (ESZ26 front month / ESH27,
    string-decimal margin schedule), following the existing cfd/crypto pattern
    (tools registered; capability manifest still declares the `fx` profile only).
  - Conformance: `smoke.mjs` exercises both futures tools against all four
    implementations (front-month uniqueness, cash settlement, decimal-string
    margins, `include_expired` semantics, root-targeted order rejection);
    `verify:alpha` green on all four. Parity matrix and `conformance/README.md`
    futures test cases added, including the Vestry Engine out-of-model divergence
    row for `apex.futures.*` and a documented not-yet-executable note for
    expired-contract search exclusion.
  - Expert-review hardening (futures-trading-expert agent findings, all resolved):
    - **`contract_size` is string-decimal in the futures profile** (fractional
      micro contract sizes, e.g. Micro Bitcoin = 0.1 BTC); RFC-0001 amended with
      a scoping note — its integer classification remains for the CFD surface.
    - **Futures `profile_data` on `apex.market.details`** (pre-trade contract
      spec: tick economics, expiry, margins, `prior_settlement_price`) including
      a `sessions` structure (`eth`/`rth`/`maintenance`, overnight-span
      semantics) that the core `trading_hours` shape cannot express.
    - **`ticks` protective-offset type** added to core `stop_loss` /
      `take_profit` / `trailing_stop` enums (compatible enum expansion); futures
      brokers must support `ticks` and reject `pips`.
    - **`variation_margin`** added to the core `apex.account.history`
      `event_subtype` enum; futures daily settlement maps to
      `funding`/`variation_margin` events.
    - Normative rules added: whole-contract quantities, net-per-dated-contract
      position model, `status: active|inactive` on chain entries, margin
      denomination in contract currency.
    - Deferred Capabilities section documents non-blocking follow-ups
      (expiration/roll notifications, holiday calendars, stop trigger method,
      continuous-series construction) and the two-digit-year century horizon.
    - Corrections: reference day-margin window now ends before session close
      (`08:30–15:45` CT); micro day-margin discount wording; MIC-convention
      wording; `contract_months` documented as a root-entry field; profile
      depends on Core `0.2.0`; `docs/protocol-overview-design.md` profile table
      split into Futures (`v0.3-alpha`) and Options (planned).

- **Parity matrix: Vestry Engine consumer divergence recorded**
  ([`conformance/parity-matrix.md`](conformance/parity-matrix.md)). Vestry Engine
  (consumer #1 / the determinism reference) conforms to the alpha Core +
  FX/CFD/crypto Layer 2 surface but is a B-book FX/CFD prop-firm engine with a
  deliberately narrower product model, so parts of `smoke.mjs` are out-of-model
  by design (spot-shaped `apex.crypto.funding_rate`; no perpetuals, wallets, or
  dividends; present-but-empty `cfd.corporate_actions`) — documented as
  divergence, not parity gaps. Also records the vendor `vestry.prop.*` prop-eval
  profile as a candidate first-class `prop` profile pending second-adopter
  validation.

### Fixed

- **All four references: `apex.order.place` accepted orders for unknown
  instruments** (filled anything at the reference EURUSD price) — none of the
  four originally validated `instrument_id` identity. Rust and Java were fixed
  first (caught by the initial futures root-order-rejection smoke run);
  TypeScript and Go were caught afterwards by a live probe with a numeric
  quantity — the original smoke test had passed on them for the wrong reason
  (a string-typed quantity tripped type validation before instrument identity
  was ever checked, masking the missing validation). All four now reject
  unknown instruments — including futures contract roots — with an in-band
  `APEX_4010`, and the smoke test asserts that specific code.

### Changed

- `apex.market.search` `profile` filter enum: placeholder value `derivatives` replaced
  by `futures` (`fx|cfd|crypto|futures|fixed_income`) in the core spec and the Go,
  TypeScript, and Java reference implementations. The `derivatives` value never had a
  backing profile spec and no registry instruments; no populated deployments are
  affected.

- Version bumped `0.2.0-alpha` → `0.3.0-alpha` across the core spec, docs,
  conformance suite, capability manifest examples, and reference-implementation
  `serverInfo`/`apex_version`. Capability manifest examples now carry the full
  pre-release string (`"apex_version": "0.3.0-alpha"`, previously shown bare as
  `"0.2.0"`), matching the `initialize` handshake format. The unchanged
  fx/cfd/crypto profiles keep their per-profile version `0.2.0` — profiles
  version independently (see `docs/profile-layering-design.md`); only the new
  futures profile is at `0.3.0`.

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
