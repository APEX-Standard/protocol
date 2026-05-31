# APEX Protocol — Transport Design

**Version:** `0.2.0-alpha`

---

## Overview

APEX layers trading semantics on MCP (Model Context Protocol) rather than inventing a new transport. MCP gives us JSON-RPC, tools, resources, subscriptions, and notifications. APEX adds trading-specific resources (quotes, candles, features, positions, risk), trading-specific notifications (fills, rejections, kill switch events), and session management (authentication, acknowledgment-driven replay, gap fill).

The result: an agent that already speaks MCP can talk to a broker without learning a new wire protocol. The broker becomes an MCP server. The agent's existing tool-calling, resource-reading, and subscription machinery works unchanged. APEX is a vocabulary, not a transport.

---

## Why MCP

The agent already speaks MCP. It knows how to call tools, read resources, subscribe to resource updates, and process notifications. If you put a broker behind an MCP server, the agent can trade without any transport-level integration work.

This is a deliberate design choice. The alternatives — a custom WebSocket protocol, a gRPC service definition, a proprietary REST API — all require the agent to learn something new. With MCP, the mapping is natural:

- **Tools** are actions: place an order, cancel an order, check risk, authenticate.
- **Resources** are live state: quotes, candles, features, positions, orders, risk.
- **Subscriptions** are change signals: the agent subscribes to a resource URI, the server pushes `notifications/resources/updated` when the state changes, the agent re-reads.
- **Notifications** are urgent events: a fill happened, an order was rejected, the kill switch engaged, a candle closed.

The agent does not parse binary frames, manage connection multiplexing, or negotiate protocol versions beyond the standard MCP `initialize` handshake. It calls tools and reads resources. The broker's job is to make those tools and resources reflect the trading reality.

---

## The Three HTTP Verbs

APEX runs on a single `/mcp` endpoint. Three HTTP verbs divide the work.

### POST — Agent Commands

Every JSON-RPC request goes through `POST /mcp`. This includes:

- Tool calls: `apex.order.place`, `apex.session.authenticate`, `apex.risk.check`
- Resource reads: `resources/read` for quotes, candles, features, positions
- Subscription management: `resources/subscribe`, `resources/unsubscribe`
- Session lifecycle: `initialize`, `apex.session.acknowledge`, `apex.session.heartbeat`

The response is a JSON-RPC result or error. For tool calls that initiate server-to-client streaming within a single request-response cycle, the server may respond with an SSE stream on that POST. But the primary server-to-client push channel is the GET stream described below.

### GET — Server Push

`GET /mcp` opens the SSE notification stream. The server pushes:

- `notifications/resources/updated` — a subscribed resource changed, the agent should re-read it
- `notifications/apex.order.filled` — an order filled completely
- `notifications/apex.order.partially_filled` — a partial fill occurred
- `notifications/apex.order.rejected` — the broker rejected an order
- `notifications/apex.market.candle_closed` — a candle bar completed on a wall-clock boundary
- `notifications/apex.risk.kill_switch_engaged` — the kill switch activated
- `notifications/apex.session.gap_fill` — replay elided a range of ephemeral events
- `notifications/apex.session.replay_failed` — the server could not replay from the requested cursor

Every SSE event gets a monotonic integer `id`. This is the foundation of reconnect and replay — the `id` is the cursor.

### DELETE — Session Teardown

`DELETE /mcp` destroys the session. The server discards the event log, drops subscriptions, and invalidates the `Mcp-Session-Id`. The agent should send DELETE on graceful shutdown. If the agent disappears without sending DELETE, the server eventually times out and cleans up.

---

## Session Identity

The `Mcp-Session-Id` header is the session anchor. The server assigns it during the `initialize` handshake and returns it as a response header. The agent includes it on every subsequent request — POST, GET, and DELETE.

The session scopes everything:

- **Authentication.** The `apex.session.authenticate` call binds credentials to the session. Subsequent tool calls inherit the authentication context.
- **Subscriptions.** Resource subscriptions are per-session. If the session dies, subscriptions die with it.
- **Event log.** The per-session event log stores every notification pushed on the SSE stream. The log enables replay on reconnect.
- **Replay cursor.** The agent's `Last-Event-ID` is meaningful only within its session's event log. A cursor from one session is meaningless in another.
- **Acknowledgment.** When the agent calls `apex.session.acknowledge({ last_event_id: "472" })`, the server discards events 1-472 from this session's log.

A session is not a TCP connection. The agent can close and reopen the SSE stream without losing the session. It can POST tool calls on different HTTP connections. The session persists as long as the `Mcp-Session-Id` is valid — until the agent sends DELETE, the server times it out, or the server restarts (for in-memory implementations).

---

## The SSE Stream

When the agent opens `GET /mcp` with its `Mcp-Session-Id`, the server begins pushing SSE events. Each event is a JSON-RPC notification with an SSE `id` field:

```
id: 1
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"apex://market/quote/APEX:FX:EURUSD"}}

id: 2
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"apex://market/quote/APEX:FX:EURUSD"}}

id: 3
data: {"jsonrpc":"2.0","method":"notifications/apex.order.filled","params":{"order_id":"ORD_789","fill_price":"1.0847","fill_quantity":"100000","timestamp":"2026-03-29T14:32:07.123Z"}}

id: 4
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"apex://account/positions/ACC_12345"}}
```

The `id` is a monotonic integer, transmitted as a string per the SSE specification. IDs are scoped to the session. They start at 1 and increment by 1 for every event. The server writes every event to the session's event log before sending it on the wire.

The stream is unidirectional: server to client only. The agent never writes to this channel. It sends commands via POST. This is a deliberate asymmetry — notifications flow one way, commands flow the other. The two channels are independent HTTP connections that share a session identity.

Servers may coalesce high-frequency resource updates. If a quote changes 50 times in one second, the server might emit 5 `notifications/resources/updated` events instead of 50. The agent re-reads the resource on each notification and gets the current state, not the intermediate states. The `sequence` field on the resource lets the agent detect that intermediate updates were coalesced.

---

## Reconnect Flow

The SSE stream drops. Network blip, load balancer rotation, idle timeout — the reason does not matter. Here is what happens:

1. **Agent detects the drop.** The SSE connection closes. The agent notes the last received event ID — say, `472`.

2. **Agent reconnects.** It sends `GET /mcp` with two headers:
   - `Mcp-Session-Id: sess_abc123` — same session
   - `Last-Event-ID: 472` — the replay cursor

3. **Server looks up the session.** It finds `sess_abc123`, checks the event log.

4. **Server replays from the cursor.** It walks the event log starting after event 472. Events are classified:
   - `required` events (fills, rejections, kill switch) are replayed with their original IDs
   - `elide` events (resource updates, candle closes) are collapsed into `gap_fill` markers

5. **Server transitions to live.** After replaying all logged events, the server switches to live streaming. From this point, every event is delivered without classification.

6. **Agent processes replay.** It handles the replayed fills and rejections — these are execution facts that happened during the gap. It processes the gap fill markers to understand what was skipped.

7. **Agent re-reads all resources.** Regardless of what was replayed, the agent reads every subscribed resource (quote, candles, features, positions, orders, fills, risk) to rebuild current state. The replay delivers history, not current state.

8. **Agent acknowledges.** It calls `apex.session.acknowledge` with the last event ID to advance the retention cursor.

9. **Agent resumes.** After freshness and sequence baselines are re-established, autonomous trading resumes.

If the `Last-Event-ID` is outside the event log (too old, evicted because the agent never acknowledged), the server sends `notifications/apex.session.replay_failed` as the first event. The agent treats this as a full discontinuity: discard all cached state, re-read everything from scratch, reconcile by comparing pre-disconnect state against current state. See [replay-design.md](./replay-design.md) for the full replay classification model, gap fill mechanics, and the FIX parallel.

---

## Why SSE over WebSocket

WebSocket provides a full-duplex bidirectional channel. APEX does not need one.

**The notification channel is unidirectional.** The server pushes events to the agent. The agent never pushes events to the server over the notification channel. Agent commands go through POST. WebSocket's bidirectional capability is unused overhead.

**SSE is HTTP-native.** It works through HTTP proxies, CDNs, load balancers, and API gateways without special configuration. WebSocket requires an HTTP Upgrade handshake that many intermediaries handle poorly or not at all. In enterprise and cloud environments where the broker might sit behind multiple proxy layers, SSE just works.

**SSE has built-in reconnection.** The `Last-Event-ID` header is part of the EventSource specification. When the connection drops, the browser (or any SSE client) automatically reconnects with the last received ID. APEX's replay model builds directly on this mechanism. With WebSocket, you implement reconnection and cursor tracking from scratch.

**SSE is text-based.** JSON-RPC notifications are JSON. SSE carries text. The mapping is trivial — one JSON-RPC notification per SSE `data` field. With WebSocket, you choose between text frames and binary frames, manage frame boundaries, and handle fragmentation. For a protocol that is fundamentally JSON-RPC, the complexity buys nothing.

**Debuggability.** You can `curl` the SSE stream and read the notifications in a terminal. You can pipe them through `jq`. You can inspect them in browser DevTools under the EventSource tab. WebSocket debugging requires specialized tools.

The trade-off: SSE does not support binary payloads or client-to-server push on the same connection. APEX does not need either. Commands are JSON over POST. Notifications are JSON over SSE. The separation is clean.

---

## Why Not gRPC

gRPC is a proven high-performance RPC framework. It requires code generation from `.proto` files, binary protobuf serialization, and HTTP/2 transport. For agent-native trading protocols, every one of these is a liability.

**Code generation.** The agent runtime needs generated stubs for every language it targets. Adding a new tool or notification means regenerating, recompiling, and redeploying. MCP is schema-free JSON-RPC — the agent discovers tools at runtime through `tools/list`, reads their input schemas, and calls them. No build step, no stub mismatch, no version skew between generated client and server.

**Binary serialization.** Protobuf is efficient but opaque. You cannot read a protobuf message in a terminal, paste it in a bug report, or hand-edit it in a test fixture. JSON-RPC is human-readable. When an order fills at the wrong price, you read the notification payload directly. When a tool call fails, you see the error in plain text. For a protocol where correctness matters more than throughput, debuggability wins.

**HTTP/2 requirement.** gRPC requires HTTP/2. Many environments — local development, simple reverse proxies, some cloud providers' default configurations — do not support HTTP/2 end-to-end without explicit setup. MCP over HTTP/1.1 with SSE works everywhere. You can test with curl. You can run it behind nginx with zero configuration. You can deploy it to any cloud provider's cheapest tier.

**Streaming model mismatch.** gRPC's server streaming is conceptually similar to SSE, but it ties the stream to a specific RPC call. APEX's notification stream is a session-level channel that carries all notification types. Mapping this to gRPC requires either one giant streaming RPC (losing type safety) or multiple streaming RPCs (losing the unified event log and monotonic ID ordering).

APEX optimizes for universality and debuggability, not wire efficiency. The agents that consume APEX are language models making tool calls, not high-frequency trading engines parsing binary feeds at microsecond latency.

---

## Streamable HTTP vs Legacy HTTP+SSE

MCP defines two HTTP transport variants. Both work with APEX.

### Streamable HTTP (Recommended)

Single `/mcp` endpoint. POST for requests, GET for the SSE stream, DELETE for teardown. Session identity via `Mcp-Session-Id` header. This is the transport described throughout this document.

Advantages:
- One endpoint to configure, secure, and monitor
- Clean verb semantics (POST = command, GET = subscribe, DELETE = teardown)
- Session header instead of URL-based session routing

### Legacy HTTP+SSE

Separate endpoints: one for the SSE stream, one for posting JSON-RPC messages. The server returns the SSE endpoint URL during initialization. The client opens the SSE connection and posts messages to the message endpoint.

This was the original MCP HTTP transport. It works, but it requires the client to manage two different URLs and the server to coordinate between the SSE connection handler and the message handler.

### APEX Semantics Are Transport-Invariant

Both transports preserve the same APEX semantics:

| Concern | Streamable HTTP | Legacy HTTP+SSE |
|---|---|---|
| Tool calls | POST /mcp | POST to message endpoint |
| Resource reads | POST /mcp | POST to message endpoint |
| SSE stream | GET /mcp | GET to SSE endpoint |
| Session identity | Mcp-Session-Id header | Embedded in SSE endpoint URL |
| Replay cursor | Last-Event-ID header | Last-Event-ID header |
| Event log | Per session | Per session |
| Acknowledgment | apex.session.acknowledge | apex.session.acknowledge |
| Teardown | DELETE /mcp | Close SSE + implementation-specific |

Alpha implementations may use either transport. The conformance suite tests APEX tool, resource, and notification semantics — not the transport variant. As the MCP ecosystem converges on Streamable HTTP, legacy HTTP+SSE will phase out, but the APEX protocol layer is unaffected.

---

## Rate Limiting

The broker advertises its rate limits in the `apex.session.capabilities` response under the `rate_limits` object:

```json
{
  "rate_limits": {
    "orders_per_second": 10,
    "market_data_per_second": 100
  }
}
```

These values are the broker's declared maximums. The agent should read them during the discovery phase and configure its request pacing accordingly. An agent that sends 15 order-related tool calls per second to a broker advertising `orders_per_second: 10` will receive `APEX_4040` (request rate exceeded) on the excess requests.

### Pre-Emptive Pacing

The agent should not rely on hitting rate limits and then backing off. Instead, the runtime should implement a token bucket or sliding window rate limiter initialized from the capabilities values. Before dispatching any tool call, the runtime checks its local rate limiter. If the bucket is empty, the runtime queues the request and dispatches it when capacity becomes available. This local pacing eliminates most `APEX_4040` errors before they occur.

For order-entry tool calls (`apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close`), the `orders_per_second` limit applies. For read-only market data tool calls (`apex.market.quote`, `apex.market.snapshot`, `apex.market.details`, `apex.market.search`), the `market_data_per_second` limit applies. Resource reads (`resources/read`) and subscription management are typically governed by the `market_data_per_second` limit unless the broker specifies otherwise.

### The `retry_after` Field

When the broker does return `APEX_4040`, the error envelope includes a `retry_after` field specifying the number of seconds the agent should wait before retrying:

```json
{
  "error": {
    "code": "APEX_4040",
    "category": "rate_limit",
    "message": "Request rate exceeded",
    "retry_after": 2
  }
}
```

If `retry_after` is present, the agent waits exactly that many seconds before retrying. If `retry_after` is absent or null, the agent should apply exponential backoff starting from 1 second (1s, 2s, 4s, 8s, max 60s). After a successful request following a rate limit, the backoff state resets.

### Rate Limiting During Reconnect and Replay

After a reconnect, the agent typically needs to re-read multiple resources in quick succession to rebuild state. This burst of reads can trigger rate limits if the agent is not careful. The recommended approach is to stagger resource re-reads across a short window (e.g., 100ms between reads) rather than issuing them all simultaneously. The replay mechanism itself -- the SSE stream delivering replayed events -- is server-initiated and not subject to client-side rate limits. But the resource re-reads that follow replay are normal tool calls and count against the `market_data_per_second` limit. An agent that needs to re-read 10 resources after reconnect against a broker with `market_data_per_second: 100` has ample headroom. An agent re-reading 10 resources against a broker with `market_data_per_second: 5` needs to pace carefully. The capabilities values tell the agent which scenario it is in.

---

## Parallels

APEX's transport architecture did not emerge from first principles. It draws on established patterns from financial protocols, event streaming, and web standards.

### FIX Session Layer

FIX (Financial Information eXchange) defines a session layer with logon, heartbeat, sequence numbers, resend requests, and gap fill — over raw TCP. APEX maps the same concepts to HTTP/SSE:

| FIX | APEX |
|---|---|
| Logon message | MCP `initialize` + `apex.session.authenticate` |
| Heartbeat / TestRequest | `apex.session.heartbeat` |
| MsgSeqNum | SSE event `id` (monotonic integer) |
| ResendRequest(beginSeqNo, endSeqNo) | `Last-Event-ID` header on GET reconnect |
| SequenceReset-GapFill | `notifications/apex.session.gap_fill` |
| Execution Report replay | Replay of fills, rejections, kill switch events |
| Message store (flat file) | Per-session event log |
| Sequence reset on Logon | `apex.session.acknowledge` advances cursor |

The FIX parallel is not cosmetic. The same operational problems — what to do when a connection drops, which messages matter during replay, how to bound storage — have the same solutions. APEX just applies them over a modern HTTP transport instead of a custom TCP framing protocol.

### EventSource API

The browser's `EventSource` interface is the native SSE client. It opens a persistent HTTP connection, receives `data`/`id`/`event` frames, and automatically reconnects with `Last-Event-ID` on disconnect. APEX's reconnect and replay model is designed to work with `EventSource` out of the box. An agent running in a browser (or using an EventSource-compatible library in Node.js, Python, Go, Rust, or Java) gets automatic reconnection for free.

### Kafka Consumer Protocol

Kafka consumers subscribe to topics, poll for messages, and commit offsets. The offset is the consumer's cursor — everything before it is "processed." APEX's acknowledgment model works the same way:

| Kafka | APEX |
|---|---|
| Topic partition | Per-session event log |
| Consumer offset | Last acknowledged event ID |
| Commit offset | `apex.session.acknowledge` |
| Auto-commit | Not supported — agent must acknowledge explicitly |
| Rebalance / seek | `Last-Event-ID` on reconnect |

The difference: Kafka is a distributed log with retention policies measured in hours or days. APEX's event log is per-session, typically in-memory, and bounded by acknowledgment. The agent controls retention by acknowledging. If it never acknowledges, the server's max retention cap (documented in `apex.session.capabilities`) is the safety limit.

### GraphQL Subscriptions

GraphQL subscriptions push data changes to clients — typically over WebSocket. APEX achieves the same thing over SSE. The subscription model is similar (subscribe to a resource, receive change events), but APEX uses HTTP-native SSE instead of WebSocket, and the "change event" is a notification that triggers a resource re-read rather than a pushed payload containing the new state. This is MCP's level-triggered invalidation model: the notification says "this changed," the client re-reads to find out what it changed to.

### Financial Market Data Feeds

Institutional market data feeds — CME MDP (Market Data Platform), LSE ITCH, Nasdaq ITCH — deliver tick-by-tick market data over multicast UDP or proprietary TCP protocols with sequence numbers and snapshot-plus-incremental recovery. APEX operates at a higher level:

- APEX delivers decision-ready resources (quotes with spreads, pre-computed features, candle series), not raw order book events.
- APEX's "snapshot-plus-incremental" is the resource re-read (snapshot) plus the notification stream (incremental invalidation).
- APEX's replay delivers execution history, not market data history — stale quotes are elided, fills are replayed.

APEX is not competing with these feeds on latency or throughput. It is solving a different problem: giving a language model agent the structured state it needs to make trading decisions, with enough operational robustness (replay, gap fill, freshness tracking, sequence continuity) that the agent can trade autonomously through network disruptions.

---

## Related Design Documents

- [Replay Design](replay-design.md) — the acknowledgment-driven replay model, gap fill classification, and reconnect recovery that build on the SSE transport described here
- [Session Design](session-design.md) — the session lifecycle (initialize, authenticate, discover, operate, teardown) that governs how the transport is established and maintained
- [Sequence Design](sequence-design.md) — per-resource sequence numbering and gap detection that complement the session-level SSE event IDs described in this document
