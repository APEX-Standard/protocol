# APEX Protocol — Layer 2: FX Profile

**Version:** `0.2.0-alpha`  
**Applies to:** Spot FX, CFD FX, Rolling Spot  
**Depends on:** Core `0.1.0`

---

## Overview

The FX Profile extends Layer 1 Core with capabilities specific to foreign exchange instruments. It covers rollover/swap rates, net currency exposure, cross-currency P&L conversion, and FX-specific order and position enrichments.

Brokers implementing this profile must declare `"fx"` in their `apex.session.capabilities` response.

---

## Profile Extensions to Core Tools

### Order Object — FX `profile_data`

When `"profile": "fx"` is set on `apex.order.place`, the following fields are available in `profile_data`:

```json
{
  "profile": "fx",
  "profile_data": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "execution_type": "market|instant",
    "slippage_tolerance_pips": "2",
    "hedging_allowed": true,
    "netting_mode": "hedge|net"
  }
}
```

### Position Object — FX `profile_data`

Positions returned from `apex.account.positions` include:

```json
{
  "profile_data": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "rollover_long_daily": "-2.50",
    "rollover_short_daily": "1.80",
    "accrued_rollover": "-7.50",
    "pip_value": "10.00",
    "pip_value_currency": "USD"
  }
}
```

---

## FX-Specific Tools

### `apex.fx.rollover`

Query rollover (swap) rates for an FX instrument. Rates are expressed in account currency per lot per night.

**Input:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "as_of": "ISO8601"   // Optional — defaults to now
}
```

**Output:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "rollover_long": "-2.50",
  "rollover_short": "1.80",
  "rollover_currency": "USD",
  "rollover_per": "lot",
  "lot_size": 100000,
  "triple_rollover_day": "wednesday",
  "next_rollover_time": "ISO8601",
  "as_of": "ISO8601"
}
```

---

### `apex.fx.exposure`

Net currency exposure across all open FX positions. Critical for agents managing portfolio-level currency risk.

**Input:**
```json
{
  "account_id": "string",
  "base_currency": "USD"   // Denominate all exposures in this currency
}
```

**Output:**
```json
{
  "account_id": "string",
  "base_currency": "USD",
  "exposures": [
    {
      "currency": "EUR",
      "net_units": "200000",
      "net_direction": "long",
      "value_in_base": "217500.00",
      "contributing_positions": ["pos_001", "pos_002"]
    },
    {
      "currency": "GBP",
      "net_units": "-50000",
      "net_direction": "short",
      "value_in_base": "-63200.00",
      "contributing_positions": ["pos_003"]
    }
  ],
  "total_gross_exposure": "280700.00",
  "as_of": "ISO8601"
}
```

---

### `apex.fx.conversion`

Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency.

**Input:**
```json
{
  "from_currency": "EUR",
  "to_currency": "USD",
  "amount": "10000.00"
}
```

**Output:**
```json
{
  "from_currency": "EUR",
  "to_currency": "USD",
  "rate": "1.0875",
  "converted_amount": "10875.00",
  "timestamp": "ISO8601"
}
```

---

## Instrument ID Format — FX

APEX canonical instrument IDs for FX follow this format:

```
APEX:FX:{BASE}{QUOTE}
```

Examples:
- `APEX:FX:EURUSD` — Euro / US Dollar
- `APEX:FX:GBPJPY` — British Pound / Japanese Yen
- `APEX:FX:XAUUSD` — Gold / US Dollar (spot)
- `APEX:FX:XAGUSD` — Silver / US Dollar (spot)

Precious metals traded as spot FX use the XAU/XAG ISO 4217 currency codes.

---

## Conformance Requirements

A broker declaring the `fx` profile must implement:

**Mandatory:**
- All Layer 1 Core tools
- FX `profile_data` fields on order and position objects
- `apex.fx.rollover`
- `apex.fx.conversion`

**Recommended:**
- `apex.fx.exposure`
- Triple-rollover day annotation in `apex.fx.rollover`
- Pip value in position `profile_data`

**Optional:**
- Hedging mode support in order `profile_data`
- Execution type preference
