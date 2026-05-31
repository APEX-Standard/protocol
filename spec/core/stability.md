# APEX Protocol — Alpha Stability And Compatibility

**Version:** `0.2.0-alpha`  
**Status:** Draft  
**Last Updated:** 2026-03-27

---

## Purpose

APEX remains alpha, but implementers still need to know which parts of the surface are stable enough to build against and which parts may change before `1.0.0`.

This document defines:

- core vs optional protocol boundaries
- schema compatibility expectations
- change classes
- deprecation policy
- alpha-to-`1.0.0` stabilization expectations

---

## 1. Surface Classes

APEX defines four stability classes.

### 1.1 Alpha Core

These surfaces are expected to remain recognizable across the rest of alpha, though fields may still tighten before `1.0.0`.

- Layer 1 tool namespaces in [`README.md`](./README.md)
- canonical realtime resource URI families in [`production.md`](./production.md)
- normative realtime and event schemas in [`schemas/`](./schemas/)
- production capability profile names

### 1.2 Alpha Optional

These surfaces are valid but not required for alpha interoperability.

- vendor extension tools
- vendor extension resources
- broker-specific notifications outside the APEX namespace
- profile-specific fields under `profile_data`

### 1.3 Alpha Experimental

These surfaces may change materially without a compatibility promise and must not be treated as contractually stable.

- any field or resource explicitly marked `experimental`
- any capability advertised only under a vendor namespace
- any pre-standard profile-specific transport behavior

### 1.4 Reserved

Reserved names and namespaces must not be repurposed by implementations.

- `apex.*`
- `apex://*`
- `notifications/apex.*`

---

## 2. Core vs Optional Matrix

| Surface | Alpha Core | Optional | Notes |
|--------|------------|----------|-------|
| Layer 1 tools | Yes | No | Required baseline |
| Quote/candle/feature/account/risk resources | Yes | No for production-targeting implementations | Core realtime contract |
| Decision context resource | Core for autonomous implementations | Optional otherwise | Stable resource family |
| Vendor tools/resources | No | Yes | Must not redefine APEX semantics |
| Event notifications in APEX namespace | Yes for production-targeting implementations | Optional for minimal alpha tools-only brokers | Strongly recommended |
| Profile-specific `profile_data` fields | No | Yes | Must not break base schema |

---

## 3. Compatibility Rules

### 3.1 Tool Compatibility

Before `1.0.0`, the following changes are considered compatible:

- adding optional tool fields
- adding new tools in new namespaces
- expanding enum values where the field is already open to forward-compatible handling
- adding new profiles

The following changes are considered incompatible:

- removing a documented core tool
- renaming a documented tool
- changing the meaning of an existing field
- changing a required field to a different type

### 3.2 Resource Compatibility

For normative resources:

- adding optional fields is compatible
- adding new resource families is compatible
- tightening `additionalProperties` from permissive to strict is incompatible unless done under a versioned replacement schema
- changing URI family semantics is incompatible

### 3.3 Event Compatibility

For normative order/fill events:

- adding optional fields is compatible
- adding new notification types is compatible
- changing required field names or lifecycle semantics is incompatible

---

## 4. Schema Evolution Rules

Normative schemas in [`schemas/`](./schemas/) follow these rules during alpha:

- required fields may only be added if the capability/profile claim that depends on them is also tightened in the same change
- existing required fields must keep meaning, type, and units — including wire encoding (all monetary/price/rate/P&L/margin/quantity fields are string-encoded decimals matching `^-?[0-9]+(\.[0-9]+)?$`, never JSON `number`; see the migration note in [`../../docs/version-stability-design.md`](../../docs/version-stability-design.md))
- optional fields may be added freely
- incompatible schema changes must use a new schema file and an explicit migration note

Recommended compatibility labels for future changes:

- `additive`
- `behavior-tightening`
- `incompatible`

---

## 5. Deprecation Policy

Alpha does not guarantee long-lived deprecation windows, but the following rules apply:

- a core field or tool should not be removed without first being marked deprecated in the spec
- deprecations should identify the replacement surface
- conformance should continue accepting the deprecated surface until a documented removal point

Deprecation notice format:

```md
Deprecated in: 0.1.x-alpha
Replacement: apex://...
Removal target: 1.0.0 or later
```

---

## 6. Capability Advertisement Expectations

Implementations should advertise clearly which class of surface they rely on:

```json
{
  "production_profiles": {
    "realtime": true,
    "autonomous": false
  },
  "stability": {
    "core_version": "0.2.0-alpha",
    "experimental_namespaces": ["vendor.example.experimental"]
  }
}
```

If an implementation depends on unstable vendor extensions for critical behavior, it should not represent that behavior as APEX core interoperability.

---

## 7. Alpha To 1.0.0 Exit Criteria

The following should be true before APEX claims `1.0.0`:

- core vs optional surfaces are frozen
- normative schemas are complete for execution-critical payloads
- conformance validates the frozen core set
- migration guidance exists for any deprecated alpha surfaces
- production profiles are executable, not just documentary
