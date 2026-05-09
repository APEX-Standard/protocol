# APEX Protocol — Documentation Index

**Version:** `0.1.0-alpha`

---

## How To Use This Library

Start with the **Protocol Overview** to understand what APEX is and how it's structured. Then follow the links for whichever aspect you're working on. The design documents explain the *why* behind each protocol mechanism — concrete scenarios, normative tables, and parallels to established systems like FIX, Kafka, and HTTP.

If you're an **agent developer**, start with the quickstart, then read the safety guide and the design docs for the mechanisms you rely on (freshness, sequences, subscriptions, notifications).

If you're a **broker implementer**, start with the broker guide, then read the design docs for the subsystems you need to build (transport, replay, resources, schemas, conformance).

---

## Design Library

### Core Design

| Document | Description |
|----------|-------------|
| [Protocol Overview](protocol-overview-design.md) | **Start here.** What APEX is, why it exists, the layered architecture (Layer 1 Core + Layer 2 Profiles), the five capability domains, production profiles, and the safety model. The entry point to the entire design library. |
| [Session Lifecycle](session-design.md) | Session lifecycle from initialize through teardown. Version negotiation via `apex_version`, authentication binding to MCP sessions, capability discovery, heartbeat, session health states (ok/degraded/paused/halted), and the bootstrap flow. |
| [Market Data Architecture](market-data-design.md) | The three tiers of market state: quotes (execution surface), candles (historical bars with partial/complete distinction), and features (derived analytics). Subscription flow, market status and tradeability, instrument discovery, and replay classification of market data. |
| [Account & Position Model](account-model-design.md) | Balance/equity/margin model, netting vs hedging position semantics, position lifecycle (open/modify/close), the fills resource, account history, profile-specific enrichment (FX rollover, CFD financing, crypto liquidation), and position close semantics. |

### Protocol Mechanisms

| Document | Description |
|----------|-------------|
| [Replay Design](replay-design.md) | Acknowledgment-driven replay with gap fill, inspired by FIX. How the agent controls event retention, how the server classifies events during replay (`required` vs `elide`), and how gap fill markers collapse ephemeral state updates. |
| [Freshness & Staleness](freshness-design.md) | How APEX decides when data is too old to trade on. Three freshness classes (Market Fast, Market Slow, Account/Risk), the staleness equation (`current_time > reference_timestamp + stale_after_ms`), the `as_of` vs `timestamp` distinction, and deterministic halt-on-stale. |
| [Sequence & Gap Detection](sequence-design.md) | Per-resource monotonic sequences as the data integrity backbone. Why sequences are scoped per URI (not global), how gaps are detected, coalescing behavior, the difference between resource sequences and SSE event IDs, and client obligations. |
| [Order Lifecycle & Idempotency](order-lifecycle-design.md) | The order state machine (accepted → working → filled/cancelled/rejected/expired), `client_order_id` deduplication for safe retry, cancel and modify semantics, the partial fill race condition, rejection classes, and the fills resource architecture. |
| [Quantity Normalization](quantity-design.md) | Why APEX uses `base_units`/`shares`/`contracts` instead of broker "lots." The dual-track model (canonical quantity for execution, broker quantity for display), profile-specific conventions, the instrument registry as translation layer, and quantity validation. |
| [Feature Resource](feature-resource-design.md) | Pre-computed derived features delivered as structured state. Quote state, short-horizon returns, realized volatility, regime classification, liquidity scoring, and execution quality — all server-side. Why agents can't compute these in a context window. |
| [Autonomous Safety](autonomous-safety-design.md) | The layered defense model for autonomous trading. "The model proposes, the runtime enforces." Seven halt conditions, the kill switch, four defense layers (broker/protocol/runtime/human), runtime modes (observe → autonomous_full), pre-trade risk checks, partial fill races, market hours gating, and the audit trail. |
| [Instrument Identity & Registry](instrument-identity-design.md) | The symbol fragmentation problem and APEX's solution: canonical hierarchical IDs (`APEX:FX:EURUSD`, `APEX:CFD:EQ:AAPL.XNAS`, `APEX:CRYPTO:PERP:BTCUSDT`). MIC codes for equities, crypto conventions, the registry API, permanence guarantees, and broker symbol resolution. |
| [Transport Architecture](transport-design.md) | HTTP/SSE over MCP: POST for commands, GET for the SSE stream, DELETE for teardown — all on `/mcp`. Session identity via `Mcp-Session-Id`, why SSE over WebSocket, why not gRPC, Streamable HTTP vs legacy HTTP+SSE, rate limiting, and reconnect flow. |
| [Resource vs Tool Split](resource-tool-design.md) | The CQRS-inspired architectural split. Tools for actions and explicit queries, resources for continuously changing state, notifications for change signals. Why tool polling is catastrophic for agents (cost, latency, missed events), the prompt cost argument, and the concrete agent loop. |
| [Profile & Layering](profile-layering-design.md) | Layer 1 Core (asset-class agnostic) + Layer 2 Profiles (FX, CFD, Crypto). The `profile_data` extension mechanism, how profiles compose independently, profile-specific differences (rollover vs financing vs funding), capability advertisement, and vendor extensions. |
| [Error Taxonomy](error-taxonomy-design.md) | Structured error handling for autonomous recovery. The error envelope (code, category, message, details, request_id, retry_after), seven error categories with agent response logic, the APEX_XXXX code table, rejection class mapping, and MCP tool annotations for retry safety. |
| [Version & Stability](version-stability-design.md) | Version negotiation via `apex_version` in MCP initialize. Four stability classes (Alpha Core/Optional/Experimental/Reserved), compatibility rules for tools/resources/events, schema evolution rules, deprecation policy, and the 1.0.0 exit criteria. |

### Notification & Subscription Model

| Document | Description |
|----------|-------------|
| [Notification Architecture](notification-architecture-design.md) | The two notification families: MCP-standard resource invalidation and APEX-specific execution events. The notification envelope structure, all seven mandatory notification types with full payloads, replay classification as a unified policy, cross-resource ordering caveats, decision triggers, and delivery guarantees. |
| [Subscription Model](subscription-model-design.md) | The subscribe/notify/re-read pattern that replaces polling. Level-triggered invalidation (not edge-triggered), server-side coalescing of high-frequency updates, sequence behavior under coalescing, mandatory subscribable resources, subscription lifecycle, the bootstrap flow, and production anti-patterns. |
| [Decision Context](decision-context-design.md) | The `apex://agent/decision-context/{instrument_id}` resource — one read for everything the model needs. Composition by reference (not inline), why constraints are inlined, freshness inheritance across referenced sub-resources, the `apex://agent/` namespace, and the concrete agent decision loop. |

### Schema & Conformance

| Document | Description |
|----------|-------------|
| [Schema Design](schema-design.md) | The 12 normative JSON Schemas as wire format contracts. Tool output vs resource schema duality, the `additionalProperties` policy (sealed vs permissive), required vs optional field patterns, the notification envelope, event vs resource schemas, profile extension through `profile_data`, and schema evolution rules. |
| [Conformance Testing](conformance-design.md) | The conformance harness architecture. Testing philosophy (behavior, not just shape), three test tiers (REQUIRED/RECOMMENDED/OPTIONAL), seven test suites, remote HTTP/SSE execution, fault injection via `reference.test.*` tools, schema validation, the parity matrix, and the path from alpha to production conformance. |

### Multi-Broker & Operations

| Document | Description |
|----------|-------------|
| [Multi-Broker Patterns](multi-broker-design.md) | Architectural patterns for agents connecting to multiple brokers simultaneously. Independent sessions, canonical IDs as the unifying layer, divergent capabilities, cross-broker quote comparison, cross-broker risk aggregation, version incompatibilities, failure isolation, and the recommended four-layer architecture. |
| [Audit Trail](audit-trail-design.md) | The debug log for real money. What to record per decision (resource URIs, sequences, freshness, model intent, validation result, broker response), the audit record structure, refusal records, correlation across decision cycles, timing and latency tracking, retention requirements, and storage recommendations. |

---

## Implementation Guides

| Document | Description |
|----------|-------------|
| [Agent Developer Quickstart](agent-quickstart.md) | Get from zero to executing trades with an APEX broker in 30 minutes. Step-by-step guide covering broker discovery, authentication, market data, order placement, and multi-broker operation. |
| [Agent Runtime Safety Guide](agent-runtime-safety-guide.md) | Practical safety rules for agent/runtime implementers. Local state cache, freshness tracking, deterministic halt conditions, structured decision context, the "model proposes, runtime enforces" pattern, and recommended runtime modes. |
| [Broker Implementation Guide](broker-implementation-guide.md) | How to implement the APEX alpha contract as a broker. Layered architecture (adapters → canonical mapping → state engine → MCP exposure → safety layer), canonicalization, authoritative resources, and operational concerns. |
| [Reference Flows](reference-flows.md) | Step-by-step reference flows for common operations: realtime bootstrap, order placement, resting order updates, reconnect without replay, autonomous refusal, partial fill lifecycle, and SSE reconnect with replay. |
| [Alpha Roadmap](alpha-roadmap.md) | The alpha hardening roadmap for APEX Protocol development. |
