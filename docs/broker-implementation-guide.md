# APEX Protocol — Broker Implementation Guide

**Audience:** broker teams and gateway implementers  
**Version:** `0.1.0-alpha`

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
- **DELETE** — Client terminates the session. Close the SSE stream, discard the replay buffer, stop the tick engine, and invalidate the `Mcp-Session-Id`.

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

### 7.4 Replay Buffer

Maintain a fixed-size ring buffer of SSE events per session. Guidance:

- **Minimum size:** 1000 events. This covers typical reconnect windows for active trading sessions.
- **Scope:** Per session. Each `Mcp-Session-Id` has its own independent buffer.
- **Eviction:** Drop the oldest events when the buffer is full.
- **Cleanup:** Discard the buffer when the session is terminated (DELETE) or the server shuts down.

### 7.5 `Last-Event-ID` Handling on GET Reconnect

When a client reconnects with a GET request that includes the `Last-Event-ID` header:

1. Look up the session by `Mcp-Session-Id`.
2. Find the event after the given `Last-Event-ID` in the replay buffer.
3. Replay all buffered events from that point forward as SSE frames with their original IDs.
4. Continue streaming new events on the same connection.

### 7.6 Replay Failure

If `Last-Event-ID` is outside the replay buffer (too old or unknown):

1. Open the SSE stream normally (new events only).
2. Send a `notifications/apex.session.replay_failed` notification as the first event, with payload: `{ "reason": "event_id_outside_buffer", "last_available_id": <int> }`.
3. The client must treat this as a sequence discontinuity: discard cached state, re-read all resources, and re-establish baseline before resuming autonomous execution.

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
