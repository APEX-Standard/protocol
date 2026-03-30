# APEX Protocol — Profile and Layering Design

**Version:** `0.1.0-alpha`

---

## Overview

APEX must work for FX, equities, commodities, and crypto without becoming a different protocol for each. A foreign exchange agent cares about rollover rates and pip values. A crypto agent cares about funding rates and liquidation prices. A CFD agent cares about overnight financing and corporate actions. None of them should have to understand the others' concerns just to place an order.

The layering architecture solves this: a universal core that handles the mechanics every trading agent needs — sessions, accounts, orders, market data, risk — plus asset-class-specific profiles that extend the core with domain-specific capabilities. The core is always the same protocol. The profiles add what each asset class demands without contaminating the shared surface.

---

## The Problem

Consider what happens if you try to put everything in one flat specification.

FX has rollover/swap charges that accrue nightly on open positions, with the triple-rollover anomaly on Wednesdays. FX positions carry pip values denominated in the quote currency. FX agents need net currency exposure across all positions — "how long am I EUR across all my pairs?"

CFDs have overnight financing charges calculated against a reference rate plus broker spread. Equity CFDs have corporate actions — dividends, stock splits, rights issues — that adjust position values. Index and commodity CFDs have different contract sizes and point values. Some brokers offer guaranteed stop-loss orders for a premium.

Crypto has funding rates on perpetual futures — periodic payments between long and short holders that anchor the perp price to spot. Crypto positions carry liquidation prices, mark prices, initial and maintenance margin. Crypto exchanges separate funds into spot, futures, and funding wallets, and agents must transfer between them before trading.

You cannot put all of this in the core without making it unwieldy. An FX broker should not need to implement `liquidation_price` fields. A crypto exchange should not need to implement `rollover_long_daily`. But you also cannot have separate protocols — the fundamental operations (authenticate, place order, read positions, check risk) are identical regardless of asset class. An order is an order. A position is a position. A quote is a quote.

The answer is two layers.

---

## Layer 1: The Universal Core

Layer 1 Core defines the mandatory baseline that every APEX implementation must support. It is asset-class agnostic. Five capability domains cover the full trading lifecycle:

| Domain | Prefix | What It Does |
|---|---|---|
| Session | `apex.session.*` | Authentication, capability discovery, keep-alive, acknowledgment |
| Account | `apex.account.*` | Balances, positions, orders, history |
| Orders | `apex.order.*` | Order entry, modification, cancellation, status |
| Market Data | `apex.market.*` | Quotes, snapshots, candles, instrument discovery |
| Risk | `apex.risk.*` | Pre-trade checks, account limits, kill switch |

These work identically regardless of asset class. `apex.order.place` places an order whether you're buying EUR/USD, a Tesla CFD, or BTC/USDT perpetual. `apex.account.positions` returns open positions whether those positions are FX lots, CFD contracts, or crypto perpetuals. `apex.market.quote` returns a bid/ask spread whether the instrument is a currency pair, an equity index, or a token.

An implementation that supports only Layer 1 is still a valid APEX participant. It can authenticate agents, accept orders, return positions, and stream quotes. It just cannot tell the agent about rollover rates, funding fees, or dividend adjustments. For many use cases — a simple market-making bot, a portfolio monitor, a basic execution agent — Layer 1 is sufficient.

The core tool set deliberately avoids asset-class assumptions. Positions have `quantity` and `quantity_unit` (base units, shares, or contracts) rather than "lots" or "coins." Orders have `order_type` and `time_in_force` rather than FX-specific execution types. Account summaries report balance, equity, margin, and P&L in a universal schema. The core is the lowest common denominator that still does real work.

---

## Layer 2: Asset Class Profiles

Layer 2 is where asset classes diverge. APEX defines three profiles:

| Profile | Applies To | Instrument ID Prefix |
|---|---|---|
| FX | Spot FX, CFD FX, Rolling Spot | `APEX:FX:` |
| CFD | Equity CFDs, Index CFDs, Commodity CFDs | `APEX:CFD:EQ:`, `APEX:CFD:IDX:`, `APEX:CFD:COM:` |
| Crypto | Crypto Spot, Perpetual Futures | `APEX:CRYPTO:SPOT:`, `APEX:CRYPTO:PERP:` |

Each profile extends the core in four ways:

1. **`profile_data` on order and position objects** — Profile-specific fields that ride alongside the base schema without modifying it.
2. **Profile-specific tools** — New tool endpoints in a dedicated namespace (`apex.fx.*`, `apex.cfd.*`, `apex.crypto.*`) that expose domain-specific queries and actions.
3. **Instrument ID conventions** — Canonical naming rules for instruments within the asset class.
4. **Conformance requirements** — What a broker must, should, and may implement to claim the profile.

Profiles depend on Layer 1 Core. A broker declaring the FX profile must implement all Layer 1 tools first, then add the FX extensions on top. The profile is an addition, never a replacement.

---

## The `profile_data` Extension Mechanism

This is the central design pattern of the layering architecture. It lets profiles add fields to core objects without breaking the base schema.

### How It Works on Orders

The core `apex.order.place` tool accepts a standard order object: instrument, side, quantity, order type, time in force, stop loss, take profit. Every order has this shape regardless of asset class. When the agent wants to use profile-specific features, it sets two additional fields:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "quantity": 100000,
  "order_type": "market",
  "time_in_force": "IOC",
  "profile": "fx",
  "profile_data": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "execution_type": "market",
    "slippage_tolerance_pips": 2,
    "netting_mode": "hedge"
  }
}
```

The base order schema stays identical. The `profile` field declares which profile the `profile_data` conforms to. The broker routes the profile data to its FX-specific handling. An agent or middleware component that doesn't understand FX `profile_data` can still read the base order — instrument, side, quantity, type — and process it meaningfully.

### How It Works on Positions

The same pattern applies to positions returned from `apex.account.positions`. The base position has `position_id`, `instrument_id`, `side`, `quantity`, `open_price`, `current_price`, `unrealised_pnl`, `used_margin`, and `open_time`. Every position looks like this, always.

For an FX position, `profile_data` adds what FX agents need:

```json
{
  "profile_data": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "rollover_long_daily": -2.50,
    "rollover_short_daily": 1.80,
    "accrued_rollover": -7.50,
    "pip_value": 10.00,
    "pip_value_currency": "USD"
  }
}
```

For a crypto perpetual position, `profile_data` adds what crypto agents need:

```json
{
  "profile_data": {
    "crypto_type": "perpetual",
    "margin_mode": "isolated",
    "leverage": 10,
    "liquidation_price": 45250.00,
    "initial_margin": 5000.00,
    "maintenance_margin": 2500.00,
    "margin_currency": "USDT",
    "accrued_funding": -12.50,
    "next_funding_time": "2026-03-29T16:00:00Z",
    "mark_price": 50100.00
  }
}
```

For a CFD equity position, `profile_data` adds what CFD agents need:

```json
{
  "profile_data": {
    "cfd_type": "equity",
    "underlying_exchange": "NASDAQ",
    "overnight_financing_rate": -0.0275,
    "overnight_financing_daily": -1.23,
    "accrued_financing": -3.69,
    "pending_dividend_adjustment": 0.00,
    "contract_size": 1,
    "point_value": 10.00,
    "point_value_currency": "USD"
  }
}
```

The base position object is always the same shape. The `profile_data` block is the only thing that changes. An agent reading positions across multiple profiles can process the universal fields (P&L, margin, quantity) without understanding any profile-specific content. When it needs the domain detail, it checks `profile` and reads `profile_data`.

### The Key Constraint

Profile-specific fields live inside `profile_data`. They must not break the base schema. This is normative: adding a profile must not require changes to the core object definition. The stability document classifies `profile_data` fields as "Alpha Optional" — they are valid but not required for core interoperability, and they must not break the base schema.

---

## How Profiles Compose

A broker can declare multiple profiles. A multi-asset broker offering FX, CFDs, and crypto lists all three:

```json
{
  "profiles": {
    "fx": "0.1.0",
    "cfd": "0.1.0",
    "crypto": "0.1.0"
  }
}
```

Each profile is independent. The FX profile does not depend on the CFD profile. The crypto profile does not depend on the FX profile. They share Layer 1 Core and nothing else.

An agent that only trades FX connects to the multi-asset broker, calls `apex.session.capabilities`, sees that the FX profile is available, and uses `apex.fx.rollover`, `apex.fx.exposure`, and `apex.fx.conversion` alongside the core tools. It never calls `apex.cfd.corporate_actions` or `apex.crypto.funding_rate`. It doesn't need to know those tools exist.

A portfolio agent that manages positions across asset classes connects to the same broker, discovers all three profiles, and routes its queries accordingly — `apex.fx.exposure` for currency risk, `apex.cfd.corporate_actions` for upcoming dividend adjustments, `apex.crypto.funding_rate` for funding cost estimates. It reads positions from `apex.account.positions` (a core tool) and inspects the `profile` field on each position to decide which domain logic to apply.

Profile independence means brokers can add profiles incrementally. A broker that starts with FX can add CFD support in a later release without modifying any existing FX behavior. Agents that were using the FX profile continue to work unchanged.

---

## Profile-Specific Differences

The profiles diverge in predictable ways. The following table maps the key concerns across asset classes:

| Concern | FX | CFD | Crypto |
|---|---|---|---|
| **Holding cost** | Rollover/swap — nightly charge based on interest rate differential. Triple rollover on Wednesdays. | Overnight financing — daily charge based on reference rate + broker spread, calculated as `Position Value x Rate / 365`. | Funding rate — periodic payment (typically every 8 hours) between long and short holders anchoring perp to spot index. |
| **Holding cost field** | `rollover_long_daily`, `rollover_short_daily`, `accrued_rollover` | `overnight_financing_rate`, `overnight_financing_daily`, `accrued_financing` | `accrued_funding`, `next_funding_time` |
| **Position risk metric** | Pip value — the monetary value of a one-pip move, denominated in quote currency. | Point value — the monetary value of a one-point move in the underlying. | Liquidation price — the price at which the exchange force-closes the position to prevent negative equity. |
| **Position risk field** | `pip_value`, `pip_value_currency` | `point_value`, `point_value_currency` | `liquidation_price`, `mark_price`, `maintenance_margin` |
| **Unique concern 1** | Net currency exposure across all pairs (`apex.fx.exposure`). | Corporate actions — dividends, splits, mergers that adjust position values (`apex.cfd.corporate_actions`). | Margin modes — cross vs isolated margin with fundamentally different risk profiles. |
| **Unique concern 2** | Cross-currency P&L conversion (`apex.fx.conversion`). | Guaranteed stop-loss orders for a premium (`guaranteed_stop`, `guaranteed_stop_premium`). | Wallet transfers — moving funds between spot, futures, and funding wallets before trading (`apex.crypto.transfer`). |
| **Unique concern 3** | Hedging vs netting mode (`netting_mode` in order `profile_data`). | DMA availability for equity CFDs (`dma_requested` in order `profile_data`). | Leverage selection per position (`leverage` in order `profile_data`). |

### Profile-Specific Tools

| Profile | Tool | Purpose |
|---|---|---|
| FX | `apex.fx.rollover` | Query rollover/swap rates for an instrument |
| FX | `apex.fx.exposure` | Net currency exposure across all open FX positions |
| FX | `apex.fx.conversion` | Real-time cross-currency conversion rate |
| CFD | `apex.cfd.corporate_actions` | Query upcoming/recent corporate actions affecting positions |
| CFD | `apex.cfd.dividend_adjustment` | Query pending and historical dividend cash adjustments |
| Crypto | `apex.crypto.funding_rate` | Current and predicted funding rate for a perpetual |
| Crypto | `apex.crypto.liquidation_estimate` | Estimate liquidation price for a hypothetical or existing position |
| Crypto | `apex.crypto.transfer` | Transfer funds between wallets on the same exchange |

---

## Capability Advertisement

When an agent connects and calls `apex.session.capabilities`, the broker returns its complete capability manifest. Profiles are declared with their versions:

```json
{
  "apex_version": "0.1.0",
  "core_tools": ["apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*"],
  "profiles": {
    "fx": "0.1.0",
    "cfd": "0.1.0",
    "crypto": "0.1.0"
  },
  "vendor_extensions": {
    "namespace": "fxcm",
    "tools": ["fxcm.sentiment.index", "fxcm.signal.feed"]
  }
}
```

The agent knows exactly what's available. If `profiles` doesn't include `"crypto"`, the agent knows not to call `apex.crypto.funding_rate`. If the broker only declares `"fx"`, the agent uses FX tools and nothing else. There is no guessing, no trial-and-error discovery, no "call it and see if it errors."

Profile versions are independent of the core version. A broker might implement core `0.1.0` with FX profile `0.1.0` and CFD profile `0.1.0` but not yet support crypto. Each profile can evolve at its own pace. A new profile version might add optional fields to `profile_data` or introduce new profile-specific tools without requiring a core version bump.

The `apex.session.authenticate` response also includes the active profiles for the session, giving the agent immediate visibility at login:

```json
{
  "session_id": "sess_abc123",
  "account_id": "acct_456",
  "profiles": ["fx", "cfd", "crypto"]
}
```

---

## Vendor Extensions

Profiles cover the standardized asset-class concerns. Vendor extensions are the escape hatch for everything else.

A broker has proprietary features — a sentiment index, a signal feed, a custom analytics engine, a social trading overlay. These don't belong in the APEX specification because they are not universal to the asset class. But the broker still wants to expose them to agents through the same protocol.

Vendor extensions live in their own namespace, declared in `apex.session.capabilities`:

```json
{
  "vendor_extensions": {
    "namespace": "fxcm",
    "tools": ["fxcm.sentiment.index", "fxcm.signal.feed"]
  }
}
```

The normative rules for vendor extensions:

| Rule | Rationale |
|---|---|
| Vendor tools must not use the `apex.*` namespace | The `apex.*` namespace is reserved for the protocol specification. Vendor tools that claim `apex.*` names would create ambiguity about what is standard and what is proprietary. |
| Vendor tools must not redefine APEX semantics | A vendor tool called `fxcm.order.place` that behaves differently from `apex.order.place` would break agent expectations. Vendor tools add capabilities; they do not replace or shadow core tools. |
| Vendor extensions are classified as "Alpha Optional" | They are valid but not required for interoperability. An agent that ignores all vendor extensions still has full APEX functionality. |
| Vendor-namespace capabilities must not be represented as APEX core interoperability | If a broker's critical trading behavior depends on a vendor extension, that behavior is broker-specific, not APEX-standard. |

Vendor extensions follow the same MCP tool calling convention as everything else. An agent discovers them through capabilities, calls them like any other tool, and handles their responses. The only difference is the namespace — `fxcm.sentiment.index` instead of `apex.market.quote`.

### Namespacing and Discovery

Brokers should namespace vendor tools with their `broker_id` as the prefix: `fxcm.sentiment.index`, `ig.alerts.subscribe`, `binance.grid.create`. This convention prevents collisions between vendors and makes the origin of every non-standard tool immediately apparent from its name. The `apex.session.capabilities` response declares the namespace and enumerates all vendor tools, so the agent can build a complete tool catalog at session start. The stability classification in Section 1.2 of the [stability document](../spec/core/stability.md) places vendor extensions in "Alpha Optional" -- they are valid protocol participants but carry no interoperability guarantee. An agent connecting to a different broker should expect the vendor namespace to be entirely different.

When an agent encounters an unknown vendor tool in the capabilities response, the correct behavior is graceful degradation: log its existence, skip it, and continue operating with core and profile tools. An agent must never fail or halt because a broker advertises vendor tools it does not understand. Conversely, an agent that depends on a specific vendor tool (e.g., `fxcm.sentiment.index` for a sentiment-driven strategy) should check for its presence in capabilities during the discovery phase and adjust its strategy if the tool is absent.

The boundary between a vendor extension and a profile tool is determined by universality. If a capability is specific to one broker's proprietary system (a sentiment index derived from that broker's client flow, a social trading overlay, a custom analytics engine), it belongs in the vendor namespace. If a capability is common to an entire asset class and meaningfully standardizable (FX rollover rates, crypto funding rates, CFD corporate actions), it belongs in a profile. When brokers develop vendor extensions that prove broadly useful, the APEX specification process can promote them into a profile in a future version -- but the vendor namespace serves as the proving ground, not the standard.

---

## Parallels

The APEX layering model is not novel. It follows a pattern established across decades of system design.

### USB Device Classes

USB defines a universal serial bus — a single physical and logical transport for connecting peripherals. But a keyboard and a webcam have nothing in common beyond the bus. USB solves this with device classes: HID for keyboards and mice, Video for cameras, Audio for microphones, Mass Storage for drives. The host queries the device descriptor to discover which class driver to load.

APEX works the same way. Layer 1 Core is the bus — the universal transport for trading interactions. Profiles are the device classes — FX, CFD, Crypto. The agent queries `apex.session.capabilities` to discover which profile "drivers" to load.

### HTTP Content Types

HTTP defines a universal request/response transport. It doesn't know or care whether the body is HTML, JSON, a JPEG, or a PDF. The `Content-Type` header tells the receiver how to interpret the payload. The transport is universal; the handling is media-specific.

APEX's `profile` and `profile_data` fields work like `Content-Type`. The base order/position object is the HTTP message. The `profile` field is the media type. The `profile_data` is the body that gets interpreted according to that type. A generic processor can route and forward the message without understanding the content. A specialized processor reads the content according to the declared type.

### OpenAPI and Extensions

OpenAPI defines a base specification for describing REST APIs. The `x-` prefix allows vendors to add custom metadata without conflicting with the standard fields. The base spec is universal; extensions are additive. Tooling that doesn't understand a particular `x-` extension ignores it gracefully.

APEX's `profile_data` is the same pattern. The base order/position schema is the standard. Profile-specific fields in `profile_data` are the extensions. An agent that doesn't understand a profile's extensions ignores them and still works with the base object.

### TCP/IP Layering

TCP/IP separates transport (TCP) from application (HTTP, FTP, SMTP). The transport layer provides reliable byte streams. The application layer defines what those bytes mean. Adding a new application protocol doesn't require changing TCP.

APEX separates core trading operations (Layer 1) from asset-class semantics (Layer 2). The core layer provides reliable trading primitives. The profile layer defines what those primitives mean in a specific market. Adding a new profile doesn't require changing the core.

### SQL and Vendor Extensions

Standard SQL defines the universal relational operations — SELECT, INSERT, UPDATE, JOIN. Every database implements these. PostgreSQL adds JSONB columns, lateral joins, and advisory locks. MySQL adds `ON DUPLICATE KEY UPDATE`. Oracle adds hierarchical queries. The vendor extensions are useful and widely adopted, but an application written against standard SQL runs on any database.

APEX's vendor extensions follow the same principle. `apex.order.place` works on every broker. `fxcm.sentiment.index` works only on FXCM. An agent written against core APEX tools and standard profiles runs on any compliant broker. An agent that uses vendor extensions is coupled to that vendor.

### Plugin Architectures

Most extensible systems — IDEs, web servers, game engines — follow a core-plus-plugins model. The core provides the application lifecycle, event system, and API surface. Plugins register against that surface to add capabilities. Plugins are independently developed, independently versioned, and independently loaded. A plugin for syntax highlighting doesn't interfere with a plugin for version control.

APEX profiles are plugins. They register against the core tool and object surface. They are independently versioned. An FX profile update doesn't interfere with the crypto profile. The core provides the lifecycle (session, orders, positions); the profiles provide the domain semantics (rollover, funding rates, corporate actions).

---

## Storage

The profile layering model has no storage implications for the protocol itself. How a broker stores profile-specific data is an implementation choice. The protocol mandates the behavioral contract: core objects always conform to the base schema, profile-specific data always lives in `profile_data`, profile-specific tools always live in the profile namespace, and `apex.session.capabilities` always declares which profiles are available. Everything else is up to the broker.

---

## Related Design Documents

- [Instrument Identity Design](instrument-identity-design.md) — how the `APEX:{ASSET_CLASS}:{SUB_CLASS}:{SYMBOL}` namespace encodes the profile that governs each instrument, and how the registry maps broker-native symbols to canonical IDs
- [Quantity Design](quantity-design.md) — how each profile defines its canonical quantity unit (`base_units`, `shares`, `contracts`) and the per-profile ancillary sizing fields (pip value, point value, contract size)
- [Session Design](session-design.md) — how profiles are advertised in `apex.session.capabilities` and `apex.session.authenticate`, and how the agent discovers available profiles at session start
