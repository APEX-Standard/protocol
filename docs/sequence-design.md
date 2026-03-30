# APEX Protocol — Sequence Numbering And Gap Detection Design

**Version:** `0.1.0-alpha`

---

## Overview

Sequences are the integrity backbone of realtime state in APEX. Every execution-critical resource — quotes, positions, orders, risk — carries a monotonically increasing `sequence` counter. Without it, an agent cannot answer the most basic question in trading: "Am I looking at current state, or did I miss something?"

The answer matters. If a quote jumps from seq=500 to seq=503, two updates were lost (or coalesced). The agent does not know what happened at 501 and 502. Maybe the spread widened. Maybe the price reversed. Maybe the server coalesced ten ticks into one. It does not matter which — the agent's local cache is no longer trustworthy. It must re-read the resource before making any decision.

This is a fundamentally different concern from SSE event IDs. Event IDs are session-scoped replay cursors — they tell the transport "where did I leave off?" Sequences are data-integrity counters — they tell the agent "is my view of this resource still contiguous?" Both are monotonic integers. Both matter. They solve different problems.

---

## Per-Resource Scoping

Each resource URI has its own independent sequence counter. The sequence for `apex://market/quote/APEX:FX:EURUSD` is completely independent of the sequence for `apex://market/quote/APEX:FX:GBPJPY`. When EURUSD shows seq=184467 and GBPJPY shows seq=901, that is normal — EURUSD has simply been updated far more times.

### Why Not a Global Counter

A global counter would mean every resource increment shares a single namespace. Consider what happens:

EURUSD updates 500 times per second during London session. GBPJPY updates 50 times per second. A global counter advances 550 times per second. Now the agent subscribes to GBPJPY. It sees seq=10000, then seq=10473. That is a gap of 472 — but 470 of those were EURUSD updates that have nothing to do with GBPJPY. The agent cannot distinguish "I missed a GBPJPY update" from "other resources advanced the counter."

This is false gap detection. The agent would invalidate its GBPJPY cache, re-read the resource, halt autonomous execution — all because EURUSD was busy. Under high-frequency conditions, global counters produce continuous false alarms for slow-updating resources.

Per-resource scoping eliminates this. A gap in GBPJPY's sequence means GBPJPY data was missed, full stop. The agent's response is scoped to the affected resource.

### Scoping Rule

The normative rule: implementations must not share a single sequence counter across multiple resource URIs. The sequence namespace is the full resource URI, including query parameters. `apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200` and `apex://market/candles/APEX:FX:EURUSD?timeframe=H1&limit=200` are independent sequence streams.

---

## Monotonic Progression

Sequences only go up. Within a single resource stream, if the agent observes seq=100 followed by seq=98, something has gone wrong.

Possible causes:

- **Replay out of order.** A reconnect delivered events in the wrong sequence. The transport violated its ordering guarantee.
- **Stale read bypassed cache.** The agent read from a replica or stale endpoint that returned an older snapshot.
- **Server bug.** The sequence counter was reset or wrapped incorrectly.

None of these are acceptable during live trading. The agent must treat a non-monotonic sequence as an integrity violation — the same way a TCP stack treats a sequence number going backward as a retransmission anomaly.

### What Monotonic Means Precisely

Monotonic means the next observed sequence is strictly greater than the last accepted sequence for that resource. It does not mean the increment is always +1. A jump from seq=100 to seq=105 is monotonic (and may indicate a gap to investigate). A jump from seq=100 to seq=98 is non-monotonic (and is always invalid).

For alpha implementations, the spec does not mandate +1 increments. Some brokers may use timestamps as sequences, or may skip numbers during internal coalescing. What matters is the invariant: the next value is always greater than the previous value.

---

## Gap Detection

A gap exists when the agent expects contiguous progression and the observed sequence skips ahead unexpectedly.

### Concrete Scenario

An agent is subscribed to `apex://market/quote/APEX:FX:EURUSD`. It has been tracking sequences:

```
seq=497: bid=1.08750 ask=1.08755
seq=498: bid=1.08748 ask=1.08753
seq=499: bid=1.08751 ask=1.08756
seq=500: bid=1.08749 ask=1.08754
```

The next notification arrives:

```
seq=503: bid=1.08762 ask=1.08767
```

The agent expected seq=501. It got seq=503. Events 501 and 502 are missing. Maybe the price spiked to 1.0880 at seq=501 and reversed at seq=502. Maybe the spread blew out. The agent does not know, and it cannot reconstruct what happened from the current state alone.

### Agent Response

The agent must:

1. **Invalidate the local cache** for this resource. The cached state at seq=500 is no longer contiguous with seq=503.
2. **Re-read the resource** via `resources/read`. The read returns current state with seq=503 (or possibly later). This is now the agent's baseline.
3. **Halt autonomous execution** until continuity is restored. If the agent was about to place an order based on a feature derived from the cached quote, that feature is suspect. The agent must not act on stale or gapped inputs.
4. **Log the gap.** For audit purposes, record that a gap was detected: resource URI, expected sequence, observed sequence, timestamp.

Only after the re-read succeeds and the agent re-establishes its baseline should it resume normal operation. This is not optional caution — it is a normative client obligation defined in the spec.

---

## Coalescing vs Gaps

Not every gap means data was lost. Servers may deliberately coalesce high-frequency updates.

### How Coalescing Works

A quote resource is updating ten times per second. The server's notification pipeline batches these: instead of sending ten notifications in one second, it sends one notification with the latest state. The sequence counter still reflects the server-side update count:

```
Server internally: seq=501, seq=502, seq=503
Server sends to agent: seq=503 (coalesced)
```

The agent sees seq=500 then seq=503. From the agent's perspective, this looks identical to a gap. And that is the point — the agent handles it the same way.

### Why This Is Fine

Agents do not need every intermediate tick. A trading agent needs current state, not a reconstruction of every price movement between decisions. The quote resource at seq=503 reflects the current bid, ask, spread, and timestamp. The intermediate states at 501 and 502 are gone — they were ephemeral and superseded.

What the agent does need is to know it missed something. If it was tracking a running average of bid prices over the last N ticks, that average is now wrong because it is missing two data points. The gap detection tells the agent: "your derived state may be stale, re-derive it from the current resource."

### The Contract

The server does not distinguish between "coalesced" and "lost" gaps in the notification stream. Both result in the same observable behavior: a sequence skip. The agent's response is the same either way: invalidate, re-read, re-derive.

This is a deliberate design choice. If servers had to label gaps as coalesced vs lost, every server would need to track per-client delivery state and classify every notification failure. That is complex and fragile. Instead, the protocol pushes the recovery logic to the client, which always has the same simple response: re-read the resource.

---

## Notification Correlation

Every notification that refers to a resource carries the current `sequence` for that resource. This creates a correlation chain:

```
1. Agent receives notification:
   method: "notifications/resources/updated"
   params: { uri: "apex://market/quote/APEX:FX:EURUSD", sequence: 503 }

2. Agent reads the resource:
   resources/read("apex://market/quote/APEX:FX:EURUSD")
   → returns: { bid: 1.08762, ask: 1.08767, sequence: 503, ... }

3. Agent confirms: notification sequence matches resource sequence.
```

If the resource read returns seq=505 instead of seq=503, the resource was updated again between the notification and the read. That is fine — the agent now has a more recent state. The key invariant: the resource sequence must be greater than or equal to the notification sequence. If it is less, something is wrong.

Execution event notifications follow the same pattern. When `notifications/apex.order.filled` fires, it includes the `sequence` of the affected resource (e.g., `apex://account/fills/ACC_12345`). The agent can read the fills resource and verify the sequence is at least as high as the notification claimed.

### Correlation Table

| Notification | Resource Affected | Sequence Scope |
|---|---|---|
| `notifications/resources/updated` (quote) | `apex://market/quote/{instrument_id}` | Per-instrument quote stream |
| `notifications/resources/updated` (positions) | `apex://account/positions/{account_id}` | Per-account positions stream |
| `notifications/apex.order.filled` | `apex://account/fills/{account_id}` | Per-account fills stream |
| `notifications/apex.order.rejected` | `apex://account/orders/{account_id}` | Per-account orders stream |
| `notifications/apex.market.candle_closed` | `apex://market/candles/{instrument_id}?timeframe=...` | Per-instrument-timeframe candle stream |
| `notifications/apex.risk.kill_switch_engaged` | `apex://account/risk/{account_id}` | Per-account risk stream |

---

## Sequence vs SSE Event IDs

These are two different monotonic counters that serve different purposes. Conflating them is a common implementation mistake.

### SSE Event IDs

- Scope: per session
- Assigned by: the SSE transport layer
- Purpose: replay cursor for reconnection
- Monotonic across: all event types in one session
- Used by: `Last-Event-ID` header on reconnect

When the agent reconnects with `Last-Event-ID: 472`, it is telling the transport "replay everything after event 472." The server walks its event log and delivers missed notifications (with gap fill classification). This is a transport concern.

### Resource Sequences

- Scope: per resource URI
- Assigned by: the data layer that produces the resource
- Purpose: data integrity for a specific resource stream
- Monotonic across: updates to one resource
- Used by: agent cache validation, gap detection, autonomous execution gating

When the agent sees seq=503 on a quote resource, it is checking "is my view of this quote contiguous?" This is a data integrity concern.

### How They Work Together

A single SSE event (event ID 487) might carry a notification about a quote update at sequence 503. The event ID tells the transport where it sits in the session stream. The sequence tells the agent where the quote sits in the quote stream. Both are needed. Neither replaces the other.

During replay, an SSE event might be elided (collapsed into a gap fill marker). The event ID is consumed by the gap fill range. But the resource sequence is unaffected — the agent still needs to detect that the quote jumped from seq=500 to seq=503, regardless of which SSE event carried that update.

---

## Client Obligations

The spec defines four normative obligations for clients handling sequences.

### Obligation Table

| Obligation | Trigger | Required Action |
|---|---|---|
| Detect non-monotonic sequences | `new_seq <= last_accepted_seq` for any resource | Treat as integrity violation; discard the update; log the anomaly |
| Invalidate cache on gap | `new_seq > last_accepted_seq + expected_increment` | Mark local cache as untrusted for the affected resource |
| Re-read before decisions | Cache invalidated for any execution-critical resource | Call `resources/read` and re-establish baseline before acting |
| Halt autonomous execution | Sequence continuity broken for any execution-critical resource | Suspend new order submission until all critical resources are re-validated |

### Minimum Execution-Critical Resources

The following resources must be sequence-tracked for autonomous trading to be viable:

- `apex://market/quote/{instrument_id}`
- `apex://market/features/{instrument_id}`
- `apex://account/summary/{account_id}`
- `apex://account/positions/{account_id}`
- `apex://account/orders/{account_id}`
- `apex://account/risk/{account_id}`

A gap in any one of these halts autonomous execution. The agent does not get to decide which gaps are important — all execution-critical gaps are halt-worthy.

---

## Parallels

Sequence-based integrity is not a novel idea. APEX adapts a pattern that appears in every reliable distributed system that cares about ordering.

### Established Systems

| System | Concept | APEX Parallel |
|---|---|---|
| TCP | Sequence numbers | Stream integrity — detect missing bytes, request retransmission. APEX sequences detect missing updates, trigger re-reads. |
| Kafka | Consumer offsets | Per-partition position tracking. Each APEX resource URI is like a Kafka partition — its own offset space. |
| Lamport timestamps | Logical clocks | Monotonic ordering without wall-clock dependency. APEX sequences provide logical ordering within a resource stream. |
| FIX Protocol | MsgSeqNum | Per-connection message ordering. If MsgSeqNum skips, send ResendRequest. If APEX sequence skips, re-read the resource. |
| Database WAL | Log Sequence Numbers (LSN) | Ordered log of state transitions. Each APEX resource maintains its own logical log, with the sequence as the position marker. |
| gRPC streams | Sequence metadata | Per-stream ordering guarantees. APEX provides per-resource ordering rather than per-connection ordering. |

### The Key Insight

Every system in this table solves the same fundamental problem: "did I miss something, and if so, how do I recover?" TCP retransmits. Kafka replays from the offset. FIX sends a ResendRequest. APEX re-reads the resource.

The recovery mechanism varies, but the detection mechanism is always the same: a monotonic counter, scoped to the stream that matters, checked by the consumer on every update. APEX sequences are TCP sequence numbers for trading state.

---

## Related Design Documents

- [Freshness Design](freshness-design.md) — the staleness model that works alongside sequence counters to determine whether cached data is safe for autonomous execution
- [Transport Design](transport-design.md) — the SSE event ID mechanism that provides session-level ordering, distinct from the per-resource sequence counters described here
- [Replay Design](replay-design.md) — how sequence continuity is re-established after a reconnect, and how gap fill markers interact with resource-level sequences
