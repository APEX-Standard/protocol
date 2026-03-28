# APEX Protocol — Broker Implementation Guide

**Audience:** broker teams and gateway implementers  
**Version:** `0.1.0-alpha`

---

## Goal

Implement the APEX alpha contract in a way that is useful for agent-native trading, not just tool demos.

---

## 1. Build The System In Layers

Recommended layering:

1. broker/exchange adapters
2. canonical instrument/account mapping
3. deterministic state engine
4. MCP exposure layer
5. autonomous safety and audit layer

Do not make the MCP server your only source of truth. It should expose the state model, not replace it.

---

## 2. Canonicalize Early

Normalize broker-native objects into APEX-native objects before exposing them:

- instrument IDs
- side enums
- order types
- quantities and units
- timestamps
- position model

If canonicalization happens late, the agent sees broker-specific drift everywhere.

---

## 3. Make Resources Authoritative

Treat tools as command/query entry points and resources as the live state plane.

At minimum, keep these resources coherent:

- quote
- candles
- features
- account summary
- positions
- orders
- risk
- decision context if autonomous mode is supported

Resource reads should reflect the same underlying state that tool responses mutate.

---

## 4. Emit Updates From State Changes

When order or account state changes:

- update the canonical state first
- then emit `notifications/resources/updated`
- keep notification emission deterministic and idempotent where possible

Do not emit notifications that refer to state the client cannot yet read consistently.

---

## 5. Document Broker-Specific Reality

Explicitly document:

- netting vs hedging
- market session boundaries
- replay support or lack of replay
- freshness expectations
- cancel vs cancel-replace behavior
- hard broker risk gates

If the broker has behavior that the APEX baseline cannot fully express, say so directly.

---

## 6. Autonomous Safety Boundary

The broker implementation should expose enough state for the agent runtime to halt safely:

- kill switch
- restricted instruments
- max position size
- max open orders
- stale data indicators
- market-hours eligibility

If you cannot enforce a control broker-side, document whether the runtime must enforce it instead.

---

## 7. Minimum Validation Before Claiming Alpha Realtime

Before claiming serious realtime support, verify:

- `npm run verify:alpha`
- `npm run verify:production`

Then add your own broker-specific tests for:

- reconnect
- stale quote handling
- order rejection mapping
- partial fill lifecycle

---

## 8. Common Failure Modes

- exposing tool responses that disagree with resources
- emitting notifications without monotonic resource versions
- mixing broker-native and canonical units
- hiding netting/hedging semantics
- treating candles as sufficient for execution logic
- lacking any clear stale-data contract
