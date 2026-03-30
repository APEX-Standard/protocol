# APEX Protocol — Order Lifecycle and Idempotency Design

**Version:** `0.1.0-alpha`

---

## Overview

Orders are the most dangerous tool an agent has. Every other APEX tool reads state or checks limits — orders change state. A malformed order creates exposure. A duplicate order doubles it. A missed fill leaves the agent trading against a position it does not know about. A partial fill that arrives between sizing and submission produces overexposure that no subsequent order can cleanly unwind.

This document defines the lifecycle semantics, idempotency contract, and failure modes that runtimes and brokers must agree on to keep order handling safe. The goal is mechanical: given any sequence of place, modify, cancel, fill, and reject events, both sides must arrive at the same order state, the same filled quantity, and the same understanding of what is still executable.

---

## The State Machine

APEX defines seven canonical order states. Four are terminal. Once an order enters a terminal state, it stays there forever — no broker, no retry, no edge case brings it back.

```
                         +-----------+
                         | rejected  |  (terminal)
                         +-----------+
                              ^
                              | (broker/venue refuses)
                              |
  +----------+          +-----------+          +-------------------+          +--------+
  | accepted | -------> |  working  | -------> | partially_filled  | -------> | filled |  (terminal)
  +----------+          +-----------+          +-------------------+          +--------+
                              |                        |
                              |  (cancel/expire)       |  (cancel remaining)
                              v                        v
                         +-----------+          +-----------+
                         | cancelled |          | cancelled |  (terminal)
                         +-----------+          +-----------+

                         +-----------+
                         |  expired  |  (terminal)
                         +-----------+
```

### State Meanings

| State | Meaning | Terminal? |
|---|---|---|
| `accepted` | Broker acknowledged the request and assigned an order ID, but the order is not yet confirmed working or filled | No |
| `working` | Active resting order with remaining executable quantity | No |
| `partially_filled` | At least one fill occurred; remaining executable quantity still open | No |
| `filled` | No remaining executable quantity — the order fully executed | **Yes** |
| `cancelled` | Remaining executable quantity was cancelled (may have partial fills) | **Yes** |
| `rejected` | Order never became executable — broker or venue refused it | **Yes** |
| `expired` | Order lapsed due to time-in-force or venue session rules | **Yes** |

### The Terminal State Rule

Terminal states are permanent facts. An order that is `filled` cannot become `working`. An order that is `rejected` cannot become `accepted`. An order that is `cancelled` cannot be un-cancelled. If a broker implementation transitions an order out of a terminal state, it has violated the protocol and the agent's state model is compromised.

This is the same guarantee that FIX provides with its `OrdStatus` field: once an ExecutionReport carries `OrdStatus=2` (Filled), no subsequent ExecutionReport for that ClOrdID can revert to `OrdStatus=0` (New). The state machine moves forward only.

### Transition Table

| From | To | Trigger |
|---|---|---|
| `accepted` | `working` | Broker confirms resting order |
| `accepted` | `filled` | Immediate full execution (market order) |
| `accepted` | `partially_filled` | Immediate partial execution |
| `accepted` | `rejected` | Broker/venue refuses order |
| `working` | `partially_filled` | First partial fill arrives |
| `working` | `filled` | Full execution of resting order |
| `working` | `cancelled` | Agent cancels or broker cancels |
| `working` | `expired` | Time-in-force lapses |
| `partially_filled` | `filled` | Remaining quantity executes |
| `partially_filled` | `cancelled` | Agent cancels remaining quantity |
| `partially_filled` | `expired` | Time-in-force lapses on remainder |

Note that `accepted` to `filled` is the common path for market orders — the order is accepted and fully executed in the same lifecycle step, so the agent may never see `working` or `partially_filled` as intermediate states.

---

## Fill Semantics

Fills are the execution facts of the protocol. Unlike state transitions, which describe what the order is doing now, fills describe what already happened. They are historical records. They cannot be retracted.

### Fill Payload

Each fill event must include:

| Field | Type | Description |
|---|---|---|
| `fill_id` | string | Stable, unique identifier for this fill |
| `order_id` | string | The order that generated this fill |
| `account_id` | string | The account the fill belongs to |
| `instrument_id` | string | The instrument that was executed |
| `quantity` | number | Quantity executed in this fill |
| `price` | number | Execution price for this fill |
| `timestamp` | ISO 8601 | When the broker/venue considers the fill to have occurred |

The `fill_id` must be stable across replays. If the agent disconnects and reconnects, and the broker replays the fill event, the `fill_id` must be identical to the original. This is how the agent deduplicates — it checks whether it has already processed a given `fill_id`, not whether the event "looks similar."

### Partial Fill Accumulation

Partial fills accumulate on the order. If a 100,000-unit order fills in three tranches (40,000, 35,000, 25,000), the order emits three fill events and the `filled_quantity` on the order progresses: 40,000, then 75,000, then 100,000. At 100,000 the order becomes `filled` (terminal).

### The Quantity Invariant

For any order at any point in its lifecycle:

```
filled_quantity + remaining_quantity <= quantity
```

For `filled` orders:

```
remaining_quantity == 0
```

For `cancelled`, `rejected`, and `expired` orders:

```
remaining_quantity == 0
```

The `<=` rather than `==` accounts for the fact that some quantity may be neither filled nor remaining — it was cancelled or expired. A 100,000-unit order that partially fills 60,000 and then is cancelled has `filled_quantity = 60,000`, `remaining_quantity = 0`, `quantity = 100,000`. The 40,000 difference is the cancelled remainder.

### Average Fill Price

If the broker exposes `average_fill_price` on order lifecycle payloads, it must be the volume-weighted average of all fills on that order:

```
average_fill_price = sum(fill_price_i * fill_quantity_i) / sum(fill_quantity_i)
```

This matches the standard FIX `AvgPx` (tag 6) calculation. It is the only meaningful average when fills arrive at different prices.

### Liquidity Flag

Brokers operating as principal counterparty (OTC FX market makers, CFD providers) may permanently report `liquidity_flag: "unknown"`. This is valid. The maker/taker distinction does not apply when the broker is the sole counterparty. Exchange-connected brokers should report `maker` or `taker` where available.

### Fills Resource vs Fill Notifications vs Order Lifecycle Payloads

Fill information surfaces in three places in the protocol, and each serves a distinct purpose. The **fills resource** (`apex://account/fills/{account_id}`) is a subscribable collection of all fill records for the account. It is the persistent ledger — the agent reads it to get the complete, current list of recent fills with their `fill_id`, `order_id`, `fill_price`, `fill_quantity`, and `timestamp`. The resource carries freshness metadata (`as_of`, `sequence`, `stale_after_ms`) and follows the standard subscription model: the broker pushes `notifications/resources/updated` when new fills arrive, and the agent re-reads the resource to see the updated collection.

**Fill notifications** (`notifications/apex.order.filled` and `notifications/apex.order.partially_filled`) are individual SSE events pushed in real time over the notification stream. Each notification describes a single fill event as it happens — one order, one fill, one notification. These notifications are classified as `required` during replay, meaning the agent will receive them even after a reconnect. They carry a `resource_uri` field pointing to the fills resource, linking the ephemeral event to the persistent collection.

**Order lifecycle payloads** — the responses from `apex.order.place`, `apex.order.status`, and the orders resource (`apex://account/orders/{account_id}`) — include aggregated fill data on the order itself: `filled_quantity`, `remaining_quantity`, `average_fill_price`, and the order's current `status`. These are summaries, not individual fill records. An order that filled in three partial tranches shows `filled_quantity` as the sum of all three, but the individual fill prices and quantities are only available from the fills resource or the fill notifications.

The practical consequence: an agent that needs to know "did my order fill?" checks the order lifecycle (status, filled quantity). An agent that needs to know "at what prices did my order fill, and in how many tranches?" reads the fills resource or processes the fill notifications. An agent reconciling after a reconnect processes replayed fill notifications for execution history and re-reads the fills resource for the current collection.

---

## The Idempotency Contract

The `client_order_id` is the agent's defense against duplicate order submission. It is the single most important safety mechanism in the order placement flow.

### The Problem

Consider this sequence:

1. Agent calls `apex.order.place` with a market buy for 100,000 EURUSD.
2. The broker receives the order, executes it, and creates a position.
3. The HTTP response is lost — network timeout, load balancer drop, TCP reset.
4. The agent sees no response. It does not know whether the order was received.
5. The agent retries `apex.order.place` with the same parameters.
6. The broker receives a second order, executes it, and creates a second position.

The agent now has 200,000 units of EURUSD exposure instead of 100,000. It may not even know — it thinks it placed one order and got one fill. The second position is invisible until it reads its positions resource and sees double the expected quantity.

### The Solution

The agent generates a unique `client_order_id` (UUID, ULID, or any unique string) for every order submission. If the tool call times out without a response, the agent retries with the **same** `client_order_id`.

The broker enforces uniqueness: a second `apex.order.place` call with the same `client_order_id` within the same session returns the result of the first order, not a new order. The response is identical to what the agent would have received if the first call had succeeded — same `order_id`, same `status`, same `fill_price`.

```
Agent                                    Broker
  |                                        |
  |-- apex.order.place(coid: "abc-123") -->|
  |                                        |-- executes, fills at 1.0847
  |         (response lost)                |
  |                                        |
  |-- apex.order.place(coid: "abc-123") -->|
  |                                        |-- looks up "abc-123", already exists
  |<-- { order_id: "X", fill: 1.0847 } ---|
  |                                        |
```

One order. One fill. One position. The `client_order_id` namespace is per session — IDs may be reused across different sessions, but within a session, each `client_order_id` maps to exactly one order.

### The Parallel to Stripe

This is exactly how Stripe's idempotency keys work. When you POST a charge with an `Idempotency-Key` header, Stripe stores the result keyed by that value. A retry with the same key returns the stored result. A retry with a different key creates a new charge. The semantics are identical: the client controls deduplication by providing a stable identifier, and the server enforces uniqueness.

It is also analogous to database UPSERT semantics — `INSERT ... ON CONFLICT (client_order_id) DO NOTHING RETURNING *`. The first insert wins. Subsequent attempts with the same key return the existing row.

### Agent Responsibilities

- Generate a unique `client_order_id` for every order submission.
- Store the `client_order_id` before sending the request, not after.
- On timeout or ambiguous failure, retry with the same `client_order_id`.
- Never reuse a `client_order_id` within the same session for a different order intent.

### Broker Responsibilities

- Enforce `client_order_id` uniqueness within a session.
- On duplicate, return the original order result without creating a new order.
- If the agent does not provide a `client_order_id`, the broker assigns one.

---

## Cancel Semantics

`apex.order.cancel` applies to remaining executable quantity only. It does not undo fills that have already occurred.

### Cancel of a Working Order

The simplest case: the order is `working` with full `remaining_quantity`. The cancel request transitions it to `cancelled`, `remaining_quantity` drops to zero, and no fills were involved.

### Cancel of a Partially Filled Order

The order has `filled_quantity = 60,000` out of `quantity = 100,000`, so `remaining_quantity = 40,000`. The agent sends `apex.order.cancel`. The broker cancels the remaining 40,000. The order becomes `cancelled` with `filled_quantity = 60,000`, `remaining_quantity = 0`. The 60,000 that already filled is a permanent fact — it produced a position (or modified one), and the cancel does not reverse it.

### Cancel of an Already-Terminal Order

If the order is already `filled`, `cancelled`, `rejected`, or `expired` when the cancel request arrives, the broker returns the terminal status unchanged. It does not emit a second cancellation event or error. This is a no-op acknowledgment — "yes, that order is already done."

This prevents a common race condition: the agent sends a cancel while the last fill is in flight. The fill arrives first, making the order `filled`. The cancel arrives second, finds a terminal order, and returns the filled status. The agent gets the correct final state without confusion.

### Cancel During Partial Fill — The Race

Here is the dangerous sequence:

```
Time    Agent                           Broker
----    -----                           ------
T1      Order working, remaining: 100k
T2                                      Fill 60k arrives from venue
T3      Sends cancel(order_id)          Processing fill...
T4                                      Fill applied: filled_qty=60k, remaining=40k
T5                                      Cancel received: cancels remaining 40k
T6      Receives cancel response        Status: cancelled, filled_qty: 60k
```

The agent must check the `filled_quantity` in the cancel response. If it expected to cancel the full 100,000 and sees `filled_quantity = 60,000`, it now has 60,000 units of exposure it needs to account for. The cancel succeeded — it cancelled the remaining 40,000 — but the order was not "cancelled" in the sense of "nothing happened." Sixty thousand units executed.

---

## Modify Semantics

`apex.order.modify` serves two distinct purposes depending on `target_type`.

### Order Modify (`target_type: "order"`)

Modifying a working order may change its price, quantity, or protection parameters. The broker must document whether this is implemented as a native amend (the order keeps its queue position and order ID) or as a cancel-replace under the hood (the old order is cancelled and a new one is placed, potentially with a new order ID and lost queue priority).

This distinction matters for agents trading resting limit orders on venues where queue position affects fill probability. A native amend preserves priority. A cancel-replace resets it. The agent cannot make informed decisions about modify vs. cancel-and-resubmit without knowing which model the broker uses.

Supported fields for order modify:

| Field | Description |
|---|---|
| `limit_price` | New limit price (limit and stop-limit orders) |
| `stop_price` | New stop trigger price (stop and stop-limit orders) |
| `quantity` | New order quantity |
| `stop_loss` | New stop loss protection |
| `take_profit` | New take profit protection |
| `trailing_stop` | New trailing stop protection |

Brokers must reject invalid field combinations with `APEX_4011`. You cannot set a `limit_price` on a market order, or change the `quantity` on a broker that does not support quantity amendment.

### Position Modify (`target_type: "position"`)

Position modification in APEX core is restricted to protection semantics:

| Field | Description |
|---|---|
| `stop_loss` | Add, change, or remove stop loss |
| `take_profit` | Add, change, or remove take profit |
| `trailing_stop` | Add, change, or remove trailing stop |

Changing the position's entry price or quantity is not a valid position modification. To reduce a position, use `apex.position.close` with a partial `quantity`. To increase it, place a new order. Protection changes are the only modifications that do not alter exposure — they define future exit conditions, not current risk.

This is a deliberate constraint. Position-level modification of executable fields (entry price, quantity, direction) would create an alternative order submission path that bypasses the idempotency model, the risk check flow, and the audit trail. Restricting position modify to protections keeps a single order entry path through `apex.order.place`.

---

## The Partial Fill Race Condition

This is the most dangerous timing hazard in the order lifecycle. It is subtle, it is common, and it produces overexposure — the one failure mode that costs real money.

### The Scenario

1. Agent places a market buy for 100,000 EURUSD.
2. Broker partially fills 50,000. Order status: `partially_filled`, `remaining_quantity: 50,000`.
3. Agent reads its position state: sees 50,000 EURUSD long.
4. Agent's sizing logic decides the target position is 100,000. Current position is 50,000. Delta is 50,000.
5. Agent places a new market buy for 50,000 to reach its target.
6. Between steps 4 and 5, the remaining 50,000 from the original order fills.
7. Agent now has: 50,000 (first fill) + 50,000 (second fill) + 50,000 (new order) = 150,000 EURUSD long.

The target was 100,000. The agent has 150,000. The 50,000 overexposure happened because the agent made a sizing decision based on non-terminal order state.

### Why This Happens

The agent's position state at step 3 was correct at that instant — it did have 50,000. But the original order was still live. The remaining 50,000 was in flight at the venue. By the time the new order reached the broker, the original order had fully filled, and the new order created additional exposure on top of the completed original.

This is a classic read-then-act race condition. The agent read state, computed a delta, and acted — but the state changed between the read and the act.

### The Solution

The runtime must enforce a simple rule: **do not make sizing decisions on non-terminal order state.**

Before sizing a new order based on position state that includes a partially filled order:

1. **Wait for the order to reach a terminal state** (`filled`, `cancelled`, `rejected`, `expired`), or
2. **Cancel the remaining quantity** via `apex.order.cancel` and confirm the cancellation before proceeding.

Option 1 is simpler — wait for the order to finish. Option 2 is faster — cancel the remainder so the agent can recalculate immediately based on known final state.

This check must happen in runtime code, not in the model's reasoning. The model cannot reliably track partial fill timing. The runtime checks: "are there any non-terminal orders for this instrument?" If yes, it either waits or cancels before asking the model to size.

---

## Reject Semantics

When a broker rejects an order, the rejection carries a reason that falls into one of several categories. These categories tell the agent what went wrong and, critically, whether retrying makes sense.

### Rejection Classes

| Class | Meaning | Retry? |
|---|---|---|
| `validation` | Invalid parameters — bad instrument, below-minimum quantity, malformed fields | No (fix the input) |
| `risk` | Insufficient margin, position limit exceeded, daily loss limit reached | Maybe (after state changes) |
| `market_state` | Market closed, instrument not tradeable, auction phase | Yes (when market reopens) |
| `venue` | Venue-side rejection — exchange-specific rules, circuit breakers | Maybe (venue-dependent) |
| `rate_limit` | Too many requests | Yes (after backoff) |
| `auth` | Invalid or expired token, insufficient permissions | No (re-authenticate first) |
| `operational` | Broker system error, stale state, sequence break | Yes (after reconnect/refresh) |

### Mapping to Wire Format

The APEX wire format defines a normative error category enum: `auth | validation | risk | operational | broker | rate_limit | internal`. The execution-level rejection classes map to these wire categories:

| Rejection Class | Wire Category |
|---|---|
| `validation` | `validation` |
| `risk` | `risk` |
| `market_state` | `operational` |
| `venue` | `broker` |
| `rate_limit` | `rate_limit` |
| `auth` | `auth` |
| `operational` | `operational` or `internal` |

Implementations should preserve the broker-native reason text in the `message` field while mapping into the stable category. The category is what the agent's logic branches on. The message is what the human reads in the audit log.

### Normative Error Codes

| Code | Category | Description |
|---|---|---|
| `APEX_4001` | auth | Invalid or expired token |
| `APEX_4002` | auth | Insufficient account permissions |
| `APEX_4010` | validation | Invalid instrument_id |
| `APEX_4011` | validation | Invalid order parameters |
| `APEX_4012` | validation | Quantity below minimum |
| `APEX_4020` | risk | Insufficient margin |
| `APEX_4021` | risk | Position limit exceeded |
| `APEX_4022` | risk | Daily loss limit reached |
| `APEX_4023` | risk | Kill switch active |
| `APEX_4024` | operational | Stale market or risk state |
| `APEX_4025` | operational | Sequence continuity broken |
| `APEX_4030` | broker | Market closed |
| `APEX_4031` | broker | Instrument not tradeable |
| `APEX_4040` | rate_limit | Request rate exceeded |
| `APEX_5000` | internal | Broker system error |
| `APEX_5001` | internal | Routing error |

---

## Parallels

The order lifecycle and idempotency model draws from several well-established systems. APEX does not invent new semantics — it applies proven patterns to the agent-broker interface.

### FIX Protocol — ExecutionReport Chain

| FIX Concept | APEX Equivalent |
|---|---|
| `NewOrderSingle` (MsgType=D) | `apex.order.place` |
| `OrderCancelRequest` (MsgType=F) | `apex.order.cancel` |
| `OrderCancelReplaceRequest` (MsgType=G) | `apex.order.modify` (target_type: order) |
| `ExecutionReport` (MsgType=8) | Order lifecycle response + notification events |
| `ClOrdID` (tag 11) | `client_order_id` |
| `OrderID` (tag 37) | `order_id` |
| `ExecID` (tag 17) | `fill_id` |
| `OrdStatus` (tag 39) | `status` field |
| `AvgPx` (tag 6) | `average_fill_price` |
| `CumQty` (tag 14) | `filled_quantity` |
| `LeavesQty` (tag 151) | `remaining_quantity` |

In FIX, every state transition produces an ExecutionReport. The `ClOrdID` is client-assigned and used for correlation — the broker's `OrderID` may differ. APEX follows the same split: `client_order_id` is the agent's identifier, `order_id` is the broker's. The agent uses `client_order_id` for idempotency and retry. The broker uses `order_id` for its internal systems.

### Stripe Idempotency Keys

Stripe's POST endpoints accept an `Idempotency-Key` header. The first request with a given key is executed and the result is stored. Subsequent requests with the same key return the stored result without re-executing the operation. The key is scoped to the API key (analogous to APEX's per-session scope). The semantics are identical: client-generated unique identifier, server-enforced uniqueness, stored-result replay on retry.

### Database UPSERT

`INSERT INTO orders (client_order_id, ...) ON CONFLICT (client_order_id) DO NOTHING RETURNING *` — the first insert wins. Duplicates are no-ops that return the existing row. This is the storage-level equivalent of the idempotency contract: the unique constraint on `client_order_id` prevents duplicate orders at the data layer, and `RETURNING *` gives the caller the existing result.

### Two-Phase Commit for State Transitions

The order lifecycle is effectively a two-phase state machine. Phase one: the agent sends a request (place, cancel, modify). Phase two: the broker confirms the transition (accepted, cancelled, modified) or rejects it. The agent must not assume the transition succeeded until it receives confirmation. This is why `client_order_id` exists for the ambiguous case — the agent sent phase one but never received phase two, so it retries phase one with the same identifier and the broker returns the phase-two result.

This maps directly to the two-phase commit pattern in distributed systems: prepare (send order), commit (receive confirmation). If the commit acknowledgment is lost, the client re-sends the prepare with the same transaction ID and the coordinator returns the commit result.

---

## Related Design Documents

- [Error Taxonomy Design](error-taxonomy-design.md) — the structured error categories and codes (APEX_4010 through APEX_4040) that govern order rejection semantics and autonomous recovery logic
- [Account Model Design](account-model-design.md) — the position and fills model that reflects the downstream effects of order lifecycle events
- [Autonomous Safety Design](autonomous-safety-design.md) — the partial fill race condition, pre-trade risk checks, and halt conditions that interact with order lifecycle state
