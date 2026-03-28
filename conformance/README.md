# APEX Protocol Conformance Test Suite

**Version:** `0.1.0-alpha`

This directory contains the alpha conformance harness for broker implementations of the APEX Protocol.

---

## Executable Harness

This package is meant to be run by any broker or implementer with an MCP stdio server. The harness starts your server process, connects over MCP stdio, and runs the same alpha-level assertions the reference implementations are held to.

```bash
npm install
npm run smoke -- --command node --args '["dist/server.js"]' --cwd ../your-server
npm run dry-run -- --command node --args '["dist/server.js"]' --cwd ../your-server
```

You can also point the harness at a JSON config file:

```json
{
  "name": "broker-sim",
  "command": "node",
  "args": ["dist/server.js"],
  "cwd": "../your-server"
}
```

```bash
npm run smoke -- --config ./broker-config.json
npm run dry-run -- --config ./broker-config.json
```

The smoke suite connects over MCP stdio, exercises core tools, and asserts key interoperability rules such as:
- account base currency vs response currency separation
- market fills returning a `position_id`
- position-targeted modification rejecting `limit_price`, `stop_price`, and `quantity`
- canonical quantity metadata in `apex.market.details`

The suite is implementation-neutral. It does not require your server to return the exact fixture values used by the bundled reference implementations.

---

## Running Against Your Implementation

```bash
# Install dependencies
cd protocol/conformance
npm install

# Run against your MCP stdio server command
npm run smoke -- \
  --command node \
  --args '["dist/server.js"]' \
  --cwd ../my-broker-server

npm run dry-run -- \
  --command node \
  --args '["dist/server.js"]' \
  --cwd ../my-broker-server

# Stream server stderr and print the spawned command
npm run smoke -- \
  --command node \
  --args '["dist/server.js"]' \
  --cwd ../my-broker-server \
  --verbose
```

If your server needs different test inputs, you can override them:

```bash
npm run smoke -- \
  --command node \
  --args '["dist/server.js"]' \
  --cwd ../my-broker-server \
  --auth-token "broker-issued-test-token" \
  --invalid-token "definitely-invalid" \
  --token-type "jwt" \
  --instrument-id "APEX:FX:EURUSD" \
  --currency "EUR"
```

You can also put those values in `test_options` inside your `--config` JSON:

```json
{
  "name": "broker-sim",
  "command": "node",
  "args": ["dist/server.js"],
  "cwd": "../your-server",
  "test_options": {
    "auth_token": "broker-issued-test-token",
    "invalid_token": "definitely-invalid",
    "token_type": "jwt",
    "instrument_id": "APEX:FX:EURUSD",
    "currency": "EUR",
    "expected_account_base_currency": "USD",
    "expected_broker_quantity_unit": "lots"
  }
}
```

---

## Built-In Targets

The reference implementations remain available as shortcuts:

```bash
npm run smoke:typescript
npm run smoke:go
npm run smoke:rust
npm run smoke:java
npm run dry-run:typescript
npm run dry-run:go
npm run dry-run:rust
npm run dry-run:java
npm run production-smoke:typescript
npm run production-resilience:typescript
npm run verify:alpha
npm run verify:production
npm run verify:transport
npm run verify:all          # includes alpha + production + transport
```

### Transport Tests (HTTP/SSE)

The transport test suites validate HTTP/SSE behavior. They start the server in HTTP mode using `--http <port>` and exercise the wire protocol directly with raw `fetch` and SSE parsing (not the MCP SDK client).

```bash
npm run transport-smoke:typescript
npm run transport-smoke:go
npm run transport-smoke:rust
npm run transport-smoke:java
npm run transport-resilience:typescript
npm run transport-resilience:go
npm run transport-resilience:rust
npm run transport-resilience:java
npm run transport-marketdata:typescript
npm run transport-marketdata:go
npm run transport-marketdata:rust
npm run transport-marketdata:java
npm run verify:transport     # all 3 transport suites × all 4 implementations
```

The three transport test scripts are:

- **`transport-smoke`** — HTTP connection lifecycle, session management via `Mcp-Session-Id`, tool calls over POST, SSE notification delivery (both `notifications/resources/updated` and APEX notifications such as `notifications/apex.order.filled` and `notifications/apex.risk.kill_switch_engaged`), APEX notification envelope validation, and negative tests (bogus session ID returns 404, missing session header returns 400).
- **`transport-resilience`** — SSE reconnect with `Last-Event-ID` replay, replayed event ordering and ID correctness, sequence monotonicity across replay boundaries, replay buffer exhaustion triggering `notifications/apex.session.replay_failed`, and post-failure baseline recovery.
- **`transport-marketdata`** — Live streaming quote updates over SSE, verification that quote values change between ticks (not static), deterministic candle close via `reference.test.force_candle_close`, `notifications/apex.market.candle_closed` payload validation, and features resource update delivery.

These shortcuts are convenience wrappers around the same harness and are primarily intended for protocol development and regression checks.

For production-grade realtime and autonomous trading claims, use the additional production smoke coverage and the checklist in [production-checklist.md](./production-checklist.md) together with:

- [`spec/core/production.md`](../spec/core/production.md)
- [`spec/core/stability.md`](../spec/core/stability.md)
- [`spec/core/execution-semantics.md`](../spec/core/execution-semantics.md)
- [`spec/core/operations.md`](../spec/core/operations.md)
- [`spec/core/schemas/`](../spec/core/schemas/)
- [Reference parity matrix](./parity-matrix.md)

---

## What The Harness Starts

The harness launches the target MCP server itself using the supplied stdio command, then connects to it with the official MCP SDK client. For the built-in shortcuts, that means:

- TypeScript: `node dist/server.js`
- Go: `go run .`
- Rust: `cargo run --quiet`
- Java: `java -jar target/apex-reference-java-0.1.0.jar`

For HTTP/SSE transport tests, the harness starts the server with the `--http <port>` flag:

- TypeScript: `node dist/server.js --http 0`
- Go: `go run . --http 0`
- Rust: `cargo run --quiet -- --http 0`
- Java: `java -jar target/apex-reference-java-0.1.0.jar --http 0`

Port `0` tells the server to bind to a random available port. The harness reads the actual port from the server's stderr output to avoid conflicts when running tests in parallel.

For third-party implementations, replace those with your own server command via `--command` and `--args`, or via `--config`.

If you pass `--verbose`, the harness will:
- print the exact server command it is starting
- stream the server's `stderr` to your terminal
- dump captured `stderr` again on failure

The harness does not print server `stdout` because MCP stdio uses `stdout` for protocol messages.

---

## Test Categories

Tests are organised by domain and profile. Each test is tagged:

- `[REQUIRED]` — part of the current alpha harness
- `[RECOMMENDED]` — useful extra coverage, not currently enforced by the executable harness
- `[OPTIONAL]` — informational only

---

> **Note:** The test catalog below describes the target coverage for APEX conformance. Tests marked `[REQUIRED]` define the eventual mandatory baseline. The executable test scripts (`smoke.mjs`, `dry-run.mjs`, `production-smoke.mjs`, `production-resilience.mjs`) implement the subset currently enforced against reference implementations.

## Core Test Cases

### Session Domain

```yaml
test: session.authenticate.valid
description: Valid token returns well-formed session response
required: true
assertions:
  - response.session_id is present and non-empty
  - response.account_id is present
  - response.expires_at is valid ISO8601 in the future
  - response.capabilities is an array containing "apex.session.*"
  - response.profiles is an array
  - response does not echo the supplied token

test: session.authenticate.invalid_token
description: Invalid token returns APEX_4001 error
required: true
input:
  token: "invalid_token_xyz"
assertions:
  - response.error.code == "APEX_4001"
  - response.error.category == "auth"

test: session.capabilities.complete
description: Capabilities manifest is complete and well-formed
required: true
assertions:
  - response.apex_version matches semver pattern
  - response.broker_id is present
  - response.core_tools is an array
  - response.supported_order_types includes at least "market"
  - response.supported_tif includes at least "GTC"

test: session.heartbeat.latency
description: Heartbeat responds within 500ms
required: true
assertions:
  - response_time_ms < 500
  - response.status == "ok"
```

### Account Domain

```yaml
test: account.summary.structure
description: Account summary returns all required fields
required: true
assertions:
  - response.account_id is present
  - response.account_base_currency is a 3-letter ISO currency code
  - response.response_currency is a 3-letter ISO currency code
  - response.balance is a number
  - response.equity is a number
  - response.used_margin >= 0
  - response.free_margin >= 0
  - response.margin_level_pct >= 0
  - response.as_of is valid ISO8601

test: account.summary.currency_conversion
description: Currency parameter returns balance in requested currency
required: recommended
input:
  currency: "EUR"
assertions:
  - response.account_base_currency is present
  - response.response_currency == "EUR"

test: account.positions.structure
description: Positions response is well-formed
required: true
assertions:
  - response.positions is an array
  - each position has instrument_id matching APEX:* pattern
  - each position has side in [buy, sell]
  - each position has quantity > 0
  - each position has quantity_unit in [base_units, shares, contracts]
  - each position has open_price > 0
  - each position has current_price > 0

test: account.positions.instrument_filter
description: instrument_id filter returns only matching positions
required: recommended
```

### Orders Domain

```yaml
test: order.place.market.buy
description: Market buy order is accepted
required: true
input:
  order:
    instrument_id: "APEX:FX:EURUSD"
    side: "buy"
    order_type: "market"
    quantity: 10000
    time_in_force: "GTC"
assertions:
  - response.order_id is present
  - response.status in ["accepted", "filled"]
  - response.rejection_reason is null

test: order.place.market.sell
description: Market sell order is accepted
required: true

test: order.place.limit.valid
description: Limit order with valid limit_price is accepted
required: true
input:
  order:
    instrument_id: "APEX:FX:EURUSD"
    side: "buy"
    order_type: "limit"
    quantity: 10000
    limit_price: 1.0000
    time_in_force: "GTC"
assertions:
  - response.status in ["working", "accepted"]

test: order.place.limit.missing_price
description: Limit order without limit_price returns validation error
required: true
input:
  order:
    order_type: "limit"
    # limit_price intentionally omitted
assertions:
  - response.error.code == "APEX_4011"
  - response.error.category == "validation"

test: order.place.with_sl_tp
description: Order with stop_loss and take_profit is accepted
required: recommended
input:
  order:
    instrument_id: "APEX:FX:EURUSD"
    side: "buy"
    order_type: "market"
    quantity: 10000
    stop_loss: { type: "price", value: 1.0750 }
    take_profit: { type: "price", value: 1.1200 }

test: order.cancel.working_order
description: Cancel a working order
required: true
setup:
  - place a limit order far from market
assertions:
  - response.status == "cancelled"

test: order.modify.sl_tp
description: Modify SL/TP on open position
required: recommended
input:
  target_type: "position"
  target_id: "pos_001"

test: order.modify.position.invalid_price_fields
description: Position modification rejects limit_price, stop_price, or quantity
required: true
input:
  target_type: "position"
  target_id: "pos_001"
  modifications:
    limit_price: 1.0700
assertions:
  - response.error.code == "APEX_4011"
  - response.error.category == "validation"
```

### Market Data Domain

```yaml
test: market.quote.eurusd
description: Quote for EURUSD returns valid bid/ask
required: true
input:
  instrument_id: "APEX:FX:EURUSD"
assertions:
  - response.bid > 0
  - response.ask > response.bid
  - response.spread == response.ask - response.bid (within floating point tolerance)
  - response.timestamp is recent ISO8601 (within last 60 seconds)

test: market.quote.invalid_instrument
description: Unknown instrument_id returns APEX_4010
required: true
input:
  instrument_id: "APEX:FX:ZZZZZZ"
assertions:
  - response.error.code == "APEX_4010"

test: market.snapshot.h1
description: H1 candles for EURUSD are returned
required: recommended
input:
  instrument_id: "APEX:FX:EURUSD"
  timeframe: "H1"
  limit: 10
assertions:
  - response.candles is array of length <= 10
  - each candle has open, high, low, close, volume
  - each candle has high >= low
  - each candle has high >= open, high >= close

test: market.search.basic
description: Search returns results for "EUR"
required: true
input:
  query: "EUR"
assertions:
  - response.instruments is non-empty array
  - each result has instrument_id matching APEX:* pattern

test: market.details.complete
description: Instrument details contains all required fields
required: true
assertions:
  - response.pip_size > 0
  - response.lot_size > 0
  - response.quantity_unit in ["base_units", "shares", "contracts"]
  - response.min_quantity > 0
  - response.margin_rate_pct > 0
```

### Risk Domain

```yaml
test: risk.check.approved
description: Small order within margin returns approved
required: true
input:
  order:
    instrument_id: "APEX:FX:EURUSD"
    side: "buy"
    order_type: "market"
    quantity: 1000
assertions:
  - response.approved == true
  - response.required_margin > 0
  - response.available_margin > 0

test: risk.check.exceeds_margin
description: Huge order exceeding available margin returns rejected
required: recommended
input:
  order:
    quantity: 999999999
assertions:
  - response.approved == false
  - response.rejection_reason is present

test: risk.limits.structure
description: Risk limits response contains all required fields
required: true
assertions:
  - response.max_position_size > 0
  - response.margin_call_level_pct > 0
  - response.stop_out_level_pct > 0
  - response.kill_switch_active is boolean
```

---

## FX Profile Test Cases

These tests run when `--profile fx` is specified.

```yaml
test: fx.profile_data.on_position
description: Open FX positions include fx profile_data
required: true
assertions:
  - each position has profile_data.pip_value > 0
  - each position has profile_data.rollover_long_daily (number)
  - each position has profile_data.rollover_short_daily (number)

test: fx.rollover.eurusd
description: Rollover rates for EURUSD are returned
required: true
input:
  instrument_id: "APEX:FX:EURUSD"
assertions:
  - response.rollover_long is a number
  - response.rollover_short is a number
  - response.rollover_currency is a 3-letter ISO code
  - response.next_rollover_time is valid ISO8601

test: fx.conversion.eurusd
description: EUR/USD conversion returns valid rate
required: true
input:
  from_currency: "EUR"
  to_currency: "USD"
  amount: 1000
assertions:
  - response.rate > 0
  - response.converted_amount > 0
  - response.converted_amount ≈ 1000 * response.rate
```

---

## Crypto Profile Test Cases

These tests run when `--profile crypto` is specified.

```yaml
test: crypto.profile_data.on_position
description: Open perpetual positions include crypto profile_data
required: true
assertions:
  - each perpetual position has profile_data.crypto_type == "perpetual"
  - each perpetual position has profile_data.margin_mode in ["cross", "isolated"]
  - each perpetual position has profile_data.leverage > 0
  - each perpetual position has profile_data.liquidation_price > 0
  - each perpetual position has profile_data.mark_price > 0

test: crypto.funding_rate.btcusdt
description: Funding rate for BTC/USDT perpetual is returned
required: true
input:
  instrument_id: "APEX:CRYPTO:PERP:BTCUSDT"
assertions:
  - response.current_rate is a number
  - response.funding_interval_hours > 0
  - response.next_funding_time is valid ISO8601
  - response.mark_price > 0
  - response.index_price > 0

test: crypto.liquidation_estimate.long
description: Liquidation estimate for a long position returns valid price
required: recommended
input:
  instrument_id: "APEX:CRYPTO:PERP:BTCUSDT"
  side: "buy"
  quantity: 0.1
  leverage: 10
  margin_mode: "isolated"
assertions:
  - response.liquidation_price > 0
  - response.liquidation_price < response.entry_price
  - response.distance_pct > 0
  - response.margin_required > 0

test: crypto.transfer.spot_to_futures
description: Transfer funds from spot to futures wallet
required: true
input:
  from_wallet: "spot"
  to_wallet: "futures"
  currency: "USDT"
  amount: 100.00
assertions:
  - response.transfer_id is present
  - response.status in ["completed", "pending"]
  - response.amount == 100.00
```

---

## Alpha Scope

The executable harness currently covers a focused subset of the core protocol:

- session authentication
- capabilities discovery
- account summary currency semantics
- market order placement
- resting limit order placement and cancellation
- position-targeted protection updates
- market details quantity metadata
- pre-trade risk checks

The longer test catalog below is the target conformance surface for future releases. In `0.1.0-alpha`, only the executable smoke and dry-run flows in `scripts/` are enforced by this repo.
