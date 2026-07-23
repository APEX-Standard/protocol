# APEX Protocol — Multi-Broker and Multi-Session Design

**Version:** `0.3.0-alpha`

---

## Overview

APEX's core value proposition is "one protocol, any broker." An agent that can trade on Broker A can trade on Broker B with zero code changes. The tool names are the same. The instrument IDs are the same. The quantity units are the same. The resource URIs are the same. The error codes are the same. The only things that differ are the broker endpoint URL and the authentication token.

Multi-broker operation is where this pays off. An agent that connects to three brokers simultaneously can compare quotes across venues, route orders to the best execution, aggregate risk across accounts, and fail over when one broker goes down — all using the same code path it uses for a single broker. There is no multi-broker SDK, no special adapter layer, no broker abstraction interface. There are just multiple MCP sessions, each speaking the same APEX protocol, each returning the same structured schemas.

This document walks through the architecture: how independent sessions work, how canonical identifiers unify cross-broker data, how capabilities diverge and how the agent adapts, and how failure at one broker is isolated from the others.

---

## The Single-Broker Baseline

Before complicating anything, here is the simple model. One agent, one broker, one session.

The agent connects to the broker's MCP endpoint, performs the `initialize` handshake, reads `apex_version` from `serverInfo`, calls `apex.session.authenticate` with a broker-issued token, and calls `apex.session.capabilities` to learn what the broker supports. It subscribes to quotes, candles, positions, orders, and risk resources over SSE. It maintains a local state cache. It places orders, receives fill notifications, acknowledges events to advance the replay cursor. When it disconnects, it reconnects with `Last-Event-ID` and gets replay with gap fill.

Everything is scoped to a single session:

| Concern | Scope |
|---|---|
| `Mcp-Session-Id` | One session ID, one broker |
| Authentication | One token, one account |
| Capabilities | One set of profiles, rate limits, order types |
| Subscriptions | One set of resource URIs |
| Event log | One monotonic sequence of SSE event IDs |
| Replay cursor | One `Last-Event-ID` on reconnect |
| Sequence counters | One set of per-resource sequence numbers |
| State cache | One cache of quote, candle, position, order, risk state |
| Acknowledgment | One cursor advanced by `apex.session.acknowledge` |

This is the model described in `session-design.md` and `replay-design.md`. It is complete and self-contained. Nothing in it references any other broker or any other session.

---

## Independent Sessions

Multi-broker operation is not a new protocol feature. It is multiple instances of the single-broker model running in parallel. Each broker connection is a separate MCP session with its own:

- **`Mcp-Session-Id`** — assigned by the broker during `initialize`. Session IDs from different brokers are unrelated. They live in different namespaces, on different servers, behind different endpoints.
- **Authentication** — each broker has its own token, its own credential format, its own expiry. Authenticating with Broker A has no effect on Broker B.
- **Capabilities** — each broker returns its own capabilities manifest: supported profiles, order types, rate limits, realtime contract parameters.
- **Subscriptions** — each broker tracks its own set of subscribed resource URIs. Subscribing to `apex://market/quote/APEX:FX:EURUSD` at Broker A does not subscribe at Broker B.
- **Event log** — each broker maintains its own per-session event log with its own monotonic sequence. Event ID 472 at Broker A and event ID 472 at Broker B are unrelated events.
- **Replay cursor** — reconnecting to Broker A with `Last-Event-ID: 472` replays from Broker A's event log. Broker B is unaffected.
- **Sequence counters** — each broker's resources have their own sequence numbers. A sequence gap at Broker A says nothing about Broker B.

Sessions are completely independent. A reconnect on Broker A does not affect Broker B. A heartbeat timeout on Broker B does not invalidate the session on Broker A. An authentication expiry on Broker C does not force re-authentication on Brokers A or B.

This independence is not accidental. It is the same model as FIX multi-session connectivity, where each venue gets its own FIX session with its own sequence numbers, its own logon, its own heartbeat interval. The sessions share nothing except the client process that manages them.

```typescript
// Three independent MCP sessions — three brokers, three endpoints, three tokens
const brokerA = new Client({ name: "my-agent", version: "1.0.0" });
await brokerA.connect(new StreamableHTTPClientTransport(new URL("https://mcp.broker-a.com/v1")));
await brokerA.callTool({ name: "apex.session.authenticate", arguments: { token: tokenA, token_type: "jwt" } });

const brokerB = new Client({ name: "my-agent", version: "1.0.0" });
await brokerB.connect(new StreamableHTTPClientTransport(new URL("https://mcp.broker-b.com/v1")));
await brokerB.callTool({ name: "apex.session.authenticate", arguments: { token: tokenB, token_type: "jwt" } });

const brokerC = new Client({ name: "my-agent", version: "1.0.0" });
await brokerC.connect(new StreamableHTTPClientTransport(new URL("https://mcp.broker-c.com/v1")));
await brokerC.callTool({ name: "apex.session.authenticate", arguments: { token: tokenC, token_type: "jwt" } });
```

Three sessions. Three event logs. Three replay cursors. Three sets of subscriptions. Three capability manifests. One agent.

---

## Canonical IDs as the Unifying Layer

Independent sessions are only useful if the agent can compare data across them. This is where canonical instrument IDs and canonical quantity units pay off.

`APEX:FX:EURUSD` is the same instrument at every broker. The agent does not need a translation table mapping Broker A's `EUR/USD` to Broker B's `EURUSD` to Broker C's `eurusd`. The canonical ID resolves unambiguously at every APEX-compatible broker. The broker handles the mapping internally — from the APEX canonical ID to whatever native symbol its platform uses.

**Concrete scenario:** the agent wants to compare EURUSD spreads across three brokers. It reads the same resource URI from each session:

```typescript
const quoteA = await brokerA.readResource({ uri: "apex://market/quote/APEX:FX:EURUSD" });
const quoteB = await brokerB.readResource({ uri: "apex://market/quote/APEX:FX:EURUSD" });
const quoteC = await brokerC.readResource({ uri: "apex://market/quote/APEX:FX:EURUSD" });
```

Same URI. Same schema. Same field names. Different broker data. The agent can compare `quoteA.bid` to `quoteB.bid` to `quoteC.bid` directly because the schemas are identical. There is no adapter, no normalizer, no per-broker response parser.

Canonical quantities work the same way. When the agent places an order for 100,000 base units of EURUSD, it sends the same payload to every broker:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "order_type": "market",
  "quantity": "100000",
  "quantity_unit": "base_units"
}
```

`quantity: 100000, quantity_unit: "base_units"` means 100,000 EUR of notional at every broker. Whether the broker internally calls this "1 standard lot" or "100000 units" or "10 mini-lots" is irrelevant to the agent. The canonical quantity is 100,000 units of the thing being bought or sold. The agent never thinks in lots. See `quantity-design.md` for the full design.

This is the same principle that DNS applies to hostnames, that ISIN applies to securities, and that LEI applies to counterparty identification: assign a canonical identifier once in a central registry, and let every participant map to and from that identifier independently. The APEX Instrument Registry (`spec/registry/README.md`) is that central registry. The canonical quantity system is the unit equivalent.

---

## Divergent Capabilities

Canonical IDs unify the data model. But brokers are not identical. They support different profiles, different order types, different rate limits, and different realtime contracts. The agent must read `apex.session.capabilities` from each broker and respect the differences.

**Concrete scenario:** the agent connects to three brokers and discovers:

| Capability | Broker A | Broker B | Broker C |
|---|---|---|---|
| Profiles | `fx`, `crypto` | `fx` | `fx`, `cfd`, `crypto` |
| Order types | `market`, `limit`, `stop` | `market`, `limit` | `market`, `limit`, `stop`, `stop_limit` |
| Orders/second | 10 | 5 | 20 |
| Market data/second | 100 | 50 | 200 |
| Max retention events | 10000 | 5000 | 50000 |
| Quote freshness (ms) | 1000 | 2000 | 500 |

The agent cannot send a `stop_limit` order to Broker A — it supports `stop` but not `stop_limit`. It cannot trade crypto on Broker B — no crypto profile. It cannot burst 10 orders per second to Broker B without being rate-limited — the cap is 5.

The normative rule: **the agent must read capabilities from each session independently and constrain its behavior per-session.** A capability available at Broker A does not imply availability at Broker B.

```typescript
const capsA = extractPayload(await brokerA.callTool({ name: "apex.session.capabilities", arguments: {} }));
const capsB = extractPayload(await brokerB.callTool({ name: "apex.session.capabilities", arguments: {} }));
const capsC = extractPayload(await brokerC.callTool({ name: "apex.session.capabilities", arguments: {} }));

// Route crypto orders only to brokers that support the crypto profile
function canTradeCrypto(caps) {
  return caps.profiles && "crypto" in caps.profiles;
}

// Respect per-broker rate limits
function maxOrderRate(caps) {
  return caps.rate_limits?.orders_per_second ?? 1;
}
```

### Capability Divergence Table

| Divergence | Agent Behavior |
|---|---|
| Broker lacks a profile | Do not send instruments from that profile to that broker |
| Broker lacks an order type | Use a supported alternative or skip that broker for that order |
| Broker has lower rate limits | Throttle order entry per-session to stay within limits |
| Broker has shorter retention | Acknowledge events more frequently on that session |
| Broker has different freshness | Apply per-session staleness thresholds when checking quote validity |
| Broker lacks vendor extensions | Do not call vendor-specific tools on that session |

---

## Cross-Broker Quote Comparison

The simplest multi-broker use case: subscribe to the same quote resource at multiple brokers, compare spreads, pick the best execution venue.

**Scenario:** the agent subscribes to EURUSD quotes at three brokers and receives the following at 14:32:07 UTC:

| Broker | Bid | Ask | Spread (pips) |
|---|---|---|---|
| Broker A | 1.08470 | 1.08490 | 2.0 |
| Broker B | 1.08465 | 1.08495 | 3.0 |
| Broker C | 1.08472 | 1.08485 | 1.3 |

The agent wants to buy. The best ask is at Broker C (1.08485). The agent routes the buy order to Broker C.

```typescript
// Subscribe to the same quote at all three brokers
for (const broker of [brokerA, brokerB, brokerC]) {
  await broker.subscribeResource({ uri: "apex://market/quote/APEX:FX:EURUSD" });
}

// On each quote update, refresh the state cache for that broker
// The notification handler is per-session — each broker's updates go to its own cache
function onQuoteUpdate(brokerId, quote) {
  quoteCache.set(brokerId, quote);
}

// When it's time to execute, compare across brokers
function bestAskBroker() {
  let best = null;
  for (const [brokerId, quote] of quoteCache.entries()) {
    if (!best || quote.ask < best.quote.ask) {
      best = { brokerId, quote };
    }
  }
  return best;
}
```

This works because the quote schema is identical across all brokers. `bid` and `ask` are decimal numbers in the quote currency. `spread` is in the instrument's pip units. The agent does not need per-broker normalization.

The same pattern applies to any resource: candles, features, order book snapshots. Same URI, same schema, different broker data. Compare directly.

---

## Cross-Broker Risk Aggregation

This is the hard problem. Positions at Broker A and Broker B are in separate accounts. Total exposure equals the sum across brokers. But each broker only sees its own positions. Broker A does not know what the agent holds at Broker B. Broker B does not know what the agent holds at Broker A.

The agent must aggregate locally: read positions from each broker, sum by instrument, compute net exposure. If total exposure exceeds the agent's risk limits, halt order entry at ALL brokers.

**Concrete scenario:** the agent trades EURUSD at two brokers.

| Broker | Position | Side | Quantity (base units) |
|---|---|---|---|
| Broker A | EURUSD | Long | 200,000 |
| Broker B | EURUSD | Long | 150,000 |

Each broker reports the agent's exposure individually. Broker A says the agent has 200,000 EUR long. Broker B says the agent has 150,000 EUR long. Neither knows about the other.

The agent aggregates locally:

```typescript
const positionsA = await brokerA.readResource({ uri: `apex://account/positions/${accountIdA}` });
const positionsB = await brokerB.readResource({ uri: `apex://account/positions/${accountIdB}` });

// Aggregate by canonical instrument ID
const exposure = new Map();
for (const pos of [...positionsA.positions, ...positionsB.positions]) {
  const current = exposure.get(pos.instrument_id) ?? { long: 0, short: 0 };
  if (pos.side === "buy") current.long += pos.quantity;
  else current.short += pos.quantity;
  exposure.set(pos.instrument_id, current);
}

// Total EURUSD exposure: 350,000 EUR long
const eurusd = exposure.get("APEX:FX:EURUSD");
const netExposure = eurusd.long - eurusd.short; // 350,000

// Agent's risk limit: 500,000 EUR total per instrument
const maxExposure = 500000;
const remainingCapacity = maxExposure - Math.abs(netExposure); // 150,000

if (remainingCapacity <= 0) {
  // Halt order entry at ALL brokers — not just one
  pauseTrading("APEX:FX:EURUSD", "cross-broker exposure limit reached");
}
```

This aggregation works because canonical instrument IDs and canonical quantity units are consistent across brokers. `APEX:FX:EURUSD` at Broker A is the same instrument as `APEX:FX:EURUSD` at Broker B. `quantity: 200000, quantity_unit: "base_units"` at Broker A means the same thing as `quantity: 150000, quantity_unit: "base_units"` at Broker B. The agent sums directly without unit conversion.

### Why the Agent Must Own Aggregation

No individual broker can enforce cross-broker risk limits. Broker A cannot query Broker B's positions. There is no shared state, no central clearing counterparty, no cross-margin agreement. The agent is the only entity that sees the full picture.

This means cross-broker risk enforcement is an agent responsibility. The agent must:

1. Read positions from every broker after each fill notification
2. Aggregate by canonical instrument ID
3. Compare against its own risk limits (not the broker's — the broker only knows its own account)
4. If limits are breached, halt new order entry at ALL brokers, not just the one where the limit was hit
5. Optionally reduce exposure by closing positions at the broker with the worst execution

See `autonomous-safety-design.md` for the broader safety model. Cross-broker risk aggregation is the multi-session extension of the same principles.

---

## Version Incompatibilities

What happens when Broker A is on `apex_version: "0.1.0-alpha"` and Broker B is on a future version?

The agent checks `apex_version` in each session's `initialize` response. During alpha (`0.x.y`), minor version changes may include breaking changes. The agent should treat any minor version mismatch as potentially incompatible.

**Concrete walkthrough:**

1. Agent connects to Broker A. `initialize` response: `apex_version: "0.1.0-alpha"`. Agent supports this version. Proceed.
2. Agent connects to Broker B. `initialize` response: `apex_version: "0.2.0-alpha"`. Agent only supports `0.1.0-alpha`. This is a minor version bump during alpha — potentially breaking.
3. Agent connects to Broker C. `initialize` response: no `apex_version` field. Server is not an APEX broker.

The agent's options for incompatible versions:

| Scenario | Agent Behavior |
|---|---|
| Same version | Full operation — all APEX tools and resources available |
| Compatible minor bump (post-1.0) | Full operation — semver guarantees backward compatibility |
| Incompatible version (alpha) | Disconnect gracefully from that broker; continue operating on compatible brokers |
| Missing `apex_version` | Do not call any APEX tools on that session; disconnect |
| Mixed fleet | Operate normally on compatible brokers, degrade gracefully on incompatible ones |

The key insight: version incompatibility at one broker does not affect the agent's operation at other brokers. If Broker B is on an incompatible version, the agent disconnects from Broker B and continues trading on Brokers A and C. It does not shut down entirely because one out of three brokers is incompatible.

This is similar to TLS version negotiation across multiple servers. A client that can't agree on a TLS version with one server simply doesn't connect to that server. It doesn't disable TLS for all connections.

See `version-stability-design.md` for the full versioning model.

---

## Failure Isolation

A reconnect or failure at one broker must not affect the agent's operation at other brokers. This is the fundamental isolation property of independent sessions.

**Scenario:** the agent is connected to three brokers, trading EURUSD on all of them. At 14:32:00, Broker A's SSE stream drops.

| Time | Broker A | Broker B | Broker C |
|---|---|---|---|
| 14:32:00 | SSE stream drops | Operating normally | Operating normally |
| 14:32:01 | Agent pauses trading on A | Continues trading | Continues trading |
| 14:32:02 | Agent reconnects with `Last-Event-ID` | Unaffected | Unaffected |
| 14:32:03 | Replay with gap fill | Unaffected | Unaffected |
| 14:32:04 | Re-read all resources | Unaffected | Unaffected |
| 14:32:05 | Resume trading on A | Was never interrupted | Was never interrupted |

During the 5 seconds that Broker A is down, the agent continues trading on Brokers B and C. It does not freeze its entire operation because one session had a network blip. It does not cancel orders at Broker B because Broker A is reconnecting. It does not halt the decision loop because one of three quote feeds is temporarily unavailable.

### What the Agent Does During Broker Failure

Each session has its own state cache, freshness tracking, and sequence counters. When one session fails:

1. **Mark that session degraded.** The agent tracks per-session health independently.
2. **Pause trading on the degraded session.** No new orders to that broker. Existing orders remain in the broker's matching engine.
3. **Continue trading on healthy sessions.** Other brokers are unaffected.
4. **Update cross-broker aggregation.** The positions at the degraded broker are still there — they just aren't updating. The agent uses the last known state from that broker, flagged as potentially stale.
5. **Reconnect the degraded session.** Follow the standard reconnect/replay flow from `replay-design.md`.
6. **Reconcile on reconnect.** After replay, re-read all resources on the recovered session, update the cross-broker aggregation with fresh data, and resume trading on that session.

### Failure Isolation Table

| Failure at Broker A | Effect on Broker B | Effect on Broker C |
|---|---|---|
| SSE stream drops | None | None |
| Authentication expires | None | None |
| Heartbeat timeout | None | None |
| Rate limit exceeded | None | None |
| Kill switch engaged | None (but agent should reassess cross-broker risk) | None (same) |
| Replay fails (events evicted) | None | None |
| Broker endpoint unreachable | None | None |

The one exception: if the failure at Broker A reveals a cross-broker risk issue (e.g., a kill switch engaged because positions exceeded the broker's limits), the agent should reassess its total exposure across all brokers. The failure itself is isolated. The risk implications may not be.

---

## Multi-Broker Architecture Pattern

The recommended runtime architecture for a multi-broker agent has four layers:

### Layer 1: Per-Broker Session Managers

One session manager per broker connection. Each manages its own MCP client, authentication lifecycle, SSE stream, state cache, freshness tracking, sequence validation, acknowledgment cursor, and reconnect/replay logic. Session managers are independent — they don't reference each other.

### Layer 2: Cross-Broker Aggregation

A single aggregation layer that reads position, risk, and account state from all session managers. It computes:

- Net exposure per instrument across all brokers
- Total margin utilization across all accounts
- Cross-broker P&L
- Aggregated risk metrics

This layer owns the agent's global risk limits — not the per-broker limits (which the brokers enforce), but the agent's own limits on total exposure, total drawdown, and total position count across all venues.

### Layer 3: Routing Decision Engine

When the agent decides to trade, the routing layer picks the best execution venue based on:

- Current quotes from all brokers (best bid/ask)
- Available capacity at each broker (rate limits, margin headroom)
- Session health (is the broker connected? is the quote fresh?)
- Capability match (does the broker support the required order type and instrument?)

This is the APEX equivalent of a smart order router (SOR) in institutional trading. The difference is that the agent builds it from standard APEX data, not from proprietary venue APIs.

### Layer 4: Decision Model

The trading strategy or LLM that sees a unified view of the market. It receives:

- Best available quotes across all brokers
- Aggregated position and risk state
- Per-broker capability constraints
- Per-broker health status

It makes trading decisions without needing to know which broker will execute them. The routing layer handles venue selection after the decision is made.

### Conceptual Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Decision Model                      │
│         (strategy / LLM / policy engine)             │
└──────────────────────┬──────────────────────────────┘
                       │ unified market + risk view
┌──────────────────────┴──────────────────────────────┐
│              Routing Decision Engine                  │
│     (best execution, capability matching, health)    │
└──────────────────────┬──────────────────────────────┘
                       │ order routing
┌──────────────────────┴──────────────────────────────┐
│           Cross-Broker Aggregation Layer              │
│   (net exposure, total margin, aggregated risk)       │
└───┬──────────────────┼──────────────────────┬───────┘
    │                  │                      │
┌───┴───┐         ┌────┴───┐            ┌────┴───┐
│Broker A│         │Broker B│            │Broker C│
│Session │         │Session │            │Session │
│Manager │         │Manager │            │Manager │
└───┬───┘         └────┬───┘            └────┬───┘
    │ MCP/SSE          │ MCP/SSE             │ MCP/SSE
┌───┴───┐         ┌────┴───┐            ┌────┴───┐
│Broker A│         │Broker B│            │Broker C│
│ Server │         │ Server │            │ Server │
└───────┘         └────────┘            └────────┘
```

Each session manager is a self-contained APEX client. The aggregation layer is agent-side logic that reads from all session managers. The routing layer is agent-side logic that writes to the best session manager. The protocol itself is unchanged — each session still speaks standard APEX to its broker.

---

## Parallels

The multi-broker model is not novel. It follows established patterns from every domain where a single client connects to multiple independent services.

| Established Pattern | APEX Multi-Broker Equivalent |
|---|---|
| **FIX multi-session connectivity** — one FIX session per venue, separate sequence numbers, separate logon/heartbeat | One MCP session per broker, separate event IDs, separate authentication/heartbeat |
| **Smart order routing (SOR)** — compare liquidity across venues, route to best execution | Compare quotes across brokers, route order to best ask/bid |
| **Multi-exchange crypto trading** — Binance + Coinbase + Kraken, same trading pairs, different prices | Same APEX instrument IDs, same tool calls, different broker data |
| **Multi-cloud deployment** — independent services on AWS + GCP + Azure, unified management plane | Independent broker sessions, unified aggregation layer |
| **CDN origin selection** — pick the best source for each request based on latency/availability | Pick the best broker for each order based on spread/availability |
| **Database read replicas** — multiple sources of the same data, aggregated view for the reader | Multiple brokers quoting the same instrument, aggregated view for the agent |

The FIX parallel is the closest. Institutional trading firms have operated multi-venue FIX connectivity for decades. Each venue gets its own FIX session. Each session has its own sequence numbers, its own logon, its own heartbeat interval, its own message store. The firm's smart order router sits above all sessions and picks the best venue for each order. APEX applies the same architecture with MCP sessions instead of FIX sessions, canonical APEX instrument IDs instead of per-venue symbology, and structured JSON-RPC instead of FIX tag-value pairs.

The multi-exchange crypto parallel is also instructive. A crypto market maker running on Binance, Coinbase, and Kraken uses the same trading pairs (BTC/USDT, ETH/USDT) across all exchanges. The pair names might differ slightly — `BTCUSDT` on Binance, `BTC-USDT` on Coinbase, `XXBTZUSDT` on Kraken — but the instruments are the same. The maker's software normalizes the symbols and compares prices directly. APEX eliminates the normalization step entirely: `APEX:CRYPTO:SPOT:BTCUSDT` is the same at every broker, with no translation needed.

---

## Cross-References

- **`instrument-identity-design.md`** — canonical instrument IDs that make cross-broker comparison possible
- **`quantity-design.md`** — canonical quantity units that make cross-broker position aggregation possible
- **`session-design.md`** — the session lifecycle that each broker connection follows independently
- **`replay-design.md`** — the reconnect/replay model that each session uses independently
- **`autonomous-safety-design.md`** — safety principles that extend to cross-broker risk enforcement
- **`version-stability-design.md`** — version negotiation that each session performs independently
