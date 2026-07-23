# APEX Protocol — Feature Resource and Agent-Native Market State Design

**Version:** `0.3.0-alpha`

---

## Overview

APEX computes derived features server-side and delivers them as structured state, not raw tick streams. The feature resource (`apex://market/features/{instrument_id}`) is the canonical decision-ready market state object for agents. The decision context resource (`apex://agent/decision-context/{instrument_id}`) layers account, risk, and constraint state on top of it to produce a single model-ready object.

This is the core "agent-native" differentiator. Every serious trading system pre-computes analytics before the decision layer touches them. APEX makes that principle a first-class protocol concern: the broker computes, the agent consumes.

---

## The Problem with Raw Ticks

An FX quote stream for a single instrument delivers roughly 50,000 price ticks per hour during active sessions. An agent connected to three instruments sees 150,000. Over a trading day, that is millions of individual price updates.

An LLM cannot compute realized volatility from those ticks. It cannot detect regime transitions. It cannot estimate expected slippage from order book snapshots. Even if you embedded the formulas in the system prompt and fed the raw numbers through the context window, the cost would be catastrophic — both in tokens and in reliability. A language model asked to compute a rolling standard deviation over 3,000 one-second returns will hallucinate. It will round. It will lose track of the window boundary. And you will not notice until the position sizing is wrong.

The traditional answer in quantitative finance is a feature pipeline: raw market data flows through a computation layer that produces derived analytics, and the decision layer consumes those analytics as structured inputs. The quant researcher does not stare at a raw tick stream. She reads a dashboard of computed signals — realized vol, return momentum, book imbalance, regime classification — and makes decisions from those.

APEX applies the same principle at the protocol level. The broker owns the raw data. The broker runs the computation. The agent receives the result as a structured JSON object with freshness metadata, a monotonic sequence number, and a staleness bound. The agent never sees the 50,000 ticks. It sees one feature resource that updates on a cadence measured in hundreds of milliseconds to low single-digit seconds.

---

## The Feature Groups

The feature resource organizes derived state into seven groups. Each group answers a specific class of question that an agent needs answered before it can make a trading decision.

### Quote State

```json
"quote": {
  "bid": "1.08740",
  "ask": "1.08760",
  "mid": "1.08750",
  "spread": "0.00020"
}
```

This is the execution surface. The bid is the price at which the agent can sell. The ask is the price at which the agent can buy. The mid is the arithmetic mean. The spread is the transaction cost of a round trip at current levels.

An agent deciding whether to enter a position checks the spread first. A 2-pip spread on EURUSD during London hours is normal. A 15-pip spread during the Tokyo-London gap is a warning. The spread tells the agent whether the market is liquid enough to trade at acceptable cost. Without it, the agent is flying blind on execution economics.

Quote state is required for Production Realtime. Every feature resource must include it.

### Short-Horizon Returns

```json
"returns": {
  "r_1s": 0.00002,
  "r_5s": 0.00005,
  "r_1m": 0.00080
}
```

These are log returns computed over rolling windows: 1 second, 5 seconds, 1 minute. They answer the question: which direction is the market moving, and how fast?

A positive `r_1m` of 80 basis points means the mid price has risen approximately 0.08% over the last 60 seconds. For EURUSD at 1.0875, that is about 8.7 pips — a meaningful move. An agent that sees `r_1s` and `r_5s` both positive and `r_1m` strongly positive is looking at sustained upward momentum. An agent that sees `r_1s` negative but `r_1m` positive is looking at a pullback within an uptrend.

The protocol requires at least three return windows including `1m`. Brokers may add finer or coarser windows (`r_100ms`, `r_5m`, `r_15m`) as their data pipeline supports. The three-window minimum gives the agent enough temporal resolution to distinguish between a tick-level blip, a short burst, and a sustained directional move.

Short-horizon returns are required for Production Realtime.

### Realized Volatility

```json
"volatility": {
  "rv_1m": 0.12,
  "rv_5m": 0.37,
  "rv_30m": 0.55
}
```

Realized volatility measures how much the price has actually moved, annualized, over the given window. `rv_1m` of 0.12 means that if the last minute's price behavior continued for a year, the annualized standard deviation would be 12%. `rv_30m` of 0.55 means the last 30 minutes have been substantially more volatile than the last minute — the market was wilder earlier and is now calming, or there was a spike event within the window.

Volatility is the fundamental input to position sizing. An agent trading a fixed-risk model (e.g., risk 1% of equity per trade) needs to know current volatility to compute the appropriate position size and stop distance. Without it, the agent either sizes too large for volatile conditions (risk of ruin) or too small for quiet conditions (opportunity cost).

The protocol requires at least `rv_1m` and `rv_5m`. The 1-minute window captures immediate conditions. The 5-minute window captures the broader regime. Brokers should expose `rv_30m` whenever their computation pipeline supports it. The term structure of volatility — comparing short and long windows — tells the agent whether volatility is expanding or contracting, which is itself a regime signal.

Realized volatility is required for Production Realtime.

### Book State

```json
"book": {
  "top_level_imbalance": 0.21,
  "depth_imbalance": 0.18,
  "microprice": 1.08753
}
```

Book state describes the supply/demand picture visible in the order book. `top_level_imbalance` measures the ratio of bid size to ask size at the best prices: a positive value means more resting bid than ask, suggesting buying pressure. `depth_imbalance` extends the same measurement across multiple price levels. `microprice` is the volume-weighted midpoint that adjusts the naive mid toward the heavier side of the book — when the bid is thicker, the microprice sits above the mid, reflecting the market's lean.

An agent about to place a market buy order checks `top_level_imbalance`. If the imbalance is strongly negative (heavy ask, light bid), the agent knows there is selling pressure and its buy may face adverse selection. If the imbalance is strongly positive, the buy has support from resting bids and is more likely to execute cleanly.

Book state is recommended but not required for Production Realtime. Many retail brokers do not have genuine order book data — they synthesize quotes from upstream liquidity aggregation and cannot provide meaningful depth. When book data is available, it should be present. When it is not, the feature resource omits the `book` group entirely rather than fabricating values.

### Flow

```json
"flow": {
  "trade_intensity_30s": 0.67,
  "aggressor_imbalance_30s": 0.44
}
```

Flow features describe what is actually happening in the market, not what is resting on the book. `trade_intensity_30s` is a normalized measure of how actively the instrument is trading over the last 30 seconds — 0 is dead, 1 is peak activity for this instrument's historical profile. `aggressor_imbalance_30s` measures whether aggressive (market) orders are predominantly buying or selling: a positive value means buy-side aggression dominates.

Flow answers the urgency question. High trade intensity with strong aggressor imbalance means the market is moving with conviction. Low trade intensity means the market is drifting or waiting. An agent that detects a regime change accompanied by high trade intensity and strong aggressor imbalance has a higher-confidence signal than one that detects a regime change in a thin, drifting market.

Flow is recommended but not required for Production Realtime, for the same data availability reasons as book state.

### Regime Classification

```json
"regime": {
  "label": "trend_up",
  "confidence": 0.81
}
```

The regime label is the broker's characterization of the current market state. It answers the broadest question: what kind of market is this right now?

The standard taxonomy defines seven labels:

| Label | Meaning |
|---|---|
| `trend_up` | Sustained directional move higher |
| `trend_down` | Sustained directional move lower |
| `range` | Price oscillating within a bounded range |
| `volatile` | High dispersion without clear direction |
| `illiquid` | Thin book, wide spreads, unreliable execution |
| `transitional` | Between regimes — trend exhaustion, range breakout, regime uncertainty |
| `other` | Broker-specific regime outside the standard taxonomy |

**Why `transitional` matters.** Most trading losses happen at regime boundaries. A trend-following agent that enters at the end of a trend is buying the top. A mean-reversion agent that fades a breakout is fighting a new trend. The `transitional` label is the broker's signal that the regime classification model is uncertain — the market is between states. An agent that sees `transitional` with low confidence should reduce size or abstain entirely. It is the protocol's way of saying "the model doesn't know, and neither should you."

**Why `other` exists.** Brokers may run proprietary regime models with labels outside the standard taxonomy — "squeeze," "news-driven," "central-bank-intervention." Rather than force every broker into seven buckets, `other` provides an escape hatch. An agent that does not understand a broker-specific regime treats `other` as unclassified and falls back to its default risk posture. Graceful degradation, not silent failure.

The `confidence` field ranges from 0 to 1. It reflects the regime model's certainty. An agent might trust `trend_up` at 0.92 confidence but not at 0.55. The confidence value lets agents implement their own conviction thresholds without second-guessing the label itself.

Regime classification is required for Production Realtime.

### Execution Quality

```json
"execution": {
  "liquidity_score": 0.79,
  "expected_slippage_bps": 0.6
}
```

Execution quality features answer the question: what will it cost to trade right now?

`liquidity_score` is a normalized 0-to-1 measure of current execution conditions. It accounts for spread width, book depth (where available), recent fill rates, and trade intensity. A score of 0.79 says the market is reasonably liquid. A score below 0.3 is a warning: execution costs will be elevated, slippage risk is high, and the agent should consider waiting or reducing size.

`expected_slippage_bps` estimates the basis-point cost of market impact for a standard-sized order at current conditions. An estimate of 0.6 bps on EURUSD is minimal — less than one tenth of a pip on a million-dollar position. An estimate of 5.0 bps during an illiquid session means the agent should expect to lose half a pip on entry alone.

An agent that ignores execution quality will produce strategies that backtest beautifully and bleed money live. Slippage and liquidity are the gap between theoretical returns and realized returns. By computing and delivering these estimates server-side, APEX ensures the agent can incorporate execution cost into its decision without attempting to model market microstructure from raw data.

Execution quality is required for Production Realtime.

---

## Regime Classification

The regime model is not a trading signal. It is a market characterization that informs how the agent should behave, not what it should trade.

Consider an agent that runs two strategies: a momentum strategy for trending markets and a mean-reversion strategy for ranging markets. Without a regime label, the agent must either run both strategies simultaneously (generating conflicting signals) or build its own regime detection from raw features (duplicating broker-side computation and consuming context window budget to do so).

With the regime label, the strategy selection is straightforward:

- `trend_up` or `trend_down`: activate momentum, deactivate mean-reversion
- `range`: activate mean-reversion, deactivate momentum
- `volatile`: reduce position sizes across all strategies
- `illiquid`: halt new entries, tighten stops on existing positions
- `transitional`: reduce size, widen entry thresholds, wait for clarity
- `other`: fall back to default risk posture

The `transitional` label deserves special emphasis. Markets do not snap between regimes. A trend exhausts over minutes or hours. A range compresses before breaking. The transitional state captures this in-between period — the regime model sees conflicting signals and honestly reports its uncertainty rather than forcing a classification.

An agent that respects `transitional` avoids the classic whipsaw: entering a trend trade as the trend dies, then reversing into a range trade as the range breaks. This label is the regime model's admission of doubt, and doubt is valuable information.

The `confidence` field complements the label. A `trend_up` label with 0.95 confidence is a strong signal. The same label with 0.55 confidence is marginal — the model detects upward bias but with substantial ambiguity. An agent can set its own confidence floor: "I only act on regime labels with confidence above 0.70." This separation of classification from conviction gives the agent control over its own risk appetite without requiring it to second-guess the broker's model.

---

## The Decision Context Resource

The decision context resource is the highest-level convenience object in the protocol. Where the feature resource answers "what is the market doing?", the decision context answers "what does the agent need to know to make a decision about this instrument right now?"

**URI:**

```text
apex://agent/decision-context/APEX:FX:EURUSD
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timestamp": "ISO8601",
  "sequence": 1,
  "stale_after_ms": 5000,
  "market": {
    "quote_resource": "apex://market/quote/APEX:FX:EURUSD",
    "feature_resource": "apex://market/features/APEX:FX:EURUSD",
    "candle_resources": [
      "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
      "apex://market/candles/APEX:FX:EURUSD?timeframe=M5&limit=200",
      "apex://market/candles/APEX:FX:EURUSD?timeframe=H1&limit=200"
    ]
  },
  "account": {
    "summary_resource": "apex://account/summary/ACC_12345",
    "positions_resource": "apex://account/positions/ACC_12345",
    "orders_resource": "apex://account/orders/ACC_12345",
    "risk_resource": "apex://account/risk/ACC_12345"
  },
  "constraints": {
    "kill_switch_active": false,
    "max_position_size": "5000000",
    "max_open_orders": 50
  }
}
```

The decision context packages three things:

1. **Market state** — references to the quote, feature, and candle resources for the instrument. The agent reads the decision context and knows exactly which resources to consult. No prompt engineering required to assemble the right URIs.

2. **Account state** — references to the account summary, positions, orders, and risk resources. The agent sees its current exposure, open orders, margin utilization, and P&L without constructing the resource URIs itself.

3. **Constraints** — the hard limits that bound autonomous action. Kill switch state, maximum position size, maximum open orders. These are not suggestions — they are the broker's enforcement boundaries. An agent that reads `kill_switch_active: true` must halt all order entry. An agent that reads `max_position_size: 5000000` must not submit an order that would exceed 5 million in notional exposure.

The decision context exists to reduce prompt assembly cost. Without it, an agent runtime must maintain a mapping of instrument IDs to resource URIs, construct the correct candle timeframe parameters, look up the account ID for each resource, and assemble all of this into a coherent context object before the model sees anything. The decision context does this once, server-side, and delivers it as a single subscribable resource.

The decision context is a read model, not a source of truth. The runtime should still be able to read the underlying resources directly for safety validation and debugging. If the decision context says `kill_switch_active: false` but the risk resource says the kill switch is active, the risk resource wins. The decision context is a convenience aggregation, not an authoritative override.

The decision context is required for Production Autonomous. An implementation claiming `APEX Production Autonomous` must expose `apex://agent/decision-context/{instrument_id}`.

---

## Required vs Recommended Features

Production Realtime draws a clear line between features that every implementation must provide and features that should be present when the underlying data supports them.

### Required Feature Groups

| Group | Fields | Rationale |
|---|---|---|
| Quote state | `bid`, `ask`, `mid`, `spread` | Cannot trade without knowing the execution surface |
| Short-horizon returns | At least three windows including `r_1m` | Cannot assess momentum without directional signal |
| Realized volatility | At least `rv_1m` and `rv_5m` | Cannot size positions without current volatility |
| Execution quality | `liquidity_score`, `expected_slippage_bps` | Cannot estimate cost without execution analytics |
| Regime classification | `label`, `confidence` | Cannot select strategy without market characterization |

These five groups constitute the minimum viable feature set for an agent to make informed trading decisions. An implementation that omits any of them cannot claim Production Realtime compliance.

### Recommended Feature Groups

| Group | Fields | Rationale |
|---|---|---|
| Book state | `top_level_imbalance`, `depth_imbalance`, `microprice` | Valuable when genuine order book data is available |
| Flow | `trade_intensity_30s`, `aggressor_imbalance_30s` | Valuable when trade-level data is available |

Book and flow features depend on data that many retail brokers do not have. A broker that aggregates liquidity from multiple upstream providers may not have a unified order book to analyze. A broker that receives only top-of-book quotes cannot compute meaningful depth imbalance. Rather than mandate fabrication, the protocol makes these groups recommended: present when genuine, absent when not.

When a recommended group is absent, the feature resource must omit the group entirely. It must not include placeholder values, zeroes, or nulls. An agent that checks for the presence of the `book` key in the feature resource can cleanly branch: if present, use it; if absent, proceed without it.

---

## Freshness of Features

Features derive from quotes, but computation adds latency. A quote might update every 200 milliseconds. The feature resource that depends on that quote stream updates on a slower cadence — the broker must collect enough ticks to compute rolling windows, apply the regime model, estimate slippage, and publish the result.

The recommended `stale_after_ms` range for features is **1000-5000 ms**, compared to **500-2000 ms** for raw quotes and **200-1000 ms** for crypto quotes. This wider window reflects the computational overhead. A feature resource with `stale_after_ms: 2000` is telling the agent: "this state was current when I computed it, and you can trust it for up to 2 seconds before you should consider it stale."

### Staleness Rules

A feature resource is stale when:

```
current_time > as_of + stale_after_ms
```

When a feature resource becomes stale, the autonomous runtime must halt new order submission — the same rule that applies to stale quotes. The rationale is identical: an agent trading on stale features is trading on stale information. A volatility estimate that is 10 seconds old during a fast market may be dangerously wrong. A regime label computed before a news spike may be the opposite of current conditions.

### Staleness Summary

| Resource | Freshness Class | Typical `stale_after_ms` | Halts Autonomy When Stale |
|---|---|---|---|
| Quote | Market Fast | 500-2000 ms | Yes |
| Features | Market Fast / Market Slow (mixed) | 1000-5000 ms | Yes |
| Candles (M1) | Market Slow | 60000-120000 ms | No (informational) |
| Account state | Account / Risk | 2000-10000 ms | Yes |
| Risk state | Account / Risk | 2000-5000 ms | Yes |
| Decision context | Composite | Up to 5000 ms | Depends on underlying resource freshness |

Features occupy a middle ground between the fast-updating quote and the slow-updating candle. Some feature components (quote state, 1-second returns) derive from the latest tick and could update at quote speed. Others (30-minute realized volatility, regime classification) derive from longer windows and change more slowly. The feature resource publishes as a unit — all groups in one update — so the `stale_after_ms` reflects the slowest acceptable update cadence for the fastest-moving component.

A broker may choose to update features on every tick, every N ticks, or on a fixed timer. The protocol does not mandate the update trigger. It mandates that the freshness metadata be accurate and that the staleness bound be respected. An implementation that updates features every 500 ms and sets `stale_after_ms: 2000` gives the agent a 1500 ms grace period. An implementation that updates every 2000 ms and sets `stale_after_ms: 2000` gives the agent no grace — if a single update is missed, the resource is immediately stale.

---

## Parallels

The feature resource is not a novel concept. It is a protocol-level expression of a pattern that exists in every serious trading system, every ML pipeline, and every operational monitoring stack. The novelty is making it a first-class interoperability concern between broker and agent.

### Quant Desk Alpha Signals

A quantitative trading desk does not hand raw tick data to its execution algorithm. The desk maintains a feature pipeline — often called an alpha pipeline or signal pipeline — that computes derived analytics from raw market data. Realized volatility, order flow imbalance, return momentum, regime state, liquidity estimates. These computed features feed into the alpha model, which produces a trading signal, which feeds into the execution algorithm.

APEX formalizes this pipeline at the protocol boundary. The broker plays the role of the feature pipeline. The agent plays the role of the alpha model and execution algorithm. The feature resource is the interface contract between them.

### Bloomberg Terminal Fields

A Bloomberg terminal does not show raw tick data on its main screens. It shows derived fields: bid-ask spread, volume-weighted average price, realized volatility, implied volatility, relative value metrics. These are computed server-side by Bloomberg's analytics engine and delivered as structured fields that a trader can read at a glance.

The feature resource is the programmatic equivalent. Instead of a human reading "RV30 0.55" on a terminal screen, an agent reads `"rv_30m": 0.55` from a JSON resource. The computation happens server-side. The consumer receives the result. The only difference is that the consumer is a language model instead of a human, which makes structured delivery even more important — the model cannot eyeball a chart and estimate volatility the way a trader can.

### Prometheus and Grafana Computed Metrics

In infrastructure monitoring, raw metrics (CPU usage per core per second, request latency per endpoint per millisecond) are collected by Prometheus. But operators do not stare at raw time series. They build Grafana dashboards with computed panels: p99 latency over 5-minute windows, error rate as a percentage of total requests, capacity utilization trends. These computed metrics are the decision-ready state for infrastructure operators.

APEX features serve the same role for trading agents. Raw ticks are the Prometheus scrapes. The feature resource is the Grafana dashboard — pre-computed, windowed, annotated with staleness metadata, ready for the decision-maker to consume without running the aggregation queries itself.

### Feature Stores in ML Pipelines

Modern ML systems use feature stores (Feast, Tecton, Hopsworks) to separate feature computation from model inference. The feature store computes features from raw data, manages freshness and versioning, and serves the computed features to the model at inference time. This separation ensures that the model sees consistent, pre-computed inputs rather than attempting ad-hoc feature computation during inference.

The feature resource is APEX's feature store. The broker computes features from raw market data. The resource includes freshness metadata (`as_of`, `stale_after_ms`) and versioning (`sequence`). The agent consumes pre-computed features at decision time without running the computation itself. The parallel is exact — right down to the freshness guarantees and the principle that stale features must halt inference (or in APEX's case, halt autonomous execution).

### Why Every Serious System Pre-Computes

The pattern is universal because the alternative does not work. Asking the decision layer to compute its own features from raw data creates four problems:

1. **Latency.** Feature computation takes time. If the decision layer computes features on demand, it adds latency to every decision cycle. In trading, latency is cost.

2. **Consistency.** If two components both compute volatility from the same tick stream, they may disagree due to timing differences. A centralized feature computation ensures everyone sees the same number.

3. **Cost.** For an LLM-based agent, the cost is context window tokens. Feeding 50,000 ticks per hour into a context window to compute five rolling statistics is absurdly expensive. Pre-computing those five numbers and delivering them as a 200-byte JSON object is essentially free.

4. **Reliability.** A language model asked to perform rolling statistical computations on streaming numerical data will produce errors. A conventional computation pipeline using standard numerical libraries will not. The feature resource keeps the math in deterministic code and the reasoning in the model — each doing what it does best.

APEX does not invent this pattern. It codifies it as a protocol requirement so that every broker-agent pair benefits from it automatically.

---

## Related Design Documents

- [Autonomous Safety Design](autonomous-safety-design.md) — how feature freshness feeds into the seven halt conditions, and how the runtime uses regime classification and volatility to gate autonomous execution
- [Market Data Design](market-data-design.md) — the quote and candle resources that provide the raw inputs to feature computation, and the subscription flow through which agents consume all three tiers of market state
- [Freshness Design](freshness-design.md) — the staleness model that applies to feature resources, with recommended `stale_after_ms` ranges for the Market Fast/Slow classification
