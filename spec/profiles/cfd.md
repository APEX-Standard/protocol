# APEX Protocol — Layer 2: CFD Profile

**Version:** `0.1.0-alpha`  
**Applies to:** CFD Equities, CFD Indices, CFD Commodities  
**Depends on:** Core `0.1.0`

---

## Overview

The CFD Profile extends Layer 1 Core with capabilities specific to Contracts for Difference on equity, index, and commodity underlyings. It covers corporate actions, dividend adjustments, DMA availability, and CFD-specific position enrichments.

Brokers implementing this profile must declare `"cfd"` in their `apex.session.capabilities` response.

---

## CFD Sub-Types

The CFD profile covers three sub-types, declared in the instrument registry:

| Sub-type | Instrument ID prefix | Examples |
|----------|---------------------|---------|
| Equity CFD | `APEX:CFD:EQ:` | Apple, Tesla, HSBC |
| Index CFD | `APEX:CFD:IDX:` | S&P 500, FTSE 100, DAX |
| Commodity CFD | `APEX:CFD:COM:` | Oil, Natural Gas, Copper |

---

## Profile Extensions to Core Tools

### Order Object — CFD `profile_data`

```json
{
  "profile": "cfd",
  "profile_data": {
    "cfd_type": "equity|index|commodity",
    "underlying_exchange": "NASDAQ",
    "dma_requested": false,
    "guaranteed_stop": false,
    "guaranteed_stop_premium": null
  }
}
```

**Guaranteed stops:** Some brokers offer guaranteed stop-loss orders for a premium. When `guaranteed_stop: true`, the broker guarantees execution at the specified stop price regardless of gapping. The `guaranteed_stop_premium` field returns the cost in account currency.

### Position Object — CFD `profile_data`

```json
{
  "profile_data": {
    "cfd_type": "equity|index|commodity",
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

---

## CFD-Specific Tools

### `apex.cfd.corporate_actions`

Query upcoming and recent corporate actions affecting open positions or watchlisted instruments.

**Input:**
```json
{
  "account_id": "string",
  "instrument_id": "APEX:CFD:EQ:AAPL.XNAS",   // Optional — omit for all
  "from": "ISO8601",
  "to": "ISO8601"
}
```

**Output:**
```json
{
  "corporate_actions": [
    {
      "action_id": "string",
      "instrument_id": "APEX:CFD:EQ:AAPL.XNAS",
      "action_type": "dividend|split|rights_issue|spinoff|merger",
      "ex_date": "ISO8601",
      "record_date": "ISO8601",
      "payment_date": "ISO8601",
      "details": {
        "dividend_amount": 0.25,
        "dividend_currency": "USD",
        "split_ratio": null
      },
      "position_impact": {
        "position_id": "string",
        "estimated_adjustment": -25.00,
        "adjustment_currency": "USD",
        "adjustment_type": "cash|price"
      }
    }
  ]
}
```

---

### `apex.cfd.dividend_adjustment`

Query pending and historical dividend cash adjustments on CFD positions.

**Input:**
```json
{
  "account_id": "string",
  "status": "pending|paid|all",
  "from": "ISO8601",
  "to": "ISO8601"
}
```

**Output:**
```json
{
  "adjustments": [
    {
      "adjustment_id": "string",
      "instrument_id": "APEX:CFD:EQ:AAPL.XNAS",
      "position_id": "string",
      "side": "buy|sell",
      "amount": -25.00,
      "currency": "USD",
      "ex_date": "ISO8601",
      "payment_date": "ISO8601",
      "status": "pending|paid",
      "description": "Apple Inc. Q4 2025 dividend"
    }
  ]
}
```

---

## Instrument ID Format — CFD

### Equity CFDs

```
APEX:CFD:EQ:{TICKER}.{MIC}
```

Equity CFDs use the primary listing venue's ISO 10383 MIC code. Country suffixes like `.US` are not sufficiently unique and must not be used in canonical IDs.

| Exchange | MIC | Example |
|----------|-----|---------|
| NASDAQ | `XNAS` | `APEX:CFD:EQ:AAPL.XNAS` |
| NYSE | `XNYS` | `APEX:CFD:EQ:GS.XNYS` |
| London Stock Exchange | `XLON` | `APEX:CFD:EQ:HSBA.XLON` |
| XETRA | `XETR` | `APEX:CFD:EQ:SAP.XETR` |
| Euronext Paris | `XPAR` | `APEX:CFD:EQ:AIR.XPAR` |
| ASX | `XASX` | `APEX:CFD:EQ:CBA.XASX` |

### Index CFDs

```
APEX:CFD:IDX:{INDEX_CODE}
```

Standard index codes:

| Index | Instrument ID |
|-------|--------------|
| S&P 500 | `APEX:CFD:IDX:SPX500` |
| NASDAQ 100 | `APEX:CFD:IDX:NAS100` |
| FTSE 100 | `APEX:CFD:IDX:UK100` |
| DAX 40 | `APEX:CFD:IDX:GER40` |
| Nikkei 225 | `APEX:CFD:IDX:JPN225` |
| ASX 200 | `APEX:CFD:IDX:AUS200` |

### Commodity CFDs

```
APEX:CFD:COM:{COMMODITY_CODE}
```

Standard commodity codes:

| Commodity | Instrument ID |
|-----------|--------------|
| WTI Crude Oil | `APEX:CFD:COM:WTIUSD` |
| Brent Crude | `APEX:CFD:COM:BRNUSD` |
| Natural Gas | `APEX:CFD:COM:NATGAS` |
| Copper | `APEX:CFD:COM:COPPER` |

---

## Overnight Financing

CFD positions held overnight incur financing charges based on the underlying position value.

The standard calculation is:

```
Daily Financing = Position Value × (LIBOR/SOFR + Broker Spread) / 365
```

Brokers must disclose the financing rate methodology in `apex.market.details` under `profile_data.financing_rate_basis` and `profile_data.financing_spread_pct`.

---

## Conformance Requirements

A broker declaring the `cfd` profile must implement:

**Mandatory:**
- All Layer 1 Core tools
- CFD `profile_data` on order and position objects
- `apex.cfd.corporate_actions`
- Overnight financing fields in position `profile_data`

**Recommended:**
- `apex.cfd.dividend_adjustment`
- Guaranteed stop support in order `profile_data`
- DMA availability flag in order `profile_data`
