# APEX Protocol — Conformance Testing Design

**Version:** `0.1.0-alpha`

---

## Overview

APEX uses an executable conformance harness to prove interoperability across implementations. The harness is a single Node.js package that launches any MCP server — reference or third-party — connects to it, and runs a structured battery of assertions covering tool existence, error envelope shape, schema validity, semantic correctness, and production resilience behavior.

The conformance suite is the enforcement mechanism for the spec. A broker that claims APEX compatibility must pass the harness. Not "we implemented the tools" — pass the harness. The distinction matters because a server that exposes `apex.account.positions` and returns `{ "positions": [] }` passes a shape check but fails a behavior check if it should have returned positions created during the test. APEX conformance tests both: the shape of the response (JSON Schema validation against the 12 normative schemas in `spec/core/schemas/`) and the semantic correctness of the behavior (a market order placed during the test must produce a `position_id` on fill; a limit order without `limit_price` must return `APEX_4011`).

This is the same philosophy behind the W3C Web Platform Tests, the Java Technology Compatibility Kit, and the Kubernetes conformance suite: you do not get to claim compatibility by assertion. You claim compatibility by passing the tests.

---

## The Testing Philosophy

The conformance harness tests behavior, not just shape.

Consider three levels of validation for `apex.order.place`:

1. **Tool existence** — the server lists a tool named `apex.order.place`. This proves nothing about behavior.
2. **Schema validity** — the response from `apex.order.place` has an `order_id` field that is a non-empty string, a `status` field in the set `["accepted", "filled", "working", "rejected"]`, and the error envelope (when present) has `code` and `category` fields. This proves the response is well-formed.
3. **Semantic correctness** — a market buy order for 10,000 base units of EURUSD returns `status: "filled"` with a non-null `position_id`. A limit order submitted without `limit_price` returns error code `APEX_4011` with category `"validation"`. A position modification that includes `limit_price` is rejected. A cancel of a working limit order returns `status: "cancelled"`.

The harness tests all three levels. Level 1 runs first (the smoke suite enumerates 19 required tools and asserts each is present). Level 2 runs inline (every response is checked for required fields and types). Level 3 is the core of the suite — multi-step scenarios that place orders, modify them, cancel them, inject faults, and verify the server behaves as the spec requires.

This is analogous to TLS conformance testing (tlsfuzzer): it is not enough to negotiate a cipher suite — the implementation must handle renegotiation, bad certificates, truncated records, and version downgrade attempts correctly. Shape is necessary but not sufficient.

---

## The Test Tiers

Every test case in the conformance catalog is tagged with one of three tiers:

| Tier | Meaning | Enforcement |
|---|---|---|
| `[REQUIRED]` | Must pass for any alpha compatibility claim | Enforced by the executable harness (`smoke.mjs`, `dry-run.mjs`, `production-smoke.mjs`, `production-resilience.mjs`, `transport-*.mjs`) |
| `[RECOMMENDED]` | Should pass for production-quality implementations | Defined in the test catalog, partially enforced, planned for full executable coverage |
| `[OPTIONAL]` | May pass for enhanced or vendor-specific capabilities | Informational; not enforced by the harness |

**`[REQUIRED]`** tests define the alpha baseline. Core tool existence (19 tools), authentication flow (valid token returns session, invalid token returns `APEX_4001`), error envelope shape, account summary currency semantics (`account_base_currency` vs `response_currency`), market order placement and fill, limit order validation, position close, position-targeted modification rules, market details quantity metadata, pre-trade risk checks, resource subscription, schema validation against all normative schemas, reconnect baseline, stale-data rejection, kill-switch enforcement, sequence-gap detection, and transport lifecycle.

**`[RECOMMENDED]`** tests cover areas that matter for production quality but are not yet fully enforced: currency conversion in account summary, instrument filtering on positions, SL/TP on order placement, candle snapshot structure, risk margin exceedance, and advanced order lifecycle scenarios.

**`[OPTIONAL]`** tests cover profile-specific tools (FX rollover rates, crypto funding rates, CFD corporate actions) and vendor extensions. These are validated at the smoke level (tool exists, basic response shape) but not at full semantic depth.

This tiering follows the precedent set by the IETF's use of MUST/SHOULD/MAY in RFCs, and by the Kubernetes conformance program which distinguishes between required conformance tests and optional feature gates.

---

## The Test Suites

The harness is organized into seven executable scripts, each covering a distinct domain:

### smoke.mjs — Alpha Tool Baseline

The entry point for any implementation. Connects over MCP stdio, enumerates 19 required tools, then runs a focused battery of assertions:

- Authentication: valid token accepted, invalid token returns `APEX_4001`
- Account summary: `account_base_currency` and `response_currency` are separate ISO currency codes
- Order placement: market buy fills with `position_id`, limit order without `limit_price` returns `APEX_4011`
- Position modification: `limit_price` on a position-targeted modify is rejected (`APEX_4011`), but `stop_loss` update succeeds
- Position close: close returns `order_id`, `fill_price`, `fill_quantity`; invalid `position_id` returns `APEX_4010`
- Market details: `quantity_unit` is canonical (`base_units`, `shares`, or `contracts`), `broker_quantity_unit` is present
- Profile tools: FX rollover, exposure, conversion; crypto funding rate, liquidation estimate, transfer; CFD corporate actions, dividend adjustment — all exist and return well-formed responses

This suite runs in under 10 seconds per implementation. It is the fast gate.

### dry-run.mjs — End-to-End Order Lifecycle

Simulates a complete trading workflow over MCP stdio: authenticate, check capabilities, look up market details, run pre-trade risk check, place a market order, attach SL/TP protection, place a resting limit order, cancel it, and verify concurrent order placement does not deadlock or corrupt state. This suite validates that the implementation handles the full lifecycle, not just individual tools in isolation.

### production-smoke.mjs — Resource and Schema Validation

Validates the production resource surface. Reads 11 resources (quote, candles M1/M5/H1, features, account summary, positions, orders, fills, risk, decision context) and validates each against its normative JSON Schema using Ajv. Subscribes to resources and verifies `notifications/resources/updated` is delivered. Validates order-event and fill-event schemas against normalized payloads. This suite requires schema compliance — not just "the field exists" but "the field matches the type, format, and constraints defined in the normative schema."

### production-resilience.mjs — Fault Injection and Safety

Tests the implementation's behavior under adversarial conditions using the `reference.test.set_realtime_state` fault injection tool:

- **Stale quote rejection** — inject `quote_stale: true`, attempt order placement, assert `APEX_4024`
- **Stale risk rejection** — inject `risk_stale: true`, attempt order placement, assert `APEX_4024`
- **Kill switch enforcement** — inject `kill_switch_active: true`, verify order rejection (`APEX_4023`), verify kill switch surfaces in risk resource and decision context
- **Partial fill lifecycle** — inject `partial_fill_next_order: true`, place order, verify `status: "partially_filled"` with correct `fill_quantity` and `remaining_quantity`, validate order-event and fill-event schemas
- **Sequence gap detection** — inject `force_sequence_gap: true`, verify gap is detectable in resource sequence numbers
- **Sequence gap rejection** — verify order placement is rejected (`APEX_4025`) when sequence continuity is broken
- **Reconnect baseline** — disconnect, reconnect, verify `no_replay` contract and resource availability after reconnect

This suite also validates heartbeat latency (average under 500ms, max under 1000ms) and concurrent order handling.

### transport-smoke.mjs — HTTP/SSE Connection Lifecycle

Validates the Streamable HTTP transport. Starts the server with `--http <port>`, then exercises the wire protocol directly with raw `fetch` and SSE parsing (not the MCP SDK client):

- Initialize handshake returns `Mcp-Session-Id` header
- `apex_version` present in `serverInfo`
- Authentication over HTTP POST
- Capabilities report `streamable_http` transport mode and `session_replay` reconnect mode
- Retention capabilities (`max_retention_events`, `max_retention_seconds`) are present and valid
- `apex.session.acknowledge` is listed in tools
- SSE stream delivers `notifications/resources/updated` for subscribed resources
- SSE stream delivers APEX notifications (`notifications/apex.order.filled`, `notifications/apex.risk.kill_switch_engaged`) with correct envelope structure
- Negative tests: bogus session ID returns HTTP 404, missing session header returns HTTP 400

### transport-resilience.mjs — Replay and Gap Fill

The most complex transport suite. Validates the full replay lifecycle over HTTP/SSE:

- SSE reconnect with `Last-Event-ID` header replays missed events
- Replayed event IDs are monotonically increasing
- Execution events (fills, rejections, kill switch) are faithfully replayed
- Ephemeral events (resource updates, candle closes) are collapsed into `notifications/apex.session.gap_fill` markers
- `apex.session.acknowledge` advances the retention cursor and evicts acknowledged events
- Replay buffer exhaustion triggers `notifications/apex.session.replay_failed` with reason `"event_id_outside_log"`
- Post-failure recovery: after replay failure, the server continues operating normally

This suite validates the acknowledgment-driven replay model described in `replay-design.md`.

### transport-marketdata.mjs — Live Streaming Validation

Validates live market data delivery over SSE:

- Quote resource updates are pushed over the SSE stream and values change between ticks (not static)
- Deterministic candle close via `reference.test.force_candle_close` triggers `notifications/apex.market.candle_closed` with correct payload structure
- Features resource updates are delivered

---

## Transport Modes

The harness runs over two transports, and both exist for concrete reasons.

**MCP stdio** (smoke, dry-run, production-smoke, production-resilience): The harness spawns the server as a child process and communicates over stdin/stdout using the MCP SDK's `StdioClientTransport`. No network stack, no ports, no TLS. This is the fast path — a smoke run completes in seconds, and you can run all four reference implementations in parallel without port conflicts. Stdio mode uses the `no_replay` reconnect contract: on disconnect, the agent rebuilds state from scratch by re-reading all resources.

**HTTP/SSE** (transport-smoke, transport-resilience, transport-marketdata): The harness spawns the server with `--http <port>` (port 0 for random assignment, read from stderr), then communicates using raw `fetch` and a custom SSE parser. This exercises the real transport: HTTP POST for tool calls, SSE GET for notification streams, `Mcp-Session-Id` for session affinity, `Last-Event-ID` for replay. HTTP mode uses the `session_replay` reconnect contract with acknowledgment-driven retention and gap fill.

Both transports test the same protocol semantics. The difference is what they prove: stdio proves the implementation logic is correct; HTTP/SSE proves it works over a real network transport with real reconnection, real session management, and real event delivery.

This is similar to how the FIX Trading Community's certification program tests both the application-layer message semantics and the transport-layer session management (logon, heartbeat, sequence reset) independently.

---

## Fault Injection

You cannot test reconnect behavior without disconnecting. You cannot test stale-data rejection without stale data. You cannot test sequence-gap handling without a sequence gap.

The reference implementations expose a `reference.test.set_realtime_state` tool that allows the conformance harness to inject faults into the running server. This tool is not part of the APEX protocol — it is a test-only capability exposed by reference implementations to make conformance testing possible.

The fault injection tool accepts these parameters:

| Parameter | Effect |
|---|---|
| `quote_stale: true` | Marks the current quote state as stale; order placement must return `APEX_4024` |
| `risk_stale: true` | Marks the current risk state as stale; order placement must return `APEX_4024` |
| `kill_switch_active: true` | Engages the kill switch; order placement must return `APEX_4023`, and the kill switch must surface in the risk resource and decision context |
| `force_sequence_gap: true` | Injects a gap in the resource sequence numbers; next resource read shows a non-contiguous sequence, and order placement must return `APEX_4025` |
| `partial_fill_next_order: true` | The next market order is partially filled (half quantity) instead of fully filled |

The harness calls `reference.test.set_realtime_state`, performs the action under test, asserts the expected behavior, then resets the fault state. This pattern is borrowed from chaos engineering practices and from TLS conformance testing where the test harness deliberately sends malformed records to verify rejection behavior.

Third-party implementations are not required to expose `reference.test.set_realtime_state`. If the tool is absent, the resilience suite skips the fault-injection checks and reports which checks were skipped. The alpha baseline (smoke + dry-run) does not depend on fault injection.

For the transport suites, fault injection works differently: the harness controls disconnection by closing the SSE stream and reconnecting with `Last-Event-ID`, and it controls replay buffer exhaustion by acknowledging events to advance the retention cursor until the requested replay point is evicted.

---

## Schema Validation

The harness validates payloads against the 12 normative JSON Schemas in `spec/core/schemas/`:

| Schema | Validates |
|---|---|
| `quote.resource.schema.json` | Quote resource: `bid`, `ask`, `spread`, `timestamp`, `sequence` |
| `candle.resource.schema.json` | Candle resource: OHLCV bars, `timeframe`, `instrument_id` |
| `feature.resource.schema.json` | Feature resource: computed indicators, `instrument_id` |
| `decision-context.resource.schema.json` | Decision context: market/account/risk state aggregation |
| `account-summary.resource.schema.json` | Account summary: balance, equity, margin, currency codes |
| `positions.resource.schema.json` | Positions: array of position objects with side, quantity, prices |
| `orders.resource.schema.json` | Orders: array of order objects with lifecycle state |
| `fills.resource.schema.json` | Fills: array of fill objects with price, quantity, commission |
| `risk.resource.schema.json` | Risk: limits, margin levels, kill switch state |
| `order-event.schema.json` | Order lifecycle event: status transitions, fill quantities |
| `fill-event.schema.json` | Fill event: individual fill details, commission, liquidity flag |
| `notification-envelope.schema.json` | APEX notification wrapper: method, params structure |

The harness uses Ajv (JSON Schema draft 2020-12) with `allErrors: true` for comprehensive error reporting. When a payload fails validation, the harness reports every violation, not just the first one.

**Missing required fields always fail.** If a schema requires `sequence` and the payload omits it, the test fails. No exceptions.

**Extra fields depend on schema policy.** The normative schemas generally do not set `additionalProperties: false`, which means implementations may include extra fields beyond the spec. This is intentional — it allows brokers to surface implementation-specific data without failing conformance. The harness validates that required fields are present and correctly typed; it does not reject unknown fields unless the schema explicitly forbids them.

This follows the same principle as OpenAPI validation tools: the schema is a contract for what MUST be present, not a restriction on what CAN be present. The Robustness Principle (Postel's Law) applies: be conservative in what you produce, liberal in what you accept.

---

## The Parity Matrix

The parity matrix (`conformance/parity-matrix.md`) tracks which reference implementations pass which test suites across four dimensions:

1. **Capability Matrix** — 25 tools plus resource operations, verified per implementation
2. **Realtime Resource Matrix** — 11 resource types, schema-validated per implementation
3. **Resilience And Trading-State Matrix** — 13 behaviors (reconnect, stale rejection, kill switch, sequence gaps, partial fills, concurrent orders, heartbeat SLA)
4. **Transport Capability Matrix** — 18 capabilities (HTTP/SSE lifecycle, replay, gap fill, acknowledgment, notifications)

All four reference implementations (TypeScript, Go, Rust, Java) currently pass all executable suites: `verify:alpha`, `verify:production`, `verify:transport`, and `verify:all`.

Why parity matters: if all four implementations agree on a behavior, the spec is unambiguous for that behavior. If they disagree, the spec needs tightening. The parity matrix is the empirical evidence for spec clarity. When a new test case is added and one implementation fails, either the implementation has a bug or the spec was ambiguous — and the resolution of that disagreement improves both.

This is the same function served by the W3C Web Platform Tests across browser engines (Blink, Gecko, WebKit): the test suite is simultaneously a conformance gate for implementers and a clarity check for spec authors. The NIST SQL test suite served the same purpose for SQL implementations — divergent results across vendors exposed ambiguities in the SQL standard that subsequent revisions resolved.

---

## The Production Checklist

The executable harness validates the alpha tool baseline and a substantial portion of the production surface. But there is a gap between what the harness currently tests and what a production deployment requires.

The production checklist (`conformance/production-checklist.md`) defines seven sections of requirements:

| Section | Domain | Currently Executable |
|---|---|---|
| 1. Realtime Transport | SSE, replay, acknowledgment, gap fill | Yes — `transport-resilience.mjs` |
| 2. Resource Availability | Quote, candles, features, account, risk, decision context | Yes — `production-smoke.mjs` |
| 3. Resource Schema Compliance | All 11 resource schemas validated against normative JSON Schemas | Yes — `production-smoke.mjs` |
| 4. Freshness And Sequencing | Timestamps, monotonic sequences, `stale_after_ms`, gap detection | Partially — sequence gap injection and stale rejection tested, wall-clock staleness not yet |
| 5. Notification Behavior | Resource updates, fills, rejections, candle close, kill switch, gap fill | Yes — `transport-smoke.mjs`, `transport-marketdata.mjs` |
| 6. Autonomous Controls | Kill switch, restricted instruments, max position size, daily loss stop | Partially — kill switch tested, other autonomous controls not yet |
| 7. Runtime Decision Safety | Stale halt, sequence halt, fill-order correlation | Partially — stale/sequence rejection tested, runtime halt behavior not yet |

Two capability claims are defined:

- **APEX Production Realtime** — sections 1-5 must pass
- **APEX Production Autonomous** — sections 1-7 must pass

The path from alpha conformance to production conformance is incremental. The executable harness already covers sections 1-3 and most of section 5. The remaining gaps (wall-clock staleness detection, candle close timing precision, autonomous control enforcement beyond kill switch) are defined in the checklist and planned for future harness releases.

This staged approach follows the Kubernetes conformance program model, where conformance tests are added incrementally as the API surface stabilizes, and the conformance level required for certification increases with each release.

---

## How The Harness Works

The harness is a single npm package (`conformance/package.json`) with three dependencies: the MCP SDK (for stdio transport), Ajv (for JSON Schema validation), and ajv-formats (for format validation like date-time and URI). It runs on Node.js 18+.

**Target resolution:** The harness accepts a target in three forms: a built-in name (`typescript`, `go`, `rust`, `java`), a `--command`/`--args`/`--cwd` triplet, or a `--config` JSON file. All three resolve to the same internal config: a command, arguments, and working directory.

**For stdio suites:** The harness spawns the server as a child process using `StdioClientTransport`, connects with the MCP SDK client, runs assertions, and tears down the connection. Server stderr is captured and dumped on failure (or streamed live with `--verbose`).

**For HTTP suites:** The harness spawns the server with `--http <port>`, waits for the "listening" line on stderr, then communicates using raw `fetch` for POST requests and a custom SSE parser for GET streams. The harness manages session IDs, event IDs, and reconnection manually — no SDK abstraction. This is intentional: the transport tests validate the wire protocol, not the SDK's interpretation of it.

**Test options:** Implementations can override default test inputs (auth token, instrument ID, currency, expected base currency, expected broker quantity unit) via CLI flags or the `test_options` block in the config JSON. This allows third-party brokers to run the harness against their real instrument universe without modifying the test scripts.

**Execution model:** Each script is a standalone Node.js module that imports shared utilities from `common.mjs`. Scripts run sequentially within a suite and output checkmarks as they pass. The `verify:*` npm scripts chain suites across all four implementations. `verify:all` runs everything: alpha + production + transport, four implementations each.

---

## Parallels

| System | What It Proves | APEX Equivalent |
|---|---|---|
| W3C Web Platform Tests | Browser engines implement web standards identically | Parity matrix: four implementations agree on every tested behavior |
| Java TCK (Technology Compatibility Kit) | A JVM implementation is compatible with the Java specification | Conformance harness: pass the tests to claim APEX compatibility |
| OpenAPI Validator | API responses match the declared schema | Schema validation: Ajv against 12 normative JSON Schemas |
| tlsfuzzer (TLS conformance) | TLS implementations handle malformed and edge-case inputs correctly | Fault injection: stale data, sequence gaps, kill switch, partial fills |
| FIX Trading Community Certification | FIX engine handles session management, sequence reset, and message types correctly | Transport suites: HTTP/SSE lifecycle, replay, gap fill, acknowledgment |
| Kubernetes Conformance Tests | A Kubernetes distribution implements the core API correctly | Test tiers: REQUIRED/RECOMMENDED/OPTIONAL mirrors Kubernetes conformance levels |
| NIST SQL Test Suite | SQL implementations handle the SQL standard correctly | Parity matrix: divergent results expose spec ambiguities |

The common thread: executable conformance testing is how standards move from specification to interoperability. A spec without a test suite is a suggestion. A spec with a test suite that multiple independent implementations pass is a standard.

---

## Cross-References

- **Protocol overview:** [`protocol-overview-design.md`](./protocol-overview-design.md) — the tool surface, resource model, and profile layering that conformance tests validate
- **Version stability:** [`version-stability-design.md`](./version-stability-design.md) — the versioning contract that determines when conformance tests must be updated
- **Schema design:** [`schema-design.md`](./schema-design.md) — the 12 normative schemas the harness validates against
- **Transport design:** [`transport-design.md`](./transport-design.md) — the HTTP/SSE transport the transport suites exercise
- **Replay design:** [`replay-design.md`](./replay-design.md) — the acknowledgment-driven replay model that `transport-resilience.mjs` validates
