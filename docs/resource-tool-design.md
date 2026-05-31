# APEX Protocol — Resource vs Tool Architectural Split

**Version:** `0.2.0-alpha`

---

## Overview

APEX separates commands from queries, actions from state. Tools are for doing things. Resources are for knowing things. Notifications are for learning that things changed.

This is not an accident of protocol design. It is the core architectural choice that makes agent-native trading viable at all. Without it, an LLM-based agent must poll for every state change, process every response in its context window, and somehow keep track of what is current. The split exists because the cost structure of language model inference — measured in tokens, latency, and dollars — makes the alternative untenable for production trading.

---

## The Problem with Tool-Only Trading

Imagine an agent that needs to track EURUSD quotes. It has one tool: `apex.market.quote`. To stay current, it calls that tool every 100 milliseconds.

That is 600 tool calls per minute for one instrument. Each call returns a JSON response. The LLM processes each response as part of its conversation. The context window fills with quote responses — bid 1.08740, bid 1.08741, bid 1.08742, bid 1.08741 — hundreds of nearly identical payloads scrolling past.

Now multiply by the instruments the agent is watching. Three instruments: 1,800 tool calls per minute. Five instruments: 3,000. The LLM is spending most of its inference budget reading quotes that were stale before it finished processing them.

But it gets worse. The agent still misses events between polls. An order fills at T+50ms. The agent's next poll is at T+100ms. For 50 milliseconds, the agent is trading on a stale position view. If it sizes a new order during that window, it may double its exposure.

And the cost. At typical API token pricing, 600 tool responses per minute per instrument translates into a prompt cost that dwarfs the trading P&L. The agent is spending more on tokens than it could ever make on the market.

This is why the spec says: **do not drive trading from repeated synchronous polling of `apex.market.quote`**.

---

## The Three Primitives

APEX defines three interaction primitives. Each has a purpose and a boundary.

### Tools

Tools are for actions and explicit queries. The agent calls a tool when it needs to **do** something or ask a one-time question.

Actions: `apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close`. These mutate state. They carry MCP annotations — `destructiveHint: true`, `idempotentHint: false` — so the agent and runtime know they have consequences.

Explicit queries: `apex.market.quote`, `apex.market.snapshot`, `apex.market.details`, `apex.market.search`, `apex.account.summary`, `apex.account.positions`, `apex.account.orders`, `apex.account.history`, `apex.risk.check`, `apex.risk.limits`. These return a point-in-time answer. The agent calls them when it needs a specific piece of information right now — the contract spec for an instrument, the account's trade history, a pre-trade margin check.

Tools are the interoperability baseline. An implementation that exposes only tools is a valid APEX participant. But it is not production-grade for realtime trading.

### Resources

Resources are continuously changing state. The agent subscribes and re-reads on change. The value is always current.

Market state: `apex://market/quote/{instrument_id}`, `apex://market/candles/{instrument_id}?timeframe=M1&limit=200`, `apex://market/features/{instrument_id}`.

Account state: `apex://account/summary/{account_id}`, `apex://account/positions/{account_id}`, `apex://account/orders/{account_id}`, `apex://account/fills/{account_id}`, `apex://account/risk/{account_id}`.

Agent state: `apex://agent/decision-context/{instrument_id}`.

Resources are not append-only event logs. They are current-state snapshots. When you read a quote resource, you get the latest quote — not the history of every tick since you last looked. When you read the positions resource, you get the current positions — not a journal of every fill that built them.

Every resource carries realtime metadata: `sequence` (monotonically increasing within the resource stream), `timestamp` or `as_of` (when the state was valid), and `stale_after_ms` (how long before the state should be considered stale for trading decisions). This metadata is what lets the runtime — not the model — decide whether the state is fresh enough to act on.

### Notifications

Notifications are change signals. They come in two flavors.

**Resource invalidation:** `notifications/resources/updated` — the standard MCP signal that a resource has changed. The agent re-reads the resource. The notification does not carry the new state; it just says "something changed, go look." This is level-triggered invalidation.

**Execution events:** `notifications/apex.order.filled`, `notifications/apex.order.partially_filled`, `notifications/apex.order.rejected`, `notifications/apex.risk.kill_switch_engaged`. These carry data the agent cannot reconstruct from current state. A fill happened at a specific price. An order was rejected for a specific reason. The kill switch was activated. These are historical facts, not current-state snapshots.

There is also `notifications/apex.market.candle_closed`, which tells the agent a candle bar completed on a wall-clock boundary. The completed candle is available in the candle resource, but the notification triggers the agent to update its candle cache and potentially recalculate features.

---

## The Division of Responsibility

This table captures the normative split. If you are implementing an APEX broker or runtime, this is the reference for what goes where.

| Responsibility | Mechanism | Examples |
|---|---|---|
| **Order entry, modification, cancellation** | Tools | `apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close` |
| **Explicit snapshots and one-time queries** | Tools | `apex.market.quote`, `apex.market.snapshot`, `apex.market.details`, `apex.market.search`, `apex.account.history` |
| **Pre-trade risk checks** | Tools | `apex.risk.check`, `apex.risk.limits` |
| **Session management** | Tools | `apex.session.authenticate`, `apex.session.capabilities`, `apex.session.heartbeat`, `apex.session.acknowledge` |
| **Live market state** | Resources | Quote, candles (M1/M5/H1), features |
| **Live account state** | Resources | Summary, positions, orders, fills, risk |
| **Decision context** | Resources | `apex://agent/decision-context/{instrument_id}` |
| **Resource invalidation** | Notifications | `notifications/resources/updated` |
| **Execution events** | Notifications | Order filled, partially filled, rejected |
| **System events** | Notifications | Kill switch engaged, candle closed, replay failed, gap fill |
| **Feed handling and feature computation** | Deterministic code (outside the model) | Tick processing, volatility calculation, regime detection, spread monitoring |
| **Throttling and rate limits** | Deterministic code (outside the model) | Update coalescing, notification batching |
| **Hard risk enforcement** | Deterministic code (outside the model) | Stale-data rejection, sequence-gap rejection, kill switch halt, position limit enforcement |

The last three rows are critical. The model does not handle raw tick streams. The model does not enforce risk limits. The model does not decide whether state is fresh enough. Deterministic code — in the broker, in the runtime, outside the LLM entirely — handles these concerns. The model proposes. The runtime enforces.

---

## Subscription Semantics

APEX resource subscriptions are level-triggered invalidation, not guaranteed delivery of every micro-event. This distinction matters.

When the server's quote changes, it emits `notifications/resources/updated` for the quote resource. The client re-reads the resource and gets the current quote. If the quote changed three times between the last notification and the re-read, the client sees only the latest value. The two intermediate quotes are gone.

This is by design. Agents need current state, not tick-by-tick history. The server may coalesce updates to avoid drowning the client in notifications. If EURUSD is ticking 10 times per second, the server might emit one notification per second. The client re-reads and gets the latest quote. The nine intermediate ticks were coalesced.

When updates are coalesced, the `sequence` value at time of read reflects the latest state — not the number of notifications the client received. If the client saw sequence 100, then received one notification and re-reads to find sequence 107, it knows six intermediate updates were coalesced. This is normal. The client should not treat coalesced updates as an error.

What the client must detect is non-monotonic sequences (something went backwards, which indicates corruption or a bug) and sequences that skip without a corresponding notification (which indicates a missed notification). In either case, the client must re-read the resource and, for execution-critical resources, halt autonomous execution until continuity is restored.

Agents that need tick-by-tick history should use candle resources or fill events. Resource subscriptions are not the mechanism for high-frequency market replay.

---

## Tool Responses vs Resource Schemas

Tools and resources sometimes return the same conceptual data. `apex.market.quote` returns a quote. `apex://market/quote/{instrument_id}` is a quote resource. Both contain bid, ask, mid, spread, timestamp, market status.

They are structurally compatible but serve different purposes.

The tool response is the interoperability baseline. It is what every APEX implementation must support. It does not carry `sequence` or `stale_after_ms` because those fields are part of the realtime resource layer, not the request/response baseline.

The resource schema extends the tool shape with realtime metadata:

| Field | Tool Output | Resource Output |
|---|---|---|
| `bid`, `ask`, `mid`, `spread` | Yes | Yes |
| `timestamp` | Yes | Yes |
| `is_tradeable`, `market_status` | Yes | Yes |
| `sequence` | No | Yes |
| `stale_after_ms` | No | Yes |

When a tool returns the same data as a resource, the data is consistent — it comes from the same underlying state. But the tool response is a point-in-time snapshot with no freshness contract. The resource is a subscribable, sequenced, freshness-bounded state object.

For one-time queries — "what is the current quote for GBPJPY?" — the tool is fine. For continuous awareness — "I need to know the current EURUSD quote at all times for trading decisions" — the resource is the correct interface.

---

## The Prompt Cost Argument

This is the economic argument for the split, stated concretely.

**With tool polling:** The agent calls `apex.market.quote` 600 times per minute. Each response is roughly 150 tokens. That is 90,000 tokens per minute of quote data alone in the conversation context. Add positions, orders, risk, and features, and the context window is dominated by polling responses. The model spends most of its time reading state it already knew, looking for the one thing that changed. At $15 per million input tokens, the quote polling alone costs $1.35 per minute per instrument. That is $81 per hour. For an agent watching five instruments, $405 per hour in prompt cost — before the model does any reasoning at all.

**With resource subscriptions:** The agent subscribes to the quote resource. The runtime maintains a local cache. When a notification arrives, the runtime re-reads the resource and updates the cache. The model sees only the latest state when it is asked to make a decision. One quote, not 600. The context window contains the current state of the world, not the history of how it got there.

The difference is not 2x or 5x. It is orders of magnitude. The subscription model turns an unbounded, append-only cost into a fixed, current-state cost.

This is also why the spec says agents should consume structured market/account/risk state, not raw unbounded tick text streams. The feature resource exists specifically to package derived state — returns, volatility, regime, liquidity — into a single object the model can consume without parsing candle arrays or computing moving averages in-prompt.

---

## Concrete Agent Loop

Here is one iteration of a production agent loop, showing how the three primitives interact.

### Bootstrap

1. Connect to the broker. Call `apex.session.authenticate` and `apex.session.capabilities`.
2. Read `resources/list` to discover available resources.
3. Subscribe to quote, candles (M1, M5, H1), features, positions, orders, fills, risk.
4. Read each subscribed resource once to establish the baseline cache. Record the `sequence` and `timestamp` for each.
5. Begin decisioning only after freshness and sequence baselines are established for all execution-critical resources.

### Steady State (One Decision Cycle)

1. **Notification arrives:** `notifications/resources/updated` for `apex://market/features/APEX:FX:EURUSD`.
2. **Re-read:** Runtime reads the feature resource. Gets new volatility, returns, regime. Sequence advanced from 3401 to 3402. Freshness is within `stale_after_ms`.
3. **Update cache:** Runtime replaces the cached feature state. Validates sequence monotonicity. Checks that no execution-critical resource is stale.
4. **Model decision:** Runtime constructs decision context from cached state — current quote, latest features, recent candles, open positions, risk limits. Passes this to the model. The model returns an intent: "buy 100,000 EURUSD at market."
5. **Validation:** Runtime checks intent against safety rules — kill switch not active, instrument is tradeable, quote is fresh, margin is sufficient, position limits are respected, no partial fills in flight on related orders.
6. **Tool call:** Runtime calls `apex.risk.check` to confirm margin. Then calls `apex.order.place` with the order parameters and a unique `client_order_id`.
7. **Response:** Broker returns order accepted. Resource notifications arrive for orders, positions, risk. Runtime re-reads affected resources, updates cache.
8. **Audit:** Runtime records the decision — which resource URIs were used, their sequences, the model's intent, the validation result, the broker response.
9. **Acknowledge:** Runtime calls `apex.session.acknowledge` with the last processed SSE event ID to advance the server's retention cursor.

The model touched the state exactly once — when it was asked to decide. It saw a single, coherent snapshot. It did not poll. It did not process intermediate ticks. It did not scroll through 600 quote responses looking for the latest one.

---

## Parallels

This architecture is not new. APEX applies established patterns to the specific problem of LLM-based trading agents.

| Pattern | Description | APEX Analogy |
|---|---|---|
| **CQRS** (Command/Query Responsibility Segregation) | Separate the write model from the read model. Commands mutate state through one path. Queries read state through another. | Tools are the command path. Resources are the query path. They share underlying state but have different interfaces, different schemas, and different access patterns. |
| **Event Sourcing** | State is derived from a sequence of events. Current state is a projection. | Fills and rejections are events — historical facts with stable IDs. Resources are projections — current state derived from those events. The positions resource is the projection of all fills. The orders resource is the projection of all order lifecycle events. |
| **Redux** (actions/reducers/store) | Actions describe what happened. Reducers compute new state. The store holds current state. Components subscribe to the store. | Tool calls are actions. The broker's state engine is the reducer. Resources are the store. The agent subscribes to resources and re-reads on change, just as a React component re-renders on store update. |
| **Database Read Replicas** | Write to the primary. Read from the replica. The replica is eventually consistent but optimized for read throughput. | Write through tools (order entry hits the primary). Read from resources (the resource layer is the read replica). Resources may lag by one update cycle, but they are always consistent within themselves and carry sequence numbers for the client to verify. |
| **MVC** (Model/View/Controller) | Model holds state. View presents it. Controller handles input. | Resources are the model. Decision context is the view (a model-friendly projection). Tools are the controller (handling agent input and translating it into state mutations). |
| **Bloomberg Terminal** | BPipe delivers market data. EMSX handles execution. Different systems, different protocols, different scaling characteristics. | Resources are BPipe — streaming state delivery optimized for consumption. Tools are EMSX — execution entry points optimized for correctness and audit. You would not submit orders through BPipe. You would not stream tick data through EMSX. |

The strongest parallel is CQRS. In a CQRS system, the command model is optimized for write consistency — validation, idempotency, ordering guarantees. The query model is optimized for read performance — denormalized, pre-computed, eventually consistent. APEX tools are the command model: validated, idempotent (`client_order_id` prevents duplicates), annotated with safety hints. APEX resources are the query model: denormalized (the feature resource pre-computes volatility and regime), pre-packaged (decision context assembles everything the model needs), and eventually consistent (the resource may lag the tool response by one notification cycle, but the sequence number makes this detectable).

The event sourcing parallel explains why notifications split into two categories. Resource update notifications are projections — they tell you the current state changed, go re-read it. Execution event notifications are source events — they tell you something happened that you need to know about as a historical fact, not just as a state change. A fill at 1.0847 is a fact. The current position of 100,000 EURUSD is a projection. Both matter. They are delivered through different mechanisms because they serve different purposes.

---

## Storage

The protocol does not mandate how brokers store resource state or how runtimes cache it. It mandates the behavioral contract:

- Resources are current-state snapshots, not append-only logs.
- Resources carry freshness metadata (`sequence`, `timestamp`, `stale_after_ms`).
- Notifications signal change; the client re-reads the resource to get the current value.
- Execution events carry data that cannot be reconstructed from current resource state.
- The runtime maintains a local cache and validates freshness before allowing autonomous execution.
- The runtime, not the model, decides whether state is fresh enough to trade.

How the broker maintains the underlying state — in-memory, database-backed, event-sourced — is an implementation choice. How the runtime caches resources — hash map, structured object, database — is an implementation choice. The protocol defines the interface between them.
