# APEX Protocol — Error Taxonomy Design

**Version:** `0.3.0-alpha`

---

## Overview

An autonomous trading agent must react to errors differently depending on what went wrong. "Something failed" is not enough. A rate limit is not the same as a risk limit breach, which is not the same as an expired token, which is not the same as a broker system outage. Each of these demands a fundamentally different recovery strategy — retry, halt, re-authenticate, fix parameters, or wait.

APEX structures errors so the agent (or its runtime) can make the right recovery decision automatically, without parsing free-text messages or guessing from HTTP status codes. Every error carries a machine-readable code, a behavioral category, and enough context for deterministic recovery logic.

---

## The Problem

Consider this concrete scenario. An agent places a sell order on EUR/USD. The broker returns an error. What should the agent do?

- **If the error is a transient rate limit:** back off for 2 seconds, then retry the same order. Safe.
- **If the error is a risk limit breach:** stop trading immediately, check positions, possibly flatten exposure. Retrying the same order would make things worse.
- **If the error is an expired authentication token:** re-authenticate, then retry. The order itself was fine.
- **If the error is invalid order parameters:** fix the parameters (wrong lot size, missing stop loss, invalid instrument). Retrying the same request is guaranteed to fail again.
- **If the error is "market closed":** wait for market hours, poll capabilities. The order might be valid in 3 hours.
- **If the error is a broker system error:** alert a human, wait, do not retry aggressively. The broker's infrastructure is down and hammering it makes recovery harder.

Without structured categories, the agent has two choices: retry everything (dangerous — it will retry into risk limit breaches and amplify losses) or halt on everything (useless — it stops trading on a transient rate limit that would have resolved in 2 seconds).

The taxonomy exists to eliminate this ambiguity. Every error self-describes its behavioral class so the agent can branch into the correct recovery path without heuristics.

---

## The Error Envelope

Every APEX tool returns errors in a consistent envelope:

```json
{
  "error": {
    "code": "APEX_4020",
    "category": "risk",
    "message": "Insufficient margin for requested position size",
    "details": {
      "required_margin": "12500.00",
      "available_margin": "8340.22",
      "instrument_id": "EURUSD"
    },
    "request_id": "req_8f3a2b1c",
    "retry_after": null
  }
}
```

Each field serves a specific purpose:

| Field | Purpose | Consumer |
|---|---|---|
| `code` | Precise error identification. The agent can branch on exact codes for fine-grained handling. | Machine logic |
| `category` | Behavioral classification. Groups codes into recovery strategies. This is the primary dispatch key for autonomous recovery. | Machine logic |
| `message` | Human-readable description. For logs, dashboards, and debugging. Never parse this programmatically. | Humans |
| `details` | Structured context. Contains error-specific data — the margin shortfall, the invalid field name, the restricted instrument. Schema varies by error code. | Both |
| `request_id` | Correlation identifier. Links the error back to the originating request for audit trails and log correlation. | Operations |
| `retry_after` | Seconds to wait before retrying. Populated for `rate_limit` errors. Null for all other categories. | Machine logic |

The envelope is intentionally flat. There is one level of structure. The agent reads `category` for dispatch, `code` for precision, `details` for context, and `retry_after` for backoff. No nested error chains, no error inheritance hierarchies, no optional sub-envelopes.

---

## The Seven Categories

APEX defines exactly seven error categories. The number is fixed by the specification. Each category maps to a distinct recovery behavior.

| Category | Description | Agent Response | Example |
|---|---|---|---|
| `auth` | Credentials invalid, expired, or insufficient | Re-authenticate. If re-authentication fails, halt the session. | Token expired after 24 hours |
| `validation` | Request parameters are malformed or invalid | Fix parameters. Do not retry the same request — it will fail identically. | Lot size 0.001 below broker minimum of 0.01 |
| `risk` | Margin, position, or loss limits breached | Reduce exposure or halt autonomous execution. Surface to human if configured. | Daily loss limit of $5,000 reached |
| `operational` | Stale data, sequence breaks, state inconsistency | Pause execution. Rebuild state from fresh resources. Resume when data is current. | Quote data 45 seconds stale |
| `broker` | Market conditions prevent execution | Wait for market condition change. Poll capabilities or instrument details. | Market closed for weekend |
| `rate_limit` | Too many requests in the time window | Back off using `retry_after`. Apply exponential backoff if `retry_after` is absent. | 50 requests/second limit exceeded |
| `internal` | Broker system error, infrastructure failure | Alert. Do not retry immediately. Wait for broker recovery. | Order routing system unreachable |

The categories are ordered from most-recoverable to least-recoverable. `auth` and `validation` are client-side problems the agent can fix. `risk` and `operational` are state problems that require careful intervention. `broker` and `rate_limit` are transient conditions. `internal` is the broker's problem — the agent can only wait.

---

## The Error Code Table

APEX error codes follow a numbering convention: **4xxx codes are client-recoverable** (the agent or its runtime can fix the problem), **5xxx codes are server-side** (the broker's infrastructure has a problem).

### Authentication Errors (4001-4009)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4001` | auth | Invalid or expired token | Re-authenticate with fresh credentials |
| `APEX_4002` | auth | Insufficient account permissions | Check account configuration, may require human intervention |

The agent receives `APEX_4001` when its JWT or OAuth token has expired or been revoked. The correct response is to call `apex.session.authenticate` with a fresh token. If that also fails, the session is unrecoverable and the agent must halt.

`APEX_4002` means the token is valid but the account lacks permission for the requested operation — for example, attempting to trade an instrument class not enabled on the account. This typically requires human intervention to adjust account permissions.

### Validation Errors (4010-4019)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4010` | validation | Invalid instrument_id | Check instrument exists via `apex.market.search` or `apex.market.details` |
| `APEX_4011` | validation | Invalid order parameters | Check field combinations, consult instrument specifications |
| `APEX_4012` | validation | Quantity below minimum | Increase quantity to meet broker minimums |

Validation errors are deterministic. The same request with the same parameters will always produce the same validation error. Retrying is pointless. The agent must inspect the `details` field to understand what was wrong and correct it.

`APEX_4011` covers invalid field combinations — for example, a limit order without a price, or a stop-loss placed on the wrong side of the market. Brokers must reject these with `APEX_4011` rather than silently accepting malformed orders.

### Risk Errors (4020-4029)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4020` | risk | Insufficient margin | Reduce position size or close existing positions to free margin |
| `APEX_4021` | risk | Position limit exceeded | Close positions before opening new ones |
| `APEX_4022` | risk | Daily loss limit reached | Halt trading for the day. This is a safety boundary. |
| `APEX_4023` | risk | Kill switch active | All autonomous execution is blocked. Human intervention required. |

Risk errors are the most consequential category. They mean the agent has reached or would breach a safety boundary. The correct response is never to retry the same order.

`APEX_4023` deserves special attention. When the kill switch is active, the broker rejects all order-entry and modification requests. The agent must not attempt workarounds. The kill switch exists to protect the account during abnormal conditions — a runaway algorithm, an unexpected market event, or a human operator intervening. The agent's only valid response is to stop and wait.

### Operational Errors (4024-4029)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4024` | operational | Stale market or risk state | Re-read resources, wait for fresh data, then retry |
| `APEX_4025` | operational | Sequence continuity broken | Re-read all resources, rebuild state from scratch |

Operational errors protect against acting on outdated information. The autonomous runtime (not the model) enforces these checks before allowing order entry.

`APEX_4024` fires when the agent's most recent market data or risk state exceeds the configured `stale_after_ms` threshold. The quote might be 30 seconds old because the SSE stream dropped. Trading on stale prices is how agents lose money on gaps. The correct response is to pause, wait for the stream to deliver fresh data, re-read the quote resource, and only then retry.

`APEX_4025` fires when the agent detects a gap in the monotonic sequence numbers on execution-critical resources. A sequence gap means the agent missed a state update — perhaps a fill notification, perhaps a position change. Trading without knowing the current state is dangerous. The correct response is to re-read all resources, reconcile state, and then resume.

### Broker Errors (4030-4039)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4030` | broker | Market closed | Wait for market hours, poll `apex.session.capabilities` or `apex.market.details` |
| `APEX_4031` | broker | Instrument not tradeable | Check instrument status, may be temporarily halted or permanently delisted |

Broker errors reflect market conditions, not agent mistakes. The order might be perfectly valid — the market just is not open. These are transient by nature but on a longer timescale than rate limits. The agent should not retry in a tight loop. It should wait for the condition to change.

`APEX_4031` covers both temporary halts (circuit breakers, trading suspensions) and permanent conditions (delisted instruments). The `details` field should indicate which case applies.

### Rate Limit Errors (4040-4049)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_4040` | rate_limit | Request rate exceeded | Wait `retry_after` seconds, then retry |

Rate limit errors are the simplest category. The request was valid, the agent just sent too many requests too quickly. The `retry_after` field tells the agent exactly how long to wait. If `retry_after` is absent, the agent should apply exponential backoff starting from 1 second.

### Internal Errors (5000-5999)

| Code | Category | Description | Recovery |
|---|---|---|---|
| `APEX_5000` | internal | Broker system error | Alert, wait, do not retry aggressively |
| `APEX_5001` | internal | Routing error | Alert, the order could not be routed to the venue |

Internal errors mean the broker's infrastructure is broken. The agent cannot fix this. Retrying aggressively makes recovery harder by adding load to an already-stressed system. The correct response is to alert (log at error level, notify a monitoring system, surface to a human), wait with exponential backoff, and monitor for recovery.

The 5xxx range mirrors HTTP convention — 5xx means the server is at fault. The agent's request may have been perfectly valid.

---

## Autonomous Recovery Logic

Each error category maps to a deterministic recovery path. This is the decision tree that an autonomous runtime should implement.

### auth

```
receive APEX_4001 or APEX_4002
  -> attempt re-authentication (apex.session.authenticate)
     -> success: retry the original request
     -> failure: halt session, surface to human
```

Re-authentication should be attempted exactly once. If it fails, the credentials are revoked or the account is locked. Retrying in a loop accomplishes nothing.

### validation

```
receive APEX_4010, APEX_4011, or APEX_4012
  -> log the error with full details
  -> do NOT retry the same request
  -> surface to the decision layer for parameter correction
```

Validation errors are bugs or bad inputs. The agent's strategy layer needs to know its request was malformed so it can adjust. An autonomous agent that silently drops validation errors will keep generating the same invalid orders.

### risk

```
receive APEX_4020, APEX_4021, APEX_4022, or APEX_4023
  -> halt autonomous execution immediately
  -> if configured: surface to human operator
  -> if APEX_4023 (kill switch): do not attempt any further order operations
  -> for margin/position limits: agent may reduce exposure, then re-evaluate
```

Risk errors are the safety boundary. The autonomous runtime must treat these as hard stops, not soft warnings. An agent that receives `APEX_4022` (daily loss limit) and then tries a smaller order is violating the intent of the limit.

### operational

```
receive APEX_4024 or APEX_4025
  -> pause autonomous execution
  -> re-read all execution-critical resources (quotes, positions, orders, risk)
  -> wait for fresh data (stale_after_ms criteria met)
  -> verify sequence continuity
  -> resume only when state is fully reconstructed
```

Operational errors are the "your map is wrong" category. The agent thinks it knows the current market state, but it does not. Trading on wrong state is how flash crashes happen. Pause, rebuild, verify, then resume.

### broker

```
receive APEX_4030 or APEX_4031
  -> stop retrying the specific instrument/operation
  -> wait for market condition change
  -> poll apex.market.details or apex.session.capabilities periodically
  -> resume when the instrument becomes tradeable
```

The polling interval should be measured in minutes, not milliseconds. Markets open on a schedule. Circuit breakers lift after a cooling period. Tight retry loops are waste.

### rate_limit

```
receive APEX_4040
  -> read retry_after from the error envelope
  -> if retry_after is present: wait exactly that many seconds, then retry
  -> if retry_after is absent: exponential backoff (1s, 2s, 4s, 8s, max 60s)
  -> after successful retry: reset backoff state
```

Rate limits are the one category where automatic retry is always safe. The request was valid. The only issue was timing.

### internal

```
receive APEX_5000 or APEX_5001
  -> log at error level with full request context
  -> alert monitoring systems
  -> do NOT retry immediately
  -> exponential backoff (5s, 10s, 20s, 40s, max 300s)
  -> if the error persists after 3 attempts: halt and surface to human
```

Internal errors demand patience. The broker is having infrastructure problems. Aggressive retry adds fuel to the fire. The agent should back off slowly and escalate if the condition persists.

---

## Rejection Class Mapping

The execution-semantics specification defines rejection classes for order lifecycle events. These are semantic labels attached to order rejections within the execution domain. The core specification defines the normative wire-format error categories. The two systems overlap but are not identical.

Execution-semantics defines seven rejection classes:

- `validation`
- `risk`
- `market_state`
- `venue`
- `rate_limit`
- `auth`
- `operational`

The wire-format specification defines seven error categories:

- `auth`
- `validation`
- `risk`
- `operational`
- `broker`
- `rate_limit`
- `internal`

Five map directly:

| Rejection Class | Wire Category |
|---|---|
| `auth` | `auth` |
| `validation` | `validation` |
| `risk` | `risk` |
| `rate_limit` | `rate_limit` |
| `operational` | `operational` |

Two require translation:

| Rejection Class | Wire Category | Rationale |
|---|---|---|
| `market_state` | `operational` | Market state issues (halted trading, stale feeds) are operational conditions the agent must wait out |
| `venue` | `broker` | Venue-level rejections (exchange rejects, clearing failures) surface through the broker channel |

The wire format does not have a `market_state` or `venue` category because those distinctions are execution-domain details. At the wire level, the agent needs to know the behavioral class — "wait for conditions to change" (`operational` / `broker`) — not the venue topology.

Implementations should preserve the broker-native rejection reason in the `details` field while mapping the top-level `category` to the normative wire-format enum. This gives the agent deterministic dispatch on `category` while preserving full diagnostic context in `details`.

---

## The Annotation System

Every APEX tool carries MCP annotations that inform error handling strategy. Annotations are metadata declared at tool registration time — they do not change per-request. Three annotations matter for error recovery:

- **`readOnlyHint`** — The tool does not modify state. Errors from read-only tools are always safe to retry (modulo rate limits).
- **`destructiveHint`** — The tool modifies state in ways that may not be reversible. Errors from destructive tools must not trigger blind retry. A failed `apex.order.place` might have partially executed before the error was returned.
- **`idempotentHint`** — Calling the tool twice with the same parameters produces the same result. Idempotent tools can be safely retried after transient failures. Non-idempotent tools cannot.

### Normative Annotation Table

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|---|---|---|---|
| `apex.session.authenticate` | false | false | true |
| `apex.session.capabilities` | true | false | true |
| `apex.session.heartbeat` | true | false | true |
| `apex.account.*` | true | false | true |
| `apex.order.place` | false | true | false |
| `apex.order.modify` | false | true | false |
| `apex.order.cancel` | false | true | true |
| `apex.order.status` | true | false | true |
| `apex.position.close` | false | true | false |
| `apex.market.*` | true | false | true |
| `apex.risk.*` | true | false | true |
| `apex.fx.*` | true | false | true |
| `apex.cfd.*` | true | false | true |
| `apex.crypto.funding_rate` | true | false | true |
| `apex.crypto.liquidation_estimate` | true | false | true |
| `apex.crypto.transfer` | false | false | false |

### How Annotations Inform Recovery

The intersection of error category and tool annotation determines the safe recovery action:

**Idempotent + rate_limit:** Retry after backoff. The tool is safe to call again with the same parameters. `apex.order.cancel` with `APEX_4040` — wait, then cancel again. The cancel is idempotent; calling it twice on the same order produces the same result.

**Non-idempotent + rate_limit:** Retry with caution. `apex.order.place` with `APEX_4040` — the order might not have been placed (rate limited before processing) or might have been placed (rate limited after processing). The agent should check `apex.order.status` or use `client_order_id` deduplication before retrying.

**Destructive + internal:** Do not retry. `apex.order.place` with `APEX_5000` — the broker's system errored, but the order might have been partially processed. Retrying could create a duplicate order. The agent should query order status first.

**Read-only + any error:** Safe to retry after appropriate backoff. `apex.market.quote` with `APEX_5000` — the query failed, no state was modified, retry when the broker recovers.

The `client_order_id` mechanism is the primary safety net for non-idempotent order operations. Brokers must enforce `client_order_id` uniqueness within a session — a second `apex.order.place` with the same `client_order_id` must return the result of the first order, not create a new one. This makes order placement effectively idempotent at the application level, even though the tool annotation correctly marks it as non-idempotent at the protocol level.

---

## Parallels

The APEX error taxonomy did not invent these ideas. It draws from a long lineage of structured error systems in protocols and APIs that serve machine consumers.

### HTTP Status Codes

HTTP divides errors into 4xx (client error) and 5xx (server error). APEX mirrors this with `APEX_4xxx` for client-recoverable errors and `APEX_5xxx` for server-side failures. But HTTP stops at two categories. A `400 Bad Request` does not tell you whether the problem is authentication, validation, or rate limiting. The agent has to parse the body, which is unstructured. APEX adds the `category` field to provide what HTTP status codes lack: behavioral classification.

### gRPC Status Codes

gRPC defines 16 canonical status codes (`OK`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE`, etc.) with structured error details via `google.rpc.Status`. This is closer to APEX's model — machine-readable codes with structured metadata. APEX's seven categories roughly correspond to gRPC groupings: `PERMISSION_DENIED` maps to `auth`, `INVALID_ARGUMENT` maps to `validation`, `RESOURCE_EXHAUSTED` maps to `rate_limit`, `UNAVAILABLE` maps to `internal`.

### PostgreSQL SQLSTATE

PostgreSQL uses 5-character error codes organized by class: `23xxx` for integrity constraints, `42xxx` for syntax errors, `53xxx` for insufficient resources. The two-character class prefix is the behavioral dispatch key, and the remaining three characters identify the specific error. APEX's `category` field serves the same role as the SQLSTATE class prefix — it tells the caller what kind of problem it is before the caller inspects the specific code.

### FIX Protocol OrdRejReason

The FIX protocol's `OrdRejReason` field (tag 103) enumerates specific order rejection reasons: `0` = broker option, `1` = unknown symbol, `2` = exchange closed, `3` = order exceeds limit, `4` = too late to enter, `5` = unknown order, `13` = incorrect quantity, etc. APEX's error codes serve the same function as FIX tag 103, but with the addition of the `category` envelope for behavioral grouping. FIX's numeric reasons require a lookup table; APEX's category field provides the behavioral class directly on the wire.

### AWS Error Codes

AWS API errors include a `Code` (e.g., `Throttling`, `AccessDeniedException`, `InternalServiceError`) and a `Message`. AWS SDKs use the error code to drive automatic retry logic — `Throttling` triggers exponential backoff, `InternalServiceError` triggers retry with jitter, `AccessDeniedException` does not retry. APEX's `category` field provides the same automatic-retry-classification that AWS SDKs derive from error codes, but as an explicit first-class field rather than something the SDK must infer from code naming conventions.

### Stripe Error Types

Stripe's API returns errors with a `type` field: `card_error`, `rate_limit_error`, `api_error`, `authentication_error`, `invalid_request_error`. Each type drives different client behavior — `card_error` means the card was declined (show the user a message), `rate_limit_error` means back off, `api_error` means Stripe is down. APEX's `category` field is directly analogous to Stripe's `type` field. Both provide a small, fixed set of behavioral classifications that the client dispatches on, with detailed error codes and messages for specifics.

The common thread across all of these systems: as protocols mature and their consumers become more automated, error responses evolve from unstructured text to categorized, machine-readable envelopes. APEX starts where those systems ended up, because APEX's primary consumer — an autonomous trading agent — was never going to read a prose error message and figure out what to do.

---

## Related Design Documents

- [Order Lifecycle Design](order-lifecycle-design.md) — the order state machine, rejection semantics, and normative error code table that define how errors manifest in the execution domain
- [Autonomous Safety Design](autonomous-safety-design.md) — the halt conditions and layered defense model that consume error categories for autonomous recovery decisions
- [Transport Design](transport-design.md) — rate limiting mechanics and the `retry_after` field in the transport context
