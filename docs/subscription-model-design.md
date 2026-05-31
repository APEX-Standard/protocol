# APEX Protocol — Subscription Model Design

**Version:** `0.2.0-alpha`

---

## Overview

Subscriptions are how agents stay current without polling. The agent subscribes to a resource URI. The server emits a notification when the underlying state changes. The agent re-reads the resource to get the latest value. This three-step loop — subscribe, notify, re-read — is the heartbeat of the agent-native model.

Without subscriptions, an agent must poll. Polling means guessing an interval: too fast wastes tokens and bandwidth, too slow means trading on stale data. The agent has no way to know the right frequency because it depends on market conditions that are themselves what the agent is trying to observe. A quote for EURUSD during London open might update 500 times per second. The same quote during Tokyo lunch might update twice per second. No polling interval is correct for both.

Subscriptions eliminate the guessing. The server knows when state changes. It tells the agent. The agent reads the current state. The frequency is exactly right because it tracks reality, not a timer.

---

## The Subscribe/Notify/Re-Read Pattern

The subscription model has three steps, always in the same order.

**Step 1 — Subscribe.** The agent sends `resources/subscribe` with the canonical resource URI:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "resources/subscribe",
  "params": {
    "uri": "apex://market/quote/APEX:FX:EURUSD"
  }
}
```

The server registers the subscription. From this point forward, it will notify the agent when the EURUSD quote changes. The subscription is scoped to the MCP session — it lives as long as the session does.

**Step 2 — Notify.** The quote updates. The server emits a notification over the SSE stream:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "uri": "apex://market/quote/APEX:FX:EURUSD"
  }
}
```

This notification is a signal, not data. It does not contain the new bid, ask, or spread. It says one thing: "the resource at this URI has changed since you last read it."

**Step 3 — Re-read.** The agent reads the resource to get current state:

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "resources/read",
  "params": {
    "uri": "apex://market/quote/APEX:FX:EURUSD"
  }
}
```

The response contains the current quote — bid, ask, mid, spread, timestamp, sequence, stale_after_ms. The agent updates its local cache. It now has the latest state.

### A Concrete Walkthrough

An agent tracking EURUSD starts by subscribing to `apex://market/quote/APEX:FX:EURUSD`. The server acknowledges. The agent reads the resource once: bid=1.08740, ask=1.08760, seq=500.

Five seconds later, the market moves. The server emits `notifications/resources/updated` for the quote URI. The agent re-reads: bid=1.08755, ask=1.08775, seq=510. The agent updates its cache. Ten coalesced ticks happened (500 to 510), but the agent sees only the current state — which is exactly what it needs for its next decision.

The agent never called `apex.market.quote` as a tool. It never polled on a timer. It subscribed once and now tracks the market in real time through the notification loop. The cost is one subscription setup, one notification per coalesced update batch, and one resource read per notification. Compared to polling at 100ms intervals, this is orders of magnitude fewer round trips and zero wasted reads when the market is quiet.

---

## Level-Triggered vs Edge-Triggered

APEX subscriptions use **level-triggered** invalidation. The notification says "the resource changed." The agent reads the current level — the full current state of the resource. It does not receive a delta, a diff, or a description of what changed.

This is a deliberate choice. The alternative is **edge-triggered** delivery: the notification would carry the change itself — "bid moved from 1.08740 to 1.08755" or "position quantity increased by 10000." Edge-triggered systems require the consumer to process every edge in order, because missing one edge means the local state diverges. If the agent misses edge 507 ("bid moved down 2 pips"), its local bid is permanently wrong until it does a full resync.

Level-triggered systems are immune to this failure mode. If the agent misses a notification, it simply reads a slightly newer state the next time it does read. The state is always internally consistent because it comes from a single read at a single point in time. There is no accumulated delta to get out of sync.

This matters for trading agents because notifications travel over SSE, which is a best-effort delivery channel. Network hiccups, load balancer rotations, and garbage collection pauses all cause brief gaps. In an edge-triggered model, every gap requires explicit recovery — sequence the deltas, detect the gap, request a resend. In APEX's level-triggered model, the agent just reads the resource. The current level is the recovery mechanism.

The spec makes this explicit: "clients must assume subscriptions are level-triggered invalidation signals, not guaranteed delivery of every market micro-event, unless the server explicitly documents stronger delivery semantics."

For agents, level-triggered is the natural fit. An LLM-based agent making a trading decision needs current state: what is the bid right now, what is my position right now, what is my risk right now. It does not need a history of how the bid got to its current value. That history is what candles are for. The subscription model delivers exactly what the decision loop requires — a signal that state changed, followed by the current state itself.

---

## Coalescing

Markets move fast. EURUSD during a news release might tick 200 times in a single second. If the server emitted one notification per tick, the agent would receive 200 notifications per second for one instrument. Each notification triggers a resource read. That is 200 reads per second — more than any agent needs, and far more than an LLM can meaningfully process.

Servers may coalesce high-frequency updates. If EURUSD ticks 10 times in 50 milliseconds, the server may emit 1 notification instead of 10. When the agent re-reads the resource in response to that single notification, it gets the state as of the 10th tick (say, seq=510). It never sees the states at seq=501 through seq=509. Those intermediate states existed on the server for a few milliseconds each and were superseded before the agent could have acted on them.

This is by design. The spec says: "when updates are coalesced, a resource read returns the current state at time of read. Intermediate states that were coalesced are never recoverable through resource reads."

The coalescing rate is an implementation choice. A server targeting high-frequency agents might coalesce to 10 notifications per second. A server targeting slower decisioning loops might coalesce to 1 notification per second. The protocol does not mandate a rate. It mandates the contract: notifications may be coalesced, resource reads return current state, intermediate states are not recoverable.

Agents that need tick-by-tick history should use candle resources or fill events, not resource polling. The subscription model is for current state, not historical replay.

---

## Sequence Behavior Under Coalescing

When updates are coalesced, the `sequence` value in the resource reflects the latest state, not the number of notifications the agent observed. This is the natural consequence of level-triggered reads: the agent reads the current state, and the current state has a sequence number that reflects all updates that have occurred, including coalesced ones.

Here is what the agent sees:

1. Agent reads quote: seq=500.
2. Server coalesces 10 ticks.
3. Server emits one `notifications/resources/updated`.
4. Agent re-reads quote: seq=510.

The gap from 500 to 510 is expected. The agent did not miss anything — the server coalesced 10 updates into one notification, and the resource read returned the state after all 10. The sequence jumped by 10 because 10 updates happened, not because the agent failed to read 9 of them.

This is different from a gap caused by a missed notification. If the agent sees seq=500, then later (without any notification) reads seq=515, something went wrong — a notification was lost, or the agent failed to process it. The sequence still enables gap detection because the agent can compare the sequence it expected (based on the notifications it received) against the sequence it got.

The rule: a sequence gap paired with a notification is coalescing. A sequence gap without a notification is a problem. In either case, the agent's response is the same — re-read the resource. But the diagnostic is different. The first is normal operation. The second warrants logging, investigation, and potentially halting autonomous execution until continuity is restored.

Cross-reference [`sequence-design.md`](./sequence-design.md) for the full sequencing model, including per-resource scoping and why global counters are wrong.

---

## What Must Be Subscribable

The production specification mandates that all execution-critical realtime resources support subscriptions. These are the resources an agent must subscribe to in order to maintain a live, tradeable view of the market and account.

### Normative Table: Mandatory Realtime Resources

| Resource URI | Category | Update Frequency | Purpose |
|---|---|---|---|
| `apex://market/quote/{instrument_id}` | Market | Continuous (tick-level) | Current bid/ask/spread for execution |
| `apex://market/candles/{instrument_id}?timeframe=M1&limit=200` | Market | Every minute | 1-minute OHLCV bars for short-horizon analysis |
| `apex://market/candles/{instrument_id}?timeframe=M5&limit=200` | Market | Every 5 minutes | 5-minute OHLCV bars for medium-horizon analysis |
| `apex://market/candles/{instrument_id}?timeframe=H1&limit=200` | Market | Every hour | 1-hour OHLCV bars for trend context |
| `apex://market/features/{instrument_id}` | Market | Derived (follows quote) | Pre-computed signals: returns, volatility, regime, liquidity |
| `apex://account/summary/{account_id}` | Account | On state change | Balance, equity, margin, P&L |
| `apex://account/positions/{account_id}` | Account | On fill/close | Open positions with unrealized P&L |
| `apex://account/orders/{account_id}` | Account | On order lifecycle event | Active and recent orders |
| `apex://account/fills/{account_id}` | Account | On fill | Execution history |
| `apex://account/risk/{account_id}` | Account | On state change | Risk metrics, kill switch state, limit utilization |

For Production Autonomous implementations, the decision context resource is also subscribable:

| Resource URI | Category | Update Frequency | Purpose |
|---|---|---|---|
| `apex://agent/decision-context/{instrument_id}` | Agent | Derived (follows dependencies) | Composite view referencing quote, features, candles, account, risk |

Every resource in this table must include `timestamp` (or `as_of`), `sequence`, and `stale_after_ms`. Without these three properties, the agent cannot determine freshness, detect gaps, or know when to halt. Cross-reference [`freshness-design.md`](./freshness-design.md) for staleness rules.

---

## Subscription Lifecycle

Subscriptions are scoped to the MCP session. They are created when the agent calls `resources/subscribe` and destroyed when the session ends.

### Creation

The agent subscribes to a resource URI. The server registers the subscription against the current session (identified by `Mcp-Session-Id`). The subscription is active immediately — the next state change for that resource will produce a notification.

### Session Teardown

When the session ends — the agent sends `DELETE /mcp`, the session times out, or the server shuts down — all subscriptions for that session are cancelled. The server stops emitting notifications. This is automatic; the agent does not need to explicitly unsubscribe from each resource.

### Reconnection

When the SSE stream drops and the agent reconnects with the same `Mcp-Session-Id` and `Last-Event-ID`, the session continues. Subscriptions remain active because the session identity is preserved. The server replays missed events (or emits gap fill markers) and resumes live notification delivery.

When the session itself is lost — the `Mcp-Session-Id` is no longer valid, or the server has evicted the session — the agent must establish a new session and re-subscribe to all resources. The spec does not mandate subscription persistence across session boundaries. An implementation may choose to restore subscriptions from stored session state, but this is implementation-dependent and agents must not rely on it.

The practical consequence: every agent must have a bootstrap routine that can subscribe to all execution-critical resources from scratch. This routine runs on first connect and on any session-level reconnect. Cross-reference [`transport-design.md`](./transport-design.md) for the reconnect model and [`session-design.md`](./session-design.md) for session identity semantics.

---

## The Bootstrap Subscription Flow

The reference bootstrap flow (from [`reference-flows.md`](./reference-flows.md)) prescribes a specific order:

1. Connect to the broker MCP server.
2. Call `apex.session.authenticate`.
3. Call `apex.session.capabilities`.
4. Read `resources/list` to discover available resources.
5. **Subscribe to all execution-critical resources** — quote, candles (M1, M5, H1), features, positions, orders, fills, risk, account summary.
6. Read each subscribed resource once to establish the baseline cache.
7. Begin decisioning only after freshness and sequence baselines are established.

The ordering of steps 5 and 6 is deliberate. **Subscribe before the first read.**

Why? Consider the alternative. The agent reads the quote (seq=500), then subscribes. Between the read and the subscribe, the quote updates to seq=501. The subscription starts at seq=501. The agent never receives a notification for the 500-to-501 transition because it was not yet subscribed. Its cache says seq=500 but the resource is at seq=501. The agent is already stale before it starts trading.

By subscribing first, the agent ensures it will receive notifications for any changes that happen after the subscription is registered. When it then reads the resource, it gets the current state (say, seq=500). If the resource updates to seq=501 before or during the read, the agent will receive a notification and re-read — getting seq=501 or later. No gap. No stale cache at bootstrap.

This is the same pattern used in React's `useEffect` with dependency arrays: register the listener before reading the initial value, so you cannot miss a change between read and listen. It is the same pattern used in PostgreSQL's `LISTEN` followed by initial `SELECT` — you start listening before you query, so changes that occur during the query trigger a notification you will process.

### Bootstrap Timing

The agent must not begin autonomous execution until all subscriptions are active and all baseline reads are complete. This means the bootstrap flow is a gate. If any subscription fails, or any resource read returns an error, the agent must not proceed to decisioning. A partial subscription set means partial visibility, which means the agent is making decisions without full state awareness.

---

## Production Anti-Patterns

### Polling Instead of Subscribing

The spec is explicit: "production implementations must not require agents to poll `apex.market.quote`, `apex.account.positions`, or `apex.account.orders` on a fixed short interval when equivalent realtime resources are available."

An agent that calls `apex.market.quote` every 100 milliseconds instead of subscribing to `apex://market/quote/{instrument_id}` is doing two things wrong. First, it is wasting tokens and bandwidth on redundant reads — most of those reads will return the same state because the market did not move in 100ms. Second, it is missing the subscription notification pathway entirely, which means it has no way to know about updates that happen between polls.

This anti-pattern usually appears when a team builds on the tool-only baseline (which is valid for basic interoperability) and never upgrades to the resource model. The resource-tool split exists precisely to avoid this. Cross-reference [`resource-tool-design.md`](./resource-tool-design.md) for the full rationale.

### Treating Notifications as Data

A notification is a signal, not a payload. If an agent tries to extract trading data from the `notifications/resources/updated` message — parsing the URI for the instrument, inferring the direction of change, using the notification timestamp as the quote timestamp — it is building on the wrong abstraction.

The notification carries one piece of information: which resource changed. Everything else comes from re-reading the resource. The notification does not contain the new bid. It does not contain the sequence. It does not contain the timestamp of the underlying data change. It says "go re-read this URI."

Implementations that enrich notifications with data fields (embedding the new bid in the notification payload, for example) are going beyond the spec. Agents that depend on enriched notifications will break when connected to a different broker that emits spec-compliant bare notifications. Always re-read.

### Subscribing to Non-Critical Resources at High Frequency

Not every resource warrants a subscription. If an agent subscribes to `apex://market/candles/{instrument_id}?timeframe=H1&limit=200` and then re-reads 200 hourly candles every time the resource updates, it is wasting bandwidth for data that changes once per hour. The subscription is correct — the agent should know when a new hourly candle closes — but the frequency of useful updates is inherently low.

The anti-pattern is subscribing to everything at the same priority and processing all notifications identically. A quote notification during active trading is urgent. An hourly candle notification is routine. The agent's runtime should triage notifications based on the resource category and the current execution context.

### Not Re-Subscribing After Session Loss

When the MCP session is lost (not just the SSE stream, but the session itself), all subscriptions are gone. An agent that reconnects and starts reading resources without re-subscribing will have a valid initial read but no way to learn about subsequent changes. Its cache goes stale silently. There is no error, no warning — just increasingly outdated data feeding into decisions.

Every agent needs a "cold start" path that re-subscribes to all execution-critical resources. This path should be the same code that runs at initial bootstrap. If the agent detects a session loss (the `Mcp-Session-Id` is rejected, or the server sends a new session identifier), it must run the full bootstrap flow: subscribe, read, establish baselines, then resume.

---

## Parallels

The subscribe/notify/re-read pattern is not novel. It appears across distributed systems wherever consumers need current state without polling.

| System | Subscribe | Notify | Re-Read | Semantics |
|---|---|---|---|---|
| **Kafka consumer** | `subscribe(topic)` | `poll()` returns records | Consumer reads current offset | Pull-based, but the subscription determines what you receive |
| **Redis Pub/Sub** | `SUBSCRIBE channel` | Message pushed to subscriber | No re-read (fire-and-forget) | Edge-triggered; APEX differs by requiring re-read |
| **GraphQL subscriptions** | `subscription { quote }` | Server pushes update event | Client refetches query for full state | Close parallel — notify then refetch |
| **React `useEffect`** | Dependency array registration | React detects dependency change | Component re-renders from current state | Level-triggered; re-render reads current props/state |
| **PostgreSQL `LISTEN/NOTIFY`** | `LISTEN channel` | `NOTIFY channel` fires | Application queries for current rows | Signal-then-query, exactly APEX's model |
| **Linux `inotify`** | `inotify_add_watch()` | Kernel emits `IN_MODIFY` | Application reads file for current content | Level-triggered file change notification |
| **MCP resource subscriptions** | `resources/subscribe` | `notifications/resources/updated` | `resources/read` | The foundation APEX builds on directly |

The closest parallel is PostgreSQL's `LISTEN/NOTIFY`. The database fires a notification when data changes. The application receives the notification and queries for current state. The notification does not carry the data. The query returns the current level. If the application misses a notification, the next query still returns current state. APEX resource subscriptions work identically — different domain, same mechanics.

The Redis Pub/Sub comparison is instructive for what APEX is *not*. Redis Pub/Sub is fire-and-forget: if you miss a message, it is gone. APEX notifications are also fire-and-forget in isolation — a missed notification is not retried. But because the agent always re-reads the resource (not the notification), missing a notification just means a slightly delayed read. The data is never lost because the data lives in the resource, not the notification.

---

## Storage

Subscriptions are metadata, not data. The server needs to track which sessions are subscribed to which resource URIs so it can fan out notifications when state changes. This is a small amount of state — a map from resource URI to session set, or from session to resource URI set.

The protocol does not mandate how this mapping is stored. In-memory sets are sufficient for single-instance deployments. For horizontally scaled deployments, the mapping might live in Redis, a shared database, or a distributed pub/sub system. The behavioral contract is simple: if a session is subscribed to a resource, it receives notifications when that resource changes. How the server tracks and fans out that contract is an implementation choice.
