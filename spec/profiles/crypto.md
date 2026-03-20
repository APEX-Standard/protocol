# APEX Protocol — Layer 2: Crypto Profile

**Version:** `0.1.0-alpha`
**Applies to:** Crypto Spot, Perpetual Futures
**Depends on:** Core `0.1.0`

---

## Overview

The Crypto Profile extends Layer 1 Core with capabilities specific to cryptocurrency spot trading and perpetual futures. It covers funding rates, liquidation mechanics, margin modes, leverage, and cross-wallet transfers.

Brokers implementing this profile must declare `"crypto"` in their `apex.session.capabilities` response.

---

## Crypto Sub-Types

The Crypto profile covers two sub-types, declared in the instrument registry:

| Sub-type | Instrument ID prefix | Examples |
|----------|---------------------|---------|
| Spot | `APEX:CRYPTO:SPOT:` | BTC/USDT, ETH/BTC, SOL/USDC |
| Perpetual | `APEX:CRYPTO:PERP:` | BTC/USDT perp, ETH/USDT perp |

---

## Profile Extensions to Core Tools

### Order Object — Crypto `profile_data`

```json
{
  "profile": "crypto",
  "profile_data": {
    "crypto_type": "spot|perpetual",
    "margin_mode": "cross|isolated",
    "leverage": 10,
    "reduce_only": false,
    "post_only": false
  }
}
```

**Field applicability:**

| Field | Spot | Perpetual |
|-------|------|-----------|
| `crypto_type` | Required | Required |
| `margin_mode` | — | Required |
| `leverage` | — | Required |
| `reduce_only` | — | Optional |
| `post_only` | Optional | Optional |

**`reduce_only`:** When `true`, the order can only reduce an existing position. Rejected if it would increase exposure. Critical for agents managing risk during volatile markets.

**`post_only`:** When `true`, the order is guaranteed to be a maker order. Rejected if it would immediately match. Useful for agents optimising execution costs.

### Position Object — Crypto `profile_data`

```json
{
  "profile_data": {
    "crypto_type": "spot|perpetual",
    "margin_mode": "cross|isolated",
    "leverage": 10,
    "liquidation_price": 25000.00,
    "initial_margin": 500.00,
    "maintenance_margin": 250.00,
    "margin_currency": "USDT",
    "accrued_funding": -12.50,
    "next_funding_time": "ISO8601",
    "mark_price": 50100.00
  }
}
```

**Spot positions** include only `crypto_type`. All margin, funding, and liquidation fields are omitted.

**Perpetual positions** include all fields. `mark_price` is the exchange's fair price used for liquidation calculations, distinct from the last traded price.

---

## Crypto-Specific Tools

### `apex.crypto.funding_rate`

Query the current and predicted funding rate for a perpetual instrument. Funding rates are periodic payments between long and short holders that anchor the perpetual price to the spot index.

**Input:**
```json
{
  "instrument_id": "APEX:CRYPTO:PERP:BTCUSDT"
}
```

**Output:**
```json
{
  "instrument_id": "APEX:CRYPTO:PERP:BTCUSDT",
  "broker_symbol": "BTCUSDT",
  "current_rate": 0.0001,
  "current_rate_annualised": 0.1095,
  "predicted_rate": 0.00012,
  "funding_interval_hours": 8,
  "next_funding_time": "ISO8601",
  "countdown_seconds": 14400,
  "index_price": 50000.00,
  "mark_price": 50050.00,
  "timestamp": "ISO8601"
}
```

**Rate convention:** A positive rate means longs pay shorts. A negative rate means shorts pay longs. Rates are expressed as a fraction per funding interval (e.g., `0.0001` = 0.01% per 8 hours).

---

### `apex.crypto.liquidation_estimate`

Estimate the liquidation price for a hypothetical or existing position. Agents should call this for pre-trade risk assessment and position sizing.

**Input:**
```json
{
  "account_id": "string",
  "instrument_id": "APEX:CRYPTO:PERP:BTCUSDT",
  "side": "buy|sell",
  "quantity": 1.0,
  "leverage": 10,
  "margin_mode": "isolated",
  "entry_price": 50000.00
}
```

**Output:**
```json
{
  "instrument_id": "APEX:CRYPTO:PERP:BTCUSDT",
  "side": "buy",
  "entry_price": 50000.00,
  "liquidation_price": 45250.00,
  "margin_required": 5000.00,
  "maintenance_margin": 2500.00,
  "margin_currency": "USDT",
  "distance_pct": 9.50,
  "warnings": []
}
```

**`distance_pct`:** The percentage distance from entry price to liquidation price. Agents can use this as a quick risk metric.

---

### `apex.crypto.transfer`

Transfer funds between wallets on the same exchange. Crypto exchanges typically separate funds into spot, futures/derivatives, and funding wallets. Agents must move funds to the correct wallet before trading.

**Input:**
```json
{
  "account_id": "string",
  "from_wallet": "spot|futures|funding",
  "to_wallet": "spot|futures|funding",
  "currency": "USDT",
  "amount": 1000.00
}
```

**Output:**
```json
{
  "transfer_id": "string",
  "from_wallet": "spot",
  "to_wallet": "futures",
  "currency": "USDT",
  "amount": 1000.00,
  "status": "completed|pending|rejected",
  "rejection_reason": null,
  "completed_at": "ISO8601"
}
```

Transfers between wallets on the same exchange are typically instant and fee-free.

---

## Instrument ID Format — Crypto

### Spot

```
APEX:CRYPTO:SPOT:{BASE}{QUOTE}
```

Examples:

| Pair | Instrument ID |
|------|--------------|
| Bitcoin / Tether | `APEX:CRYPTO:SPOT:BTCUSDT` |
| Ethereum / Tether | `APEX:CRYPTO:SPOT:ETHUSDT` |
| Ethereum / Bitcoin | `APEX:CRYPTO:SPOT:ETHBTC` |
| Solana / USDC | `APEX:CRYPTO:SPOT:SOLUSDC` |
| Bitcoin / US Dollar | `APEX:CRYPTO:SPOT:BTCUSD` |

### Perpetuals

```
APEX:CRYPTO:PERP:{BASE}{QUOTE}
```

Examples:

| Contract | Instrument ID |
|----------|--------------|
| BTC/USDT Perpetual | `APEX:CRYPTO:PERP:BTCUSDT` |
| ETH/USDT Perpetual | `APEX:CRYPTO:PERP:ETHUSDT` |
| SOL/USDT Perpetual | `APEX:CRYPTO:PERP:SOLUSDT` |
| BTC/USD Perpetual (inverse) | `APEX:CRYPTO:PERP:BTCUSD` |

**Quote currency convention:** `USDT` and `USDC` denote linear (stablecoin-margined) contracts. `USD` denotes inverse (coin-margined) contracts where the base asset is used as collateral.

---

## Funding Rate Mechanics

Perpetual futures have no expiry date. To keep the perpetual price anchored to the underlying spot index, exchanges use a **funding rate** mechanism:

- Funding is exchanged between long and short holders at regular intervals (typically every 8 hours)
- When the rate is **positive**, longs pay shorts (perpetual trading at a premium to spot)
- When the rate is **negative**, shorts pay longs (perpetual trading at a discount to spot)

The funding payment for a position is:

```
Funding Payment = Position Value × Funding Rate
```

Brokers must expose funding rates through `apex.crypto.funding_rate` and accumulate funding payments in the position `profile_data.accrued_funding` field.

---

## Margin Modes

### Cross Margin

The entire futures wallet balance is shared across all open positions. Liquidation of one position can consume margin reserved for others. Higher capital efficiency but correlated liquidation risk.

### Isolated Margin

Each position has a dedicated margin allocation. Liquidation of one position does not affect others. Maximum loss is limited to the isolated margin amount. Lower capital efficiency but contained risk.

Brokers must indicate the active margin mode in both order and position `profile_data`. Switching margin mode on an existing position is broker-specific and not covered by v0.1.

---

## Conformance Requirements

A broker declaring the `crypto` profile must implement:

**Mandatory:**
- All Layer 1 Core tools
- Crypto `profile_data` fields on order and position objects
- `apex.crypto.funding_rate`
- `apex.crypto.transfer`
- Liquidation price in perpetual position `profile_data`

**Recommended:**
- `apex.crypto.liquidation_estimate`
- Mark price in position `profile_data`
- Predicted funding rate in `apex.crypto.funding_rate`
- `distance_pct` in liquidation estimate output

**Optional:**
- `post_only` order support
- `reduce_only` order support
- Inverse contract support (`USD`-quoted perpetuals)
