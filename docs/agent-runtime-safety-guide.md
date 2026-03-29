# APEX Protocol — Agent Runtime Safety Guide

**Audience:** agent/runtime implementers  
**Version:** `0.1.0-alpha`

---

## Goal

Use APEX as a live trading interface without turning the model into the unsafe part of the stack.

---

## 1. Maintain A Local State Cache

Subscribe to execution-critical resources and keep a local cache:

- quote
- candles
- features
- account summary
- positions
- orders
- risk
- decision context if used

Do not drive trading from repeated synchronous polling of `apex.market.quote`.

---

## 2. Track Freshness And Sequence

For each cached resource, store:

- last payload
- last `sequence`
- `timestamp` or `as_of`
- `stale_after_ms`

The runtime, not the model, should decide whether the state is fresh enough to trade.

Call `apex.session.acknowledge` with the last processed SSE event ID after each decision cycle or at least every 30 seconds. This advances the server's retention cursor and ensures replay remains available across longer disconnection windows. On reconnect, the server replays only execution-critical events and collapses ephemeral market data into gap fill markers — re-read all resources regardless to rebuild current state.

---

## 3. Halt Autonomy Deterministically

Pause new order entry when:

- quote is stale
- account or risk state is stale
- sequence continuity breaks
- reconnect occurs without replay confidence
- kill switch is active
- instrument is restricted
- market is not tradeable

This halt must happen in code before the LLM is even asked to decide.

### Partial Fill Race Conditions

When an order is `partially_filled`, the agent's position has changed but the order is not yet terminal. If the agent sizes a new order based on current position state while the remaining fill is in flight, the second fill may arrive between the sizing decision and the new order submission — resulting in overexposure.

Before sizing a new order based on position state that includes a partially filled order:

1. Wait for the order to reach a terminal state (`filled`, `cancelled`, `rejected`, `expired`), or
2. Cancel the remaining quantity via `apex.order.cancel` and confirm the cancellation before proceeding.

Do not make sizing decisions on non-terminal order state. The runtime should enforce this check in code — do not rely on the model to reason about partial fill timing.

---

## 4. Give The Model Structured Decision Context

Preferred decision input:

- current quote and spread
- last completed candles on multiple timeframes
- derived features
- positions and open orders
- risk limits and hard-stop state

Avoid feeding the model raw tick streams or large append-only logs.

---

## 5. Separate Decisioning From Execution

Recommended pattern:

1. runtime maintains state
2. runtime constructs decision context
3. model returns an intent
4. runtime validates intent against safety rules
5. runtime submits tool call
6. runtime records the audit trail

The model proposes. The runtime enforces.

---

## 6. Record An Audit Trail

Per decision, record:

- model input resource URIs
- resource sequences used
- freshness values used
- model output intent
- risk validation result
- resulting broker tool response

If a trade goes wrong, this record matters more than the original prompt text.

---

## 7. Treat Decision Context As Read Model, Not Source Of Truth

`apex://agent/decision-context/{instrument}` is the model-friendly view, but the runtime should still be able to read the underlying resources directly for safety validation and debugging.

---

## 8. Recommended Runtime Modes

- `observe` — read-only access to market data and account state; no order actions permitted
- `paper` — simulated order execution against live market data; no real capital at risk
- `assist` — agent proposes actions that a human must approve before execution
- `autonomous_limited` — agent may execute within strict position size, loss, and instrument limits
- `autonomous_full` — agent operates with full account authority subject only to broker-level risk controls

Alpha implementations should expose mode clearly in runtime configuration even if the broker does not standardize it yet.
