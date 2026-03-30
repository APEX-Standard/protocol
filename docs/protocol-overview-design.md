# APEX Protocol — Protocol Overview and Architecture

**Version:** `0.1.0-alpha`

---

## Overview

APEX Protocol is an open standard for agent-native trading. It lets AI agents connect to any broker through a unified interface built on MCP (Model Context Protocol). One protocol, any broker, any asset class.

An agent built against APEX can authenticate with a spot FX broker, read a live quote, place an order, monitor a position, and close it — using the same tool names, the same instrument identifiers, the same order schema, the same risk checks — as it would with a crypto exchange, a CFD platform, or a futures dealer. The broker implements the APEX surface. The agent speaks APEX. The integration is done.

This document is the entry point to the APEX design library. It covers what APEX is, why it exists, how it is structured, and where to find the detailed specifications for every part of the system.

---

## The Problem APEX Solves

Today, every broker has a proprietary API. Different authentication flows. Different order formats. Different market data shapes. Different symbol naming conventions. Different error codes. Different position models. Different quantity units.

An agent that successfully trades EUR/USD through Broker A needs a completely different integration for Broker B — different endpoint URLs, different request bodies, different response parsing, different error handling, different reconnection logic. The trading logic may be the same, but the plumbing is entirely different.

Multiply this across 20 brokers and 5 asset classes. Each combination is a bespoke integration. The cost is not just engineering time — it is ongoing maintenance as each broker independently evolves its API, deprecates endpoints, changes authentication, or restructures its market data feeds.

This is the same problem the web faced before HTTP. Every network service had its own protocol. FTP for files. Gopher for menus. Proprietary protocols for everything else. HTTP did not replace what those services did — it standardized how clients talked to them.

APEX is the HTTP of trading. It is a universal interoperability layer between AI agents and financial brokers. It standardizes the vocabulary (tool names), the nouns (instrument identifiers, order schemas, position models), the transport expectations (MCP over HTTP with SSE), and the operational semantics (freshness, sequencing, replay, safety). Brokers implement the standard. Agents consume it. The bespoke integration disappears.

---

## Why Agent-Native

APEX is not a human trading API adapted for agents. It is designed from the ground up for how language model agents actually work.

Human trading platforms are built around visual dashboards, manual order tickets, and chart-based analysis. Their APIs tend to mirror this: poll for a quote, submit an order form, poll again for the result. The human is the event loop. The API is a remote control for the GUI.

Agents do not work this way. An agent reasons over structured context in a single pass, proposes an action, and expects deterministic validation before that action reaches the market. It cannot stare at a price chart. It cannot compute a rolling volatility estimate inside a context window. It cannot be trusted to remember that the kill switch is active three tool calls later.

APEX adopts the following design principles for agent-native trading:

**Tools for actions and explicit queries, not for polling.** `apex.order.place` submits an order. `apex.market.details` retrieves a contract specification. `apex.risk.check` runs a pre-trade margin check. These are imperative operations the agent invokes when it needs to do something or explicitly ask something. They are not the primary interface for tracking continuously changing state.

**Resources for continuously changing state.** Live quotes, candle series, account balances, open positions, risk limits — these change constantly and independently of agent actions. APEX exposes them as MCP resources that the agent subscribes to. When the state changes, the server pushes a notification. The agent re-reads the resource. No polling loops. No wasted tool calls. The agent's runtime maintains a local state cache that is always current.

**Pre-computed features instead of raw tick streams.** An agent cannot compute realized volatility from a stream of raw ticks in a context window. It cannot maintain a rolling order book imbalance metric across conversation turns. APEX provides a feature resource (`apex://market/features/{instrument_id}`) that the server computes and publishes: returns over multiple horizons, realized volatility, regime classification, liquidity scores, expected slippage. The heavy computation happens in deterministic code on the server. The agent receives structured, decision-ready numbers.

**Structured decision context.** The decision context resource (`apex://agent/decision-context/{instrument_id}`) packages everything the model needs for one instrument into a single object: quote, features, candles, account summary, positions, orders, risk. One resource read, one coherent snapshot, one model inference. No prompt assembly cost. No stale-data mixing from multiple sequential reads.

**Deterministic safety enforced in code, not in the model.** The model proposes an action. The runtime — not the model — checks whether the quote is fresh, whether the account state is current, whether the kill switch is active, whether the position size exceeds the limit, whether the instrument is restricted. If any check fails, the runtime refuses the action before it reaches the broker. The model never needs to remember safety rules. Safety is structural.

---

## Built on MCP

APEX is a layer on top of MCP, not a replacement for it. MCP (Model Context Protocol) provides the foundation:

- JSON-RPC 2.0 as the message format
- Tools as the action interface
- Resources as the state interface
- Subscriptions for change notification
- Notifications for server-pushed events
- Transport: HTTP with SSE for remote sessions, stdio for local development

APEX adds what MCP intentionally does not define:

- A canonical trading tool vocabulary (`apex.session.*`, `apex.account.*`, `apex.order.*`, `apex.market.*`, `apex.risk.*`)
- Market, account, and risk resource schemas with freshness metadata
- Execution notifications with stable payloads (fills, rejections, kill switch events)
- Session management with version negotiation, capability discovery, and heartbeat
- Acknowledgment-driven replay with gap fill for reconnection
- Freshness gating and sequence continuity for autonomous execution
- A safety model that separates model intent from runtime enforcement
- An instrument identity system that canonicalizes symbols across brokers
- Asset-class profiles that extend the baseline for FX, CFD, crypto, and future asset classes

The relationship is analogous to HTTP and REST. HTTP defines how messages travel. REST defines how to structure an API over HTTP. MCP defines how agents communicate with servers. APEX defines how to structure a trading system over MCP.

---

## The Layered Architecture

APEX is organized in layers. Each layer builds on the one below it. An implementation can be useful at any layer, but deeper layers enable richer agent-native workflows.

### Layer 1: Core

The mandatory baseline. Asset-class agnostic. Any APEX implementation must support this.

Layer 1 defines five capability domains (Session, Account, Orders, Market Data, Risk), their tool interfaces, their resource schemas, and their notification types. An implementation that supports only Layer 1 is still a valid APEX participant — it can authenticate an agent, show account state, accept orders, deliver quotes, and check risk. It just does not know anything about FX rollovers or crypto funding rates.

Layer 1 is tool-complete for basic interoperability. For production use, it also defines the realtime state model: resources, subscriptions, notifications, freshness, sequencing, and replay.

### Layer 2: Profiles

Asset-class extensions that add domain-specific tools, position enrichments, and instrument conventions on top of Layer 1.

| Profile | Scope | Status |
|---------|-------|--------|
| FX | Spot FX, CFD FX, rollovers, currency exposure, swap rates | `v0.1-alpha` |
| CFD | Equities, indices, commodities, corporate actions, dividend adjustments | `v0.1-alpha` |
| Crypto | Spot, perpetuals, funding rates, margin modes, liquidation estimates | `v0.1-alpha` |
| Derivatives | Listed options, futures, greeks | Planned |
| Fixed Income | Bonds, yield, duration | Planned |

A broker activates the profiles that match its asset classes. An FX broker implements Core + FX. A multi-asset broker implements Core + FX + CFD + Crypto. The agent discovers active profiles during session initialization and adapts accordingly.

Profile-specific data rides in the `profile_data` extension field that appears on positions, orders, and instrument details. The base schema stays stable. The profile adds what it needs without breaking cross-asset-class code.

### Instrument Registry

Canonical instrument identity across all brokers. Every instrument gets a stable identifier in the format:

```
APEX:{ASSET_CLASS}:{SUB_CLASS?}:{SYMBOL}
```

Examples: `APEX:FX:EURUSD`, `APEX:CFD:IDX:SPX500`, `APEX:CRYPTO:SPOT:BTCUSDT`.

The registry eliminates the symbol naming problem. Broker A calls it "EURUSD". Broker B calls it "EUR/USD". Broker C calls it "EUR_USD". The APEX identifier is always `APEX:FX:EURUSD`. Brokers map their native symbols to canonical identifiers. Agents never need to know the broker-specific name.

### Conformance

An executable test harness that validates implementations against the specification. Run the conformance suite against your server. If it passes, agents can connect.

The conformance suite currently validates the tool baseline (all 19 core tools). Future versions will validate resource availability, subscription behavior, notification schemas, freshness metadata, and autonomous safety controls.

---

## The Five Capability Domains

Every APEX tool belongs to one of five domains. The domain determines the tool's namespace prefix and its role in the protocol.

| Domain | Prefix | Purpose |
|--------|--------|---------|
| Session | `apex.session.*` | Authentication, capability discovery, heartbeat, acknowledgment |
| Account | `apex.account.*` | Balances, positions, orders, trade history |
| Orders | `apex.order.*` | Order entry, modification, cancellation, status, position close |
| Market Data | `apex.market.*` | Quotes, candles, instrument discovery, snapshots, search |
| Risk | `apex.risk.*` | Pre-trade checks, account limits, kill switch state |

**Session** is the control plane. The agent authenticates, discovers what the broker supports (tools, profiles, rate limits, order types, realtime contract), maintains a heartbeat, negotiates the protocol version, and acknowledges event delivery for replay retention. Session tools are the first thing called and the last thing to matter when something goes wrong.

**Account** is the read model for the agent's financial state. Balances, margin utilization, equity, open positions with live P&L, working orders and their lifecycle state, and closed trade history. In the realtime model, account state is exposed as subscribable resources that update when anything changes — a fill, a margin recalculation, a position open or close.

**Orders** is the write path. Place, modify, cancel, query status, close positions. Every order carries a canonical instrument identifier, a canonical quantity unit, and a client-generated idempotency key. The broker rejects duplicate submissions. The agent retries safely on transport failure.

**Market Data** is the read model for the market. Current quotes, OHLCV candle history, instrument search, full contract specifications. In the realtime model, quotes and candles are subscribable resources. The feature resource adds pre-computed derived state: returns, volatility, regime, liquidity, expected slippage.

**Risk** is the guardrail domain. Pre-trade margin checks, account-level risk limits (max position size, max open orders, daily loss limits, restricted instruments), and kill switch state. The risk domain provides the data that the safety model uses to accept or refuse autonomous actions.

---

## Production Capability Profiles

Not every APEX implementation needs the same depth. A tools-only integration for a demo is different from a production system running autonomous trading. APEX defines two production capability profiles that answer a practical question: what exactly must a broker and runtime implement for production trading to be viable?

### Production Realtime

The baseline for any production deployment. An implementation claiming `APEX Production Realtime` must provide:

| Requirement | What It Means |
|-------------|---------------|
| HTTP + SSE transport | Remote MCP over Streamable HTTP with SSE notification delivery |
| All 19 core tools | The complete Layer 1 tool vocabulary |
| All realtime resources | Quote, candles (M1, M5, H1), features, account summary, positions, orders, fills, risk |
| Freshness metadata | Every execution-relevant resource carries `timestamp`/`as_of`, `sequence`, and `stale_after_ms` |
| Mandatory notifications | Resource updates, order fills, partial fills, rejections, candle closes, kill switch, gap fill, replay failed |
| Sequencing | Monotonic sequences per resource stream, gap detection support |
| Replay with gap fill | Acknowledgment-driven event log, `Last-Event-ID` reconnect, replay classification, gap fill markers |
| Feature minimums | Quote state, short-horizon returns, realized volatility, regime, liquidity, expected slippage |

Production Realtime means the agent has a live, reliable, reconnectable view of market and account state. It can trade in real time with confidence that it will not miss a fill during a network blip.

### Production Autonomous

Everything in Production Realtime, plus the controls required for unsupervised agent execution:

| Requirement | What It Means |
|-------------|---------------|
| Decision context resource | `apex://agent/decision-context/{instrument_id}` with market, account, and risk references |
| Autonomous controls | Kill switch, max position size, max open orders, daily loss status, restricted instruments, market-hours gating, stale-data rejection, sequence-gap rejection, rate-limit rejection |
| Runtime refusals | Autonomous order entry rejected when any execution input is stale, sequence-broken, kill-switched, restricted, or risk-exceeded |
| Execution event semantics | Stable fill payloads, partial/final fill distinction, duplicate detection via stable IDs and sequence |
| Operational documentation | Replay retention, freshness limits, supported controls, broker-specific hard stops |

Production Autonomous means the system is safe enough to let an agent trade without a human in the loop. The runtime enforces every safety check deterministically. The model never needs to reason about whether it is safe to act.

An implementation may claim `Production Realtime` without `Production Autonomous`. `Production Autonomous` implies `Production Realtime`.

---

## The Safety Model

APEX separates intent from enforcement. The model proposes. The runtime enforces.

This is the single most important architectural decision in the protocol. A language model cannot be trusted to consistently remember and apply safety rules across an unbounded sequence of trading decisions. It will forget. It will hallucinate a rationale for why the kill switch does not apply this time. It will misread a stale timestamp. It will not notice that the sequence counter skipped.

The APEX safety model moves all of these checks out of the model and into deterministic code:

**Freshness gating.** Every execution-relevant resource carries a staleness limit (`stale_after_ms`). The runtime checks the resource timestamp against wall clock time before allowing autonomous order entry. If the quote is stale, the order is refused. The model is never asked whether the quote looks fresh enough.

**Sequence continuity.** Every resource carries a monotonic sequence counter. If the runtime detects a gap — a sequence that skipped, a reconnect without successful replay — it invalidates the local cache and halts autonomous execution until the resource is re-read and continuity is restored.

**Kill switch.** A binary halt. When the kill switch is active, all autonomous order entry is refused. No exceptions. No model override. The kill switch state is exposed in the risk resource and as a dedicated notification (`apex.risk.kill_switch_engaged`).

**Halt conditions.** The runtime halts autonomous execution when: the quote is stale, the account or risk state is stale, sequence continuity is broken, the kill switch is active, the instrument is restricted or non-tradeable, or hard broker risk limits are exceeded. These checks happen in code before the model is consulted.

**Runtime modes.** APEX defines five operational modes: `observe` (read-only), `paper` (simulated execution), `assist` (human approval required), `autonomous_limited` (strict limits), `autonomous_full` (full authority subject to broker risk controls). The mode constrains what the agent can do regardless of what it wants to do.

For the full treatment, see [`autonomous-safety-design.md`](./autonomous-safety-design.md).

---

## The Spec Ecosystem

APEX is not a single document. It is a coordinated set of specifications, schemas, and design documents. Here is what lives where.

### Specification (`spec/`)

| Path | Contents |
|------|----------|
| [`spec/core/README.md`](../spec/core/README.md) | Layer 1 tool definitions, resource schemas, notification taxonomy, error codes, annotations |
| [`spec/core/production.md`](../spec/core/production.md) | Production Realtime and Production Autonomous capability profiles |
| [`spec/core/execution-semantics.md`](../spec/core/execution-semantics.md) | Order lifecycle, fill behavior, cancel semantics, idempotency |
| [`spec/core/operations.md`](../spec/core/operations.md) | Freshness, sequencing, replay modes, session health |
| [`spec/core/stability.md`](../spec/core/stability.md) | Surface classes, compatibility rules, deprecation policy, alpha-to-1.0 exit criteria |
| [`spec/core/schemas/`](../spec/core/schemas/) | Normative JSON schemas for all realtime resources and event payloads |
| [`spec/profiles/fx.md`](../spec/profiles/fx.md) | FX profile: spot, CFD FX, rollovers, swap rates, currency exposure |
| [`spec/profiles/cfd.md`](../spec/profiles/cfd.md) | CFD profile: equities, indices, commodities, corporate actions |
| [`spec/profiles/crypto.md`](../spec/profiles/crypto.md) | Crypto profile: spot, perpetuals, funding rates, margin modes |
| [`spec/registry/`](../spec/registry/) | Instrument identity format, canonical symbol taxonomy |

### Design Library (`docs/`)

**Core Design:**

| Document | Contents |
|----------|----------|
| [Protocol Overview](protocol-overview-design.md) | This document — the start-here entry point |
| [Session Lifecycle](session-design.md) | Session lifecycle, auth, capabilities, heartbeat, health states |
| [Market Data Architecture](market-data-design.md) | Quotes, candles, subscriptions, market status, instrument discovery |
| [Account & Position Model](account-model-design.md) | Balance/equity/margin, netting vs hedging, position lifecycle, fills |

**Protocol Mechanisms:**

| Document | Contents |
|----------|----------|
| [Replay Design](replay-design.md) | Acknowledgment-driven replay, gap fill, FIX parallels |
| [Freshness & Staleness](freshness-design.md) | Staleness detection, freshness gating, stale_after_ms semantics |
| [Sequence & Gap Detection](sequence-design.md) | Monotonic sequences, gap detection, continuity restoration |
| [Order Lifecycle & Idempotency](order-lifecycle-design.md) | Order states, transitions, idempotency, partial fill handling |
| [Quantity Normalization](quantity-design.md) | Canonical quantity model, base_units vs lots, unit normalization |
| [Feature Resource](feature-resource-design.md) | Feature resource computation, regime detection, derived state |
| [Autonomous Safety](autonomous-safety-design.md) | Safety model deep dive, halt conditions, runtime modes |
| [Instrument Identity & Registry](instrument-identity-design.md) | Canonical instrument ID format, broker symbol mapping |
| [Transport Architecture](transport-design.md) | HTTP/SSE transport, Streamable HTTP, rate limiting |
| [Resource vs Tool Split](resource-tool-design.md) | CQRS split — tools for actions, resources for state |
| [Profile & Layering](profile-layering-design.md) | Layer 1 Core + Layer 2 profiles, vendor extensions |
| [Error Taxonomy](error-taxonomy-design.md) | APEX_XXXX codes, seven categories, recovery logic |
| [Version & Stability](version-stability-design.md) | Stability classes, schema evolution, deprecation |

**Notification & Subscription Model:**

| Document | Contents |
|----------|----------|
| [Notification Architecture](notification-architecture-design.md) | 7 mandatory types, envelope, replay classification, delivery guarantees |
| [Subscription Model](subscription-model-design.md) | Subscribe/notify/re-read, coalescing, level-triggered invalidation |
| [Decision Context](decision-context-design.md) | Composition-by-reference, freshness inheritance, agent namespace |

**Schema & Conformance:**

| Document | Contents |
|----------|----------|
| [Schema Design](schema-design.md) | 12 normative schemas, additionalProperties policy, evolution |
| [Conformance Testing](conformance-design.md) | Testing philosophy, tiers, fault injection, parity matrix |

**Multi-Broker & Operations:**

| Document | Contents |
|----------|----------|
| [Multi-Broker Patterns](multi-broker-design.md) | Independent sessions, cross-broker risk aggregation |
| [Audit Trail](audit-trail-design.md) | Per-decision records, correlation, retention |

**Implementation Guides:**

| Document | Contents |
|----------|----------|
| [Agent Quickstart](agent-quickstart.md) | Getting started guide for agent developers |
| [Agent Runtime Safety Guide](agent-runtime-safety-guide.md) | Practical guide for agent/runtime implementers |
| [Broker Implementation Guide](broker-implementation-guide.md) | Practical guide for broker teams and gateway implementers |
| [Reference Flows](reference-flows.md) | End-to-end worked examples |

### Implementation

| Path | Contents |
|------|----------|
| [`reference-implementation/typescript/`](../reference-implementation/typescript/) | Node.js reference server |
| [`reference-implementation/rust/`](../reference-implementation/rust/) | Rust reference server |
| [`reference-implementation/go/`](../reference-implementation/go/) | Go reference server |
| [`reference-implementation/java/`](../reference-implementation/java/) | Java reference server |
| [`conformance/`](../conformance/) | Executable conformance test harness |

---

## Parallels

APEX is not the first attempt to standardize financial messaging. It is informed by decades of prior work and consciously borrows ideas from established systems.

**FIX Protocol.** The Financial Information eXchange protocol has been the standard for institutional trading since the 1990s. FIX defined session management, message sequencing, replay, and execution reports — concepts that APEX carries forward directly. APEX's acknowledgment-driven replay is modeled on FIX's message store and sequence reset mechanisms. The gap fill classification (replay execution events, elide administrative messages) is a direct parallel. Where FIX is session-oriented, tag-value encoded, and designed for point-to-point TCP connections between institutions, APEX is HTTP-native, JSON-based, and designed for agent-to-broker communication over the open internet.

**OpenAPI / Swagger.** OpenAPI standardized how REST APIs describe themselves — endpoints, schemas, request/response formats. APEX does something similar for trading: it standardizes the tool vocabulary, the schema shapes, and the capability discovery mechanism. But APEX is not just an API description format. It defines behavioral semantics (order lifecycle, replay, freshness) that OpenAPI intentionally leaves to the implementer.

**MCP.** The Model Context Protocol is the foundation APEX builds on. MCP standardized how AI agents communicate with external systems — tools for actions, resources for state, subscriptions for change. APEX is the first domain-specific protocol layer built on MCP for a regulated, real-time, high-stakes vertical. The relationship is like HTTP to the web: MCP provides the transport and interaction model, APEX provides the domain semantics.

**SWIFT.** The Society for Worldwide Interbank Financial Telecommunication standardized financial messaging between banks — payment instructions, securities transactions, trade confirmations. SWIFT solved the same interoperability problem APEX addresses, but for interbank communication rather than agent-to-broker communication. SWIFT's message types (MT and MX) are the conceptual ancestor of APEX's notification taxonomy.

**OMS/EMS.** Order Management Systems and Execution Management Systems are the institutional software that manages the order lifecycle — routing, execution, allocation, compliance. These systems solve many of the same problems APEX addresses (order lifecycle tracking, position management, risk checks), but as proprietary software rather than an open protocol. APEX externalizes these capabilities as a standardized protocol surface that any agent can consume.

---

## Stability

APEX is currently at version `0.1.0-alpha`. The protocol surface is organized into four stability classes:

| Class | Description |
|-------|-------------|
| Alpha Core | Expected to remain recognizable through alpha. Layer 1 tool namespaces, resource URI families, normative schemas, profile names. |
| Alpha Optional | Valid but not required. Vendor extension tools, vendor resources, broker-specific notifications, profile-specific `profile_data` fields. |
| Alpha Experimental | May change materially. Surfaces explicitly marked experimental, vendor-namespace-only capabilities. |
| Reserved | Must not be repurposed by implementations. `apex.*`, `apex://*`, `notifications/apex.*`. |

Before APEX claims `1.0.0`, the following must be true: core surfaces are frozen, normative schemas are complete for execution-critical payloads, conformance validates the frozen core set, migration guidance exists for deprecated alpha surfaces, and production profiles are executable rather than documentary.

For the full compatibility rules, deprecation policy, and exit criteria, see [`stability.md`](../spec/core/stability.md). For the design rationale, see [Version & Stability Design](version-stability-design.md).
