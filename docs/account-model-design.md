# APEX Protocol — Account and Position Model Design

**Version:** `0.3.0-alpha`

---

## Overview

An autonomous trading agent asks two questions constantly: **"What do I own?"** and **"What can I afford?"** Every decision cycle begins with these answers. If the agent cannot get them quickly, consistently, and in a format it can reason over without broker-specific parsing, it cannot trade.

APEX normalizes the account and position model across all broker types — retail FX market makers, CFD providers, crypto exchanges, DMA venues — into a consistent set of fields, resources, and lifecycle semantics. The agent sees the same account summary shape whether the underlying broker is a London spread-bet firm or a Binance futures API. Profile-specific enrichment (rollover rates, funding fees, liquidation prices) layers on top without breaking the base model.

This document walks through the account model from the agent's perspective: what the numbers mean, how positions behave, how history accumulates, and how the whole thing stays fresh enough for autonomous execution.

---

## The Account Summary

The account summary is the single most important object for risk-aware execution. It answers "What can I afford?" in seven numbers.

**Resource URI:** `apex://account/summary/{account_id}`

**Fields:**

| Field | Type | Meaning |
|---|---|---|
| `balance` | number | Settled cash in the account. This is what you would have if every open position vanished without P&L. It changes only on realized events: closed trades, deposits, withdrawals, commissions, rollovers, funding fees. |
| `equity` | number | The account's current liquidation value. Balance plus the mark-to-market value of all open positions. This is what you would have if you closed everything right now at current prices. |
| `used_margin` | number | Margin currently reserved to maintain open positions. This is collateral the broker holds against your exposure. You cannot use it for new trades. |
| `free_margin` | number | Equity available for new exposure. This is what the agent can spend on new positions before triggering a margin call. |
| `margin_level_pct` | number | The ratio of equity to used margin, expressed as a percentage. The broker uses this to decide when to warn you and when to start liquidating. |
| `unrealised_pnl` | number | Total mark-to-market profit or loss across all open positions. Positive means your positions are in profit. Negative means they are underwater. This is not cash — it becomes cash when you close. |
| `realised_pnl_today` | number | Cumulative realized profit or loss for the current trading day. Resets on the broker's daily cut. Includes closed trades, commissions, rollovers, and funding fees settled today. |

### The Key Equations

Three equations govern the relationship between these fields. An agent that understands these equations can reason about risk without broker-specific logic.

**Equity:**

```
equity = balance + unrealised_pnl
```

If your balance is $10,000 and your open positions are up $250, your equity is $10,250. If those positions go underwater by $500, your equity drops to $9,500. The balance does not change until positions close — equity absorbs the live fluctuation.

**Free margin:**

```
free_margin = equity - used_margin
```

If your equity is $10,250 and $500 is locked as margin, you have $9,750 available for new trades. This is the number the agent checks before sizing a new position. If free margin is zero, you cannot open anything new.

**Margin level:**

```
margin_level_pct = (equity / used_margin) * 100
```

If equity is $10,250 and used margin is $500, your margin level is 2,050%. That is healthy. If equity drops to $500 against $500 of used margin, your margin level is 100% — you are at the margin call threshold on most retail brokers. If it drops to $250, you are at 50% — the broker starts liquidating positions.

When no positions are open, `used_margin` is zero. The margin level is conventionally reported as a very large number or omitted. Agents should treat zero used margin as "no margin constraint active."

### Concrete Example

An agent connects to an FX broker. The account summary reads:

```json
{
  "balance": "10000.00",
  "equity": "10250.00",
  "used_margin": "500.00",
  "free_margin": "9750.00",
  "margin_level_pct": "2050.00",
  "unrealised_pnl": "250.00",
  "realised_pnl_today": "0.00"
}
```

The agent has one open EURUSD position that is up $250. The $500 margin is held for that position. The agent has $9,750 free to work with. Margin level of 2,050% is well above any danger zone.

---

## Margin and Leverage

Margin is the collateral a broker requires to hold a position. In APEX, the margin requirement for an instrument is expressed as `margin_rate_pct` in `apex.market.details`. This single number determines how much leverage the instrument allows.

### The Relationship

```
margin_required = position_value * (margin_rate_pct / 100)
```

And leverage is the inverse:

```
leverage = 100 / margin_rate_pct
```

**Concrete example:** EURUSD has `margin_rate_pct: 0.5`. That means 0.5% margin, which is 200:1 leverage.

A position of 100,000 EUR (1 standard lot) at 1.0875 has a position value of $108,750. The margin required is:

```
$108,750 * 0.005 = $543.75
```

Rounded by the broker, roughly $500. That is the `used_margin` you see on the position object.

### Margin Thresholds

Two thresholds control what happens when the account is under stress, exposed through `apex.risk.limits`:

| Threshold | Typical Value | What Happens |
|---|---|---|
| `margin_call_level_pct` | 100% | Broker warns the account. Some brokers restrict new position opening. The agent should treat this as a soft halt — stop adding exposure, consider reducing. |
| `stop_out_level_pct` | 50% | Broker begins forced liquidation of positions, starting with the largest loser. This is not a request — the broker closes positions unilaterally to protect itself. |

**Walk-through:** The agent has equity of $600 and used margin of $500. Margin level is 120%. A sharp move against the position drops equity to $500. Margin level hits 100% — margin call. The agent should not open new positions. The move continues, equity drops to $250. Margin level is 50% — stop out. The broker starts closing positions.

The specific thresholds vary by broker and jurisdiction. European retail brokers under ESMA rules typically use 50% stop-out. Professional accounts may have lower thresholds. APEX exposes the broker's actual values through `apex.risk.limits` so the agent does not need to hardcode assumptions.

---

## Position Semantics

Positions represent live exposure after the broker's netting rules have been applied. The position object answers "What do I own?" for a single instrument.

### Required Broker Documentation

APEX core does not mandate whether a broker operates in netting mode or hedging mode. It mandates that the broker **documents** which mode it uses, because the agent's behavior must differ. Implementations must document:

- Whether the account is **netted** or **hedged**
- Whether multiple same-direction entries **collapse** into one position
- Whether opposite-direction entries **reduce** or **invert** exposure

### Netting Mode

In netting mode, there is at most one position per instrument per account. New entries in the same direction increase the position. Entries in the opposite direction reduce it.

**Scenario: Building and reducing a netted position**

1. Agent buys 100,000 EURUSD at 1.0850. The account now has one position: buy 100,000 EURUSD.
2. Agent buys another 100,000 EURUSD at 1.0860. The position **collapses** into one: buy 200,000 EURUSD. The open price becomes the volume-weighted average: (100,000 * 1.0850 + 100,000 * 1.0860) / 200,000 = 1.0855.
3. Agent sells 50,000 EURUSD at 1.0870. The position **reduces** to buy 150,000 EURUSD. The closed portion (50,000 at a profit of 1.0870 - 1.0855 = 15 pips) is realized into the balance. The open price of the remaining 150,000 stays at 1.0855.
4. Agent sells 200,000 EURUSD at 1.0840. The position first reduces to zero, then inverts to sell 50,000 EURUSD at 1.0840. The closed 150,000 (at a loss of 1.0855 - 1.0840 = -15 pips) is realized.

This is how most institutional FX platforms, equity brokers, and crypto exchanges work. One instrument, one position, one average price.

### Hedging Mode

In hedging mode, each entry creates an independent position with its own P&L, stop loss, and take profit. Opposite-direction positions coexist.

**Scenario: Hedged positions on the same instrument**

1. Agent buys 100,000 EURUSD at 1.0850 with SL at 1.0800 and TP at 1.0950. Position A is created.
2. Agent sells 100,000 EURUSD at 1.0870 with SL at 1.0920 and TP at 1.0800. Position B is created.
3. Both positions exist simultaneously. Position A shows +20 pips unrealized P&L. Position B shows 0 pips. They have independent stop losses and take profits.
4. Agent closes Position A at 1.0870. Realized profit: 20 pips. Position B remains open.

This is how many retail FX/CFD brokers (particularly MetaTrader 5 in hedging mode) operate. It allows strategies like locking in a loss while keeping the opposite direction open for reversal.

### What the Agent Sees

Regardless of mode, each position in `apex.account.positions` has the same base fields:

| Field | Meaning |
|---|---|
| `position_id` | Stable identifier. Survives partial closes. |
| `instrument_id` | APEX canonical instrument ID |
| `side` | `buy` or `sell` — the direction of exposure |
| `quantity` | Current open quantity in canonical units |
| `open_price` | Entry price (or volume-weighted average in netting mode) |
| `current_price` | Latest mark-to-market price |
| `unrealised_pnl` | Mark-to-market P&L in account currency |
| `used_margin` | Margin reserved for this position |
| `stop_loss` | Protection price, if set |
| `take_profit` | Protection price, if set |
| `profile_data` | Profile-specific enrichment (see Section 8) |

---

## Position Lifecycle

A position moves through three stages: open, modify protections, close. APEX provides distinct tools for each stage rather than overloading a single order entry mechanism.

### Stage 1: Open (via Order Fill)

A position is created when an order fills. The agent places an order with `apex.order.place`, the broker executes it, and a position appears in `apex://account/positions/{account_id}`.

```
Agent                          Broker
  |                              |
  |-- apex.order.place --------->|
  |   (buy 100k EURUSD market)  |
  |                              |
  |<-- order result -------------|
  |   (status: filled,           |
  |    position_id: pos_001)     |
  |                              |
  |<-- notifications/resources/  |
  |    updated (positions) ------|
  |                              |
  |-- read positions resource -->|
  |                              |
  |<-- positions: [{             |
  |      position_id: pos_001,   |
  |      side: buy,              |
  |      quantity: 100000,       |
  |      open_price: 1.0875      |
  |    }] ----------------------|
```

The order fill also appears in `apex://account/fills/{account_id}` and triggers a fill notification. The position is the result of the fill, not a separate event.

### Stage 2: Modify Protections (SL/TP/Trailing Stop)

Once a position is open, the agent modifies its protection levels using `apex.order.modify` with `target_type: "position"`. Only protection fields are valid for position modification — the agent cannot change entry price or quantity through modify.

```json
{
  "target_type": "position",
  "target_id": "pos_001",
  "modifications": {
    "stop_loss": { "type": "price", "value": "1.0820" },
    "take_profit": { "type": "price", "value": "1.1050" },
    "trailing_stop": { "type": "pips", "value": "30" }
  }
}
```

The broker responds with `status: "modified"` or `status: "rejected"`. Protection values appear on the position object after the next resource update.

### Stage 3: Close (via `apex.position.close`)

The agent closes a position — fully or partially — using `apex.position.close`. This is a first-class tool, not a workaround of placing an opposite-direction market order (though that is what the broker does internally).

**Full close:**

```json
{
  "account_id": "ACC_12345",
  "position_id": "pos_001"
}
```

Omitting `quantity` means close the entire position.

**Partial close:**

```json
{
  "account_id": "ACC_12345",
  "position_id": "pos_001",
  "quantity": "50000"
}
```

This closes half of a 100,000-unit position. The position remains in `apex://account/positions` with `quantity: 50000`. The closed portion is realized — balance changes, unrealized P&L reduces, used margin adjusts.

**The response:**

| Field | Meaning |
|---|---|
| `order_id` | The ID of the closing order the broker created internally |
| `status` | `filled`, `partially_filled`, or `rejected` |
| `fill_price` | The execution price of the close |
| `fill_quantity` | How much was closed |
| `remaining_quantity` | What remains open (0 if fully closed) |
| `closed_at` | Timestamp of the close |

After a full close, the position disappears from the positions resource. The P&L is realized into the balance. The corresponding fill appears in the fills resource.

### Position Close Semantics

`apex.position.close` is a convenience tool, but its semantics are precise. Internally, the broker treats a position close as placing an opposite-direction market order for the specified quantity. Closing a long 100,000 EURUSD position is equivalent to selling 100,000 EURUSD at market. The tool carries `destructiveHint: true` and `idempotentHint: false` annotations — it modifies account state irreversibly, and calling it twice on the same position will attempt to close twice (the second call would fail because the position no longer exists, or would close an additional portion if the position was only partially closed the first time).

Partial close with the `quantity` parameter reduces the position without eliminating it. If the agent holds 100,000 EURUSD long and calls `apex.position.close` with `quantity: 40000`, the broker sells 40,000 EURUSD at market. The position remains in `apex://account/positions` with `quantity: 60000`. The realized P&L on the 40,000 closed units flows into the balance. The remaining 60,000 units retain their original open price and continue to accrue unrealized P&L. Omitting `quantity` means close the entire position.

When a position has stop loss, take profit, or trailing stop protections attached, closing the position — fully or partially — interacts with those protections. A full close eliminates the position entirely, and all attached protections are cancelled automatically. A partial close reduces the position quantity, and brokers should proportionally adjust or maintain the protection levels. The stop loss and take profit prices typically remain unchanged (they are price-based triggers, not quantity-based), but the effective exposure protected by those triggers decreases because the underlying position is smaller. If the position's stop loss was set at 1.0820 before a partial close, it remains at 1.0820 after the partial close — but now it protects 60,000 units instead of 100,000. Trailing stops follow the same logic: the trailing distance persists, but the protected quantity reflects the reduced position.

---

## The Fills Resource

**Resource URI:** `apex://account/fills/{account_id}`

Every execution event — every time shares, contracts, or currency units change hands — produces a fill. The fills resource is the immutable ledger of execution. Positions tell you what you have now. Fills tell you how you got there.

Each fill contains:

| Field | Type | Meaning |
|---|---|---|
| `fill_id` | string | Unique, stable identifier. Survives replay. |
| `order_id` | string | The order that produced this fill |
| `account_id` | string | The account |
| `instrument_id` | string | APEX canonical instrument ID |
| `side` | string | `buy` or `sell` |
| `fill_quantity` | number | Quantity executed in this fill |
| `fill_price` | number | Execution price |
| `commission` | number | Commission charged (negative value) |
| `commission_currency` | string | Currency of the commission |
| `liquidity_flag` | string | `maker`, `taker`, or `unknown` |
| `position_id` | string or null | The position this fill created or affected |
| `timestamp` | string | When the fill occurred |

### Why Fills Matter for Replay

During SSE reconnect replay, fills are classified as `required` — they are replayed with their original event IDs, never elided. This is because a fill is a historical fact that cannot be reconstructed from current state. If the agent was disconnected when an order filled at 1.0847 at 14:32:07, it cannot recover that information from reading the current positions resource. The positions resource just shows "you have a position" — not when, at what price, or in how many partial fills it was built.

Fills are the audit trail. Positions are the summary.

### Liquidity Flag

Brokers operating as principal counterparty (OTC FX market makers, CFD providers) may permanently report `liquidity_flag: "unknown"`. This is valid and expected. The maker/taker distinction applies on lit venues with order books — not when the broker is the sole counterparty.

---

## Account History

The fills resource captures live execution. Account history captures everything else: closed trades with their realized P&L, funding events, cash movements, and corporate actions.

**Tool:** `apex.account.history`

**Input:** account_id, date range, event type filter, pagination cursor.

**Event types and sub-types:**

| Event Type | Sub-Types | What It Covers |
|---|---|---|
| `trade` | `fill` | A completed round trip — open and close prices, realized P&L, commission. This is the closed-trade record. |
| `funding` | `rollover`, `funding_fee`, `commission` | Periodic charges and credits. FX rollover (swap). Crypto perpetual funding. Trade commissions settled separately from fills. |
| `cash` | `deposit`, `withdrawal` | Money in, money out. Balance changes not related to trading. |
| `corporate_action` | `dividend_adjustment`, `split` | CFD-specific: dividend cash adjustments on equity CFD positions, stock split adjustments to position quantity and price. |

### Pagination

History is paginated with cursors. Each response includes `next_cursor` and `has_more`. The agent pages forward through the history by passing `cursor` from the previous response. This avoids offset-based pagination, which is unstable when new events arrive between pages.

### What History Looks Like

A closed EURUSD trade:

```json
{
  "event_id": "hist_001",
  "event_type": "trade",
  "event_subtype": "fill",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "quantity": "100000",
  "open_price": "1.0850",
  "close_price": "1.0900",
  "pnl": "500.00",
  "pnl_currency": "USD",
  "commission": "-7.00",
  "open_time": "2026-03-28T09:15:00Z",
  "close_time": "2026-03-28T14:22:00Z"
}
```

A rollover event:

```json
{
  "event_id": "hist_002",
  "event_type": "funding",
  "event_subtype": "rollover",
  "instrument_id": "APEX:FX:EURUSD",
  "pnl": "-2.50",
  "pnl_currency": "USD",
  "close_time": "2026-03-28T22:00:00Z"
}
```

The history resource is not subscribable as a realtime resource. It is a tool-based query over settled events. The realtime analog is the fills resource, which captures execution as it happens.

---

## Profile-Specific Enrichment

The base position model is asset-class agnostic. Profile extensions add fields that only make sense in specific markets. These appear in the `profile_data` object on each position. The base fields remain unchanged — profiles extend, they do not replace.

### FX Profile

FX positions carry rollover and pip valuation data.

| Field | Meaning |
|---|---|
| `base_currency` | EUR in EURUSD |
| `quote_currency` | USD in EURUSD |
| `rollover_long_daily` | Daily rollover charge for long positions (in account currency per lot per night) |
| `rollover_short_daily` | Daily rollover credit/charge for short positions |
| `accrued_rollover` | Cumulative rollover since the position opened |
| `pip_value` | Value of one pip in the quote currency for the position's quantity |
| `pip_value_currency` | Currency of the pip value |

Rollover (swap) is the cost of holding a leveraged FX position overnight. It reflects the interest rate differential between the two currencies. The triple rollover day — typically Wednesday — applies three nights of rollover to account for the weekend settlement gap. Agents holding positions across the daily cut should factor accrued rollover into P&L calculations.

### CFD Profile

CFD positions carry overnight financing and corporate action data.

| Field | Meaning |
|---|---|
| `cfd_type` | `equity`, `index`, or `commodity` |
| `underlying_exchange` | Exchange of the underlying (e.g., NASDAQ) |
| `overnight_financing_rate` | Annualized financing rate applied daily |
| `overnight_financing_daily` | Daily financing charge in account currency |
| `accrued_financing` | Cumulative financing since the position opened |
| `pending_dividend_adjustment` | Cash adjustment pending for upcoming ex-dividend dates |
| `contract_size` | Number of units per contract |
| `point_value` | Value of one point move in the point value currency |
| `point_value_currency` | Currency of the point value |

CFD overnight financing follows the formula: `position_value * (reference_rate + broker_spread) / 365`. This is disclosed in `apex.market.details` under `profile_data.financing_rate_basis` and `profile_data.financing_spread_pct`. Unlike FX rollover, which reflects interbank rate differentials, CFD financing is a direct borrowing cost.

For equity CFDs, dividend adjustments are critical. When the underlying stock goes ex-dividend, long CFD holders receive a cash credit and short holders are debited. The `pending_dividend_adjustment` field lets the agent anticipate this before the ex-date.

### Crypto Profile

Crypto perpetual positions carry margin mode, leverage, and liquidation data.

| Field | Meaning |
|---|---|
| `crypto_type` | `spot` or `perpetual` |
| `margin_mode` | `cross` or `isolated` — determines how margin is allocated |
| `leverage` | Position leverage multiplier |
| `liquidation_price` | Price at which the exchange will forcibly close the position |
| `initial_margin` | Margin required to open the position |
| `maintenance_margin` | Minimum margin to keep the position open |
| `margin_currency` | Currency of the margin (e.g., USDT) |
| `accrued_funding` | Cumulative funding payments since position open |
| `next_funding_time` | When the next funding settlement occurs |
| `mark_price` | Exchange's fair price used for liquidation calculation, distinct from last traded price |

**Cross margin vs isolated margin:** In cross margin mode, the entire futures wallet balance backs all positions. One position's liquidation can consume margin reserved for others — higher capital efficiency, but correlated liquidation risk. In isolated margin mode, each position has its own margin allocation. Liquidation of one position does not affect others — contained risk, but lower capital efficiency.

**Funding rates:** Perpetual futures have no expiry date. Funding rates anchor the perpetual price to the spot index through periodic payments between longs and shorts. A positive rate means longs pay shorts (perpetual trading at a premium). A negative rate means shorts pay longs (perpetual trading at a discount). Funding is settled every 8 hours on most exchanges and accumulates in `accrued_funding`.

**Liquidation price:** This is the most operationally critical field for crypto perpetual positions. Unlike FX/CFD stop-out, which is based on account-level margin level, crypto liquidation is per-position (in isolated mode) and calculated against the exchange's mark price, not the last traded price. The `mark_price` is a fair price index designed to resist manipulation.

Spot crypto positions include only `crypto_type`. All margin, funding, and liquidation fields are omitted — spot means you own the asset outright with no leverage.

---

## Account State as Realtime Resource

The five account resources are subscribable through MCP resource subscriptions, just like market data. They carry freshness metadata and form part of the execution-critical state an autonomous agent must monitor continuously.

### The Five Account Resources

| Resource URI | What It Contains | Update Trigger |
|---|---|---|
| `apex://account/summary/{account_id}` | Balance, equity, margin, P&L | Any position change, any fill, any cash event, periodic mark-to-market sweeps |
| `apex://account/positions/{account_id}` | All open positions with live P&L | Position open, close, partial close, protection modify, price change |
| `apex://account/orders/{account_id}` | All known orders and lifecycle state | Order placed, modified, filled, cancelled, expired |
| `apex://account/fills/{account_id}` | Execution events (fills) | Any fill or partial fill |
| `apex://account/risk/{account_id}` | Risk limits, kill switch, daily loss status | Risk state change, daily reset, admin action |

### Freshness Metadata

Every account resource includes three metadata fields:

| Field | Purpose |
|---|---|
| `as_of` | ISO 8601 timestamp — when the broker last considered this data current |
| `sequence` | Monotonically increasing integer — enables gap detection within the resource stream |
| `stale_after_ms` | How long the data remains valid for autonomous execution decisions |

The recommended staleness range for account state is 2,000-10,000 ms. Account snapshots update on fills and periodic sweeps. They do not need to be as fast as quotes (500-2,000 ms), but they must be fresh enough that the agent is not making position-sizing decisions on stale equity figures.

### Staleness and Execution Halting

Account state is execution-critical. If the account summary is stale, the agent does not know its current equity. If positions are stale, the agent does not know its current exposure. If the risk resource is stale, the agent does not know whether the kill switch is active.

APEX requires autonomous runtimes to halt new order submission when any execution-critical resource is stale:

```
current_time > as_of + stale_after_ms  →  resource is stale  →  halt execution
```

This is not optional for autonomous agents. The minimum execution-critical set includes:

- Quote state
- Account summary
- Positions
- Orders
- Risk state

If the SSE stream drops and the agent reconnects, it must re-read all account resources and re-establish freshness baselines before resuming execution. Replayed fill events from the gap tell the agent what happened while it was away. Current resource reads tell the agent what the state is now. Both are required before autonomous trading resumes.

### Sequence Continuity

Each account resource has its own independent `sequence` counter. The sequence for `apex://account/positions/ACC_12345` is independent of the sequence for `apex://account/orders/ACC_12345`. If the agent reads positions at sequence 42 and the next read returns sequence 44, it knows it missed an intermediate update. It must treat the current read as authoritative and rebuild any derived state.

If sequence continuity is broken and the agent cannot explain the gap (for example, after a reconnect without replay), autonomous execution must halt until the agent has re-read the resource and accepted the new baseline.

---

## Parallels

The APEX account model did not invent these concepts. It normalizes patterns that have existed in financial systems for decades.

| Established System | APEX Equivalent |
|---|---|
| **FIX Position Reports** (`PositionReport<AP>` messages) | `apex://account/positions/{account_id}` — same concept of a snapshot of live positions with mark-to-market valuations, but delivered as a subscribable MCP resource instead of a FIX message. FIX `SettlPrice` maps to `current_price`. FIX `PositionQty` maps to `quantity`. |
| **Bank account ledgers** (balance + pending = available) | The account summary equation: `equity = balance + unrealised_pnl`, `free_margin = equity - used_margin`. The "pending" items in a bank ledger are the trading analog of unrealized P&L — they affect your available funds but are not settled. |
| **Double-entry bookkeeping** (every trade has two legs) | Every position open has a corresponding fill. Every position close has a corresponding fill. The fills resource is the journal. The positions resource is the trial balance. The account summary is the balance sheet. |
| **Brokerage statements** (positions + P&L + history) | `apex.account.positions` is the open positions section. `apex.account.summary` is the account value section. `apex.account.history` is the transaction history section. Same information, machine-readable and subscribable instead of a PDF. |
| **OMS position blotters** (Order Management System) | The orders and positions resources together form the real-time blotter. Working orders in the orders resource map to open order rows. Positions map to position rows. Fill events update both. The agent's runtime is the OMS. |

The key insight from these parallels: the account model is a **projection** of the fill history. If you replay all fills from the beginning of time, you can reconstruct every position, every P&L figure, and every balance change. The summary and positions resources are materialized views optimized for real-time query. The fills resource is the source of truth.

---

## Storage and Reconstruction

APEX does not mandate how brokers store account state internally. It mandates the behavioral contract: positions reflect post-netting exposure, the summary reflects real-time equity and margin, fills are immutable, and history is paginated and queryable.

A broker might maintain account state as:

- **Event-sourced from fills** — Every fill mutates a position aggregate and an account aggregate. The summary is a projection of the aggregate. This is the cleanest model and the one that maps most naturally to APEX semantics.
- **Snapshot-based with periodic reconciliation** — The broker maintains summary and position snapshots and reconciles against the upstream execution system periodically. This is common with brokers that wrap a third-party matching engine.
- **Direct database state** — The broker's internal account table maps directly to APEX fields. No projection needed. This works when the broker's data model is already close to APEX's.

The protocol does not care. What matters is that the exposed state is consistent, fresh, and correct. If the agent reads the positions resource and the fills resource at the same time, the positions must reflect all the fills. If the summary shows equity of $10,250, the sum of balance and unrealized P&L across all positions must equal $10,250. Internal consistency is not optional.

---

## Related Design Documents

- [Order Lifecycle Design](order-lifecycle-design.md) — the order state machine and fill semantics that produce the positions, fills, and account state described here
- [Quantity Design](quantity-design.md) — the canonical quantity units (`base_units`, `shares`, `contracts`) used in position and fill payloads, and the dual-track model for broker-native display
- [Freshness Design](freshness-design.md) — the staleness model applied to account resources, including the execution-critical set that must all be fresh for autonomous trading
