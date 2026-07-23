# APEX Protocol — Broker Implementation Guide

**Audience:** broker teams and gateway implementers  
**Version:** `0.3.0-alpha`

---

## Goal

Implement the APEX alpha contract in a way that is useful for agent-native trading, not just tool demos.

---

## 1. Build The System In Layers

Recommended layering:

1. broker/exchange adapters
2. canonical instrument/account mapping
3. deterministic state engine
4. MCP exposure layer
5. autonomous safety and audit layer

Do not make the MCP server your only source of truth. It should expose the state model, not replace it.

---

## 2. Canonicalize Early

Normalize broker-native objects into APEX-native objects before exposing them:

- instrument IDs
- side enums
- order types
- quantities and units
- timestamps
- position model

If canonicalization happens late, the agent sees broker-specific drift everywhere.

---

## 3. Make Resources Authoritative

Treat tools as command/query entry points and resources as the live state plane.

At minimum, keep these resources coherent:

- quote
- candles
- features
- account summary
- positions
- orders
- risk
- decision context if autonomous mode is supported

Resource reads should reflect the same underlying state that tool responses mutate.

---

## 4. Emit Updates From State Changes

When order or account state changes:

- update the canonical state first
- then emit `notifications/resources/updated`
- keep notification emission deterministic and idempotent where possible

Do not emit notifications that refer to state the client cannot yet read consistently.

---

## 5. Document Broker-Specific Reality

Explicitly document:

- netting vs hedging
- market session boundaries
- replay support or lack of replay
- freshness expectations
- cancel vs cancel-replace behavior
- hard broker risk gates

If the broker has behavior that the APEX baseline cannot fully express, say so directly.

---

## 6. Autonomous Safety Boundary

The broker implementation should expose enough state for the agent runtime to halt safely:

- kill switch
- restricted instruments
- max position size
- max open orders
- stale data indicators
- market-hours eligibility

If you cannot enforce a control broker-side, document whether the runtime must enforce it instead.

---

## 7. Transport Implementation

### 7.1 Streamable HTTP Endpoint

Expose a single `/mcp` endpoint that handles three HTTP methods:

- **POST** — Client sends JSON-RPC requests (initialize, tool calls, resource reads). Server responds with a JSON-RPC response. On `initialize`, generate a unique `Mcp-Session-Id` and return it as a response header.
- **GET** — Client opens a persistent SSE stream for server-pushed notifications. Requires a valid `Mcp-Session-Id` header and `Accept: text/event-stream`. Only one SSE stream is allowed per session; if a second GET arrives, close the previous stream before opening the new one.
- **DELETE** — Client terminates the session. Close the SSE stream, discard the event log, stop the tick engine, and invalidate the `Mcp-Session-Id`.

### 7.2 Session Management

- Generate a `Mcp-Session-Id` on the `initialize` JSON-RPC request and return it as a response header.
- Validate the `Mcp-Session-Id` header on all subsequent POST, GET, and DELETE requests.
- Reject requests with an unknown or expired session ID with HTTP 404.
- Reject requests missing the session header (after initialization) with HTTP 400.

### 7.3 SSE Event Formatting

Every event pushed over the SSE stream must include three fields:

```
id: 42
event: message
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"apex://market/quote/APEX:FX:EURUSD"}}

```

- `id` — A monotonic integer starting at 1 for each session, transmitted as a string per the SSE spec. This is the replay cursor.
- `event` — Always `message`.
- `data` — The full JSON-RPC 2.0 notification object.

### 7.4 Event Log

Maintain a per-session event log for replay. The storage mechanism is an implementation choice:

- **In-memory buffer** — Simplest. Bounded by max retention count. Lost on restart.
- **File-based log** — FIX-style sequential file. Survives restarts. Cheap storage.
- **Durable queue** — Redis, Kafka, or similar. For scaled deployments with shared state.

Requirements:

- **Scope:** Per session. Each `Mcp-Session-Id` has its own independent log.
- **Retention:** Retain events until the agent calls `apex.session.acknowledge` with the event ID. Discard events at or before the acknowledged ID.
- **Maximum retention:** Enforce a safety cap (event count, time window, or both) to bound growth when the agent has not acknowledged. Document the limit in `apex.session.capabilities` under `realtime_contract`.
- **Default maximum:** Reference implementations use 10000 events in-memory.
- **Cleanup:** Discard the log when the session is terminated (DELETE) or the server shuts down.

### 7.5 `Last-Event-ID` Handling on GET Reconnect

When a client reconnects with a GET request that includes the `Last-Event-ID` header:

1. Look up the session by `Mcp-Session-Id`.
2. Find the event after the given `Last-Event-ID` in the event log.
3. During replay, classify each event and apply gap fill rules (see Section 7.8). Only `required` events are sent with original IDs; consecutive `elide` events are collapsed into `gap_fill` markers.
4. Continue streaming new events on the same connection.

### 7.6 Replay Failure

If `Last-Event-ID` is outside the event log (evicted due to max retention exceeded, or unknown):

1. Open the SSE stream normally (new events only).
2. Send `notifications/apex.session.replay_failed` as the first event, with payload: `{ "reason": "event_id_outside_log", "last_available_id": <int> }`.
3. The client treats this as a sequence discontinuity: discard cached state, re-read all resources, re-establish baseline before resuming autonomous execution.

With acknowledgment-driven retention, replay failure only occurs when the server's max retention is exceeded with unacknowledged events.

### 7.7 Handling `apex.session.acknowledge`

When the agent calls `apex.session.acknowledge`:

1. Parse `last_event_id` as an integer.
2. Discard all events in the session's event log with ID ≤ `last_event_id`.
3. Return `acknowledged_through` (the acknowledged ID) and `buffer_depth` (count of remaining unacknowledged events).
4. If `last_event_id` is higher than any event the server has sent, return the highest sent event ID as `acknowledged_through`.

If the event has already been pruned or was never known for the current session, return the closest acknowledged cursor and the current replay buffer depth.

### 7.8 Gap Fill During Replay

During replay (events sent after `Last-Event-ID` reconnect), classify each logged event:

**`required`** — Send with original event ID:
- `notifications/apex.order.filled`
- `notifications/apex.order.partially_filled`
- `notifications/apex.order.rejected`
- `notifications/apex.risk.kill_switch_engaged`

**`elide`** — Do not replay individually. Collapse consecutive elided events into a single gap fill marker:
- `notifications/resources/updated`
- `notifications/apex.market.candle_closed`

The gap fill notification:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.session.gap_fill",
  "params": {
    "elided_count": 47,
    "from_id": "12",
    "to_id": "58"
  }
}
```

Gap fill markers use the `to_id` of the elided range as their SSE event ID, preserving monotonic ordering. The marker's SSE event ID equals its `to_id` field. After all logged events are replayed or elided, the server transitions to live streaming where all events are delivered without classification.

### 7.9 Session Affinity in Scaled Deployments

Event logs and session state are per-instance by default. In horizontally scaled deployments behind a load balancer, session affinity (sticky sessions) is required to ensure reconnecting clients reach the instance holding their event log.

Configure the load balancer to route requests based on the `Mcp-Session-Id` header. If the header is absent (initial `POST /mcp` for `initialize`), any instance may handle the request.

Alternatively, implementations using shared storage for event logs (file-based on shared disk, Redis, Kafka, or a durable queue) avoid the affinity requirement — any instance can serve any session's replay.

---

## 8. Minimum Validation Before Claiming Alpha Realtime

Before claiming serious realtime support, verify:

- `npm run verify:alpha`
- `npm run verify:production`

Then add your own broker-specific tests for:

- reconnect
- stale quote handling
- order rejection mapping
- partial fill lifecycle

---

## 9. Common Failure Modes

- exposing tool responses that disagree with resources
- emitting notifications without monotonic resource versions
- mixing broker-native and canonical units
- hiding netting/hedging semantics
- treating candles as sufficient for execution logic
- lacking any clear stale-data contract
