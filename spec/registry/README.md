# APEX Protocol — Instrument Registry

**Version:** `0.1.0-alpha`

---

## Overview

The APEX Instrument Registry is the canonical source of truth for instrument identity across the APEX Protocol ecosystem. It maps APEX canonical instrument IDs to broker-native symbols, contract specifications, and asset class metadata.

It plays a similar role to standards like ISIN and LEI: a stable identifier layer that reduces the symbol fragmentation that plagues broker API integrations today.

---

## Instrument ID Format

All APEX instrument IDs follow a hierarchical namespace:

```
APEX:{ASSET_CLASS}:{SUB_CLASS?}:{SYMBOL}
```

### Full Taxonomy

```
APEX:FX:{BASE}{QUOTE}              Spot FX and CFD FX
APEX:CFD:EQ:{TICKER}.{MIC}        Equity CFDs
APEX:CFD:IDX:{INDEX}               Index CFDs
APEX:CFD:COM:{COMMODITY}           Commodity CFDs
APEX:CRYPTO:SPOT:{BASE}{QUOTE}     Crypto spot
APEX:CRYPTO:PERP:{BASE}{QUOTE}     Crypto perpetual futures
APEX:DERIV:{TYPE}:{UNDERLYING}     Listed derivatives (futures, options)
APEX:FI:{ISIN}                     Fixed income (uses ISIN directly)
```

---

## Registry Entry Schema

Each instrument in the registry has the following structure:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "display_name": "Euro / US Dollar",
  "asset_class": "fx",
  "sub_class": null,
  "profile": "fx",
  "status": "active|inactive|deprecated",
  "introduced_version": "0.1.0-alpha",
  "deprecated_version": null,

  "canonical": {
    "base_currency": "EUR",
    "quote_currency": "USD",
    "pip_size": 0.0001,
    "pip_digits": 4,
    "standard_lot_size": 100000,
    "lot_size_currency": "EUR"
  },

  "broker_mappings": [
    {
      "broker_id": "fxcm",
      "broker_symbol": "EUR/USD",
      "broker_display_name": "EUR/USD",
      "min_quantity": 1000,
      "quantity_step": 1000,
      "canonical_quantity_unit": "base_units",
      "broker_quantity_unit": "units",
      "margin_rate_pct": 0.5,
      "as_of": "2026-01-01"
    },
    {
      "broker_id": "ig",
      "broker_symbol": "EURUSD",
      "broker_display_name": "EUR/USD",
      "min_quantity": 0.01,
      "quantity_step": 0.01,
      "canonical_quantity_unit": "base_units",
      "broker_quantity_unit": "lots",
      "margin_rate_pct": 0.5,
      "as_of": "2026-01-01"
    }
  ],

  "reference_data": {
    "iso_currency_base": "EUR",
    "iso_currency_quote": "USD",
    "central_bank_base": "ECB",
    "central_bank_quote": "Federal Reserve",
    "trading_sessions": ["sydney", "tokyo", "london", "new_york"],
    "is_24h": true
  }
}
```

---

## Registry API

The registry is part of the APEX Standard ([apexstandard.org](https://apexstandard.org)) and is queryable via a public REST API.

### Lookup by APEX Instrument ID

```
GET /registry/v1/instruments/APEX:FX:EURUSD
```

### Search

```
GET /registry/v1/instruments?query=EUR&profile=fx&status=active&limit=20
```

### Broker Symbol Resolution

Resolve a broker-native symbol to an APEX canonical ID:

```
GET /registry/v1/resolve?broker_id=fxcm&broker_symbol=EUR/USD
```

**Response:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_id": "fxcm",
  "broker_symbol": "EUR/USD",
  "confidence": "exact|fuzzy",
  "alternatives": []
}
```

### Broker Symbol Manifest

Download a broker's complete symbol-to-APEX-ID mapping:

```
GET /registry/v1/brokers/{broker_id}/manifest
```

---

## Versioning and Stability

Instrument IDs are **permanent**. Once assigned, an APEX instrument ID is never recycled or reassigned.

Deprecated instruments are marked `"status": "deprecated"` and retain their ID indefinitely. The `deprecated_version` field records when deprecation occurred.

Breaking changes to the canonical schema require a MAJOR version bump of the registry, not just the core spec.

---

## Broker Onboarding Process

When a new broker joins the APEX Protocol network, the following steps occur:

1. **Broker submits symbol manifest** — a CSV or JSON file mapping their native symbols to APEX instrument IDs (or flagging new instruments requiring registration)
2. **Registry team reviews** — validates symbols against canonical definitions, resolves conflicts
3. **New instruments registered** — any genuinely novel instruments receive new APEX IDs
4. **Broker manifest published** — the broker's mapping goes live in the registry
5. **Conformance harness inputs updated** — any alpha harness inputs or registry-backed fixtures used for broker validation are updated as needed

Brokers should re-submit their manifest whenever they add new instruments to their offering.

---

## Requesting New Instrument IDs

To request registration of an instrument not yet in the registry:

1. Open a GitHub issue in [APEX-Standard/protocol](https://github.com/APEX-Standard/protocol) with label `registry-request`
2. Provide: display name, asset class, profile, underlying details, and any existing identifiers (ISIN, SEDOL, Bloomberg ticker)
3. Registry maintainers will assign an APEX ID within 5 business days

---

## Seed Registry — FX Major Pairs

| APEX Instrument ID | Display Name | Pip Size |
|-----------------|--------------|----------|
| `APEX:FX:EURUSD` | Euro / US Dollar | 0.0001 |
| `APEX:FX:GBPUSD` | British Pound / US Dollar | 0.0001 |
| `APEX:FX:USDJPY` | US Dollar / Japanese Yen | 0.01 |
| `APEX:FX:USDCHF` | US Dollar / Swiss Franc | 0.0001 |
| `APEX:FX:AUDUSD` | Australian Dollar / US Dollar | 0.0001 |
| `APEX:FX:USDCAD` | US Dollar / Canadian Dollar | 0.0001 |
| `APEX:FX:NZDUSD` | New Zealand Dollar / US Dollar | 0.0001 |
| `APEX:FX:EURGBP` | Euro / British Pound | 0.0001 |
| `APEX:FX:EURJPY` | Euro / Japanese Yen | 0.01 |
| `APEX:FX:GBPJPY` | British Pound / Japanese Yen | 0.01 |
| `APEX:FX:XAUUSD` | Gold / US Dollar | 0.01 |
| `APEX:FX:XAGUSD` | Silver / US Dollar | 0.001 |

## Seed Registry — Major Index CFDs

| APEX Instrument ID | Display Name | Point Value |
|-----------------|--------------|-------------|
| `APEX:CFD:IDX:SPX500` | S&P 500 | $10 |
| `APEX:CFD:IDX:NAS100` | NASDAQ 100 | $10 |
| `APEX:CFD:IDX:US30` | Dow Jones 30 | $10 |
| `APEX:CFD:IDX:UK100` | FTSE 100 | £10 |
| `APEX:CFD:IDX:GER40` | DAX 40 | €10 |
| `APEX:CFD:IDX:FRA40` | CAC 40 | €10 |
| `APEX:CFD:IDX:JPN225` | Nikkei 225 | ¥1000 |
| `APEX:CFD:IDX:AUS200` | ASX 200 | A$10 |

## Seed Registry — Major Crypto Spot

| APEX Instrument ID | Display Name | Tick Size |
|-----------------|--------------|-----------|
| `APEX:CRYPTO:SPOT:BTCUSDT` | Bitcoin / Tether | 0.01 |
| `APEX:CRYPTO:SPOT:ETHUSDT` | Ethereum / Tether | 0.01 |
| `APEX:CRYPTO:SPOT:SOLUSDT` | Solana / Tether | 0.01 |
| `APEX:CRYPTO:SPOT:BTCUSDC` | Bitcoin / USD Coin | 0.01 |
| `APEX:CRYPTO:SPOT:ETHBTC` | Ethereum / Bitcoin | 0.00001 |
| `APEX:CRYPTO:SPOT:BTCUSD` | Bitcoin / US Dollar | 0.01 |

## Seed Registry — Major Crypto Perpetuals

| APEX Instrument ID | Display Name | Tick Size |
|-----------------|--------------|-----------|
| `APEX:CRYPTO:PERP:BTCUSDT` | BTC/USDT Perpetual | 0.01 |
| `APEX:CRYPTO:PERP:ETHUSDT` | ETH/USDT Perpetual | 0.01 |
| `APEX:CRYPTO:PERP:SOLUSDT` | SOL/USDT Perpetual | 0.01 |
| `APEX:CRYPTO:PERP:BTCUSD` | BTC/USD Perpetual (inverse) | 0.01 |
| `APEX:CRYPTO:PERP:ETHUSD` | ETH/USD Perpetual (inverse) | 0.01 |
