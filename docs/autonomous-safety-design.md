# APEX Protocol — Autonomous Safety Design

**Version:** `0.3.0-alpha`

---

## Overview

An autonomous trading agent with real money needs layered defenses. No single component — not the model, not the broker, not the runtime — should be the sole safety gate. A model can hallucinate a trade rationale. A broker can lag on risk updates. A runtime can have a bug in its freshness check. Any one of these failures is survivable if the other layers catch it. All three failing simultaneously is how you lose real capital.

APEX builds safety into the protocol layer, not as an afterthought. The kill switch is not a feature bolted on after the first incident — it is a first-class notification type, a mandatory tool field, a replay-classified event. Stale data rejection is not a best practice suggestion — it is a normative error code (`APEX_4024`) that brokers must return. The seven halt conditions are not runtime implementation hints — they are protocol-level contracts that autonomous implementations must enforce.

This document walks through the complete safety architecture: the core enforcement principle, the seven halt conditions, the kill switch mechanism, the layered defense model, the runtime modes, pre-trade risk checks, the partial fill race condition, and the audit trail. Each section explains the what, the why, and the how — with enough specificity to implement against.

---

## The Core Principle

**The model proposes, the runtime enforces.**

The LLM generates intents. Deterministic code validates those intents against safety rules BEFORE any tool call reaches the broker. The model never talks to the broker directly. The runtime is always in the middle, and the runtime is not an LLM — it is ordinary, testable, deterministic software.

Here is the flow, step by step:

1. **State.** The runtime maintains a local cache of execution-critical resources: quote, candles, features, account summary, positions, orders, risk. Each cached resource carries a `sequence`, a `timestamp` or `as_of`, and a `stale_after_ms` value.

2. **Context.** The runtime assembles a structured decision context from the cached state. This is the model-friendly view — current quote and spread, last completed candles on multiple timeframes, derived features, positions and open orders, risk limits and hard-stop state. The model receives structured data, not raw tick streams or append-only logs.

3. **Model.** The LLM receives the decision context and returns an intent. An intent is a structured object: "buy 100,000 EURUSD at market" or "cancel order X" or "do nothing." The intent is not a tool call. It is a proposal.

4. **Intent.** The runtime receives the intent and begins validation. The intent has not touched the broker yet. No order has been submitted. No capital is at risk.

5. **Validation.** The runtime checks the intent against every applicable safety rule: Is the quote fresh? Is the risk state fresh? Is the sequence continuous? Is the kill switch inactive? Is the instrument tradeable? Is the market open? Does the position size stay within limits? If any check fails, the intent is refused. The model does not get a vote.

6. **Execution.** If validation passes, the runtime translates the intent into the appropriate APEX tool call (`apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close`) and submits it to the broker. The broker performs its own independent validation — margin checks, position limits, market-hours gating — and returns the result.

7. **Audit.** The runtime records the complete decision trail: input resource URIs, sequences, freshness values, the model's intent, the validation result, the broker's response, and any refusal reasons. This record exists whether the trade succeeded, was refused by the runtime, or was rejected by the broker.

The model is powerful but unreliable. The runtime is simple but deterministic. The broker is authoritative but remote. Safety comes from the combination — three independent systems, each with veto power, none trusting the others.

---

## The Seven Halt Conditions

Autonomous order entry must halt when any of the following conditions is detected. These are not suggestions. They are normative requirements for any implementation claiming `APEX Production Autonomous`.

The halt must happen in code, before the LLM is even asked to decide. When the runtime detects a halt condition, it does not construct a decision context, does not call the model, does not generate an intent. It records the refusal reason, waits for the condition to clear, and resumes only after all halt conditions are resolved.

### 1. Quote State Is Stale

The quote resource carries a `timestamp` (or `as_of`) and a `stale_after_ms` value. If `current_time > reference_timestamp + stale_after_ms`, the quote is stale. For retail FX, typical staleness thresholds are 500-2000 ms. For crypto, 200-1000 ms.

**Why this matters:** A stale quote means the runtime does not know the current market price. An order sized or priced against a stale quote may execute at a materially different level. For a market order, this means unexpected slippage. For a limit order, the agent may place a resting order at a price that is already through the market.

**What happens:** The runtime refuses to generate a decision context. No model call occurs. The runtime logs the refusal: `halt_reason: quote_stale, instrument: APEX:FX:EURUSD, last_update: 1711234567890, stale_after_ms: 1000, current_time: 1711234569100`. When fresh quotes resume (new `notifications/resources/updated` for the quote resource with a current timestamp), the runtime clears the halt and resumes.

### 2. Account/Risk State Is Stale

The account summary, positions, orders, and risk resources all carry freshness metadata. If any of these is stale, the runtime cannot reliably assess margin availability, current exposure, or kill switch state.

**Why this matters:** The agent might size a new position based on margin availability that no longer reflects reality. A fill might have occurred moments ago, consuming margin that the stale state still shows as available. The result is overexposure — the agent holds more risk than it intended.

**What happens:** Same pattern as quote staleness. The runtime halts, logs the specific stale resource, and waits. Typical account state staleness thresholds are 2000-10000 ms.

### 3. Sequence Continuity Broken

Every execution-critical resource carries a monotonically increasing `sequence`. The runtime tracks the last observed sequence for each resource. If a newly received resource has a sequence that skips ahead unexpectedly, or if the runtime detects a gap it cannot explain, continuity is broken.

**Why this matters:** A sequence gap means the runtime missed a state transition. Maybe a fill happened and the positions resource jumped from sequence 47 to sequence 49. The runtime does not know what happened at sequence 48. Trading on incomplete state is trading blind.

**What happens:** The runtime halts and attempts to rebuild state. It re-reads all execution-critical resources from the broker. If the rebuild succeeds (all resources return current, consistent state with no unexplained gaps), the runtime clears the halt and resumes. If rebuild fails, the runtime remains halted until an operator intervenes. The broker returns `APEX_4025` (sequence continuity broken) if the runtime attempts to submit an order during a sequence gap.

### 4. Reconnect Without Successful State Rebuild

The SSE connection dropped. The runtime reconnected. Maybe replay succeeded, maybe it failed. Either way, the runtime must rebuild its state baseline before resuming autonomous trading.

**Why this matters:** During the disconnection window, anything could have happened. Orders may have filled. The kill switch may have engaged. Positions may have changed. The runtime's cached state is a snapshot from before the disconnection — it may be completely wrong.

**What happens:** On reconnect, the runtime pauses autonomous execution immediately. It processes any replayed execution events (fills, rejections, kill switch). It re-reads ALL resources. It re-establishes freshness baselines and sequence continuity. Only after every execution-critical resource passes freshness and continuity checks does the runtime clear the halt. If replay failed (`notifications/apex.session.replay_failed`), the runtime discards all cached state entirely and rebuilds from scratch. This is the most conservative halt condition — and intentionally so, because a reconnect is the moment of greatest uncertainty.

### 5. Kill Switch Active

The kill switch is an account-level emergency stop. When active, ALL order entry is blocked. The agent cannot override it. The runtime cannot override it. It is a hard wall.

**Why this matters:** The kill switch exists for the scenario where something has gone fundamentally wrong — a loss limit has been breached, a human operator has pressed the emergency stop, or the broker's risk system has flagged the account. In all these cases, the correct response is to stop trading immediately and completely.

**What happens:** The runtime checks the `kill_switch_active` field in the risk limits resource (`apex.risk.limits`). If `true`, the runtime halts. If the runtime attempts to submit an order anyway, the broker returns `APEX_4023` (kill switch active). The kill switch is also propagated as a notification (`notifications/apex.risk.kill_switch_engaged`) and classified as `required` during replay — meaning the agent will learn about a kill switch engagement even if it was disconnected when it happened.

### 6. Instrument Restricted or Non-Tradeable

The broker reports that the instrument is restricted (listed in `restricted_instruments` in risk limits) or currently non-tradeable (instrument status from `apex.market.details`).

**Why this matters:** An instrument can become restricted for regulatory reasons, risk reasons, or operational reasons (corporate action, symbol migration, liquidity withdrawal). Attempting to trade a restricted instrument wastes a round trip and generates a rejection — or worse, in an edge case, might succeed against a stale order book.

**What happens:** The runtime checks the restricted instruments list and the instrument's tradeable status before constructing a decision context for that instrument. If restricted or non-tradeable, the runtime halts trading for that specific instrument (not necessarily the entire account). The broker returns `APEX_4031` (instrument not tradeable) if the runtime attempts to submit an order anyway.

### 7. Market-Hours Gating Disallows Orders

The market is closed, or the broker's market-hours gating does not permit new orders for this session or instrument at the current time.

**Why this matters:** Orders submitted outside market hours may queue for the next open (unintended overnight risk) or may be rejected outright (wasted round trip, confusing state for the agent). Some brokers accept orders outside hours but fill them at the open — which can be at a materially different price than the agent intended.

**What happens:** The runtime checks the instrument's market hours (from `apex.market.details` or the features resource) before constructing a decision context. If the market is closed, the runtime halts order entry for that instrument. The broker returns `APEX_4030` (market closed) if the runtime attempts to submit anyway.

**Interpreting the `trading_hours` array.** The `apex.market.details` output includes a `trading_hours` array that lists, per weekday, the open and close times with an explicit timezone. The runtime should parse this array at session start and build an in-memory schedule for each traded instrument. On every decision cycle, the runtime compares the current wall-clock time against the schedule before allowing order entry. The schedule is static for the session duration -- the agent does not need to re-query `apex.market.details` mid-session unless it receives `APEX_4030` unexpectedly, which would indicate an unscheduled market closure (holiday, emergency halt).

For 24/5 FX markets, the `trading_hours` array typically shows Monday 00:00 through Friday 23:59 UTC (or the broker's equivalent, such as Sunday 17:00 to Friday 17:00 New York time). The weekend gap -- roughly 48 hours from Friday close to Sunday open -- is implicit: days not listed in the array are non-tradeable. Agents holding positions across the weekend gap must account for the fact that prices can move significantly during the gap. The `is_tradeable` flag on the quote resource transitions to `false` at market close and back to `true` at market open, providing a real-time complement to the static schedule. The runtime should treat both signals as authoritative: if either the static schedule or the live `is_tradeable` flag says "no," the runtime halts.

Profile-specific conventions add nuance. FX brokers apply triple rollover on Wednesdays to account for the two-day settlement window spanning the weekend. An agent that holds FX positions across the Wednesday daily cut incurs three nights of rollover charges. This is not a market-hours concern per se, but it interacts with market-hours gating: an agent that plans to flatten positions before the daily cut needs to know when the cut occurs (typically 17:00 New York time for FX). The `trading_hours` timezone field provides this anchor. For crypto markets that trade 24/7, the `trading_hours` array covers all seven days and `is_tradeable` is almost always `true` -- the exception being exchange-scheduled maintenance windows, which are communicated through the `is_tradeable` flag rather than the static schedule.

### Halt Condition Summary

| # | Condition | Scope | Error Code | Clears When |
|---|---|---|---|---|
| 1 | Quote stale | Per instrument | `APEX_4024` | Fresh quote received |
| 2 | Account/risk stale | Per account | `APEX_4024` | Fresh account state received |
| 3 | Sequence gap | Per resource | `APEX_4025` | State rebuild succeeds |
| 4 | Reconnect without rebuild | Per session | N/A (runtime-side) | All resources pass freshness/continuity |
| 5 | Kill switch active | Per account | `APEX_4023` | Kill switch deactivated |
| 6 | Instrument restricted | Per instrument | `APEX_4031` | Instrument unrestricted |
| 7 | Market closed | Per instrument | `APEX_4030` | Market reopens |

---

## The Kill Switch

The kill switch deserves its own section because it is the most absolute safety mechanism in the protocol. The other halt conditions are transient — stale data becomes fresh, sequences get rebuilt, markets reopen. The kill switch is different. Once active, it stays active until a human (or the broker's risk system) explicitly deactivates it.

### What It Is

An account-level emergency stop that blocks all order entry. It is exposed through two protocol surfaces:

1. **The risk limits resource.** `apex.risk.limits` returns `kill_switch_active: true`. The runtime checks this field before every decision cycle.

2. **The kill switch notification.** `notifications/apex.risk.kill_switch_engaged` is pushed over the SSE stream when the kill switch activates. The runtime processes this notification and halts immediately — it does not need to wait for the next risk limits poll.

### How It Propagates

The kill switch propagation chain looks like this:

1. **Trigger event** occurs (daily loss limit breached, manual activation, broker risk event).
2. **Broker updates** the account's risk state internally. `kill_switch_active` becomes `true`.
3. **Risk resource updates.** The broker pushes `notifications/resources/updated` for the risk resource with the new state.
4. **Kill switch notification fires.** The broker pushes `notifications/apex.risk.kill_switch_engaged` as a separate notification. This is classified as `required` for replay — it will survive reconnection and gap fill.
5. **Runtime halts.** The runtime receives either the resource update or the dedicated notification (whichever arrives first) and immediately halts all order entry.
6. **Broker-side enforcement.** Even if the runtime fails to halt (bug, race condition, ignoring the notification), the broker rejects any order with `APEX_4023`. The kill switch is enforced at both ends.

### When It Activates

Three common triggers:

- **Daily loss limit breached.** `apex.risk.limits` reports `daily_loss_limit: -1000.00` and `daily_loss_used: -1050.00`. The broker automatically engages the kill switch.
- **Manual trigger.** A human operator activates the kill switch through the broker's risk management interface. This is the "big red button" — it works regardless of what the agent is doing.
- **Broker risk event.** The broker's internal risk systems flag the account for unusual activity, margin call, or regulatory reasons. The kill switch engages automatically.

### What the Agent Cannot Do

Once the kill switch is active:

- The agent cannot place new orders.
- The agent cannot modify existing orders.
- The agent cannot override or deactivate the kill switch.
- The agent can still read market data, account state, and position information.
- The agent can still cancel existing orders (brokers may permit this as a risk-reducing action).

The kill switch is a one-way gate from the agent's perspective. Only a human or a broker risk system can lift it.

---

## The Layered Defense Model

No single layer is sufficient. Each layer has blind spots. The safety architecture works because all four layers operate independently and any one of them can stop a bad trade.

### Layer 1: Broker-Side Risk

The broker is the ultimate gatekeeper. It controls the execution venue. It enforces:

- **Margin requirements.** The broker will not fill an order if the account lacks sufficient margin. This is a hard limit that no amount of clever protocol design can bypass.
- **Position limits.** `max_position_size` and `max_open_orders` from `apex.risk.limits`. The broker enforces these even if the runtime miscalculates.
- **Kill switch.** The broker holds the kill switch state and rejects orders with `APEX_4023` when it is active. This is the last line of defense.
- **Daily loss limits.** The broker tracks P&L and can automatically engage the kill switch when `daily_loss_used` exceeds `daily_loss_limit`.

Broker-side risk is the most reliable layer because it does not depend on the agent or runtime being correct. It is also the least granular — it catches catastrophic violations but cannot enforce the agent's specific trading strategy or risk preferences.

### Layer 2: Protocol-Level Rejection

The APEX protocol defines specific error codes that brokers must return when safety conditions are violated:

| Code | Category | Condition |
|---|---|---|
| `APEX_4024` | operational | Stale market or risk state — the broker detects that the agent's state is outdated |
| `APEX_4025` | operational | Sequence continuity broken — the agent's sequence does not match the broker's |
| `APEX_4040` | rate_limit | Request rate exceeded — the agent is calling tools too frequently |
| `APEX_4023` | risk | Kill switch active |
| `APEX_4020` | risk | Insufficient margin |
| `APEX_4021` | risk | Position limit exceeded |
| `APEX_4022` | risk | Daily loss limit reached |

These are not advisory. They are normative rejection codes. An autonomous runtime that receives `APEX_4024` must not simply retry — it must halt, rebuild state, and resume only after freshness is re-established.

Protocol-level rejection catches the case where the runtime's safety checks have a bug. The runtime thinks the data is fresh, but the broker knows it is stale. The runtime thinks the sequence is continuous, but the broker detects a gap. Layer 2 is the protocol's independent verification of what Layer 3 should have caught.

### Layer 3: Runtime-Level Gating

The runtime enforces the seven halt conditions described above. This is the most granular layer — it operates on every decision cycle, checks every resource, and gates every intent before it becomes a tool call.

- **Freshness checks.** For each cached resource: is `current_time > reference_timestamp + stale_after_ms`?
- **Sequence continuity.** For each resource: does the new sequence follow monotonically from the last observed sequence?
- **Halt condition evaluation.** Before every decision cycle: are all seven halt conditions clear?
- **Mode enforcement.** Is the runtime in a mode that permits autonomous order entry? (See the next section.)

Runtime-level gating catches the vast majority of safety issues. It is the fastest layer — it operates locally with no network round trip. But it depends on the runtime being correctly implemented, which is why Layers 1 and 2 exist as independent backstops.

### Layer 4: Human Oversight

The runtime mode system provides graduated human oversight. The most conservative modes (observe, paper, assist) keep a human in the loop. The most permissive mode (autonomous_full) removes human gating but still operates under Layers 1-3.

| Mode | Human Involvement | Risk |
|---|---|---|
| `observe` | Human sees everything, agent does nothing | Zero — read-only |
| `paper` | Human can watch, agent trades simulated | Zero — no real capital |
| `assist` | Human approves every action | Low — human veto on every trade |
| `autonomous_limited` | Human sets bounds, agent operates within them | Bounded — strict limits |
| `autonomous_full` | Human sets initial config, agent has full authority | Full — subject to Layers 1-3 |

The progression from observe to autonomous_full is intentional. An implementation should start at observe and promote through each mode only after building confidence in the agent's behavior at the previous level. This is not a theoretical recommendation — it is the only responsible way to deploy a system that trades real money with an LLM in the decision loop.

### How the Layers Interact

Consider a scenario: the agent's model decides to buy 1,000,000 EURUSD at market.

1. **Layer 4 (human oversight):** Is the runtime in `autonomous_limited`? If so, is 1,000,000 within the configured position size limit? If not, the intent is refused before it reaches the broker.
2. **Layer 3 (runtime gating):** Is the quote fresh? Is the risk state fresh? Is the kill switch inactive? If any check fails, the intent is refused.
3. **Layer 2 (protocol rejection):** The runtime submits the order. The broker checks: is the agent's state sequence consistent? Is the data fresh from the broker's perspective? If not, `APEX_4024` or `APEX_4025`.
4. **Layer 1 (broker risk):** The broker checks margin. Does the account have sufficient margin for a 1,000,000 position? If not, `APEX_4020`.

Four independent checks. Four independent veto points. The order only executes if all four layers approve.

---

## The Runtime Modes

Runtime modes are the human oversight mechanism. They control what the agent is permitted to do, independent of what the model wants to do or what the broker would allow.

### Observe

Read-only access to market data and account state. No order actions permitted.

**Permitted:** `apex.market.quote`, `apex.market.snapshot`, `apex.market.details`, `apex.market.search`, `apex.account.summary`, `apex.account.positions`, `apex.account.orders`, `apex.account.history`, `apex.risk.check`, `apex.risk.limits`, `apex.session.*`, all resource reads and subscriptions.

**Blocked:** `apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close`.

**Use case:** Validating that the agent's market analysis and decision reasoning are sound before giving it execution authority. Running the agent against live data to observe what it would do.

### Paper

Simulated order execution against live market data. No real capital at risk.

**Permitted:** Everything in observe, plus simulated order entry. The runtime intercepts order tool calls and simulates fills against the live quote stream. The agent believes it is trading; the broker never sees the orders.

**Blocked:** Real order submission to the broker.

**Use case:** Measuring the agent's strategy performance with live market conditions but zero capital risk. Identifying bugs in the decision logic before they cost money.

### Assist

Agent proposes actions that a human must approve before execution.

**Permitted:** Everything in observe, plus the agent can generate order intents. The runtime presents the intent (with full context: instrument, side, size, current quote, risk check results) to a human. The human approves or rejects.

**Blocked:** Autonomous order submission. Every order requires explicit human approval.

**Use case:** The agent handles the analysis and sizing. The human handles the final go/no-go decision. This is the safest mode that involves real capital.

### Autonomous Limited

Agent may execute within strict position size, loss, and instrument limits.

**Permitted:** Everything in observe, plus autonomous order entry — but bounded. The runtime enforces additional constraints beyond the broker's:

- Maximum position size per instrument (may be tighter than the broker's `max_position_size`)
- Maximum number of open orders (may be tighter than the broker's `max_open_orders`)
- Maximum daily loss (may be tighter than the broker's `daily_loss_limit`)
- Allowed instrument list (a subset of what the broker permits)
- Maximum order size per trade

**Blocked:** Any order that exceeds the runtime's configured limits, even if the broker would accept it.

**Use case:** Giving the agent real execution authority while bounding its maximum possible impact. The limits are set by a human before the session starts and cannot be changed by the agent during the session.

### Autonomous Full

Agent operates with full account authority subject only to broker-level risk controls.

**Permitted:** Everything. The agent can trade any instrument the broker supports, up to the broker's position limits, with the broker's margin and risk controls as the only constraints (Layers 1-3 still apply; Layer 4 does not add additional restrictions).

**Blocked:** Nothing beyond what the broker itself blocks.

**Use case:** A fully validated agent operating a production strategy that has been tested through observe, paper, assist, and autonomous_limited modes. This mode is the end state, not the starting point.

### How Modes Gate Tool Calls

Runtime modes are not a protocol-level mechanism -- they are a runtime-side enforcement layer. The APEX protocol defines the tools and their annotations, but it does not carry a "current mode" field in the session or on the wire. The runtime is responsible for maintaining its current mode, mapping that mode to a set of permitted tool namespaces, and refusing to dispatch any tool call that falls outside the permitted set.

In `observe` mode, the runtime permits only read-only tools: `apex.market.*`, `apex.account.*`, `apex.risk.*`, `apex.session.*`, and all resource reads and subscriptions. Any tool call with `destructiveHint: true` (`apex.order.place`, `apex.order.modify`, `apex.order.cancel`, `apex.position.close`) is intercepted and refused before it reaches the broker. In `paper` mode, the runtime intercepts destructive tool calls, simulates them against the live quote stream, and returns synthetic responses -- the broker never sees the request. In `assist` mode, the runtime queues the intent for human approval and only dispatches the actual tool call after explicit confirmation. In `autonomous_limited`, the runtime applies its own position size, loss, and instrument limits on top of the broker's limits before dispatching. In `autonomous_full`, no additional runtime-side limits are applied beyond the seven halt conditions and the broker's own risk controls.

Mode also affects risk checking scope. In `autonomous_limited`, the runtime runs `apex.risk.check` against both the broker's limits and its own tighter limits. A hypothetical order that passes the broker's margin check but exceeds the runtime's configured `max_position_size` is refused at the runtime layer. In `autonomous_full`, the runtime still runs risk checks (freshness, sequence, kill switch) but does not impose additional position or loss constraints. The key principle: modes are additive restrictions. Each mode adds constraints on top of the layers below it. No mode removes constraints that the protocol or broker already enforce.

### Mode Transition

| From | To | Requires |
|---|---|---|
| `observe` | `paper` | Configuration change |
| `paper` | `assist` | Configuration change |
| `assist` | `autonomous_limited` | Configuration change + limit configuration |
| `autonomous_limited` | `autonomous_full` | Configuration change + explicit acknowledgment of full authority |
| Any mode | `observe` | Configuration change (always allowed — this is the safe direction) |

Modes should be set in runtime configuration. They should not be changeable by the model during a session. The agent should not be able to promote itself from `assist` to `autonomous_full`.

---

## Pre-Trade Risk Checks

`apex.risk.check` is a pre-trade margin and exposure check. The agent submits a hypothetical order, and the broker returns the margin impact without actually placing the order.

**Input:**
```json
{
  "account_id": "string",
  "order": {
    "instrument_id": "APEX:FX:EURUSD",
    "side": "buy",
    "order_type": "market",
    "quantity": "500000"
  }
}
```

**Output:**
```json
{
  "approved": true,
  "required_margin": "2500.00",
  "available_margin": "9750.00",
  "margin_after_trade": "7250.00",
  "exposure_increase": "500000",
  "warnings": [],
  "rejection_reason": null
}
```

The check tells the agent four things: whether the order would be approved, how much margin it requires, how much margin remains after the trade, and the total exposure increase. The `warnings` array may contain advisory messages — near margin call, approaching daily loss limit, high exposure concentration.

**Why the agent should always check before placing:** The alternative is submitting the order and getting `APEX_4020` (insufficient margin) back. That wastes a round trip, creates a failed order event in the audit trail, and means the agent's decision cycle produced a rejected intent — which is a signal that the agent's understanding of its own account state was wrong. A pre-trade risk check catches this before the order is submitted.

For small orders with ample margin, the check is arguably unnecessary. For large orders, orders that significantly change the portfolio's exposure, or orders placed after a sequence of partial fills (where the margin picture may have shifted), the check is critical.

The risk check is read-only. It does not reserve margin, does not create an order, and does not modify account state. It is a snapshot: "if you placed this order right now, here is what would happen." The market can move between the check and the actual order submission, so the check is advisory — the broker still performs its own margin validation at execution time.

---

## The Partial Fill Race Condition

This is a safety issue, not just a correctness issue.

Consider this sequence:

1. The agent places a market order to buy 100,000 EURUSD.
2. The broker fills 60,000 — the order is now `partially_filled` with `remaining_quantity: 40,000`.
3. The agent's position resource updates to show 60,000 long.
4. The agent's model sees the 60,000 position and decides to buy another 50,000 to reach a target of 110,000.
5. The runtime validates the intent: current position is 60,000, new order is 50,000, total would be 110,000. Within limits. Approved.
6. The runtime submits the new order for 50,000.
7. Between steps 5 and 6, the broker fills the remaining 40,000 from the original order.
8. The agent now has: 100,000 (from the original order) + 50,000 (from the new order) = 150,000 total exposure.

The agent intended 110,000. It got 150,000. The 40,000 overexposure happened because the agent made a sizing decision based on position state that included a non-terminal order. The remaining fill from the original order was still in flight when the agent sized the second order.

**Why this is a safety issue:** Overexposure is real risk. If the 150,000 position moves against the agent, the loss is 36% larger than the agent intended. At leverage, this can be the difference between a manageable drawdown and a margin call.

**The fix:** Before sizing a new order based on position state that includes a partially filled order, the runtime must either:

1. **Wait for the order to reach a terminal state** (`filled`, `cancelled`, `rejected`, `expired`). Only then does the runtime know the final position.

2. **Cancel the remaining quantity** via `apex.order.cancel` and confirm the cancellation before proceeding. This forces the original order to terminal state.

The runtime must enforce this check in code. Do not rely on the model to reason about partial fill timing — the model does not have the timing precision or the deterministic control flow to handle this correctly.

---

## Audit Trail

Per decision, the runtime should record:

| Field | Description | Example |
|---|---|---|
| `input_uris` | Resource URIs used as decision input | `["apex://market/quote/APEX:FX:EURUSD", "apex://account/risk/ACC-001"]` |
| `input_sequences` | Sequence numbers for each input resource | `{"quote": 1847, "risk": 312}` |
| `input_freshness` | Freshness timestamps observed | `{"quote_as_of": 1711234567890, "risk_as_of": 1711234567500}` |
| `intent` | The model's output intent | `{"action": "buy", "instrument": "APEX:FX:EURUSD", "quantity": "100000"}` |
| `validation_result` | Runtime validation outcome | `{"passed": true}` or `{"passed": false, "reason": "quote_stale"}` |
| `broker_response` | Resulting tool call and broker response | `{"tool": "apex.order.place", "order_id": "ORD-789", "status": "filled"}` |
| `refusal_reason` | Why the runtime refused (if applicable) | `"kill_switch_active"` or `null` |
| `timestamp` | When the decision was made | `1711234568000` |

This is not optional. It is not a compliance checkbox. It is necessary for debugging real trading behavior.

When a trade goes wrong — and trades will go wrong — the audit trail is the only way to answer: What did the agent see? Was the data fresh? Was the sequence continuous? What did the model decide? Did the runtime approve? What did the broker return? Without this record, debugging an autonomous trading agent is guesswork.

The audit trail also serves a forward-looking purpose: it is the training data for understanding where the agent's decision-making breaks down. If the model consistently proposes orders that the runtime refuses (because risk limits are tight), that is a signal. If the model proposes well but the broker consistently rejects (because the runtime's margin estimates are wrong), that is a different signal. The audit trail is how you distinguish between these failure modes.

Record refusals with the same rigor as executions. A refusal is not a non-event — it is a decision the runtime made. The runtime decided that conditions were unsafe and prevented the trade. That decision needs the same audit trail as a successful fill.

---

## Parallels

The APEX safety architecture is not novel. It draws from established safety patterns across multiple domains.

### Exchange Circuit Breakers

Stock exchanges implement market-wide trading halts when prices move too rapidly — the NYSE's Rule 80B, CME's price limits, the EU's MiFID II circuit breaker requirements. These are automatic, deterministic, and cannot be overridden by any single market participant. APEX's kill switch is the account-level equivalent: an automatic, deterministic halt that cannot be overridden by the agent. The difference is scope — exchange circuit breakers protect the market, APEX's kill switch protects a single account — but the mechanism is identical: detect abnormal conditions, halt trading, require human intervention to resume.

### Nuclear Launch Dual-Key Systems

Nuclear launch systems require multiple independent authorization steps — the "two-man rule" ensures no single individual can initiate a launch. APEX's layered defense model applies the same principle: no single component (model, runtime, broker) can unilaterally execute a trade. The model proposes, the runtime validates, the broker enforces. Each layer operates independently, and each has veto power. The human oversight layer (runtime modes) adds a fourth key for the most sensitive operations.

### Kubernetes Admission Controllers

Kubernetes validates every resource mutation through admission controllers before it reaches the API server's persistent store. A pod spec that violates resource limits, security policies, or namespace constraints is rejected before it exists. APEX's runtime validation layer operates identically: an order intent that violates freshness constraints, risk limits, or halt conditions is rejected before it reaches the broker. The pattern is validate-before-execute — the mutation (order) passes through a deterministic validation pipeline, and rejection at any stage prevents execution.

### Aircraft Autopilot Disconnect

Commercial aircraft autopilot systems have a hard disconnect mechanism — the pilot presses a button on the yoke, and the autopilot immediately surrenders control to manual flight. This is a deterministic override that the autopilot cannot refuse. APEX's kill switch is the trading equivalent: when activated, the autonomous agent immediately loses execution authority. The agent can still observe (like instruments on a manually-flown aircraft) but cannot act. The disconnect is instant, absolute, and requires positive human action to re-engage.

### FIX Protocol PossResend and PossDupFlag

FIX protocol uses `PossResend` and `PossDupFlag` to handle message retransmission safely. A message marked `PossDupFlag=Y` tells the receiver: "you may have already seen this — check your records before acting on it." This prevents duplicate execution from replay. APEX's replay classification serves the same purpose: execution events are replayed with their original IDs, and the runtime must reconcile them against its state rather than blindly re-executing. The `gap_fill` markers serve the inverse role — they tell the agent "these events existed but are not worth replaying because current state supersedes them."

---

## Storage

This document defines behavioral contracts, not implementation mandates. The safety architecture works regardless of whether the runtime stores its state cache in memory, on disk, or in a database. The audit trail can be a structured log file, a database table, or a message queue. The halt condition evaluator can be a simple function that runs before each decision cycle.

What matters is the invariant: **the model never reaches the broker without passing through deterministic safety validation.** How that validation is implemented is an engineering choice. That it is implemented is a protocol requirement.

---

## Related Design Documents

- [Feature Resource Design](feature-resource-design.md) — the server-side computed features (regime classification, volatility, liquidity) that feed into autonomous decision-making and are subject to the freshness-based halt conditions described here
- [Freshness Design](freshness-design.md) — the staleness equation and execution-critical resource set that underpin halt conditions 1 and 2
- [Order Lifecycle Design](order-lifecycle-design.md) — the partial fill race condition and order state machine that interact with the safety architecture's sizing rules
- [Error Taxonomy Design](error-taxonomy-design.md) — the structured error codes (APEX_4023, APEX_4024, APEX_4025) that the broker returns when safety conditions are violated at the protocol level
