# APEX Protocol — Freshness Design

**Version:** `0.2.0-alpha`

---

## Overview

Stale data is the most direct path from "autonomous agent" to "real money lost." A quote that was accurate 800 milliseconds ago may already be wrong. A risk snapshot from three seconds ago may not reflect the fill that just landed. An account summary from ten seconds ago may be missing a margin call. When a human trader glances at a screen and sees prices flickering, they have an intuitive sense of liveness — things are moving, the feed is alive. An autonomous agent has no such intuition. It will act on whatever data it has, stale or not, unless the runtime tells it to stop.

APEX defines a deterministic freshness model so that runtimes can answer one question in code, before the model is even consulted: **is the data fresh enough to trade on?**

The model never sees stale data. The runtime gates it.

---

## The Three Freshness Classes

APEX classifies execution-critical resources into three freshness classes based on how fast they change and how dangerous staleness is.

### Market Fast

Resources that reflect current execution conditions. They change rapidly and go stale quickly.

Examples:
- quote (bid/ask/mid/spread)
- order book
- trade flow
- short-horizon derived features

Requirements:
- must include `timestamp` or `as_of`
- must include `stale_after_ms`
- should update frequently enough to reflect current execution conditions

A quote on EUR/USD might update every 100-500 ms in retail FX. A crypto exchange websocket feed might update even faster. If the quote stops updating for one second, something is wrong — the feed is down, the network dropped, or the broker's pipeline stalled. The agent should not be placing orders against a one-second-old quote in a market that moves in milliseconds.

### Market Slow

Resources that change on known intervals, not tick by tick.

Examples:
- completed candles (M1, M5, H1)
- slower derived features (regime classification, multi-bar indicators)
- instrument metadata caches

Requirements:
- must include `as_of`
- must include `stale_after_ms` if relied upon for autonomous decisions

A completed M1 candle has a natural lifetime of 60 seconds. It was true when the bar closed and remains true until the next bar closes. Staleness here means "an entire candle period passed and no new bar arrived" — that is a data pipeline problem, not normal market behavior. A `stale_after_ms` of 60000-120000 ms is typical.

### Account / Risk

Resources that reflect the agent's financial state. They change on fills, sweeps, and periodic snapshots.

Examples:
- account summary (balance, equity, margin)
- positions
- orders
- risk state (kill switch, daily loss, limits)

Requirements:
- must include `as_of`
- must include `stale_after_ms`
- should be treated as execution-critical when autonomous order entry is enabled

Account state typically updates on every fill and on periodic sweeps (every 1-5 seconds). Risk state must be fresh for any autonomous order submission. If the agent's last risk snapshot is five seconds old and a fill landed two seconds ago that pushed margin utilization to 95%, the agent might size a new position that triggers a margin call.

---

## The Staleness Equation

A resource is stale when:

```
current_time > reference_timestamp + stale_after_ms
```

Where `reference_timestamp` is resolved as:

1. Use `as_of` if present.
2. Otherwise use `timestamp`.
3. If neither is present, the resource cannot be freshness-checked and must be treated as stale for autonomous decisions.

### `as_of` vs `timestamp`

These two fields serve different purposes:

| Field | Meaning | Example |
|---|---|---|
| `timestamp` | Publication time — when the broker emitted this payload | `2026-03-27T14:30:00.100Z` |
| `as_of` | Currency assertion — when the broker last knew this data to be current | `2026-03-27T14:30:00.050Z` |

When both fields exist, `as_of` takes precedence. Here is why: a broker might receive a quote from its liquidity provider at 14:30:00.050, process it through a pipeline, and publish it to the agent at 14:30:00.100. The quote reflects the market at 14:30:00.050, not at 14:30:00.100. Using `timestamp` would make the quote appear 50 ms fresher than it actually is. At trading speeds, 50 ms matters.

In most implementations the two fields will be close together or identical. The distinction matters at the margins — literally.

---

## Freshness Walk-Through

Concrete scenario. The agent is subscribed to `apex://market/quote/APEX:FX:EURUSD`. The quote resource carries:

```json
{
  "bid": "1.08750",
  "ask": "1.08760",
  "timestamp": "2026-03-27T14:30:00.100Z",
  "as_of": "2026-03-27T14:30:00.050Z",
  "sequence": 4871,
  "stale_after_ms": 1000
}
```

The reference timestamp is `as_of`: `14:30:00.050`. The staleness deadline is `14:30:01.050`.

**14:30:01.000 — fresh.** The runtime checks: `14:30:01.000 > 14:30:01.050`? No. The quote is 950 ms old. The agent may trade.

**14:30:01.050 — boundary.** The runtime checks: `14:30:01.050 > 14:30:01.050`? No. The comparison is strict greater-than. The quote is still technically fresh at exactly the deadline. The agent may trade, but this is the last instant.

**14:30:01.150 — stale.** The runtime checks: `14:30:01.150 > 14:30:01.050`? Yes. The quote is stale. The runtime halts autonomous order entry. If the model was about to submit a buy order, it never gets the chance — the runtime refuses before the model is consulted.

**14:30:01.200 — new quote arrives.**

```json
{
  "bid": "1.08755",
  "ask": "1.08765",
  "timestamp": "2026-03-27T14:30:01.200Z",
  "as_of": "2026-03-27T14:30:01.150Z",
  "sequence": 4872,
  "stale_after_ms": 1000
}
```

The new reference timestamp is `14:30:01.150`. New deadline: `14:30:02.150`. The quote is fresh again. Autonomous execution resumes.

The halt lasted 100 ms. In that window, the agent was prevented from acting on data that was over a second old. In a fast market, 100 ms of inaction is far cheaper than one order placed on a stale quote.

---

## The Execution-Critical Set

Autonomous order entry requires that a minimum set of resources all be fresh simultaneously. If any single resource in this set is stale, the runtime halts.

| Resource | What Goes Wrong When Stale |
|---|---|
| **Quote** | The agent prices orders against a market that has moved. A limit order goes in at a price the market has already passed. A market order fills at unexpected slippage. |
| **Features** | The agent's derived signals (regime, volatility, liquidity score) are based on old quotes. It might enter a momentum trade in a market that has already reversed. |
| **Account summary** | The agent does not know its current balance, equity, or margin level. It might open a position that triggers a margin call. |
| **Positions** | The agent does not know what it already holds. It might double a position it thinks it closed, or close a position that was already liquidated. |
| **Orders** | The agent does not know which orders are still working. It might place a duplicate, or fail to cancel an order that should no longer exist. |
| **Risk** | The agent does not know if the kill switch is active, if daily loss limits are hit, or if position size limits are exhausted. It might trade into a hard stop. |

Every resource in this set must pass the staleness equation. The runtime checks all of them before allowing any autonomous order submission.

### The Cascade

Staleness often cascades. A quote feed drops, which means features derived from quotes stop updating, which means the feature resource goes stale 1-4 seconds later (its `stale_after_ms` is longer because computation adds latency). The runtime catches the quote staleness first — 500-2000 ms after the last update — and halts immediately. The feature staleness would halt it again a few seconds later if the quote check did not already catch it. Defense in depth.

---

## Recommended `stale_after_ms` Ranges

These ranges are guidance, not mandates. Brokers may deviate based on their data pipeline characteristics.

| Resource | Freshness Class | Typical Range | Rationale |
|---|---|---|---|
| Quote (FX) | Market Fast | 500-2000 ms | Retail FX quotes update every 100-500 ms; a 1-2 second gap means the feed is degraded |
| Quote (Crypto) | Market Fast | 200-1000 ms | Exchange websocket feeds update more frequently; tighter staleness is appropriate |
| Features | Market Fast | 1000-5000 ms | Derived from quotes; computation adds latency; still must be reasonably current |
| Candles (M1) | Market Slow | 60000-120000 ms | Only stale if an entire candle period passes without update |
| Account state | Account/Risk | 2000-10000 ms | Snapshots update on fills and periodic sweeps |
| Risk state | Account/Risk | 2000-5000 ms | Must be fresh for autonomous order submission; tighter than general account state |

A broker that updates quotes every 200 ms and sets `stale_after_ms` to 500 ms is saying "if you haven't heard from me in 500 ms, assume I'm broken." A broker that updates every 500 ms and sets `stale_after_ms` to 2000 ms is saying the same thing with a wider tolerance. The agent runtime does not need to know the update frequency — it only needs the staleness deadline.

---

## Freshness Metadata Propagation

Every execution-relevant realtime resource carries three pieces of freshness metadata:

| Field | Purpose | Scope |
|---|---|---|
| `timestamp` or `as_of` | When the data was current | Per resource payload |
| `sequence` | Monotonic ordering within the resource stream | Per resource URI |
| `stale_after_ms` | How long the data remains usable | Per resource payload |

### Resource Payloads

When the agent reads a resource (via `resources/read`) or receives an update from the local cache, the payload includes all three fields. The resource is self-describing — everything needed to evaluate freshness is in the payload itself.

### Notifications

When the broker pushes `notifications/resources/updated`, the notification carries the resource URI and the current `sequence` for that resource. The agent uses the sequence to detect gaps and the URI to know which cached resource to refresh. The freshness metadata lives in the resource payload that the agent reads, not in the notification envelope.

### Sequence Independence

The `sequence` counter is per resource URI instance. The sequence for `apex://market/quote/APEX:FX:EURUSD` is independent of the sequence for `apex://market/quote/APEX:FX:GBPJPY`. Implementations must not share a single counter across resource URIs. A gap in one resource's sequence does not affect the freshness of another resource — but the runtime must track each resource's sequence independently.

---

## The Halt Decision

The halt decision is deterministic code. It is not a prompt, not a suggestion, not something the model weighs against other factors. The runtime executes a function roughly equivalent to:

```python
def may_trade(state_cache, current_time):
    for resource in EXECUTION_CRITICAL_SET:
        entry = state_cache[resource]
        ref_time = entry.as_of or entry.timestamp
        if ref_time is None:
            return False  # no freshness metadata — cannot verify
        if current_time > ref_time + entry.stale_after_ms:
            return False  # stale
        if entry.sequence_gap:
            return False  # sequence discontinuity
    return True
```

This runs before the model is consulted. If `may_trade` returns `False`, the model never sees a decision prompt. There is no opportunity for the model to reason about whether "the data is probably still close enough" or "the market is slow right now so staleness is fine." The model does not get a vote.

This is intentional. Models are good at pattern recognition and strategy. They are bad at clock arithmetic and safety invariants. The runtime handles the clock arithmetic. The model handles the strategy. The boundary is enforced in code, not in prompts.

### After A Halt

When the halt condition clears (fresh data arrives, sequence continuity is restored), the runtime resumes autonomous execution automatically. No human intervention is needed for transient staleness — a dropped quote that recovers in 200 ms causes a 200 ms pause, not a manual restart. Persistent staleness (feed down for minutes) keeps the agent halted until the feed recovers, which is the correct behavior.

---

## Parallels To Established Systems

The APEX freshness model draws from patterns that are well-established in trading infrastructure and distributed systems.

| Established Pattern | APEX Equivalent | What They Share |
|---|---|---|
| **FIX Heartbeat / TestRequest** | `apex.session.heartbeat` + `stale_after_ms` | FIX uses heartbeats to detect session liveness — if no message arrives within the heartbeat interval, the counterparty sends a TestRequest. If that goes unanswered, the session is considered dead. APEX uses `stale_after_ms` per resource rather than per session — more granular, same principle. |
| **ITCH/OUCH "last update" timestamps** | `timestamp` / `as_of` on every resource | Exchange-native protocols like ITCH attach timestamps to every message so consumers can detect stale data. APEX does the same at the resource level. |
| **Kafka consumer lag** | `sequence` gap detection | A Kafka consumer that falls behind its partition's head offset has "lag" — it is processing stale events. APEX agents track per-resource sequences and detect gaps the same way. A gap means "you missed something" and triggers a re-read. |
| **HTTP `Cache-Control: max-age`** | `stale_after_ms` | An HTTP response with `max-age=1` tells the client "this is valid for 1 second." After that, refetch. `stale_after_ms` is the same contract: "this data is valid for N milliseconds." After that, treat it as stale. |
| **Circuit breakers in microservices** | Execution-critical set halt | A circuit breaker trips when a downstream service fails, preventing cascading failures. The APEX freshness halt is a circuit breaker: when any data dependency goes stale, the trading circuit opens and no orders flow until the dependency recovers. |

The underlying principle is the same across all of these: **do not act on data you cannot prove is current.** FIX enforces it at the session level. Kafka enforces it at the partition level. HTTP enforces it at the cache level. APEX enforces it at the resource level, which is the right granularity for a system where the agent consumes multiple independent data streams that all must be fresh for a single trading decision.

---

## Related Design Documents

- [Sequence Design](sequence-design.md) — the per-resource monotonic sequence counters that complement freshness timestamps for data integrity, including gap detection and the distinction between sequence numbers and SSE event IDs
- [Autonomous Safety Design](autonomous-safety-design.md) — the seven halt conditions that consume freshness metadata, including quote staleness and account/risk staleness as execution-halting triggers
- [Replay Design](replay-design.md) — how freshness baselines are re-established after a reconnect and replay cycle
