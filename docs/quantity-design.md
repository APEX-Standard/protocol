# APEX Protocol — Quantity Normalization Design

**Version:** `0.2.0-alpha`

---

## Overview

Every broker says "1 lot" but means something different. APEX normalizes quantities into canonical units so agents do not need broker-specific translation logic. An agent sends a quantity in the canonical unit for the asset class, and the broker translates to its internal representation. The agent never thinks in lots, micro-lots, or mini-lots. It thinks in base currency units, shares, or contracts.

---

## The Problem

Consider an agent that trades EURUSD across three brokers:

**Broker A** (institutional lot-based): "1 lot" = 100,000 EUR. The agent sends `quantity: 1`. It gets 100,000 EUR of exposure.

**Broker B** (unit-based retail): "1 unit" = 1 EUR. The agent sends `quantity: 1`. It gets 1 EUR of exposure.

**Broker C** (mini-lot retail): "0.01 lots" = 1,000 EUR. The agent sends `quantity: 1`. The broker interprets this as 1 lot = 100,000 EUR, or maybe 1 mini-lot = 10,000 EUR, or maybe rejects it because "1" is not a valid increment.

Same number, three wildly different outcomes. The agent that sends `quantity: 1` to all three gets exposure ranging from 1 EUR to 100,000 EUR. This is not theoretical. It is the number one integration bug in multi-broker trading systems. Every firm that has connected to more than one broker has a war story about a quantity mismatch that resulted in an unintended position ten or a hundred times larger than expected.

The root cause is that brokers chose their native quantity units based on their own platform conventions, not on any shared standard. FIX protocol addressed this with the `OrderQtyData` component, where quantity types are explicit. SWIFT MT messages express amounts in canonical currency units. APEX applies the same principle: every quantity on the wire has an unambiguous unit, and that unit is canonical across all brokers.

---

## The Three Canonical Units

APEX defines three canonical quantity units. Each one maps to a natural counting unit for its asset class.

### `base_units`

For FX and crypto spot instruments, quantity is denominated in units of the base currency.

EURUSD: the base currency is EUR. `quantity: 100000, quantity_unit: "base_units"` means 100,000 EUR of notional. Whether the broker internally calls this "1 standard lot" or "100000 units" or "10 mini-lots" is irrelevant to the agent. The canonical quantity is 100,000 units of the thing being bought or sold.

BTCUSDT: the base currency is BTC. `quantity: 0.5, quantity_unit: "base_units"` means 0.5 BTC. A crypto exchange that uses BTC as its native size passes this through directly. A broker that wraps the exchange and expresses size in "contracts" translates internally.

Why base currency units? Because they are the only measure of quantity that is stable across brokers. "1 lot" varies. "100,000 EUR" does not.

### `shares`

For equity CFDs, quantity is denominated in shares of the underlying equity.

AAPL equity CFD: `quantity: 50, quantity_unit: "shares"` means exposure to 50 shares of Apple. Whether the broker's platform shows "50 shares" or "50 units" or "0.5 lots" (if the broker defines 1 lot = 100 shares), the canonical quantity is 50 shares.

Why shares? Because equity CFDs derive from equity markets, where the natural counting unit is shares. No equity trader thinks in "lots of Apple." They think in shares.

### `contracts`

For index CFDs, commodity CFDs, and listed derivatives, quantity is denominated in contracts.

S&P 500 index CFD: `quantity: 2, quantity_unit: "contracts"` means 2 contracts. The monetary exposure depends on the index level and the contract's `point_value` — but the counting unit is contracts, because that is how index and commodity derivatives are universally sized.

WTI crude oil CFD: `quantity: 5, quantity_unit: "contracts"` means 5 contracts. The contract size (e.g., 100 barrels per contract) is a property of the instrument, not the order.

Why contracts? Because index and commodity derivatives have no natural "share" or "base unit." The contract is the atomic unit of exposure, and its monetary value is defined by the instrument specification.

---

## The Dual-Track Model

APEX carries two quantity representations:

**Canonical track** — what the protocol uses:
- `quantity` — the size in canonical units, encoded as a string-decimal (`^-?[0-9]+(\.[0-9]+)?$`)
- `quantity_unit` — one of `base_units`, `shares`, `contracts`

**Display track** — what the broker shows humans:
- `broker_quantity` — the numeric size in the broker's native units
- `broker_quantity_unit` — the broker's native unit label (e.g., `lots`, `units`, `mini-lots`)

### Rules

Order entry MUST use the canonical track. When an agent calls `apex.order.place`, it sends `quantity` and `quantity_unit`. It never sends `broker_quantity`. The broker translates the canonical quantity to its internal representation before routing to the execution venue.

Read models MAY include the display track. When the agent reads positions, orders, or fills, the response includes the canonical `quantity` and `quantity_unit` and may additionally include `broker_quantity` and `broker_quantity_unit` for human context. An agent displaying a dashboard might show "1.0 lot" next to "100,000 base_units" — but its internal logic uses only the canonical values.

The display track is informational. It exists so that a human reviewing an agent's activity can map back to what they see on their broker's platform. It is never authoritative for computation.

This is the same pattern used in database normalization: store data in canonical form, project display representations as needed. Or in physics: store measurements in SI units, display in local units. The canonical form is the source of truth. The display form is a convenience.

---

## Concrete Walkthrough

An agent wants to buy 100,000 EUR worth of EURUSD. Here is what happens at two different brokers:

### Broker A — Lot-Based (e.g., institutional FX)

The agent sends:

```json
{
  "account_id": "acct_001",
  "order": {
    "instrument_id": "APEX:FX:EURUSD",
    "side": "buy",
    "order_type": "market",
    "quantity": "100000",
    "quantity_unit": "base_units"
  }
}
```

Broker A knows from its instrument configuration that 1 standard lot = 100,000 base units. It translates `100000 base_units` to `1.0 lots` internally, routes the order, gets a fill. The response:

```json
{
  "order_id": "ord_a_001",
  "status": "filled",
  "fill_price": "1.0875",
  "fill_quantity": "100000",
  "remaining_quantity": "0"
}
```

The position read model includes both tracks:

```json
{
  "position_id": "pos_a_001",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "quantity": "100000",
  "quantity_unit": "base_units",
  "broker_quantity": "1.0",
  "broker_quantity_unit": "lots",
  "open_price": "1.0875"
}
```

### Broker B — Unit-Based (e.g., retail micro-account)

The agent sends the identical request:

```json
{
  "account_id": "acct_002",
  "order": {
    "instrument_id": "APEX:FX:EURUSD",
    "side": "buy",
    "order_type": "market",
    "quantity": "100000",
    "quantity_unit": "base_units"
  }
}
```

Broker B uses units natively. 100,000 base units = 100,000 units in the broker's system. No conversion needed. The response is structurally identical:

```json
{
  "order_id": "ord_b_001",
  "status": "filled",
  "fill_price": "1.0875",
  "fill_quantity": "100000",
  "remaining_quantity": "0"
}
```

The position includes the display track:

```json
{
  "position_id": "pos_b_001",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "quantity": "100000",
  "quantity_unit": "base_units",
  "broker_quantity": "100000",
  "broker_quantity_unit": "units",
  "open_price": "1.0875"
}
```

**Same agent code. Same quantity. Same exposure. Different brokers.** The agent does not know or care whether Broker A uses lots or Broker B uses units. It asked for 100,000 base units of EURUSD and got 100,000 base units of EURUSD at both.

---

## Profile-Specific Quantity Conventions

Each asset class profile defines which canonical unit applies and what ancillary sizing metadata is available.

| Asset Class | Profile | Canonical Unit | Meaning | Ancillary Fields |
|---|---|---|---|---|
| Spot FX | `fx` | `base_units` | Units of base currency (EUR in EURUSD) | `pip_value`, `pip_value_currency`, `lot_size` |
| CFD FX | `fx` | `base_units` | Units of base currency (EUR in EURUSD) | `pip_value`, `pip_value_currency`, `lot_size` |
| Crypto Spot | `crypto` | `base_units` | Units of base asset (BTC in BTCUSDT) | — |
| Crypto Perpetual | `crypto` | `base_units` | Units of base asset (BTC in BTCUSDT perp) | `contract_size` (if applicable) |
| Equity CFD | `cfd` | `shares` | Shares of underlying equity | `contract_size` (typically 1) |
| Index CFD | `cfd` | `contracts` | Contracts of the index derivative | `point_value`, `point_value_currency` |
| Commodity CFD | `cfd` | `contracts` | Contracts of the commodity derivative | `point_value`, `point_value_currency`, `contract_size` |

### How Pip Value and Point Value Relate to Quantity

For FX instruments, `pip_value` is the monetary value of a one-pip move per standard lot (typically per 100,000 base units). An agent that holds 50,000 base units of EURUSD and sees `pip_value: 10.00, pip_value_currency: "USD"` knows that its pip value is `(50000 / 100000) * 10.00 = 5.00 USD` per pip.

For index and commodity CFDs, `point_value` is the monetary value of a one-point move per contract. An agent that holds 3 contracts of SPX500 with `point_value: 10.00, point_value_currency: "USD"` knows that a 1-point move in the S&P 500 changes its P&L by `3 * 10.00 = 30.00 USD`.

These fields live in the position `profile_data` and in `apex.market.details` output. They are read-only metadata — the agent uses them for risk calculation, not for order entry.

---

## Instrument Registry as Translation Layer

The APEX Instrument Registry carries the per-broker, per-instrument mapping that makes quantity normalization work. Each broker mapping entry includes:

```json
{
  "broker_id": "fxcm",
  "broker_symbol": "EUR/USD",
  "canonical_quantity_unit": "base_units",
  "broker_quantity_unit": "units",
  "min_quantity": "1000",
  "quantity_step": "1000",
  "margin_rate_pct": "0.5"
}
```

```json
{
  "broker_id": "ig",
  "broker_symbol": "EURUSD",
  "canonical_quantity_unit": "base_units",
  "broker_quantity_unit": "lots",
  "min_quantity": "0.01",
  "quantity_step": "0.01",
  "margin_rate_pct": "0.5"
}
```

Notice: `min_quantity` and `quantity_step` in the registry are expressed in the broker's native unit when the `broker_quantity_unit` differs from the canonical unit (as with IG's lot-based sizing). At the wire level, however, the instrument details returned by `apex.market.details` express `min_quantity`, `max_quantity`, and `quantity_step` in the canonical unit. The broker performs this normalization so the agent never does arithmetic in broker-native units.

This is where the translation lives. An agent building a position sizer queries the instrument details, receives constraints in canonical units, validates its desired quantity against those constraints, and sends the order. The broker's APEX adapter translates the canonical quantity to broker-native units before passing to the execution layer.

The registry also enables pre-flight validation without a live broker connection. An agent can look up constraints for a given broker and instrument ahead of time and reject invalid quantities before ever sending an order.

---

## Quantity Validation

Every instrument has three quantity constraints expressed in canonical units:

| Constraint | Field | Description |
|---|---|---|
| Minimum | `min_quantity` | Smallest order the broker accepts |
| Maximum | `max_quantity` | Largest single order the broker accepts |
| Step | `quantity_step` | Granularity — quantity must be a multiple of this value |

### Validation Rules

1. `quantity >= min_quantity` — the order must meet the minimum.
2. `quantity <= max_quantity` — the order must not exceed the maximum.
3. `(quantity - min_quantity) % quantity_step == 0` — the quantity must fall on a valid step. In practice this means quantity must be a multiple of `quantity_step` (when `min_quantity` is itself a multiple of `quantity_step`, which it always should be).

### Error Handling

If the agent sends a quantity that violates these constraints, the broker rejects the order with error code `APEX_4012` (Quantity below minimum) or `APEX_4011` (Invalid order parameters) depending on which constraint was violated.

```json
{
  "error": {
    "code": -32602,
    "message": "Quantity below minimum",
    "data": {
      "apex_code": "APEX_4012",
      "category": "validation",
      "requested_quantity": "500",
      "min_quantity": "1000",
      "quantity_step": "1000",
      "quantity_unit": "base_units"
    }
  }
}
```

The error response includes the constraint values so the agent can adjust and retry without making a separate instrument query. This is a small but important usability detail — an agent that gets rejected for quantity can immediately compute the nearest valid quantity from the error payload.

### Practical Example

EURUSD at Broker A: `min_quantity: 1000, max_quantity: 50000000, quantity_step: 1000` (all in base_units).

- `quantity: 100000` — valid (100,000 EUR, exactly 100 steps of 1,000).
- `quantity: 1500` — invalid (not a multiple of 1,000). Rejected with `APEX_4011`.
- `quantity: 500` — invalid (below minimum of 1,000). Rejected with `APEX_4012`.
- `quantity: 60000000` — invalid (exceeds maximum of 50,000,000). Rejected with `APEX_4011`.

---

## Parallels

The quantity normalization model in APEX is not novel. It applies a well-established principle from several domains: always store and transmit in canonical units, display in local units.

| Domain | Canonical Representation | Display Representation | Parallel |
|---|---|---|---|
| **SWIFT MT messages** | Currency amounts in ISO 4217 minor units | Local formatting (commas, periods, symbols) | Amount fields are always canonical; presentation varies by locale |
| **FIX Protocol** | `OrderQtyData` component with `OrderQtyType` | Broker-specific display | Quantity + explicit type tag, same pattern as `quantity` + `quantity_unit` |
| **SI units in physics** | Metres, kilograms, seconds | Feet, pounds, minutes | Store in SI, display in local; never compute in local units |
| **Database normalization** | Third normal form (canonical) | Views and projections (display) | Canonical form is the source of truth; display forms are derived |
| **Unicode** | UTF-8 internal encoding | Locale-specific rendering | One encoding on the wire, many renderings on screen |

The FIX parallel is closest. FIX's `OrderQtyData` group contains `OrderQty` (the quantity), `CashOrderQty` (notional amount), and `OrderQtyType` (how to interpret the number). APEX simplifies this by constraining to one canonical unit per asset class — there is no ambiguity about which quantity type to use for a given instrument, because the instrument's profile determines it. FIX leaves this to bilateral agreement. APEX standardizes it.

The SWIFT parallel is instructive for a different reason. SWIFT MT messages carry currency amounts in the smallest unit of the currency (cents, not dollars). This eliminates rounding ambiguity. APEX's `base_units` serves the same purpose — by expressing FX quantities in units of the base currency rather than lots, there is no fractional lot arithmetic, no micro-lot confusion, and no broker-specific lot size tables.

---

## Storage

The quantity normalization model has no storage requirements beyond what the broker already maintains. The canonical quantity is the wire format. If the broker stores positions in lots internally, it converts on read and write at the APEX adapter boundary. If the broker stores in base units natively, no conversion is needed.

The key architectural constraint: the APEX adapter must be stateless with respect to quantity conversion. The conversion factor comes from the instrument specification, not from any per-session or per-order state. Given an instrument ID and a canonical quantity, the broker can always compute the broker-native equivalent, and vice versa.

---

## Related Design Documents

- [Instrument Identity Design](instrument-identity-design.md) — the canonical instrument ID namespace and the registry that carries per-broker quantity mappings (`canonical_quantity_unit`, `broker_quantity_unit`, `min_quantity`, `quantity_step`)
- [Profile Layering Design](profile-layering-design.md) — how each asset class profile defines which canonical quantity unit applies and what ancillary sizing metadata (pip value, point value, contract size) is available
- [Account Model Design](account-model-design.md) — how positions carry both canonical and display quantity tracks, and how the fills resource records executed quantities in canonical units
