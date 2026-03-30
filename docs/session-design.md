# APEX Protocol — Session Lifecycle Design

**Version:** `0.1.0-alpha`

---

## Overview

A trading session is a live, authenticated connection between an agent and a broker. It is the scope for everything: authentication, subscriptions, event logs, replay cursors, and safety state. Every tool call, every resource read, every notification delivery, every acknowledgment happens within a session. When the session ends, the broker discards the event log, cancels subscriptions, and forgets the connection existed.

If the replay design document answers "what happens when the connection drops," this document answers the prior question: "what is the connection in the first place?"

---

## Session Lifecycle

An APEX session moves through five phases. Every production session follows this sequence. Skipping a phase or reordering them produces undefined behavior — the broker may reject tool calls, the agent may trade on stale state, or both.

### Phase 1: Initialize

The agent connects to the broker's MCP endpoint and performs the standard MCP `initialize` handshake. This is not APEX-specific — it's the MCP protocol's own capability negotiation. But APEX uses it to advertise a critical piece of metadata: the protocol version.

The broker includes `apex_version` in the `serverInfo` block of the initialize response:

```json
{
  "serverInfo": {
    "name": "acme-broker",
    "version": "2.4.1",
    "apex_version": "0.1.0-alpha"
  }
}
```

The agent reads `apex_version` before calling any APEX tools. If it's missing, the server is not an APEX broker. If it's present but incompatible, the agent disconnects gracefully. Section 3 walks through version negotiation in detail.

For remote sessions, the transport is MCP Streamable HTTP on a single `/mcp` endpoint: POST for JSON-RPC requests, GET for the SSE notification stream, DELETE for session teardown. Session identity is carried via the `Mcp-Session-Id` response/request header. For alpha interoperability, implementations may also use the older MCP HTTP+SSE compatibility transport.

### Phase 2: Authenticate

The agent calls `apex.session.authenticate` with a broker-issued token:

```json
{
  "token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "jwt",
  "account_id": "ACC-7721"
}
```

The broker validates the token directly — there is no hub, no intermediary, no federated identity broker in the path. The broker checks the token, binds the authenticated identity to the MCP session (identified by `Mcp-Session-Id`), and returns the session binding:

```json
{
  "session_id": "sess-a1b2c3",
  "account_id": "ACC-7721",
  "expires_at": "2026-03-29T18:00:00Z",
  "capabilities": ["apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*"],
  "profiles": ["fx", "cfd"],
  "broker_id": "acme",
  "broker_name": "Acme Brokerage"
}
```

After this call succeeds, the session is live. Every subsequent tool call, resource subscription, and notification delivery is bound to this session and this authenticated identity. Section 4 covers the authentication design in detail.

### Phase 3: Discover

The agent calls `apex.session.capabilities` to learn what the broker supports:

```json
{
  "apex_version": "0.1.0-alpha",
  "broker_id": "acme",
  "core_tools": ["apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*"],
  "profiles": { "fx": "0.1.0", "cfd": "0.1.0" },
  "vendor_extensions": {
    "namespace": "acme",
    "tools": ["acme.sentiment.index"]
  },
  "rate_limits": {
    "orders_per_second": 10,
    "market_data_per_second": 100
  },
  "supported_order_types": ["market", "limit", "stop", "stop_limit"],
  "supported_tif": ["GTC", "IOC", "FOK", "DAY"],
  "realtime_contract": {
    "transport_mode": "streamable_http",
    "reconnect_mode": "session_replay",
    "max_retention_events": 10000,
    "max_retention_seconds": 0,
    "quote_freshness_ms": 1000,
    "account_freshness_ms": 2000
  }
}
```

This is the broker's menu. The agent reads it before doing anything else because it answers every operational question: what order types can I use? What are my rate limits? Does the broker support replay? How fresh will quotes be? Section 5 and Section 6 cover this in detail.

### Phase 4: Operate

The session is now live, authenticated, and the agent knows what the broker supports. This is the trading phase. The agent:

- Calls `resources/list` to discover available resources
- Subscribes to execution-critical resources: quotes, candles, features, positions, orders, fills, risk
- Reads each subscribed resource once to establish baseline state with freshness timestamps and sequence numbers
- Begins receiving notifications over the SSE stream as state changes
- Places orders, modifies orders, cancels orders, reads account state
- Acknowledges processed events via `apex.session.acknowledge` to advance the broker's retention cursor
- Sends periodic heartbeats via `apex.session.heartbeat` to confirm session liveness

The operate phase has no fixed duration. It lasts as long as the trading session is active — seconds for a quick check, hours for an autonomous trading run. During this phase, the agent maintains a local state cache, tracks freshness and sequence continuity, and halts autonomous execution when safety conditions are violated.

### Phase 5: Teardown

The agent sends `DELETE /mcp` to end the session. The broker:

- Discards the per-session event log
- Cancels all active subscriptions
- Releases the `Mcp-Session-Id`
- Cleans up any session-scoped state

After teardown, the session ID is invalid. Any attempt to use it gets rejected. The agent must re-initialize, re-authenticate, and re-discover to trade again.

If the agent doesn't explicitly tear down the session (network failure, process crash), the broker eventually times out the session based on heartbeat failure and authentication expiry. The effect is the same: event log discarded, subscriptions cancelled, session forgotten.

---

## Version Negotiation

The MCP `initialize` response is the first thing the agent sees. APEX embeds `apex_version` in `serverInfo` so the agent can check compatibility before calling any APEX-specific tools.

**Concrete walkthrough:**

1. Agent connects and sends MCP `initialize`.
2. Broker responds with `serverInfo` including `apex_version: "0.1.0-alpha"`.
3. Agent parses the version. Three outcomes:

**Compatible:** The agent supports `0.1.0-alpha`. Proceed to `apex.session.authenticate`.

**Incompatible:** The agent only supports `0.2.0`. The version schemes don't align. The agent logs the mismatch and disconnects gracefully — no APEX tool calls, no partial session, no ambiguous state. This is better than calling `apex.session.authenticate` and getting a tool-not-found error or, worse, getting a response with a different schema than expected.

**Missing:** The broker's `serverInfo` has no `apex_version` field. The server is either not an APEX broker or an older implementation that predates version advertisement. The agent should not assume APEX capability.

The version string follows semantic versioning. During alpha (`0.x.y`), minor version changes may include breaking changes. Agents should treat any minor version mismatch as potentially incompatible until the protocol reaches `1.0.0`, after which normal semver rules apply.

This is similar to the TLS handshake's version negotiation — the client proposes, the server declares, and both sides agree or abort before any sensitive data flows.

---

## Authentication Design

APEX uses direct broker authentication. The agent sends a token directly to the broker. The broker validates it. There is no authentication hub, no token exchange service, no intermediary that sees the credential.

**Why direct authentication?** Because the broker is the party the agent is trading with. The broker issued the token (or accepted the OAuth2 grant). The broker knows whether the token is valid, what account it maps to, and what permissions it carries. Adding an intermediary would add latency, a single point of failure, and a party that sees trading credentials without needing to.

The authentication flow:

1. Agent obtains a token out-of-band (broker's web portal, OAuth2 flow, API key generation).
2. Agent calls `apex.session.authenticate` with the token.
3. Broker validates the token against its own auth system.
4. Broker binds the authenticated identity to the MCP session (`Mcp-Session-Id`).
5. All subsequent tool calls on this session are authorized as this identity.

### Security Requirements

These are normative. Implementations that claim APEX compliance must follow them.

| Requirement | Scope | Rationale |
|---|---|---|
| HTTPS/TLS required for remote sessions | Transport | Tokens traverse the wire in the `apex.session.authenticate` payload. Without TLS, they are plaintext. |
| Tokens must not be logged or traced | Server | MCP servers often log tool calls for debugging. The `token` field must be excluded from any log output. |
| Tokens must not be echoed in responses | Server | The authenticate response returns `session_id`, not the token. The token goes in, it doesn't come back. |
| Hosts persisting MCP transcripts must redact the token field | Host/client | AI agent hosts (Claude Desktop, custom runtimes) may persist conversation transcripts. The `token` field must be redacted before storage. |
| Transport-level auth may substitute for tool-level auth | Server | When the transport already carries authentication (mTLS client certificates, HTTP bearer tokens on every request), `apex.session.authenticate` becomes session activation — confirming the agent wants to begin an APEX trading session — rather than primary login. |

The parallel to OAuth2 is intentional. The token is a bearer credential. It grants access. Protect it the same way you'd protect an OAuth2 access token: TLS in transit, redaction at rest, no logging, no echoing.

---

## Capability Discovery

`apex.session.capabilities` returns the broker's full capability manifest. The agent should call it immediately after authentication and before any trading activity.

**Why read capabilities first?** Because the agent cannot assume what the broker supports. One broker might support stop-limit orders; another might not. One broker might offer 10 orders per second; another might allow 100. One broker might support session replay with 10,000-event retention; another might offer no replay at all. The agent needs to know these constraints before it makes any decisions.

### Capability Fields

| Field | Type | Purpose |
|---|---|---|
| `apex_version` | string | Protocol version the broker implements |
| `broker_id` | string | Stable broker identifier |
| `core_tools` | string[] | Tool namespace groups available in this session |
| `profiles` | object | Asset class profiles and their versions (fx, cfd, crypto) |
| `vendor_extensions` | object | Broker-specific tools outside the APEX standard |
| `rate_limits` | object | Orders per second, market data requests per second |
| `supported_order_types` | string[] | Order types the broker accepts (market, limit, stop, stop_limit) |
| `supported_tif` | string[] | Time-in-force values the broker accepts (GTC, IOC, FOK, DAY) |
| `realtime_contract` | object | The broker's realtime delivery parameters (see Section 6) |

An agent that skips capability discovery and goes straight to placing orders is like a FIX client that skips Logon and sends a NewOrderSingle — it might work on some implementations by accident, but it's wrong.

---

## The Realtime Contract

The `realtime_contract` block within capabilities tells the agent how the broker's realtime layer behaves. This is not about what data is available — it's about how that data is delivered, how reconnection works, how long events are retained, and how fresh the data will be.

```json
{
  "realtime_contract": {
    "transport_mode": "streamable_http",
    "reconnect_mode": "session_replay",
    "max_retention_events": 10000,
    "max_retention_seconds": 0,
    "quote_freshness_ms": 1000,
    "account_freshness_ms": 2000
  }
}
```

### Realtime Contract Fields

| Field | Type | Meaning |
|---|---|---|
| `transport_mode` | string | How notifications are delivered: `streamable_http` (recommended) or `http_sse_compat` |
| `reconnect_mode` | string | What happens on reconnect: `no_replay`, `session_replay`, `best_effort_replay`, or `guaranteed_replay` |
| `max_retention_events` | integer | Maximum events the broker retains in the per-session event log before evicting the oldest. 0 means no event-count limit. |
| `max_retention_seconds` | integer | Maximum seconds the broker retains events. 0 means no time limit. |
| `quote_freshness_ms` | integer | Expected quote update interval in milliseconds. The agent uses this to calibrate its staleness detection. |
| `account_freshness_ms` | integer | Expected account state update interval in milliseconds. |

The agent uses this contract to configure its runtime behavior. If `reconnect_mode` is `no_replay`, the agent knows it must rebuild all state from scratch on every reconnect — no Last-Event-ID, no replay, no gap fill. If `max_retention_events` is 10,000 and the agent's decision cycle produces about 100 events per second, the agent knows it has roughly 100 seconds of retention if it stops acknowledging.

If `quote_freshness_ms` is 1000, the agent knows that a quote older than 1 second is likely stale. If the agent's trading strategy requires sub-200ms freshness and the broker advertises 1000ms, the agent knows this broker is not suitable for that strategy — and it knows this before placing a single order.

---

## Heartbeat

`apex.session.heartbeat` is a keep-alive ping. The agent sends it; the broker responds.

```
Agent → { "timestamp": "2026-03-29T14:30:00.000Z" }
Broker → { "timestamp": "2026-03-29T14:30:00.012Z", "status": "ok" }
```

Brokers should respond within 500ms. If the response takes longer, the agent should mark the session as degraded. If the heartbeat fails entirely (timeout, connection error), the session may be broken.

Heartbeat is simple by design. It carries no payload beyond a timestamp. It exists for one reason: to confirm the session is alive and the broker is responsive. A missed heartbeat doesn't necessarily mean the session is dead — the broker might be under load, the network might have a transient issue. But a sequence of missed heartbeats is a strong signal that something is wrong, and the agent should stop making execution decisions until the session is confirmed healthy.

The parallel to FIX is direct. FIX Heartbeat (MsgType 0) serves exactly the same purpose: keep the TCP session alive, detect connection failures, trigger TestRequest when heartbeats stop arriving. APEX heartbeat is simpler — there's no TestRequest equivalent because the transport layer (HTTP) already handles connection-level health — but the operational intent is identical.

---

## Session Health States

Session health is not a single boolean. It's a spectrum, and the agent's behavior should vary across it.

| State | Meaning | Agent Behavior |
|---|---|---|
| `ok` | Heartbeat responsive, subscriptions delivering, all execution-critical resources fresh, authentication valid | Normal operation. Full autonomous execution permitted. |
| `degraded` | Heartbeat slow (>500ms) or occasional subscription delivery gaps, but resources still updating | Proceed with caution. The agent may continue executing but should widen its safety margins — tighter position limits, wider staleness thresholds, more conservative order sizing. |
| `paused` | Heartbeat failing, subscription delivery interrupted, or one or more execution-critical resources stale beyond their `stale_after_ms` threshold | Halt new order entry. Do not ask the model for execution decisions. Continue monitoring. Resume only when the condition clears and fresh state is confirmed. |
| `halted` | Authentication expired, kill switch engaged, session teardown in progress, or unrecoverable error | No execution. No new orders. The agent should attempt to close or cancel existing orders if possible, then tear down and re-establish the session. |

How each state is determined:

**Heartbeat responsiveness** feeds `ok` vs `degraded`. A heartbeat that consistently returns within 500ms is `ok`. A heartbeat that takes 500ms-2000ms is `degraded`. A heartbeat that times out is `paused` or worse.

**Subscription delivery continuity** feeds `ok` vs `degraded` vs `paused`. If the agent is subscribed to quotes and stops receiving updates for longer than the expected `quote_freshness_ms`, either the subscription is broken or the broker has stopped publishing. Either way, the data is stale.

**Freshness of execution-critical resources** feeds `ok` vs `paused`. Every execution-critical resource carries a timestamp and a `stale_after_ms` value. When `current_time > resource_timestamp + stale_after_ms`, the resource is stale. When any execution-critical resource is stale, the session is `paused` for autonomous execution.

**Authentication validity** feeds `ok` vs `halted`. The authenticate response includes `expires_at`. When the current time exceeds that value, the session's authentication is expired. The agent must re-authenticate or tear down.

These states are not communicated by the broker as a single status field. The agent derives them from observable signals — heartbeat timing, subscription delivery, resource freshness, authentication expiry. The agent runtime is responsible for maintaining this state machine.

---

## The Bootstrap Flow

Here is the concrete sequence from connection to first trade, as defined in the reference flows. Every step matters. Skipping or reordering steps produces an unsafe session.

**Step 1: Connect.** Open the MCP transport to the broker endpoint. Perform the MCP `initialize` handshake. Read `apex_version` from `serverInfo`. Verify compatibility. If incompatible, disconnect.

**Step 2: Authenticate.** Call `apex.session.authenticate` with the broker-issued token. The broker validates the token, binds the identity to the session, and returns the session binding with `session_id`, `account_id`, `expires_at`, available capabilities, and active profiles.

**Step 3: Discover.** Call `apex.session.capabilities`. Read the full capability manifest. Store it. The agent now knows what order types are available, what rate limits apply, what the realtime contract looks like, and what profiles are active.

**Step 4: List resources.** Call `resources/list`. The broker returns all available MCP resources for this session — quote URIs, candle URIs, account URIs, risk URIs. This is the resource catalog.

**Step 5: Subscribe.** Subscribe to every execution-critical resource: quote, candles (M1, M5, H1), features, account summary, positions, orders, fills, risk. After subscription, the broker will push `notifications/resources/updated` over the SSE stream whenever these resources change.

**Step 6: Baseline read.** Read each subscribed resource once. Store the payload, the `sequence` number, the `timestamp` or `as_of`, and the `stale_after_ms`. This is the baseline cache. The agent now has a known-good snapshot of every execution-critical resource with freshness and sequence metadata.

**Step 7: Begin decisioning.** Only now — after all six prior steps have completed — does the agent begin making trading decisions. Freshness baselines are established. Sequence baselines are established. The local cache is populated. The subscription stream is flowing. The agent knows what the broker supports. The session is healthy.

If the agent places an order before completing the bootstrap — before it has a baseline cache, before it knows its current positions, before it has confirmed resource freshness — it is trading blind. The bootstrap flow exists to prevent this.

---

## Parallels

The APEX session lifecycle borrows from established patterns across protocols and systems that solve the same fundamental problem: establish identity, negotiate capabilities, operate, and tear down cleanly.

| System | Session Parallel |
|---|---|
| **FIX Logon/Logout** | FIX begins with Logon (MsgType A) — authenticate, exchange sequences, start heartbeat. APEX begins with `initialize` + `authenticate` + `heartbeat`. FIX ends with Logout (MsgType 5). APEX ends with `DELETE /mcp`. Both use heartbeat as a session liveness signal. Both discard session state on disconnect. |
| **OAuth2 session** | OAuth2 issues a token that grants scoped access. APEX's `authenticate` accepts a token and returns capability scopes. OAuth2 tokens expire. APEX sessions have `expires_at`. OAuth2 scopes limit what the client can do. APEX capabilities limit what tools and profiles are available. |
| **TLS handshake** | TLS negotiates cipher suites and protocol version before any application data flows. APEX negotiates `apex_version` and capabilities before any trading activity. Both abort if negotiation fails. Both establish a session identifier that subsequent messages reference. |
| **Database connection pooling** | A database connection has a lifecycle: open, authenticate, configure (SET statements, timezone, isolation level), operate (queries), close. APEX sessions follow the same pattern: connect, authenticate, discover (capabilities are the "SET" phase), operate (tool calls), teardown. Both reclaim resources on close. |
| **SSH session** | SSH negotiates protocol version, exchanges keys, authenticates, then opens channels for operation. APEX negotiates version, authenticates, discovers capabilities, then operates. SSH sessions end with a disconnect message. APEX sessions end with DELETE. Both maintain session liveness through keepalive mechanisms. |

The common thread: every protocol that manages a stateful connection between two parties follows the same lifecycle — negotiate, authenticate, discover capabilities, operate, tear down. APEX applies this pattern to agent-broker trading sessions over MCP.

---

## Related Design Documents

- [Transport Design](transport-design.md) — the HTTP/SSE transport mechanics (POST, GET, DELETE on `/mcp`) that underlie the session lifecycle described here
- [Replay Design](replay-design.md) — what happens when the SSE stream drops during the operate phase, including acknowledgment-driven replay and gap fill
- [Profile Layering Design](profile-layering-design.md) — how profiles and vendor extensions advertised in the capabilities response determine which tools are available during the session
