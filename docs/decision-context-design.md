# APEX Protocol — Decision Context Resource Design

**Version:** `0.1.0-alpha`

---

## Overview

The decision context is the single resource an agent reads to get everything it needs for a trading decision on one instrument. It lives at `apex://agent/decision-context/{instrument_id}` and its job is to answer one question: "give me everything I need to decide, in one read."

It does not contain all the data. It references the resources that do. It carries a small block of inlined safety constraints. And it provides its own freshness metadata so the agent knows when the context was last assembled. The decision context is the entry point to a decision cycle, not a replacement for reading the underlying state.

---

## The Problem

An agent trading EURUSD needs, at minimum, the following state before it can make a decision:

1. The current quote — bid, ask, spread
2. Derived features — realized volatility, returns, regime, liquidity
3. M1 candles — the last 200 one-minute bars
4. M5 candles — the last 200 five-minute bars
5. H1 candles — the last 200 hourly bars
6. Account summary — equity, margin, free margin
7. Open positions — what the agent already holds
8. Open orders — what the agent has pending
9. Risk state — kill switch, daily P&L, limit utilization

That is nine resource reads per decision cycle per instrument. Each read costs tokens — the agent must include the URI in its tool call, parse the response, and incorporate the result into its reasoning context. If the agent trades three instruments, it issues twenty-seven resource reads before it has done anything.

The cost problem is bad. The consistency problem is worse.

Resource reads are not atomic. The agent reads the quote at T=0, the positions at T=50ms, and the risk state at T=120ms. Between the quote read and the risk read, a stop-loss may have triggered. The positions the agent just read are now stale. The risk limits have changed. The agent is reasoning over a state that never existed as a coherent snapshot. In a fast market, 120ms is enough for the world to move.

The decision context solves both problems. One read gives the agent a consistent view of what it needs. One resource URI. One sequence number. One freshness bound. The agent reads it, follows the references to get full data, and proceeds.

---

## Composition by Reference

The decision context does not inline market data, candle series, account balances, or position details. It references them by URI. Here is the full schema as it appears for EURUSD:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timestamp": "2026-03-29T14:32:07.123Z",
  "sequence": 847,
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
    "max_position_size": 5000000,
    "max_open_orders": 50
  }
}
```

The `market` block references three categories of market state. The `quote_resource` points to the live bid/ask/spread. The `feature_resource` points to the derived analytics — realized vol, returns, regime label, liquidity score, expected slippage — as described in [feature-resource-design.md](./feature-resource-design.md). The `candle_resources` array points to at least three timeframes of OHLCV candle series. The schema requires a minimum of three candle resource URIs. Implementations may include additional timeframes.

The `account` block references four account-level resources. The `summary_resource` points to equity, margin, and balance. The `positions_resource` points to current open positions. The `orders_resource` points to pending orders. The `risk_resource` points to the account's risk state — kill switch, daily P&L tracking, limit utilization.

Why reference instead of inline? Three reasons.

**The agent reads the referenced resources separately for full data.** The decision context tells the agent *where* to look. The referenced resources contain the actual numbers. A feature resource payload can be several hundred tokens. Three candle series at 200 bars each can be thousands of tokens. Inlining all of that into a single resource would create a payload measured in tens of thousands of tokens — too large for efficient subscription updates, too expensive to re-transmit on every quote tick, and impossible to coalesce at different cadences for different data types.

**The context resource stays small.** The decision context itself is roughly 40 lines of JSON. It changes only when the set of referenced resources changes (rare) or when the constraints change (also rare). A subscription to the decision context fires infrequently. A subscription to the quote resource fires on every price movement. These are fundamentally different update cadences, and the reference model keeps them decoupled. See [subscription-model-design.md](./subscription-model-design.md) for how subscription coalescing interacts with resource update frequency.

**Freshness is delegated to each sub-resource.** The quote resource has its own `timestamp`, `sequence`, and `stale_after_ms`. So does the feature resource. So does the risk resource. Each sub-resource manages its own freshness lifecycle. The decision context does not need to re-derive freshness for data it does not own. It simply points to the authoritative source.

---

## Inline Constraints

The `constraints` block is the exception to the reference-only model. It is inlined directly in the decision context, not referenced by URI:

```json
"constraints": {
  "kill_switch_active": false,
  "max_position_size": 5000000,
  "max_open_orders": 50
}
```

Three required fields:

| Field | Type | Semantics |
|---|---|---|
| `kill_switch_active` | boolean | If `true`, the agent must not submit any orders |
| `max_position_size` | number | Maximum notional position size for this instrument |
| `max_open_orders` | integer | Maximum number of concurrent open orders |

These are inlined for a specific reason: they are the immediate safety gate. When an agent reads the decision context, the very first thing it checks — before reading any referenced resource, before constructing any prompt, before invoking any model — is whether the kill switch is active. If it is, the decision cycle terminates immediately. No further reads. No further token spend.

If the constraints were referenced by URI, the agent would need a second read just to determine whether it is allowed to trade at all. That second read costs time and tokens, and introduces a window where the kill switch could activate between the context read and the constraint read. Inlining eliminates that window.

The constraints block uses `additionalProperties: true` in the normative schema. Implementations may extend it with broker-specific constraints — daily loss limits, restricted instrument lists, market-hours flags — without violating the schema. The three required fields are the protocol minimum. See [autonomous-safety-design.md](./autonomous-safety-design.md) for the full set of recommended autonomous controls.

---

## Freshness Inheritance

The decision context has its own freshness metadata:

- `timestamp` — when the context was last assembled
- `sequence` — monotonic integer, incremented on each reassembly
- `stale_after_ms` — how long the context is considered fresh

But the referenced sub-resources have their own freshness. The quote resource has its own `timestamp` and `stale_after_ms`. The feature resource has its own. The risk resource has its own. The decision context's freshness tells you when the *composition* was last assembled. The sub-resource freshness tells you when each *data source* was last current.

The agent must check both.

### Scenario: Fresh Context, Stale Quote

The server assembles the decision context at T=0. The context's `stale_after_ms` is 5000. At T=2000, the agent reads the decision context. The context is fresh — only 2 seconds old. The agent extracts `quote_resource` and reads the quote. The quote's `timestamp` is T=-3000 (three seconds before the context was assembled) and its `stale_after_ms` is 2000. The quote has been stale for 5 seconds.

The context is fresh. The quote is stale. The agent must not trade.

This is not a protocol failure. The quote may be stale because the market closed, because the broker's feed disconnected, or because the instrument was halted. The decision context cannot know why the quote is stale — it only knows that it referenced a quote resource. The staleness lives in the quote resource itself, and the agent must check it there.

### Freshness Validation Order

| Step | Check | Fail Action |
|---|---|---|
| 1 | Decision context `timestamp` + `stale_after_ms` > now | Re-read context |
| 2 | `constraints.kill_switch_active` == false | Halt decision cycle |
| 3 | Quote resource fresh | Halt decision cycle |
| 4 | Feature resource fresh | Halt or degrade |
| 5 | Account/risk resources fresh | Halt decision cycle |
| 6 | Sequence continuity for all resources | Halt and reconcile |

Step 2 happens before any sub-resource reads. Steps 3-6 happen after the agent reads each referenced resource. The freshness model is layered: the context's freshness gates whether the composition is worth reading, and the sub-resource freshness gates whether the underlying data is worth trading on. See [freshness-design.md](./freshness-design.md) for the full freshness validation model.

---

## The apex://agent/ Namespace

The decision context lives under `apex://agent/`, not `apex://market/` or `apex://account/`. This is deliberate.

The `apex://market/` namespace contains raw market data resources — quotes, candles, features. These are objective data: the bid is 1.0874 regardless of which agent is connected, which account is trading, or what constraints apply.

The `apex://account/` namespace contains account-level state — balances, positions, orders, risk. These are tied to a specific account but are still raw data: the account has $47,000 in equity regardless of what the agent intends to do with it.

The `apex://agent/` namespace contains agent-facing compositions. The decision context is not raw data. It is a *view* — an opinionated assembly of references and constraints designed for a specific consumer (the agent) and a specific purpose (making a trading decision on one instrument). It combines market data URIs, account data URIs, and safety constraints into a single object that makes sense only in the context of an agent decision loop.

The namespace separation preserves a clean semantic boundary. Market resources are the broker's data. Account resources are the account's data. Agent resources are the agent's working view of both.

The `apex://agent/` namespace is currently defined with only the decision context resource. The spec reserves additional agent resources for future specification: watchlist, intents, and memory. These follow the same principle — they are agent-facing compositions, not raw data — and they will live in the same namespace when specified.

---

## Production Autonomous Requirement

The decision context is mandatory for implementations claiming `APEX Production Autonomous` (see [production.md](../spec/core/production.md) Section 2.1). The requirements are precise:

- Expose `apex://agent/decision-context/{instrument_id}`
- Reference quote, feature, candle, account summary, positions, orders, and risk resources
- Be stable enough for direct use by agent runtimes without broker-specific prompt shaping

The third requirement is the critical one. "Stable enough for direct use" means an agent framework can read the decision context from any conforming broker and construct a model prompt from it without knowing anything about the broker's implementation. The schema is normative. The field names are normative. The URI patterns for referenced resources are normative. A runtime that works with one APEX Production Autonomous broker works with all of them.

This is the interoperability value of the decision context. Without it, every agent framework needs a broker-specific adapter to know which resources to read, in what order, and how to assemble them. The decision context is the protocol's answer to adapter proliferation: one canonical shape, one canonical location, one canonical set of references.

Implementations that claim only `APEX Production Realtime` (not Autonomous) are not required to expose the decision context, but may do so. The decision context is useful even outside autonomous trading — it reduces prompt assembly cost for any agent that reads market and account state together.

---

## How Agents Use It

The decision context is the entry point, not the only read. Here is the concrete agent loop:

```
1. Read decision context
   → apex://agent/decision-context/APEX:FX:EURUSD

2. Check context freshness
   → Is timestamp + stale_after_ms > now?
   → If no: re-read or halt

3. Check inline constraints
   → Is kill_switch_active true? → halt
   → Note max_position_size and max_open_orders for later validation

4. Extract resource URIs from market and account blocks

5. Read each referenced resource
   → quote, features, M1 candles, M5 candles, H1 candles,
      account summary, positions, orders, risk

6. Validate freshness of each sub-resource
   → Each has its own timestamp, sequence, stale_after_ms
   → If any execution-critical resource is stale: halt

7. Check sequence continuity
   → Each resource's sequence should be >= last seen sequence
   → If gap detected: reconcile before proceeding

8. Construct model prompt from structured resource data

9. Invoke model → receive intent (e.g., "buy 100000 EURUSD limit 1.0873")

10. Validate intent against constraints
    → Size <= max_position_size?
    → Open orders < max_open_orders?
    → Risk check passes?

11. Execute via apex.order.place

12. Record audit trail
    → Resource URIs used, sequences, freshness values,
       model intent, validation result, broker response
```

Steps 1-3 use only the decision context. Steps 5-7 use the referenced sub-resources. The decision context reduces step 1 from nine separate reads to one, but the agent still reads the sub-resources in step 5. The total number of reads is the same — the difference is that the agent knows *which* reads to make without hardcoding them, and it can fail fast on constraints before spending tokens on data reads.

See [resource-tool-design.md](./resource-tool-design.md) for how resource reads interact with the tool layer, and [autonomous-safety-design.md](./autonomous-safety-design.md) for the full safety validation pipeline.

---

## Parallels

The decision context is a common pattern in system design. It appears wherever a consumer needs a pre-composed view over multiple data sources.

**GraphQL query.** A single GraphQL request resolves data from multiple backend services — user profile, order history, product catalog — and returns a composed response. The decision context is the same idea: one request, multiple data sources, one composed result. The difference is that the decision context uses URI references instead of inline resolution, more like a GraphQL response that returns links to sub-resources rather than embedding them.

**Database VIEW.** A SQL VIEW is a pre-composed query over base tables. `SELECT * FROM trading_context WHERE instrument = 'EURUSD'` joins quote, position, risk, and feature tables into one row. The decision context is a protocol-level VIEW: it defines the join, and the agent executes it by reading the referenced resources. The base tables (quote, positions, risk) exist independently and can be queried directly.

**API gateway aggregation.** API gateways like Kong or AWS API Gateway can compose responses from multiple backend services into a single endpoint. The decision context is this pattern applied to the agent's data needs: one endpoint (`apex://agent/decision-context/{instrument_id}`) that aggregates references to market data, account state, and risk constraints.

**React context provider.** In React, a context provider wraps nested components and makes composed state available without prop drilling. The decision context wraps market, account, and constraint state and makes it available to the agent without requiring the agent to know the individual resource paths. The context provider pattern and the decision context pattern share the same motivation: reduce the coupling between the consumer and the sources.

**Financial risk dashboard.** A Bloomberg terminal's DES (Description) function for an instrument composes data from multiple feeds — pricing, reference data, analytics, corporate actions — into a single screen. The trader does not query each feed separately. The terminal assembles the view. The decision context is the programmatic equivalent: the broker assembles the view, and the agent reads it.

**Bloomberg DES function.** More specifically, DES composes static reference data, live pricing, computed analytics, and risk metrics for one instrument into a single display. The decision context composes quote references, feature references, candle references, account references, and safety constraints for one instrument into a single JSON object. Same principle, different consumer — a human trader versus an autonomous agent.

---

## Schema Summary

The normative schema is defined in [`schemas/decision-context.resource.schema.json`](../spec/core/schemas/decision-context.resource.schema.json).

| Field | Type | Required | Description |
|---|---|---|---|
| `instrument_id` | string | Yes | APEX instrument identifier (pattern: `^APEX:[A-Z]+:[A-Z0-9:.]+$`) |
| `timestamp` | date-time | Yes | When the context was last assembled |
| `sequence` | integer | Yes | Monotonic sequence, incremented on each reassembly |
| `stale_after_ms` | integer | Yes | Freshness bound in milliseconds |
| `market.quote_resource` | URI | Yes | Reference to the live quote resource |
| `market.feature_resource` | URI | Yes | Reference to the derived features resource |
| `market.candle_resources` | URI[] | Yes | References to candle resources (minimum 3 timeframes) |
| `account.summary_resource` | URI | Yes | Reference to the account summary resource |
| `account.positions_resource` | URI | Yes | Reference to the positions resource |
| `account.orders_resource` | URI | Yes | Reference to the orders resource |
| `account.risk_resource` | URI | Yes | Reference to the risk state resource |
| `constraints.kill_switch_active` | boolean | Yes | Whether the kill switch is engaged |
| `constraints.max_position_size` | number | Yes | Maximum notional position size |
| `constraints.max_open_orders` | integer | Yes | Maximum concurrent open orders |
