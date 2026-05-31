# APEX Protocol — Execution And Account Semantics

**Version:** `0.2.0-alpha`  
**Status:** Draft  
**Last Updated:** 2026-03-27

---

## Purpose

This document tightens the meaning of execution-critical trading objects so brokers and runtimes do not drift into superficially compatible but behaviorally different implementations.

It covers:

- order lifecycle semantics
- fill semantics
- cancel/modify behavior
- account and position interpretation
- timestamp expectations

---

## 1. Order Lifecycle

APEX defines the following canonical order states:

- `accepted`
- `working`
- `partially_filled`
- `filled`
- `cancelled`
- `rejected`
- `expired`

### 1.1 State Meanings

- `accepted`: broker accepted the order request and assigned an order ID, but the order is not yet confirmed working or filled
- `working`: active resting order with remaining executable quantity
- `partially_filled`: at least one fill occurred and remaining executable quantity remains
- `filled`: no remaining executable quantity remains because the order fully executed
- `cancelled`: remaining executable quantity was cancelled
- `rejected`: order never became executable because the broker or venue refused it
- `expired`: order lapsed due to time-in-force or venue session rules

### 1.2 Terminal States

Terminal states are:

- `filled`
- `cancelled`
- `rejected`
- `expired`

After an order reaches a terminal state, implementations must not transition it back to `working` or `partially_filled`.

---

## 2. Quantity Semantics

- `quantity` means the original requested order quantity
- `filled_quantity` means total executed quantity accumulated so far
- `remaining_quantity` means currently executable quantity still open

For any order event:

`filled_quantity + remaining_quantity <= quantity`

For `filled`:

`remaining_quantity == 0`

For `cancelled`, `rejected`, and `expired`:

`remaining_quantity == 0`

---

## 3. Fill Semantics

Each fill event must:

- identify the `fill_id`
- identify the originating `order_id`
- identify the account and instrument
- include executed quantity and price
- include a stable timestamp

### 3.1 Partial Fills

If an order is partially filled:

- at least one fill event must be emitted
- order status must become `partially_filled` unless it reaches full completion in the same lifecycle step
- `filled_quantity` must accumulate across fills

### 3.2 Average Fill Price

If `average_fill_price` is exposed on order lifecycle payloads, it must represent the volume-weighted average of all fills accumulated on that order so far.

Brokers operating as principal counterparty (e.g., OTC FX market makers, CFD providers) may permanently report `liquidity_flag: "unknown"`. This is valid and expected — the maker/taker distinction does not apply when the broker is the sole counterparty.

---

## 4. Cancel And Modify Semantics

### 4.1 Cancel

`apex.order.cancel` applies only to executable remaining quantity.

If the order is already terminal when cancel is received:

- the broker may return terminal status unchanged
- the broker should not emit a misleading second cancellation event

### 4.2 Modify

`apex.order.modify` changes an existing working order or a position protection object, depending on `target_type`.

For `target_type = order`:

- modifications apply to the current working object
- implementations must document whether modify is broker-native amend or cancel-replace under the hood

For `target_type = position`:

- only protection semantics are allowed in core APEX
- changing executable entry price or quantity is not valid position modification

---

## 5. Reject Semantics

Rejections should be distinguishable by reason category, even if the broker exposes only a free-text `reason`.

Recommended rejection classes:

- validation
- risk
- market_state
- venue
- rate_limit
- auth
- operational

Implementations should preserve the broker-native reason while still mapping into a stable class where possible.

These rejection classes are recommendations for semantic categorisation within execution-semantics contexts. The normative error category enum for the wire format is defined in the core README (`auth|validation|risk|operational|broker|rate_limit|internal`). Implementations should map execution rejection classes to the closest normative category — for example, `market_state` maps to `operational` and `venue` maps to `broker`.

---

## 6. Position Semantics

APEX core assumes positions represent live exposure after broker-side netting rules have been applied.

Implementations must document:

- whether the account is netted or hedged
- whether multiple same-direction entries collapse into one position
- whether opposite-direction entries reduce or invert exposure

If the broker supports hedging and independent tickets, that detail may appear in profile-specific fields, but the base position object must still remain valid.

---

## 7. Account State Semantics

Execution-relevant account state should be interpretable as follows:

- `balance`: settled account cash excluding unrealized P&L
- `equity`: balance plus unrealized P&L
- `used_margin`: margin currently reserved
- `free_margin`: equity available for additional exposure under broker rules
- `margin_level_pct`: broker-defined ratio used for margin warning / liquidation logic

Implementations must document any broker-specific deviations.

---

## 8. Timestamp Semantics

Execution and account payloads should distinguish three timestamp classes when available:

- event time: when the broker/venue considers the event to have occurred
- processing time: when the broker processed the event internally
- publish time: when the MCP payload was emitted

If only one timestamp is present in core payloads:

- it must be documented which class it represents

For alpha, a single canonical timestamp is acceptable if accompanied by operational documentation.

---

## 9. Duplicate And Replay Handling

Clients must be able to tolerate duplicate order/fill events.

Implementations should therefore provide:

- stable `order_id`
- stable `fill_id`
- monotonic resource `sequence`

If replay is supported, replayed events must preserve the same identifiers as the original live events.

#### Duplicate Handling via `client_order_id`

Brokers must enforce `client_order_id` uniqueness within a session. A second `apex.order.place` call with the same `client_order_id` must return the result of the first order, not create a new order. This is the primary mechanism for safe retry after transport failures. The `client_order_id` namespace is per session — IDs may be reused across different sessions.

---

## 10. Required Documentation For Brokers

To claim serious trading support, a broker should document:

- netting vs hedging mode
- average fill price calculation
- cancel vs cancel-replace behavior
- fill timestamp meaning
- rejection taxonomy mapping
- partial fill aggregation behavior
