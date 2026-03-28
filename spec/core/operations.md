# APEX Protocol — Operational Semantics

**Version:** `0.1.0-alpha`  
**Status:** Draft  
**Last Updated:** 2026-03-27

---

## Purpose

Trading viability depends on operational behavior, not only payload shape. This document defines the runtime rules that agent implementations and brokers should align on during alpha.

It covers:

- freshness and staleness
- sequencing and gap handling
- replay and reconnect behavior
- session health
- autonomous runtime halting rules

---

## 1. Freshness Classes

Execution-critical APEX resources fall into three freshness classes.

### 1.1 Market Fast

Examples:

- quote
- order book
- trade flow
- short-horizon features

Requirements:

- must include `timestamp` or `as_of`
- must include `stale_after_ms`
- should update frequently enough to reflect current execution conditions

### 1.2 Market Slow

Examples:

- completed candles
- slower derived features
- instrument metadata caches

Requirements:

- must include `as_of`
- must include `stale_after_ms` if relied upon for autonomous decisions

### 1.3 Account / Risk

Examples:

- account summary
- positions
- orders
- risk state

Requirements:

- must include `as_of`
- must include `stale_after_ms`
- should be treated as execution-critical when autonomous order entry is enabled

---

## 2. Staleness Rules

A resource is stale when:

- current_time > resource_timestamp + stale_after_ms

Autonomous runtimes should halt new order submission when any execution-critical resource is stale.

Minimum execution-critical set:

- quote
- features
- account summary
- positions
- orders
- risk

---

## 3. Sequencing Rules

For execution-critical realtime resources:

- `sequence` must be monotonic within the resource stream
- clients must retain the last observed `sequence`
- if a newly read resource has a lower `sequence` than the last accepted value, the client should treat it as invalid or replayed out of order unless replay mode is explicitly active

### 3.1 Gap Detection

A gap exists when:

- the client expects a contiguous progression and the observed `sequence` skips ahead unexpectedly
- the server documents a stricter gap definition and the client can detect it deterministically

For alpha, exact sequence arithmetic may remain implementation-specific, but clients must still be able to detect discontinuity.

---

## 4. Reconnect And Replay

Implementations should document one of the following reconnect modes:

- `no_replay`
- `best_effort_replay`
- `guaranteed_replay`

### 4.1 No Replay

After reconnect:

- the client must discard prior freshness assumptions
- the client must re-read all execution-critical resources
- autonomous execution should remain paused until the new baseline is established

### 4.2 Replay Modes

If replay is supported, implementations should document:

- retention window
- replay ordering guarantees
- whether replay includes only notifications or also resource versions

---

## 5. Session Health

Session health should be evaluated from:

- heartbeat responsiveness
- subscription delivery continuity
- freshness of execution-critical resources
- authentication validity

Recommended health states:

- `ok`
- `degraded`
- `paused`
- `halted`

---

## 6. Autonomous Runtime Halt Conditions

Autonomous order entry should halt when any of the following occurs:

- quote state is stale
- account/risk state is stale
- sequence continuity is broken for execution-critical resources
- reconnect occurs without a successful state rebuild
- kill switch becomes active
- broker reports the instrument as non-tradeable
- market-hours gating disallows new orders

---

## 7. Audit Expectations

Autonomous runtimes should record:

- input resource URIs used for each decision
- latest accepted sequences for those resources
- freshness timestamps observed
- resulting tool call and broker response
- any runtime refusal reason

This is not just a compliance aid. It is necessary for debugging real trading behavior.

---

## 8. Recommended Capability Advertisement

Implementations should advertise operationally important facts in capabilities:

```json
{
  "realtime_contract": {
    "reconnect_mode": "no_replay",
    "quote_freshness_ms": 1000,
    "account_freshness_ms": 2000
  }
}
```

This does not replace resource-level metadata. It complements it.
