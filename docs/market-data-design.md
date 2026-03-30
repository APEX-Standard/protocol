# APEX Protocol — Market Data Design

**Version:** `0.1.0-alpha`

---

## Overview

APEX delivers market data as structured, decision-ready state rather than raw tick streams. The protocol does not hand an agent a firehose of Level 1 updates and expect it to build its own picture. Instead, the broker maintains the picture and exposes it as three tiers of market state, each serving a different decision need:

**Quotes** — the current execution surface. Bid, ask, spread, tradeability. This is what the agent looks at when deciding whether to trade right now.

**Candles** — historical price bars. The completed record of what happened over recent time horizons. This is what the agent looks at when deciding whether conditions favor a trade.

**Features** — derived analytics. Returns, volatility, regime classification, liquidity, expected slippage. This is what the agent looks at when assessing the character of the current market environment.

Each tier exists as both a tool (for one-time snapshots) and a resource (for continuous state). The resource is the primary interface for production trading. The tool is the fallback for basic interoperability and explicit queries.

This design reflects a core APEX principle: the model should consume a maintained world state, not the raw tape. Raw market feeds are processed by deterministic code outside the model. The agent reasons over the result.

---

## The Quote

**URI:**

```text
apex://market/quote/APEX:FX:EURUSD
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "bid": 1.08740,
  "ask": 1.08760,
  "mid": 1.08750,
  "spread": 0.00020,
  "timestamp": "2026-03-27T14:30:00.123Z",
  "is_tradeable": true,
  "market_status": "open",
  "sequence": 184467,
  "stale_after_ms": 1000
}
```

The quote resource is the execution surface. Every field has a specific role in the agent's decision chain:

**`bid` and `ask`** are the prices the agent can actually trade at. `bid` is the price to sell, `ask` is the price to buy. An agent deciding to enter a long position will pay the `ask`. An agent closing that position will receive the `bid`. These are not theoretical prices — they are the broker's current executable levels.

**`mid`** is the midpoint of bid and ask. It is the conventional reference price for P&L calculations, fair value estimates, and feature computations like returns and volatility. The agent should not assume it can trade at mid.

**`spread`** is `ask - bid`. It is the immediate cost of a round trip. An agent that buys at the ask and immediately sells at the bid loses the spread. Spread widening is a signal of deteriorating liquidity, increased volatility, or approaching market close. A spread of 0.00020 on EUR/USD is tight. A spread of 0.00080 means something has changed.

**`timestamp`** is when the broker last priced this quote. Combined with `stale_after_ms`, the agent can determine if the quote is still valid. A quote with `stale_after_ms: 1000` that is 1500ms old is stale. The runtime must refuse autonomous order entry against a stale quote.

**`is_tradeable`** is the broker's assertion that this instrument can be traded right now. When false, the runtime must not submit orders. The flag covers all non-tradeable conditions: market closed, trading halted, instrument suspended, weekend gap, broker maintenance.

**`market_status`** gives the reason behind tradeability. The enum values are `open`, `closed`, `pre_market`, and `post_market`. An instrument in `pre_market` might have `is_tradeable: false` (no orders accepted) or `is_tradeable: true` (limited order types accepted). The status tells the agent what phase the market is in. The `is_tradeable` flag tells the agent whether to act.

**`sequence`** is a monotonically increasing integer within this resource stream. The sequence for `apex://market/quote/APEX:FX:EURUSD` is independent of the sequence for `apex://market/quote/APEX:FX:GBPJPY`. If the agent reads sequence 184467 and then reads 184469, it knows one intermediate update was coalesced. If it reads 184465, something is wrong — reject the read and re-establish state.

This is Market Fast class. Retail FX quotes typically update every 100-500ms. The recommended `stale_after_ms` range for FX quotes is 500-2000ms. For crypto, where exchange websocket feeds update more frequently, 200-1000ms is typical. The exact value is the broker's assertion: "if you haven't heard from me in this many milliseconds, the quote you're holding is no longer reliable for execution."

---

## The Candle Series

**URI:**

```text
apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timeframe": "M1",
  "partial_candle_included": true,
  "as_of": "2026-03-27T14:30:45.000Z",
  "candles": [
    {
      "time": "2026-03-27T14:28:00.000Z",
      "open": 1.0850,
      "high": 1.0890,
      "low": 1.0840,
      "close": 1.0875,
      "volume": 125000,
      "complete": true
    },
    {
      "time": "2026-03-27T14:29:00.000Z",
      "open": 1.0875,
      "high": 1.0882,
      "low": 1.0871,
      "close": 1.0878,
      "volume": 98000,
      "complete": true
    },
    {
      "time": "2026-03-27T14:30:00.000Z",
      "open": 1.0878,
      "high": 1.0881,
      "low": 1.0876,
      "close": 1.0879,
      "volume": 42000,
      "complete": false
    }
  ],
  "sequence": 1,
  "stale_after_ms": 60000
}
```

Production implementations must support at least three timeframes: `M1` (one minute), `M5` (five minutes), and `H1` (one hour). Each is a separate resource URI. The `limit` parameter returns the last N candles, including the currently forming partial bar. The default of 200 gives enough history for basic technical analysis — moving averages, Bollinger bands, RSI, recent support/resistance levels — without delivering thousands of bars the agent will never inspect.

### Partial vs Complete Candles

The `complete` flag is the single most important field in the candle schema. It distinguishes the currently forming bar from closed bars.

A complete candle is a historical fact. The M1 bar for 14:28 opened at 1.0850, hit a high of 1.0890, a low of 1.0840, closed at 1.0875, and traded 125,000 units of volume. That bar is done. It will never change.

A partial candle is a work in progress. The M1 bar for 14:30 opened at 1.0878, and so far has traded up to 1.0881 and down to 1.0876. But the minute is not over. The high could go higher. The low could go lower. The close is just the last tick so far, not the final close.

Agents must not treat a partial candle as a completed data point. A moving average computed with a partial candle in the window will change as the bar develops. A breakout signal triggered by a partial high is premature — the high is provisional. An agent computing a 20-period SMA should use the 20 most recent complete candles and treat the partial candle separately, if at all.

The `partial_candle_included` flag at the resource level tells the agent whether the last candle in the array is partial. This saves the agent from inspecting `complete` on every candle — just check the resource-level flag and handle the last element accordingly.

### Candle Close Notifications

When a candle completes on a wall-clock boundary, the server fires `notifications/apex.market.candle_closed`:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.market.candle_closed",
  "params": {
    "event_id": "evt_d4e5f6g7",
    "event_type": "notifications/apex.market.candle_closed",
    "account_id": null,
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
    "timestamp": "2026-03-27T14:31:00.000Z",
    "sequence": 45,
    "payload": {
      "instrument_id": "APEX:FX:EURUSD",
      "timeframe": "M1",
      "open": 1.08750,
      "high": 1.08780,
      "low": 1.08740,
      "close": 1.08765,
      "volume": 1500000,
      "complete": true
    }
  }
}
```

This is a Market Slow class event. The notification carries the final OHLCV data for the completed bar. The notification payload includes the completed candle data directly — the agent does not need to re-read the entire candle resource just to see what the last bar closed at, though it should re-read the resource if it needs the full series with the new partial bar.

Candle close is a natural decision trigger. Many systematic strategies evaluate on bar close: "the M1 bar just closed, here is the complete picture, should I trade?" Production runtimes should use candle close as a primary trigger for strategy evaluation rather than polling on arbitrary intervals.

### Time Alignment

Candle boundaries align to UTC unless a profile specifies otherwise. The M1 candle for 14:30 covers the period from 14:30:00.000Z to 14:30:59.999Z. The M5 candle for 14:30 covers 14:30:00.000Z to 14:34:59.999Z. The H1 candle for 14:00 covers 14:00:00.000Z to 14:59:59.999Z.

UTC alignment means every participant — regardless of local timezone — agrees on when a candle opens and closes. A candle close notification fired at 14:31:00.000Z is unambiguous. An equity profile might define candle alignment relative to the exchange's trading session (e.g., 09:30 ET for NYSE), but this must be explicitly documented in the profile. The default is UTC.

The `time` field on a partial candle refers to the candle open time, not the last tick time. The M1 candle currently forming at 14:30 has `time: "2026-03-27T14:30:00.000Z"` even if the last tick arrived at 14:30:42. This ensures every candle's `time` field is the bar boundary, not a moving target.

### The Limit Parameter

The `limit` parameter on the candle resource URI specifies how many candles to return. `limit=200` returns the most recent 200 candles, including the partial bar if one exists. This means 199 complete bars plus 1 partial, or 200 complete bars if queried exactly on a boundary before the next bar opens.

The default of 200 is a pragmatic choice. For M1 candles, 200 bars is 3 hours and 20 minutes of history — enough for intraday technical analysis. For H1 candles, 200 bars is over 8 days. For M5 candles, 200 bars is about 16 hours. These windows cover common analytical needs without excessive payload size.

Agents that need deeper history can use the `apex.market.snapshot` tool with explicit `from`/`to` parameters. The resource is for the rolling recent window. The tool is for arbitrary historical queries.

---

## The Feature Resource

**URI:**

```text
apex://market/features/APEX:FX:EURUSD
```

The feature resource is the canonical decision-ready market state object for agents. It packages pre-computed derived analytics that would otherwise require the agent to process raw data: returns over multiple horizons, realized volatility, regime classification, liquidity scoring, and expected slippage estimates.

The feature resource is covered in depth in [`feature-resource-design.md`](./feature-resource-design.md). The brief summary here:

- **Quote state** (`bid`, `ask`, `mid`, `spread`) — embedded directly so the agent does not need a separate resource read for basic price data.
- **Returns** (`r_1s`, `r_5s`, `r_1m`) — short-horizon price changes. At least three windows including `1m` are required.
- **Volatility** (`rv_1m`, `rv_5m`, `rv_30m`) — realized volatility at multiple horizons. At least `1m` and `5m` are required.
- **Regime** (`label`, `confidence`) — a classification of the current market character: trending up, trending down, ranging, volatile, illiquid, transitional, or other.
- **Execution quality** (`liquidity_score`, `expected_slippage_bps`) — how easy it is to trade right now and what the expected cost will be.
- **Book and flow** (when available) — order book imbalance, microprice, trade intensity, aggressor flow.

The feature resource exists because agents should not compute these from raw data. A language model cannot meaningfully process 50,000 ticks to derive realized volatility. But it can reason over `rv_5m: 0.37` alongside `regime: trend_up, confidence: 0.81` and `liquidity_score: 0.79` to form a trading judgment. The broker (or a deterministic computation layer) does the math. The agent consumes the result.

Features are Market Fast class for the quote and short-horizon components, with a recommended `stale_after_ms` of 1000-5000ms. Computation adds latency relative to raw quotes, which is why the freshness window is wider than for the quote resource itself.

---

## Tools vs Resources for Market Data

APEX defines both tools and resources for market data. They overlap intentionally, and the overlap serves a purpose.

**`apex.market.quote` (tool)** — Call it, get the current quote. One request, one response. No subscription, no continuous updates. This is the baseline interoperability mechanism. Every APEX implementation must support it.

**`apex://market/quote/{instrument_id}` (resource)** — Subscribe to it, receive update notifications when the quote changes, re-read it to get the latest state. This is the production mechanism.

The tool is for one-time snapshots. An agent that needs to check the current price of an instrument it is not actively trading calls `apex.market.quote`. An agent bootstrapping its initial state at session start calls `apex.market.quote` for each instrument before subscribing to resources.

The resource is for continuous state. An agent that is actively trading EUR/USD subscribes to `apex://market/quote/APEX:FX:EURUSD` and receives update notifications as the quote changes. It never calls `apex.market.quote` for EUR/USD again during the session — the resource is always current.

The same pattern applies to candles:

- `apex.market.snapshot` (tool) — fetch candle history with arbitrary `from`/`to`/`timeframe` parameters. Good for one-time historical queries, backtesting preparation, or fetching a timeframe the agent is not subscribed to.
- `apex://market/candles/{instrument_id}?timeframe=M1&limit=200` (resource) — the rolling recent candle window with continuous updates and partial bar tracking.

**The normative requirement:** Production implementations must not require agents to poll the quote tool on a fixed interval. When equivalent realtime resources are available, the resource subscription model is the expected interface. An agent that polls `apex.market.quote` every 200ms is working around the protocol, not with it. The subscription model — subscribe, receive update notification, re-read — exists precisely to eliminate polling.

When should an agent use the tool despite having the resource?

- At session start, before subscriptions are established.
- For instruments the agent is evaluating but not actively trading.
- When the resource subscription is temporarily unavailable or in a degraded state.
- For explicit snapshot capture with a known timestamp (audit, logging).

---

## The Subscription Flow

Here is the concrete flow for an agent trading EUR/USD, from subscription to decision.

**1. Subscribe.** The agent subscribes to `apex://market/quote/APEX:FX:EURUSD` using the MCP resource subscription mechanism. It also subscribes to the candle resources for M1, M5, and H1, and to the feature resource.

**2. Initial read.** The agent reads each resource to establish its baseline state. It records the `sequence` and `timestamp` from each resource.

**3. Quote changes.** EUR/USD moves. The broker's feed handler receives a new tick from the liquidity provider: bid 1.08745, ask 1.08765. The broker updates the quote resource, increments the sequence, and emits `notifications/resources/updated` over the SSE stream:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "apex://market/quote/APEX:FX:EURUSD"
  }
}
```

**4. Agent re-reads.** The agent receives the notification and re-reads the resource. It gets the latest quote with `sequence: 184468`, verifies the sequence is monotonically greater than its last read (184467), checks that `timestamp` plus `stale_after_ms` is in the future, and updates its local state.

**5. Coalescing.** EUR/USD is a fast-moving pair. During London session, the quote might update 5-10 times per second. The server may coalesce these updates — if three ticks arrive in 100ms, the server emits one `notifications/resources/updated` rather than three. The agent re-reads the resource and gets the latest state. The intermediate ticks are gone. This is by design. The agent does not need tick-by-tick granularity. It needs the current execution surface.

When updates are coalesced, the `sequence` at time of read reflects the latest state. If the agent last saw sequence 184467 and the next read returns 184470, three intermediate updates were coalesced. This is normal. The agent can detect it. It is not a gap — the resource was updated, the agent re-read, and the state is current. A gap is when the agent's subscription is interrupted and events are lost, which is handled by the replay mechanism.

**6. Candle close.** The wall clock hits 14:31:00.000Z. The M1 bar for 14:30 is complete. The server fires `notifications/apex.market.candle_closed` with the final OHLCV data and also fires `notifications/resources/updated` for the candle resource. The agent's runtime triggers a decision evaluation: new complete bar available, time to re-assess.

**7. Decision.** The agent reads the updated candle resource (now includes the completed 14:30 bar and a new partial 14:31 bar), reads the current quote, reads features. All fresh. All sequences monotonic. It evaluates its strategy and decides to enter a position.

This flow replaces polling. The agent is never asking "has anything changed?" on a timer. The server tells the agent when something changes. The agent reads the current state when it matters.

---

## Market Status and Tradeability

The `is_tradeable` flag and `market_status` enum work together to gate execution.

### The `is_tradeable` Flag

This is a binary gate. When `is_tradeable` is `false`, the runtime must not submit orders for this instrument. No exceptions for "the agent really thinks it should trade." The flag is the broker's definitive statement: this instrument cannot be traded right now.

The flag covers multiple conditions:

- Market is closed (weekends for FX, after-hours for equities)
- Trading halt on the instrument (news event, circuit breaker)
- Instrument suspended or delisted
- Broker maintenance window
- Regulatory restriction

The agent does not need to know which condition applies to respect the flag. It just needs to know: can I trade, or can't I?

### The `market_status` Enum

The enum provides context: `open`, `closed`, `pre_market`, `post_market`.

- **`open`** — Normal trading session. `is_tradeable` should be `true`. Full order types available.
- **`closed`** — Market is closed. `is_tradeable` must be `false`. For FX, this typically means the weekend gap (Friday 17:00 ET to Sunday 17:00 ET). For equities, outside regular trading hours.
- **`pre_market`** — Before the main session opens. `is_tradeable` may be `true` (pre-market orders accepted) or `false` (no orders until open), depending on the broker and instrument.
- **`post_market`** — After the main session closes. Same conditional tradeability as `pre_market`.

When the market status changes, the quote resource updates and the server emits `notifications/resources/updated`. The agent re-reads the quote, sees the new status and tradeability flag, and adjusts. An agent that was actively trading EUR/USD during London session and sees `market_status` transition to `closed` with `is_tradeable: false` knows to stop submitting orders and wait.

### Runtime Enforcement

The tradeability gate is a hard control, not a suggestion. Production autonomous runtimes must enforce it deterministically:

| Condition | Runtime Behavior |
|---|---|
| `is_tradeable: true`, `market_status: open` | Orders permitted (subject to other risk checks) |
| `is_tradeable: true`, `market_status: pre_market` | Orders permitted if broker accepts pre-market orders |
| `is_tradeable: false`, any `market_status` | Orders refused — runtime must reject before sending to broker |
| Quote is stale | Orders refused — cannot verify tradeability |

The runtime rejects the order before it reaches the broker. This is cheaper and faster than sending an order the broker will reject, and it produces a clear audit trail: "order refused by runtime, reason: instrument not tradeable."

---

## Instrument Discovery

Before an agent can trade, it needs to know what instruments are available. APEX provides two tools for this: `apex.market.search` and `apex.market.details`.

These are tools, not resources, because instrument metadata changes rarely. The contract specification for EUR/USD — pip size, lot size, margin rate, trading hours — does not update on a tick-by-tick basis. A tool call at session start is sufficient. There is no need for a subscription to instrument metadata.

### Search: Finding Instruments

```json
{
  "query": "EUR",
  "profile": "fx",
  "limit": 20
}
```

Returns a list of matching instruments:

```json
{
  "instruments": [
    {
      "instrument_id": "APEX:FX:EURUSD",
      "broker_symbol": "EURUSD",
      "display_name": "Euro / US Dollar",
      "profile": "fx",
      "is_tradeable": true
    },
    {
      "instrument_id": "APEX:FX:EURJPY",
      "broker_symbol": "EURJPY",
      "display_name": "Euro / Japanese Yen",
      "profile": "fx",
      "is_tradeable": true
    }
  ]
}
```

The search is keyword-based and profile-filtered. An agent that knows it wants to trade FX can search within the `fx` profile. An agent exploring available instruments can search broadly. The `is_tradeable` flag in search results gives a quick filter — the agent can skip instruments that are currently untradeable.

### Details: Full Contract Specification

Once the agent has identified an instrument, it calls `apex.market.details` to get the full contract specification:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "display_name": "Euro / US Dollar",
  "profile": "fx",
  "base_currency": "EUR",
  "quote_currency": "USD",
  "pip_size": 0.0001,
  "lot_size": 100000,
  "quantity_unit": "base_units",
  "broker_quantity_unit": "lots",
  "min_quantity": 1000,
  "max_quantity": 50000000,
  "quantity_step": 1000,
  "margin_rate_pct": 0.5,
  "commission_per_lot": 0.0,
  "spread_type": "variable",
  "typical_spread_pips": 0.8,
  "trading_hours": [
    { "day": "monday", "open": "00:00", "close": "23:59", "timezone": "UTC" }
  ]
}
```

This tells the agent everything it needs to size orders correctly (`lot_size`, `min_quantity`, `max_quantity`, `quantity_step`), calculate costs (`margin_rate_pct`, `commission_per_lot`, `typical_spread_pips`), and understand the instrument's characteristics (`pip_size`, `base_currency`, `quote_currency`).

### Session Start Discovery Flow

A typical agent bootstrap sequence:

1. Authenticate with `apex.session.authenticate`.
2. Query capabilities with `apex.session.capabilities` to discover profiles, rate limits, and realtime contract parameters.
3. Search for instruments: `apex.market.search({ query: "EUR", profile: "fx" })` to find available FX pairs.
4. Get details for each instrument of interest: `apex.market.details({ instrument_id: "APEX:FX:EURUSD" })`.
5. Read initial market state: call `apex.market.quote` for each instrument.
6. Subscribe to realtime resources: quote, candles (M1, M5, H1), and features for each instrument the agent will actively trade.
7. Read each subscribed resource to establish the baseline state (sequences, timestamps).
8. Begin trading.

Steps 3 and 4 are one-time operations. The agent does not re-discover instruments mid-session unless it needs to expand its trading universe.

---

## Market Data Classification for Replay

Quotes and candle closes are classified as `elide` during replay. This means they are collapsed into gap fill markers instead of being replayed individually.

The reasoning is straightforward: market data is ephemeral. The quote at 14:30:00.123Z is superseded by the quote at 14:30:00.456Z, which is superseded by the quote at 14:30:00.789Z. If the agent was disconnected for 30 seconds and 150 quote updates accumulated in the event log, replaying all 150 is pointless. The agent is going to re-read the current quote resource anyway, and the current quote supersedes all 150 historical values.

The same logic applies to candle close notifications. A candle close at 14:30 is a historical fact, but it is embedded in the candle resource. When the agent re-reads `apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200` after reconnect, the completed 14:30 bar is already there.

Here is what happens during reconnect:

```
473: notifications/resources/updated (quote)        → elide
474: notifications/resources/updated (quote)        → elide
475: notifications/resources/updated (quote)        → elide
476: notifications/resources/updated (candles M1)   → elide
477: notifications/apex.market.candle_closed (M1)   → elide
478: notifications/resources/updated (quote)        → elide
479: notifications/resources/updated (features)     → elide
```

All seven events collapse into a single gap fill marker:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.gap_fill",
  "params": {
    "elided_count": 7,
    "from_id": "473",
    "to_id": "479"
  }
}
```

The agent receives the gap fill marker, understands that market data updates were skipped, and re-reads all market resources to get the current state. No stale quotes replayed. No outdated candles processed. Just the current picture.

Compare this with execution events: `apex.order.filled` is classified `required` and is always replayed. "Your order filled at 1.0847 at 14:32:07" is an execution fact. You cannot reconstruct it from reading the current positions resource — you just see "you have a position." The fill price, fill time, and fill quantity are historical records that must be delivered.

Market data has no such permanence. The current state supersedes all historical values. This is why it gets elided.

For the full replay mechanism — gap fill markers, acknowledgment-driven retention, replay failure recovery — see [`replay-design.md`](./replay-design.md).

### Normative Replay Classification for Market Data

| Notification | Classification | Reason |
|---|---|---|
| `notifications/resources/updated` (quote) | `elide` | Current quote supersedes all previous quotes |
| `notifications/resources/updated` (candles) | `elide` | Current candle resource contains all completed bars |
| `notifications/resources/updated` (features) | `elide` | Current features supersede all previous features |
| `notifications/apex.market.candle_closed` | `elide` | Completed candle is in the candle resource |

---

## Parallels

The APEX market data architecture draws on established systems across the industry.

| Established System | APEX Parallel |
|---|---|
| Bloomberg BPipe / DAPI | Market data feed APIs that deliver structured, vendor-normalized quotes and analytics. APEX quote and feature resources serve the same role for agent consumers. |
| FIX MarketDataRequest / MarketDataSnapshotFullRefresh | FIX messages for requesting and receiving quote snapshots. `apex.market.quote` (tool) maps to the request/response pattern; the quote resource maps to the subscription model (FIX MarketDataIncrementalRefresh). |
| CME MDP 3.0 / LSE ITCH | Exchange data feeds with sequence numbers, incremental updates, and snapshot recovery. APEX `sequence` fields and replay-after-reconnect serve the same purpose — deterministic gap detection and state recovery. |
| TradingView data model | Candle series with partial bars distinguished from completed bars. The `complete` flag in APEX candles mirrors TradingView's real-time bar management where the current bar updates continuously until the period closes. |
| CQG / Rithmic | Professional market data platforms with per-instrument sequence numbers, freshness metadata, and deterministic stale-data detection. APEX `stale_after_ms` and per-resource `sequence` derive from this class of system. |
| Kafka consumer offsets | The agent acknowledges processed events; the server discards acknowledged events. APEX acknowledgment-driven retention mirrors the Kafka consumer group offset model. |

The key architectural difference: these established systems deliver data to human traders with terminals, automated trading systems with custom parsers, or application code with explicit feed handlers. APEX delivers data to language model agents through a structured, decision-ready interface. The data model is similar. The consumer is different. The protocol design reflects that difference — pre-computed features, regime classification, freshness enforcement, and tradeability gating exist because the consumer cannot process raw tick streams and should not be expected to.

---

## Related Design Documents

- [Feature Resource Design](feature-resource-design.md) — the derived analytics resource (returns, volatility, regime, execution quality) that builds on the raw market data described here
- [Freshness Design](freshness-design.md) — the staleness model applied to quotes, candles, and features, including the `stale_after_ms` ranges and the execution-critical set
- [Replay Design](replay-design.md) — how market data notifications are classified as `elide` during replay, with gap fill markers replacing stale quote and candle close events
