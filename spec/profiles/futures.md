# APEX Protocol — Layer 2: Futures Profile

**Version:** `0.3.0-alpha`  
**Applies to:** Listed futures on regulated derivatives exchanges  
**Depends on:** Core `0.2.0` (string-decimal wire encoding per RFC-0001)

---

## Overview

The Futures Profile extends Layer 1 Core with capabilities specific to exchange-listed futures contracts on regulated derivatives venues (such as CME Group — CME, CBOT, NYMEX, COMEX — Eurex, or ICE). It covers contract identity across expirations, contract chains and rolls, exchange-set margin schedules, broker-set intraday margins, daily settlement, and expiration/delivery handling.

Brokers implementing this profile must declare `"futures"` in their `apex.session.capabilities` response.

The profile is implementation-neutral. It names exchanges and contracts because that is where listed futures live, but it assumes nothing about any particular broker, FCM, or trading platform. Any futures trading firm can implement this specification exactly as written; venue and contract references are illustrative, never normative endorsements.

Futures are a top-level asset class: the `APEX:FUT:` namespace, matching ISO 10962 (CFI category `F`) and FIX `SecurityType` conventions. Registry entries carry `"asset_class": "fut"`, no sub-class, and `"profile": "futures"`. The `APEX:OPT:` namespace is reserved for listed options and is not covered by this profile. (The `APEX:DERIV:` umbrella reserved in `0.1.0-alpha` was retired unpopulated — see RFC-0002.)

---

## Futures Categories

The futures profile covers listed contracts across the standard exchange categories, declared as `category` in the instrument registry's canonical block:

| Category | Registry value | Examples |
|----------|---------------|----------|
| Equity Index | `equity_index` | E-mini S&P 500 (ES), E-mini NASDAQ-100 (NQ), Micro E-minis (MES, MNQ) |
| Energy | `energy` | Crude Oil (CL), Natural Gas (NG) |
| Metals | `metals` | Gold (GC), Silver (SI), Copper (HG) |
| Currency | `currency` | Euro FX (6E), Japanese Yen (6J) |
| Interest Rates | `rates` | 30-Year Bond (ZB), 10-Year Note (ZN) |
| Agriculture | `agriculture` | Corn (ZC), Soybeans (ZS), Wheat (ZW) |
| Crypto | `crypto` | Micro Bitcoin (MBT), Micro Ether (MET) |

Micro contracts (typically 1/10 the size of their full-size counterparts) are distinct contract roots with their own instrument IDs, not a sub-type of the full-size contract.

---

## Instrument ID Format — Futures

### Contract Roots (Continuous Reference)

```
APEX:FUT:{ROOT}
```

The root identifies the contract family — e.g. `APEX:FUT:ES` for the E-mini S&P 500. Root IDs serve registry metadata, instrument discovery, and continuous market-data series. **Orders must not target a root ID** — brokers must reject root-targeted orders with `APEX_4010` (invalid instrument) and may indicate the current front month in the error detail.

Continuous-series construction for root IDs (roll timing, back-adjustment method) is broker-defined in this version; agents must not assume that root-ID quote or candle series are comparable across brokers. Only the identity convention is normative.

### Dated Contracts (Tradeable)

```
APEX:FUT:{ROOT}{MONTH_CODE}{YY}
```

Dated contracts append the standard exchange month code and a two-digit year to the root. `APEX:FUT:ESZ26` is the December 2026 E-mini S&P 500.

Standard month codes:

| Code | Month | Code | Month | Code | Month |
|------|-------|------|-------|------|-------|
| `F` | January | `K` | May | `U` | September |
| `G` | February | `M` | June | `V` | October |
| `H` | March | `N` | July | `X` | November |
| `J` | April | `Q` | August | `Z` | December |

The two-digit year avoids the single-digit decade ambiguity found in some platform symbologies (`ESZ6` could be 2016 or 2026; `ESZ26` cannot).

### Broker Symbol Normalization

Platforms render dated contracts in divergent native formats — `ESZ26`, `ESZ6`, `ES 12-26` (root + MM-YY), or `MES DEC26`. Broker mappings in the instrument registry normalize each native format to the canonical dated ID, exactly as FX mappings normalize `EUR/USD` vs `EURUSD`.

Like all APEX instrument IDs, dated contract IDs are permanent. When a contract expires its registry entry becomes `"status": "inactive"`; the ID is never recycled. Because IDs are permanent, the two-digit year eventually collides across centuries (`ESZ26` could not also denote December 2126); resolving that horizon is explicitly out of scope for alpha and will be handled by a registry-versioned convention before it can arise.

---

## Profile Extensions to Core Tools

### Order Object — Futures `profile_data`

The futures profile defines no mandatory order `profile_data` fields in this version. Contract identity — including expiration — is fully encoded in the dated instrument ID, so a core order object is sufficient to trade futures.

```json
{
  "profile": "futures",
  "profile_data": {}
}
```

Two core-field rules are normative for futures orders:

- **Quantities are whole contracts.** `quantity_unit` is `"contracts"`, `min_quantity` is `"1"`, `quantity_step` is `"1"`. Brokers must reject fractional contract quantities.
- **Protective offsets use ticks.** Brokers declaring this profile must support the `ticks` offset type on `stop_loss`, `take_profit`, and `trailing_stop` (e.g. a stop 8 ticks below entry). The `pips` offset type is not meaningful for futures and must be rejected. Absolute `price` and `percent` offsets retain their core semantics.

### Position Object — Futures `profile_data`

```json
{
  "profile_data": {
    "category": "equity_index",
    "exchange": "XCME",
    "root": "APEX:FUT:ES",
    "contract_month": "2026-12",
    "expiration_date": "2026-12-18",
    "first_notice_date": null,
    "days_to_expiration": 42,
    "settlement_type": "cash",
    "contract_size": "50",
    "contract_unit": "index_points",
    "tick_size": "0.25",
    "tick_value": "12.50",
    "point_value": "50.00",
    "point_value_currency": "USD",
    "initial_margin": "15500.00",
    "maintenance_margin": "14000.00",
    "day_trading_margin": "500.00",
    "prior_settlement_price": "6205.25"
  }
}
```

**Field notes:**

- `exchange` — ISO 10383 MIC of the listing exchange (`XCME`, `XCBT`, `XNYM`, `XCEC`, `XEUR`, `IFUS`), consistent with the MIC convention used in CFD instrument IDs.
- `first_notice_date` — `null` for cash-settled contracts; required for physically-delivered contracts.
- `initial_margin` / `maintenance_margin` — the exchange-set overnight margin requirement per contract, as passed through by the broker.
- `day_trading_margin` — the broker-set intraday margin per contract, if offered; `null` when the broker does not discount intraday margin. Brokers set these independently of the exchange (e.g. reduced intraday margins on micro contracts).
- `prior_settlement_price` — the prior session's exchange settlement price, the reference for daily mark-to-market.

All money/price fields are string-encoded decimals per the `0.2.0-alpha` wire encoding rules (RFC-0001). **`contract_size` is a string-decimal in the futures profile** — micro contracts have fractional sizes (Micro Bitcoin is 0.1 BTC, Micro Ether is 0.1 ETH), so the integer typing that RFC-0001 preserves for the CFD profile's `contract_size` does not apply here (see the amendment note in RFC-0001). `days_to_expiration` remains an integer. Margin fields (`initial_margin`, `maintenance_margin`, `day_trading_margin`) are denominated per contract in the contract's trading currency.

### Instrument Details — Futures `profile_data`

`apex.market.details` must return the futures contract specification in `profile_data`, so agents can size positions in ticks and check expiry and margin **before** placing an order — not only after holding a position:

```json
{
  "instrument_id": "APEX:FUT:ESZ26",
  "profile": "futures",
  "quantity_unit": "contracts",
  "min_quantity": "1",
  "quantity_step": "1",
  "profile_data": {
    "root": "APEX:FUT:ES",
    "category": "equity_index",
    "exchange": "XCME",
    "currency": "USD",
    "contract_month": "2026-12",
    "expiration_date": "2026-12-18",
    "first_notice_date": null,
    "days_to_expiration": 42,
    "settlement_type": "cash",
    "contract_size": "50",
    "contract_unit": "index_points",
    "tick_size": "0.25",
    "tick_value": "12.50",
    "point_value": "50.00",
    "point_value_currency": "USD",
    "initial_margin": "15500.00",
    "maintenance_margin": "14000.00",
    "day_trading_margin": "500.00",
    "prior_settlement_price": "6205.25",
    "sessions": [
      { "type": "eth", "day": "monday", "open": "17:00", "close": "16:00", "timezone": "America/Chicago" },
      { "type": "rth", "day": "monday", "open": "08:30", "close": "15:00", "timezone": "America/Chicago" },
      { "type": "maintenance", "day": "monday", "open": "15:15", "close": "15:30", "timezone": "America/Chicago" },
      { "type": "maintenance", "day": "monday", "open": "16:00", "close": "17:00", "timezone": "America/Chicago" }
    ]
  }
}
```

**Field notes:**

- For a **root ID**, `apex.market.details` describes the contract family: expiration fields (`contract_month`, `expiration_date`, `first_notice_date`, `days_to_expiration`) are `null`, while margin fields and `prior_settlement_price` reflect the current front month.
- `sessions` expresses what the core `trading_hours` shape cannot: session typing and overnight spans. `type` is `eth` (full electronic session), `rth` (regular trading hours), or `maintenance` (trading halt). `day` is the **trade date**; when `open` ≥ `close`, the session opens at `open` on the **preceding calendar day** — so Monday's ETH entry above opens Sunday 17:00 and closes Monday 16:00 America/Chicago. Brokers must still populate the core `trading_hours` field as a coarse fallback for profile-unaware consumers.
- `prior_settlement_price` here lets agents obtain the daily mark reference for instruments they do not hold.

---

## Position Netting

Futures positions are **net per dated contract**. A fill opposite an existing position reduces or closes it (and opens the remainder in the opposite direction if larger); a broker never reports simultaneous long and short positions in the same dated contract for one account. This differs from the FX profile's optional hedging mode — the futures profile has no `netting_mode`; netting is the only model.

---

## Futures-Specific Tools

### `apex.futures.contract_chain`

List the dated contracts for a contract root, with expiration and liquidity data. This is how agents resolve a root to the front month and plan rolls.

**Annotations:** `readOnlyHint: true`

**Input:**
```json
{
  "root": "APEX:FUT:ES",
  "include_expired": false
}
```

**Output:**
```json
{
  "root": "APEX:FUT:ES",
  "contracts": [
    {
      "instrument_id": "APEX:FUT:ESZ26",
      "contract_month": "2026-12",
      "expiration_date": "2026-12-18",
      "first_notice_date": null,
      "settlement_type": "cash",
      "is_front_month": true,
      "volume": 1250000,
      "open_interest": 2100000,
      "status": "active"
    },
    {
      "instrument_id": "APEX:FUT:ESH27",
      "contract_month": "2027-03",
      "expiration_date": "2027-03-19",
      "first_notice_date": null,
      "settlement_type": "cash",
      "is_front_month": false,
      "volume": 41000,
      "open_interest": 98000,
      "status": "active"
    }
  ]
}
```

`is_front_month` reflects the broker's front-month designation (typically the highest-liquidity contract, accounting for roll periods), not merely the nearest expiration.

`status` is `active|inactive`. Expired contracts are `inactive` and are **excluded by default**; `include_expired: true` includes them (with their final `volume`/`open_interest` reported as `0` if the broker does not retain historical figures). Exactly one contract in the returned chain has `is_front_month: true`.

---

### `apex.futures.margin_schedule`

Query per-contract margin requirements — exchange overnight margins and any broker intraday margins.

**Annotations:** `readOnlyHint: true`

**Input:**
```json
{
  "account_id": "string",
  "instrument_id": "APEX:FUT:ESZ26"   // Optional — omit for all tradeable contracts
}
```

**Output:**
```json
{
  "margins": [
    {
      "instrument_id": "APEX:FUT:ESZ26",
      "currency": "USD",
      "initial_margin": "15500.00",
      "maintenance_margin": "14000.00",
      "day_trading_margin": "500.00",
      "day_trading_hours": [
        { "day": "monday", "from": "08:30", "to": "15:45", "timezone": "America/Chicago" }
      ],
      "as_of": "2026-07-23T00:00:00Z"
    }
  ]
}
```

`day_trading_hours` declares when the intraday margin applies; outside those hours the exchange overnight margins govern, and brokers typically auto-liquidate or require a margin top-up at the boundary. The window must end **before** the session close (brokers commonly force-flatten day-margin positions 15–30 minutes before the equity-index close at 16:00 America/Chicago — hence `15:45` above), never inside the maintenance halt.

---

## Margin Model

Futures margin is performance bond, not borrowing. Two tiers apply:

1. **Exchange margin** — initial and maintenance requirements set by the exchange per contract (SPAN or successor methodology), adjusted for volatility, liquidity, and pending events. The broker passes these through.
2. **Broker intraday margin** — a broker-set discount for positions held only within the trading session, commonly a small fraction of the exchange requirement (micro-contract day margins are often 1/20th of overnight margin or less).

Brokers must report margin through the core account schema (`used_margin`, `free_margin`, `margin_level_pct`) using whichever tier currently governs the account's positions, and must expose the per-contract schedule via `apex.futures.margin_schedule`.

`apex.risk.check` `required_margin` reflects the margin tier that would govern at execution time — the day-trading margin inside its declared `day_trading_hours` window, the exchange margin otherwise — and brokers should warn (via the check's `warnings` array) that positions held past the day-margin window re-margin at exchange rates.

Account-level protections (daily loss limits, trailing max drawdown, auto-liquidation thresholds) are reported through the core risk domain (`apex.risk.*`) — they are not futures-specific and gain no profile fields.

---

## Daily Settlement

Futures positions are marked to market daily at the exchange settlement price. Variation margin is credited or debited to the account in cash each session, unlike CFDs (financing charge) or FX (rollover swap) — holding cost is embedded in the contract basis rather than charged as a fee.

Implementation requirements:

- `balance` and `equity` in the core account summary must reflect posted variation margin once the broker's settlement cycle completes.
- `unrealised_pnl` retains its core definition — measured from the position's open price, not from the prior settlement. Brokers that internally account in open-trade-equity terms must convert.
- `prior_settlement_price` in position `profile_data` gives agents the daily mark reference.
- **Daily settlement postings appear in `apex.account.history`** as `event_type: "funding"` with `event_subtype: "variation_margin"`, one event per instrument per settlement cycle, with `pnl` carrying the signed cash amount. This is how agents reconcile daily statements.

---

## Expiration and Delivery

- Cash-settled contracts (`settlement_type: "cash"`) expire into a final cash mark; no delivery risk exists.
- Physically-delivered contracts (`settlement_type: "physical"`) carry a `first_notice_date`. Brokers must either block opening positions at or past first notice, or force-liquidate before delivery obligations attach, per their account terms. Agents should treat `days_to_expiration` and `first_notice_date` as hard scheduling constraints.
- Expired dated contracts become `"status": "inactive"` in the registry and must be excluded from `apex.market.search` results by default.

---

## Trading Sessions

Listed futures trade nearly 24 hours on weekdays (for example, CME Globex: Sunday 17:00 – Friday 16:00 America/Chicago, with a daily maintenance break 16:00–17:00). Brokers must publish per-instrument sessions through the `profile_data.sessions` structure in `apex.market.details` (see Instrument Details above), which expresses session typing (`eth`/`rth`/`maintenance`) and overnight spans that the core `trading_hours` shape cannot. The core `trading_hours` field must still be populated as a coarse fallback for profile-unaware consumers.

---

## Deferred Capabilities

The following are explicitly deferred from this version — documented here so implementers know they are recognized, not overlooked:

- **Expiration/roll notifications** (e.g. `notifications/apex.futures.expiration_warning`) — agents poll `days_to_expiration` and `apex.futures.contract_chain` in this version; push notification types are a planned follow-up consistent with the protocol's agentic-safety posture.
- **Holiday calendars and early closes** — no APEX profile models venue holidays yet; `sessions` describes the regular weekly schedule only.
- **Stop trigger method disclosure** (last trade vs bid/ask trigger) — broker-specific today; a candidate optional order `profile_data` field.
- **Continuous-series construction** (back-adjustment method, roll timing for root-ID series) — broker-defined; only the root-ID identity convention is normative.
- **Exchange-native calendar spreads** — no spread instrument identity or spread order support at alpha; agents can leg rolls with two outright orders.
- **Price limits and circuit breakers** — equity-index daily limits (7/13/20% declines during RTH, ±5% overnight banding) and dynamic circuit breakers in other categories are not modeled; limit-locked markets surface only as order rejections in this version. A candidate `market.details` `profile_data` extension.

---

## Conformance Requirements

A broker declaring the `futures` profile must implement:

**Mandatory:**
- All Layer 1 Core tools
- Futures `profile_data` on position objects **and** on `apex.market.details` responses
- `apex.futures.contract_chain`
- Rejection of orders targeting contract root IDs
- Whole-contract quantity enforcement (`quantity_unit: "contracts"`, integral quantities)
- Expired-contract exclusion in `apex.market.search` defaults
- `ticks` protective-offset support on orders

**Recommended:**
- `apex.futures.margin_schedule`
- `day_trading_margin` disclosure where intraday margins are offered
- `profile_data.sessions` with `rth`/`eth`/`maintenance` typing
- Continuous (root ID) market-data series for quotes and candles
- First-notice-date protection for physically-delivered contracts
