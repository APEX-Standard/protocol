# APEX Protocol — Alpha Hardening Roadmap

**Version:** `0.1.0-alpha`

---

## Purpose

APEX remains alpha. This roadmap lists the work that should be completed during alpha before a `1.0.0` freeze is attempted.

---

## Hardening Tracks

### 1. Stability

- freeze core vs optional surfaces
- finalize schema compatibility rules
- finalize deprecation process

### 2. Execution Semantics

- complete order/fill/account lifecycle semantics
- document netting and hedging expectations
- tighten rejection taxonomy

### 3. Operations

- finalize freshness and sequencing rules
- standardize reconnect and replay vocabulary
- standardize runtime halt conditions

### 4. Conformance

- add schema validation to production checks
- add replay and stale-state scenarios
- add sequence-gap scenarios
- add execution lifecycle scenarios

### 5. Guides

- broker implementation guide
- agent runtime safety guide
- reference flows
- migration notes for any incompatible alpha changes

---

## Exit Signals For A Future 1.0.0 Candidate

- production conformance is broad and executable
- core schemas are frozen
- capability profile claims are testable
- known alpha incompatibilities are resolved or deprecated
- at least one non-reference implementation validates successfully
