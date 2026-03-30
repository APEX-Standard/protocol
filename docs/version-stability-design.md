# APEX Protocol — Version Negotiation and Stability Model

**Version:** `0.1.0-alpha`

---

## Overview

APEX is alpha. But alpha does not mean "anything goes." Implementers are already building brokers, agents, and conformance tooling against the spec. The stability model exists to tell them three things: what is safe to build against today, what might change before `1.0.0`, and how changes will be communicated when they happen.

This is the contract between the protocol authors and the people writing code. Without it, every integration is a guess.

---

## The Problem

A broker builds an APEX integration against the `0.1.0-alpha` spec. They implement all 19 core tools, wire up the SSE notification stream, populate the realtime resources, and pass the conformance suite. Six months later, the protocol renames `apex.risk.check` to `apex.risk.evaluate`, drops the `features` resource in favor of a new `indicators` URI family, and changes the `fill_price` field from a string to a number.

Their integration breaks. Not loudly — silently. The agent calls `apex.risk.check` and gets tool-not-found. It reads `apex://market/features/{instrument_id}` and gets a 404. It parses `fill_price` expecting a string and gets a number, which the JSON deserializer handles differently depending on the language.

Without stability guarantees, implementers have two choices:

1. **Build against everything.** Brittle. Every spec change is a fire drill.
2. **Trust nothing.** Useless. You can't build a trading system on a protocol you won't commit to.

The stability model gives them a third option: build against the surfaces that are classified as core, treat optional surfaces as opt-in, ignore experimental surfaces unless you want to live on the edge, and never touch reserved namespaces. When a core surface changes incompatibly, the protocol version changes and migration guidance ships with it.

---

## Version Advertisement

Version negotiation happens exactly once per session, during the MCP `initialize` handshake. Here is the sequence:

**Step 1.** The agent connects to the broker over HTTP and sends the MCP `initialize` request. This is the standard MCP handshake — the agent declares its own capabilities and the server responds with `serverInfo`.

**Step 2.** The broker includes the APEX protocol version in the `serverInfo` metadata:

```json
{
  "serverInfo": {
    "name": "broker-name",
    "version": "1.0.0",
    "apex_version": "0.1.0-alpha"
  }
}
```

The `version` field is the broker's own software version. The `apex_version` field is the protocol version. They are independent. A broker at software version 3.7.2 might implement APEX `0.1.0-alpha`.

**Step 3.** The agent checks `apex_version` before calling any APEX tools. Three outcomes:

| Agent expectation | Server `apex_version` | Action |
|---|---|---|
| `0.1.0-alpha` | `0.1.0-alpha` | Proceed. Full compatibility expected. |
| `0.1.0-alpha` | `0.2.0-alpha` | Proceed with caution. Minor version bump means additive changes only. |
| `0.1.0-alpha` | `1.0.0` | Disconnect gracefully. Major version change may include incompatible changes. Re-read the migration guide. |

**Step 4.** If compatible, the agent calls `apex.session.authenticate` to establish the trading session, then `apex.session.capabilities` to discover the full capability manifest — tools, profiles, vendor extensions, rate limits, realtime contract, and production profile claims.

The key design choice: version checking happens at the transport layer (MCP initialize), not at the application layer (APEX tool calls). If the version is wrong, you find out before you call a single tool, not after you've placed an order and the response schema doesn't match what you expected.

---

## The Four Stability Classes

APEX defines four stability classes. Every protocol surface — every tool, resource, notification, schema, and namespace — falls into exactly one class.

### Alpha Core

These surfaces are expected to remain recognizable across the rest of alpha. Fields may tighten before `1.0.0`, but the names, shapes, and semantics should stay stable enough that code written against them today will not need a full rewrite.

Alpha Core includes:

- **Layer 1 tool namespaces** — `apex.session.*`, `apex.account.*`, `apex.order.*`, `apex.market.*`, `apex.risk.*`
- **Canonical realtime resource URI families** — `apex://market/quote/{instrument_id}`, `apex://account/positions/{account_id}`, and the rest of the production resource set
- **Normative schemas** — the JSON schemas in `schemas/` that define tool inputs/outputs, resource payloads, and event payloads
- **Production capability profile names** — `APEX Production Realtime` and `APEX Production Autonomous`

If you are building an APEX integration and want to know what to trust, start here. Alpha Core is the foundation.

### Alpha Optional

These surfaces are valid but not required for alpha interoperability. An implementation that omits them entirely is still a conformant APEX participant.

Alpha Optional includes:

- **Vendor extension tools** — tools under broker-specific namespaces like `fxcm.sentiment.index`
- **Vendor extension resources** — resources under broker-specific URI families
- **Broker-specific notifications** — notifications outside the `apex.*` namespace
- **Profile-specific `profile_data` fields** — additional fields under `profile_data` in tool responses, carrying broker-specific context that supplements but does not replace the base schema

You can build against these, but understand that their stability is the vendor's promise, not the protocol's.

### Alpha Experimental

These surfaces may change materially without a compatibility promise. They exist to let the protocol and its implementations explore new capabilities without committing to them prematurely.

Alpha Experimental includes:

- Any field or resource explicitly marked `experimental` in the spec
- Any capability advertised only under a vendor namespace (not under `apex.*`)
- Any pre-standard profile-specific transport behavior

Do not write production trading logic against experimental surfaces. They are for prototyping and feedback, not for execution paths that handle real money.

### Reserved

Reserved names and namespaces are owned by the protocol. Implementations must not repurpose them, even if the protocol has not yet defined behavior for them.

Reserved namespaces:

- `apex.*` — all tool names starting with `apex.`
- `apex://*` — all resource URIs starting with `apex://`
- `notifications/apex.*` — all notification methods starting with `notifications/apex.`

If a broker needs custom tools, resources, or notifications, they use their own namespace: `fxcm.*`, `fxcm://`, `notifications/fxcm.*`. Never `apex.fxcm.*`.

---

## The Core vs Optional Matrix

Not every surface has an obvious classification. This matrix makes it explicit.

| Surface | Alpha Core | Optional | Notes |
|---|---|---|---|
| Layer 1 tools (`apex.session.*`, `apex.account.*`, `apex.order.*`, `apex.market.*`, `apex.risk.*`) | Yes | No | Required baseline for all implementations |
| Quote/candle/feature/account/risk resources | Yes | No (for production-targeting) | Core realtime contract |
| Decision context resource (`apex://agent/decision-context/{instrument_id}`) | Core for autonomous | Optional otherwise | Stable resource family, required only for Production Autonomous |
| Vendor tools and resources | No | Yes | Must not redefine APEX semantics |
| Event notifications in APEX namespace (`notifications/apex.*`) | Yes (for production-targeting) | Optional for minimal tools-only brokers | Strongly recommended even when optional |
| Profile-specific `profile_data` fields | No | Yes | Must not break base schema |

The practical reading: if you are building a production trading integration, the "Yes" column is your minimum. If you are building a minimal alpha prototype to test tool interoperability, you can start with just the Layer 1 tools and add the resource/notification layer when you move toward production.

---

## Compatibility Rules

### Tool Compatibility

**Compatible changes** (can happen within a minor version):

- Adding optional fields to a tool's input or output
- Adding new tools in new namespaces
- Expanding enum values where the field already supports forward-compatible handling
- Adding new production profiles

**Incompatible changes** (require a version bump and migration note):

- Removing a documented core tool
- Renaming a documented tool
- Changing the meaning of an existing field
- Changing a required field to a different type

Concrete example: adding an optional `metadata` field to `apex.order.place` output is compatible. Renaming `apex.order.place` to `apex.order.submit` is incompatible. Changing `fill_price` from string to number is incompatible.

### Resource Compatibility

**Compatible changes:**

- Adding optional fields to a resource payload
- Adding new resource URI families

**Incompatible changes:**

- Tightening `additionalProperties` from permissive to strict (unless done under a versioned replacement schema)
- Changing URI family semantics (e.g., making `apex://market/quote/{instrument_id}` return candle data)

### Event Compatibility

**Compatible changes:**

- Adding optional fields to an event payload
- Adding new notification types

**Incompatible changes:**

- Changing required field names in an event payload
- Changing lifecycle semantics (e.g., making `apex.order.filled` fire before the fill is confirmed rather than after)

The general principle across all three categories: additive changes are compatible, subtractive or semantic changes are not. This follows the same rule as Protocol Buffers, gRPC service versioning, and every other system that has learned the hard way that removing a field breaks more things than adding one.

---

## Schema Evolution

Normative schemas in `schemas/` follow specific rules during alpha. These rules balance the need to evolve the protocol with the need to not break existing implementations.

**Rule 1: Required fields may only be added if the capability claim also tightens.** If you add a required `risk_score` field to the quote resource schema, you must also update the production profile requirement to reflect that `risk_score` is now mandatory. This ensures that an implementation cannot claim compliance without implementing the new field.

**Rule 2: Existing required fields keep meaning, type, and units.** If `fill_price` is a required string representing a decimal price, it stays a required string representing a decimal price. You do not change it to a number. You do not change its units from the instrument's quote currency to basis points. You do not change its meaning from "price at which the fill occurred" to "price at which the order was submitted."

**Rule 3: Optional fields may be added freely.** This is the primary mechanism for protocol evolution during alpha. New capabilities start as optional fields. If they prove their value, they may be promoted to required in a future version with appropriate migration guidance.

**Rule 4: Incompatible schema changes must use a new schema file and an explicit migration note.** You do not silently change `order-filled.schema.json`. You create `order-filled-v2.schema.json` and document what changed and why.

Changes carry one of three labels:

| Label | Meaning | Example |
|---|---|---|
| `additive` | New optional fields or new schemas. No existing code breaks. | Adding `metadata` to fill events |
| `behavior-tightening` | Existing field gets stricter validation. Compliant implementations already satisfy the tighter rule. | Requiring `timestamp` to be UTC (was previously unspecified timezone) |
| `incompatible` | Existing field changes type, meaning, or is removed. Existing code may break. | Renaming `fill_price` to `execution_price` |

---

## Deprecation Policy

Alpha does not guarantee long-lived deprecation windows. The protocol is still finding its shape. But "alpha" is not a license to break things without warning. The following rules apply:

**Rule 1: Deprecated before removed.** A core field or tool must be marked deprecated in the spec before it is removed. No surprise deletions.

**Rule 2: Replacement identified.** The deprecation notice must identify the replacement surface. "We're removing X" is not sufficient. "We're removing X because Y replaces it, and here's how to migrate" is the minimum.

**Rule 3: Conformance keeps accepting.** The conformance suite continues accepting the deprecated surface until a documented removal point. This gives implementers a concrete window to migrate.

Deprecation notice format:

```
Deprecated in: 0.1.x-alpha
Replacement:   apex://market/indicators/{instrument_id}
Removal target: 1.0.0 or later
```

The window between deprecation and removal will be short during alpha — potentially a single minor version. After `1.0.0`, the window will follow standard semver conventions (deprecated in minor, removed in major).

---

## The 1.0.0 Exit Criteria

What must be true before APEX claims `1.0.0`:

1. **Core surfaces are frozen.** The tools, resources, notifications, and schemas classified as Alpha Core are locked. No incompatible changes without a major version bump.

2. **Normative schemas are complete.** Every execution-critical payload — tool inputs, tool outputs, resource payloads, event payloads — has a normative JSON schema in `schemas/`. No undocumented fields in the critical path.

3. **Conformance validates the frozen core.** The conformance suite tests every surface in the Core column of the matrix. Passing conformance means you implement the protocol, not just a subset of it.

4. **Migration guidance exists.** For every surface that was deprecated or changed incompatibly during alpha, a migration document explains what changed and how to update. An implementer who built against `0.1.0-alpha` can follow the guide to reach `1.0.0` compliance.

5. **Production profiles are executable.** `APEX Production Realtime` and `APEX Production Autonomous` are testable claims, not documentary aspirations. The conformance suite validates them. A broker that claims Production Realtime has been tested for transport, tools, resources, notifications, replay, acknowledgment, and sequencing.

These criteria are deliberately concrete. "The spec is stable" is not an exit criterion. "Conformance validates the frozen core set" is.

---

## Capability Advertisement

Version negotiation tells the agent which protocol version the broker speaks. Capability advertisement tells the agent what the broker can do within that version. They are complementary.

The `apex.session.capabilities` response includes two relevant sections:

```json
{
  "production_profiles": {
    "realtime": true,
    "autonomous": false
  },
  "stability": {
    "core_version": "0.1.0-alpha",
    "experimental_namespaces": ["vendor.example.experimental"]
  }
}
```

**`production_profiles`** declares which production profiles the broker satisfies. `realtime: true` means the broker claims full `APEX Production Realtime` compliance — all 19 mandatory tools, all 10 mandatory resources, all 7 mandatory notification types, replay with gap fill, acknowledgment-driven retention, and sequencing. `autonomous: false` means the broker does not yet implement the decision context, autonomous controls, and runtime refusals required for Production Autonomous.

**`stability`** declares the protocol version and any experimental namespaces in use. `core_version` matches the `apex_version` from the initialize handshake. `experimental_namespaces` lists vendor-specific experimental capabilities that the broker exposes. If an agent depends on a capability from an experimental namespace for critical behavior, it should not treat that behavior as APEX core interoperability — it is a vendor-specific extension that may change or disappear without protocol-level migration guidance.

How agents should use this:

1. Check `core_version`. If it does not match what the agent expects, apply the version compatibility logic from the Version Advertisement section.
2. Check `production_profiles`. If the agent requires realtime streaming and the broker reports `realtime: false`, the agent should not attempt to subscribe to resources or rely on notifications.
3. Check `experimental_namespaces`. If the agent uses vendor-specific experimental features, it should verify the namespace is listed. If it is not, those features are unavailable.
4. Do not assume unlisted capabilities. If `autonomous` is `false`, do not call `apex://agent/decision-context/{instrument_id}` and hope for the best.

---

## Parallels

The APEX stability model did not invent any of these ideas. Every mature protocol and platform has solved the same problem. Here is where the ideas come from and how they map.

### Semver

Semantic versioning (`major.minor.patch`) is the foundation. APEX uses semver with the `-alpha` pre-release suffix. The compatibility rules map directly:

| Semver rule | APEX equivalent |
|---|---|
| Major bump = incompatible changes | New major version required for incompatible core changes |
| Minor bump = additive, backward-compatible | New optional fields, new tools in new namespaces |
| Patch bump = bug fixes | Schema corrections, conformance fixes |
| Pre-release suffix = no stability guarantees | `-alpha` means stability classes apply instead of full semver guarantees |

### HTTP Content Negotiation

HTTP's `Accept` header lets the client declare what it can handle. The server responds with what it chose. APEX's version advertisement serves the same purpose: the agent reads `apex_version` and decides whether to proceed. The difference is that HTTP negotiates per-request and APEX negotiates per-session — once at `initialize`, not on every tool call.

### gRPC Service Versioning

gRPC puts the version in the package name: `package apex.v1;`. A breaking change means a new package: `apex.v2`. APEX takes the same approach at the protocol level — incompatible schema changes get new schema files, not silent edits to existing ones.

### Go Module Compatibility

Go's module system uses the import path as the stability boundary. `github.com/apex/v1` and `github.com/apex/v2` are different modules. You can depend on both simultaneously. APEX's reserved namespaces serve a similar purpose: `apex.*` is the protocol's territory, and implementations carve out their own namespaces for their own stability promises.

### W3C Spec Maturity Levels

The W3C moves specifications through Working Draft, Candidate Recommendation, Proposed Recommendation, and W3C Recommendation. APEX's alpha stability classes serve the same purpose at a smaller scale:

| W3C level | APEX equivalent |
|---|---|
| Working Draft | Alpha Experimental |
| Candidate Recommendation | Alpha Core |
| W3C Recommendation | Post-`1.0.0` frozen core |

The `1.0.0` exit criteria are APEX's version of the W3C's transition requirements — concrete conditions that must be met before the spec advances.

### Linux Kernel Stable ABI

The Linux kernel distinguishes between stable ABI (guaranteed across versions, documented in `Documentation/ABI/stable/`) and internal ABI (may change at any time). APEX's Alpha Core is the stable ABI — not frozen yet, but expected to remain recognizable. Alpha Experimental is the internal ABI — useful, but change it at will.

### Kubernetes API Groups

Kubernetes uses API group versions to signal stability:

| Kubernetes | APEX equivalent | Meaning |
|---|---|---|
| `v1` (stable) | Post-`1.0.0` core | Frozen. Backward compatible. |
| `v1beta1` (pre-release) | Alpha Core | Expected to remain but may tighten. |
| `v1alpha1` (experimental) | Alpha Experimental | May change materially. No compatibility promise. |

The Kubernetes model is the closest parallel to APEX's stability classes. The key lesson from Kubernetes: `v1alpha1` APIs get used in production despite the warnings, so you need to handle their eventual stabilization or removal gracefully. The same will be true for APEX experimental surfaces.

---

## Storage

This document is normative for protocol governance. It does not define implementation behavior — it defines the contract between the spec and its implementers. The stability classifications, compatibility rules, schema evolution rules, and deprecation policy apply to the spec itself, not to any particular broker or agent implementation.
