# APEX Protocol — Replay Design

**Version:** `0.1.0-alpha`

---

## Overview

APEX uses an acknowledgment-driven replay model inspired by FIX protocol's message store, sequence reset, and gap fill mechanisms. The agent controls event retention. The server classifies events during replay and only delivers execution-critical history, collapsing ephemeral market data into gap fill markers.

---

## Normal Operation

The agent is connected to a broker over HTTP/SSE. Two things are happening:

**Inbound (SSE stream):** The broker pushes notifications as they happen — quote updates, candle closes, order fills, position changes. Every SSE event gets a monotonic integer ID (1, 2, 3, ...). The broker writes every event to a per-session **event log**. The storage mechanism is an implementation choice: in-memory buffer, file-based sequential log (as in FIX), durable queue, or any storage that preserves event ordering.

**Outbound (acknowledgment):** The agent periodically calls `apex.session.acknowledge({ last_event_id: "472" })` to tell the broker "I've fully processed everything through event 472." The broker discards events 1-472 from the log. This is like committing a Kafka consumer offset, or like FIX sequence reset — the agent controls what the broker needs to keep.

If the agent never acknowledges, the broker retains everything up to its max retention cap (documented in capabilities via `max_retention_events` and `max_retention_seconds`). Reference implementations default to 10000 events in-memory.

---

## When the Connection Drops

The agent loses its SSE stream — network blip, timeout, load balancer rotation. During the gap, the broker keeps generating events: quotes update, maybe an order fills, maybe a candle closes. All events go into the event log.

The agent reconnects: `GET /mcp` with `Mcp-Session-Id` and `Last-Event-ID: 472`.

---

## Replay with Gap Fill

The broker walks the event log starting after event 472. Say the log contains events 473 through 519. During that gap, here's what happened:

```
473: notifications/resources/updated (quote)
474: notifications/resources/updated (quote)
475: notifications/resources/updated (quote)
476: notifications/resources/updated (candles M1)
477: notifications/apex.market.candle_closed (M1 bar)
478: notifications/resources/updated (quote)
479: notifications/resources/updated (features)
480: notifications/apex.order.filled            ← execution event
481: notifications/resources/updated (positions)
482: notifications/resources/updated (orders)
483: notifications/resources/updated (fills)
484: notifications/resources/updated (risk)
485: notifications/resources/updated (quote)
486: notifications/resources/updated (quote)
...
519: notifications/resources/updated (quote)
```

**Without gap fill:** Replay all 47 events. The agent processes 43 stale quote/resource updates that are immediately superseded by the current state it's about to re-read anyway. Wasteful.

**With gap fill:** The broker classifies each event:

- Events 473-479: all `elide` (resource updates, candle close) — collapse into one gap fill marker
- Event 480: `required` (order filled) — **replay this**
- Events 481-484: all `elide` (resource updates from the fill) — collapse into one gap fill marker
- Events 485-519: all `elide` (more quote updates) — collapse into one gap fill marker

What the agent actually receives on reconnect:

```
gap_fill:          { elided_count: 7,  from_id: "473", to_id: "479" }
apex.order.filled: { order_id: "...", fill_price: 1.0847, ... }        ← original ID 480
gap_fill:          { elided_count: 4,  from_id: "481", to_id: "484" }
gap_fill:          { elided_count: 35, from_id: "485", to_id: "519" }
```

**4 events instead of 47.** The agent gets the one thing it actually needs — the fill that happened while it was away — and knows that everything else was ephemeral market/account state it's about to re-read from the current resources.

---

## Replay Classification

Each notification type is classified based on one question: **can the agent reconstruct this information from current resource state?**

| Event | Reconstructable? | Classification |
|---|---|---|
| Quote updated 50 times | Yes — current quote supersedes all | `elide` |
| Candle closed | Yes — completed candle is in the candle resource | `elide` |
| Features updated | Yes — current features supersede | `elide` |
| Positions/orders/risk updated | Yes — current state supersedes | `elide` |
| **Order filled at 1.0847** | **No** — fill price, quantity, fill_id are historical facts | `required` |
| **Order partially filled** | **No** — the sequence of partial fills matters | `required` |
| **Order rejected** | **No** — the agent needs to know it was rejected and why | `required` |
| **Kill switch engaged** | **No** — the agent needs to know this happened | `required` |

The `required` events are execution facts. They happened, they're done, and the agent needs them to understand what occurred during the gap. You cannot get "your order filled at 1.0847 at 14:32:07" from reading the current positions resource — you just see "you have a position."

The `elide` events are state snapshots. They were true at one moment but are superseded by the current state. Replaying them is like reading yesterday's newspaper before reading today's.

### Normative Classification Table

| Classification | Notification Types | Replay Behavior |
|---|---|---|
| `required` | `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`, `apex.risk.kill_switch_engaged` | Replayed with original event IDs |
| `elide` | `notifications/resources/updated`, `apex.market.candle_closed` | Collapsed into `gap_fill` markers |
| Always sent | `apex.session.replay_failed`, `apex.session.gap_fill` | Meta-notifications about the replay mechanism itself |

### Gap Fill Notification

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.gap_fill",
  "params": {
    "elided_count": 47,
    "from_id": "473",
    "to_id": "519"
  }
}
```

Gap fill markers use the `to_id` of the elided range as their SSE event ID, preserving monotonic ordering. The marker's SSE event ID equals its `to_id` field. After all logged events are replayed or elided, the server transitions to live streaming where all events are delivered without classification.

---

## After Replay

The agent:

1. Processes the replayed execution events (updates its fill history, reconciles orders)
2. Re-reads ALL resources (quote, candles, features, positions, orders, fills, risk) to get current state
3. Calls `apex.session.acknowledge` with the last event ID to advance the cursor
4. Re-establishes its execution baseline (freshness checks, sequence continuity)
5. Resumes trading

---

## When Replay Fails

If the agent was disconnected so long that the broker's max retention was exceeded and unacknowledged events were evicted, the broker can't replay from the requested cursor. It sends `notifications/apex.session.replay_failed` as the first event:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.replay_failed",
  "params": {
    "reason": "event_id_outside_log",
    "last_available_id": "1042"
  }
}
```

The agent treats this as a full discontinuity — discard everything, re-read all resources from scratch, rebuild state completely. It loses the execution history from the gap (what filled, what was rejected), which means it needs to reconcile by comparing its pre-disconnect state against current state.

With acknowledgment-driven retention, this is much harder to trigger than a fixed ring buffer. The agent controls when events get discarded. If it acknowledges every 30 seconds, the broker only needs to retain ~30 seconds of events plus whatever accumulated since the last acknowledgment.

---

## The FIX Parallel

| FIX Concept | APEX Equivalent |
|---|---|
| Message store (flat file) | Event log (implementation choice) |
| Sequence numbers | Monotonic SSE event IDs |
| ResendRequest | `Last-Event-ID` header on GET reconnect |
| SequenceReset-GapFill | `notifications/apex.session.gap_fill` |
| Gap fill skips admin/heartbeat messages | Gap fill elides resource updates and candle closes |
| Replays execution reports | Replays fills, rejections, kill switch |
| Sequence reset on Logon | `apex.session.acknowledge` advances cursor |
| Message store persists to disk | Storage is implementation choice |

The key insight from FIX: not all messages are equal during replay. Admin messages and market data are ephemeral. Execution reports are permanent records. APEX applies the same principle — ephemeral notifications get elided, execution events get replayed.

---

## Storage

The event log storage mechanism is an implementation choice:

- **In-memory buffer** — Simplest. Bounded by max retention count. Lost on restart.
- **File-based sequential log** — FIX-style. Survives restarts. Cheap storage. Enables longer retention windows.
- **Durable queue** — Redis, Kafka, or similar. For scaled deployments with shared state across instances.

The protocol does not mandate a storage mechanism. It mandates the behavioral contract: events are retained until acknowledged or max retention is exceeded, replay classifies events and applies gap fill, and the agent re-reads all resources on reconnect.

---

## Related Design Documents

- [Transport Design](transport-design.md) — the HTTP/SSE transport layer on which replay operates, including the `Last-Event-ID` reconnect mechanism and SSE event stream architecture
- [Session Design](session-design.md) — the session lifecycle that scopes event logs, subscriptions, and replay cursors
- [Freshness Design](freshness-design.md) — the staleness model that determines when the agent must re-read resources after replay completes
