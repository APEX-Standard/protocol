# APEX Protocol — Audit Trail Design

**Version:** `0.2.0-alpha`

---

## Overview

When a trade goes wrong at 3 a.m. and the agent was running autonomously, the audit trail is the only thing that tells you what happened. It is not compliance decoration. It is the debug log for real money.

APEX's audit trail records every decision the runtime makes — whether that decision results in an order, a refusal, or a halt. Each record captures the full input-to-outcome path: what the agent saw, what it decided, whether the runtime approved, and what the broker returned. The goal is simple: given any trading outcome, you can trace backward through the exact data, logic, and execution that produced it.

This is the same principle behind the FIX message log (every message recorded sequentially), the flight data recorder (every instrument reading captured continuously), the database write-ahead log (every mutation recorded before applied), and the financial trade blotter (every trade documented with full context). APEX applies it to autonomous agent trading, where the decision-maker is an LLM and the stakes are real capital.

---

## The Problem

An agent placed a losing trade. Now you need to answer: Was the quote stale? Was the feature data incorrect? Did the model hallucinate a trade rationale? Was the risk check bypassed? Was there a sequence gap the agent did not detect? Was the broker slow to respond? Did the market move between the decision and the execution?

Without a structured audit trail, you are guessing. You have the MCP transcript, but it may be truncated, redacted, or missing the timing information you need. You have the broker's trade log, but it only shows what the broker saw — not what the agent saw, not what the model decided, not why the runtime approved the trade. You have the model's output, but without knowing the exact input state, you cannot tell whether the model made a reasonable decision on bad data or a bad decision on good data.

With a structured audit trail, you can trace the exact path: the agent read `apex://market/quote/APEX:FX:EURUSD` at sequence 1847, the quote had an `as_of` timestamp of `1711234567890` and was 340ms fresh, the features resource was at sequence 412 with a regime label of `trending` and confidence 0.82, the model proposed buying 100,000 EURUSD at market, the runtime validated the intent against risk limits and approved, the broker accepted the order and filled it at 1.0847, and the broker response arrived 180ms after the tool call. Every link in the chain is recorded. Every question has an answer.

---

## What To Record Per Decision

The normative fields come from the [operational semantics](../spec/core/operations.md) (Section 7) and the [agent runtime safety guide](./agent-runtime-safety-guide.md) (Section 6). A complete audit record captures the full decision cycle: input, reasoning, validation, execution, and outcome.

### Normative Fields

| Field | Description | Source |
|---|---|---|
| `input_uris` | Resource URIs used as decision input | operations.md Section 7 |
| `input_sequences` | Latest accepted sequence for each input resource | operations.md Section 7 |
| `input_freshness` | Freshness timestamps observed (`as_of` or `timestamp` for each resource) | operations.md Section 7 |
| `intent` | The model's output intent — what it wanted to do | safety guide Section 6 |
| `validation_result` | Risk validation outcome — approved or refused, and why | safety guide Section 6 |
| `broker_call` | The resulting tool call sent to the broker | operations.md Section 7 |
| `broker_response` | The broker's response to the tool call | operations.md Section 7 |
| `refusal_reason` | Why the runtime refused, if applicable | operations.md Section 7 |

These fields are not optional. They are the minimum set required to answer the question: given this outcome, what led to it?

---

## The Audit Record Structure

An audit record is one complete decision cycle. It begins when the runtime assembles the decision context and ends when the broker responds (or the runtime refuses). Here is a concrete example of a successful trade.

### Successful Trade Record

```json
{
  "decision_cycle_id": "dc-2026-0329-143207-001",
  "session_id": "sess-abc-123",
  "timestamp": 1711720327000,
  "instrument": "APEX:FX:EURUSD",
  "inputs": {
    "resources": [
      {
        "uri": "apex://market/quote/APEX:FX:EURUSD",
        "sequence": 1847,
        "as_of": 1711720326660,
        "stale_after_ms": 1000,
        "freshness_ms": 340
      },
      {
        "uri": "apex://market/features/APEX:FX:EURUSD",
        "sequence": 412,
        "as_of": 1711720326200,
        "stale_after_ms": 5000,
        "freshness_ms": 800
      },
      {
        "uri": "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
        "sequence": 88,
        "as_of": 1711720320000,
        "stale_after_ms": 120000,
        "freshness_ms": 7000
      },
      {
        "uri": "apex://account/positions/ACC-001",
        "sequence": 56,
        "as_of": 1711720325000,
        "stale_after_ms": 5000,
        "freshness_ms": 2000
      },
      {
        "uri": "apex://account/risk/ACC-001",
        "sequence": 312,
        "as_of": 1711720326000,
        "stale_after_ms": 3000,
        "freshness_ms": 1000
      }
    ],
    "resource_read_at": 1711720326700
  },
  "intent": {
    "action": "buy",
    "instrument": "APEX:FX:EURUSD",
    "quantity": "100000",
    "order_type": "market",
    "model_intent_at": 1711720327050
  },
  "validation": {
    "passed": true,
    "checks": [
      { "check": "quote_fresh", "result": "pass" },
      { "check": "risk_fresh", "result": "pass" },
      { "check": "sequence_continuous", "result": "pass" },
      { "check": "kill_switch_inactive", "result": "pass" },
      { "check": "position_within_limits", "result": "pass" },
      { "check": "instrument_tradeable", "result": "pass" }
    ],
    "validation_at": 1711720327055
  },
  "execution": {
    "tool": "apex.order.place",
    "client_order_id": "co-2026-0329-143207-001",
    "tool_call_at": 1711720327060,
    "broker_response": {
      "order_id": "ORD-789",
      "status": "filled",
      "fill_price": "1.0847",
      "fill_quantity": "100000"
    },
    "broker_response_at": 1711720327240
  }
}
```

Walk through the fields:

- **`decision_cycle_id`** — a unique identifier for this decision cycle. Ties together everything from the input read to the broker response.
- **`session_id`** — the MCP session this decision belongs to. Every record in one session shares this value.
- **`timestamp`** — when the decision cycle started.
- **`inputs.resources`** — every resource the runtime used to construct the decision context. For each: the URI, the sequence the runtime accepted, the freshness timestamp, the staleness threshold, and how fresh the data actually was at the time of read. This is the evidence — if the quote was 340ms fresh and the staleness limit was 1000ms, the runtime was justified in proceeding.
- **`intent`** — what the model wanted to do. Not a tool call — a proposal that the runtime has not yet validated.
- **`validation`** — every safety check the runtime performed and the result. If any check had failed, the record would show which one and the intent would not have been executed.
- **`execution`** — the actual broker tool call, the client order ID (for correlation with fills), and the broker's response. The `tool_call_at` and `broker_response_at` timestamps capture broker latency.

### Refused Trade Record

Now a refused trade. The runtime detected a stale quote and refused before the model was even asked to decide.

```json
{
  "decision_cycle_id": "dc-2026-0329-143215-002",
  "session_id": "sess-abc-123",
  "timestamp": 1711720335000,
  "instrument": "APEX:FX:EURUSD",
  "inputs": {
    "resources": [
      {
        "uri": "apex://market/quote/APEX:FX:EURUSD",
        "sequence": 1847,
        "as_of": 1711720326660,
        "stale_after_ms": 1000,
        "freshness_ms": 8340
      }
    ],
    "resource_read_at": 1711720335000
  },
  "intent": null,
  "validation": {
    "passed": false,
    "checks": [
      { "check": "quote_fresh", "result": "fail", "detail": "quote_age_ms: 8340, stale_after_ms: 1000" }
    ],
    "validation_at": 1711720335001
  },
  "execution": null,
  "refusal": {
    "reason": "halt_condition_active",
    "halt_condition": "quote_stale",
    "stale_resource": "apex://market/quote/APEX:FX:EURUSD",
    "last_update": 1711720326660,
    "stale_after_ms": 1000,
    "current_time": 1711720335000
  }
}
```

Note the differences: `intent` is null because the model was never asked. `execution` is null because no tool call was made. The `refusal` block captures the exact reason — the quote was 8340ms old against a 1000ms staleness limit. This record is just as important as the successful trade record. It proves the safety system was working.

---

## Refusal Records

Refusals are just as important as executions. If the runtime refused to trade because the quote was stale, that is an audit record. If the runtime refused because the kill switch was active, that is an audit record. If the runtime validated the model's intent and refused because the position would exceed limits, that is an audit record.

There are two categories of refusal:

**Pre-model refusals** happen before the LLM is invoked. The runtime evaluates the seven halt conditions defined in the [autonomous safety design](./autonomous-safety-design.md) and finds that one or more conditions are active. No decision context is constructed, no model call occurs. The audit record has a null `intent` because the model never spoke.

**Post-model refusals** happen after the model returns an intent but before the tool call reaches the broker. The model proposed an action, but the runtime's validation layer rejected it — the position size exceeds limits, the risk check failed, or a halt condition activated between the model call and the validation step. The audit record has an `intent` but a null `execution`.

Both categories get full audit records. The refusal record includes:

| Field | Description |
|---|---|
| `refusal.reason` | High-level reason: `halt_condition_active`, `validation_failed`, `risk_check_refused` |
| `refusal.halt_condition` | Which halt condition, if applicable: `quote_stale`, `risk_stale`, `sequence_gap`, `kill_switch_active`, `instrument_restricted`, `market_closed`, `reconnect_rebuild_pending` |
| `refusal.stale_resource` | The URI of the stale or gapped resource |
| `refusal.detail` | The freshness or sequence values at the time of refusal |

### Stale-Quote Refusal Walkthrough

The most common refusal in production is a stale quote. Here is how it happens and what the record looks like.

The agent is trading EURUSD. Quotes normally arrive every 200-500ms with a `stale_after_ms` of 1000. At 14:32:07.000, the last quote had an `as_of` of `1711720326660`. The next quote never arrives — maybe the broker's upstream feed lagged, maybe the SSE connection had a micro-interruption. At 14:32:07.340, the runtime begins a new decision cycle. The quote is 340ms old — still fresh. By 14:32:15.000, the runtime begins the next decision cycle. The quote is now 8340ms old. The `stale_after_ms` is 1000ms. The quote is stale by a factor of 8.

The runtime does not call the model. It records the refusal and waits. When the next fresh quote arrives (a new `notifications/resources/updated` for the quote resource), the halt condition clears and the runtime resumes. The refusal record documents the exact gap — which is valuable for two reasons: it proves the safety system was working, and it tells you how often and how long the quote feed drops out. If you see hundreds of stale-quote refusals per day, you have a feed quality problem, not a model problem.

---

## Correlation

Audit records do not exist in isolation. They form chains across time and across subsystems. Three identifiers provide the linkage.

### Decision Cycle ID

The `decision_cycle_id` ties together everything that happened in one decision cycle: the input reads, the model intent, the validation, and the execution or refusal. It is the primary key for answering "what happened in this one decision?"

If you need to debug a single trade, start with the `decision_cycle_id`. It gives you the complete input-to-outcome path in one record.

### Client Order ID

The `client_order_id` ties the placement audit record to the fill audit record. When the agent places an order via `apex.order.place`, it assigns a `client_order_id`. When the broker fills the order and sends `notifications/apex.order.filled`, the fill notification carries the same `client_order_id`. The placement record and the fill record are now linked.

This is the same pattern as FIX protocol's `ClOrdID` field — a client-assigned identifier that follows the order through its entire lifecycle. See the [order lifecycle design](./order-lifecycle-design.md) for how orders transition through states and how partial fills are tracked.

For partial fills, this linkage is especially important. A single `client_order_id` may appear in multiple fill records (one per partial fill). The chain of fill records, ordered by timestamp, tells you exactly how the order was executed: first fill at 1.0847 for 50,000 units, second fill at 1.0848 for the remaining 50,000 units.

### Session ID

The `session_id` ties all records in one MCP session together. If the agent ran for 4 hours before the session ended, every decision cycle, every refusal, every fill — they all share the same `session_id`.

This is the broadest correlation scope. Use it for session-level analysis: how many decisions did the agent make? How many were refused? What was the average latency? Did decision quality degrade over time?

### Correlation Summary

| Identifier | Scope | Links |
|---|---|---|
| `decision_cycle_id` | One decision | Input reads, model intent, validation, execution/refusal |
| `client_order_id` | One order lifecycle | Placement record, partial fills, final fill, cancellation |
| `session_id` | One MCP session | All decision cycles, all refusals, all fills in the session |

---

## Timing and Latency

Record timestamps at each stage of the decision cycle. The deltas tell you where latency lives, which is essential for diagnosing performance issues in production.

### Timestamps

| Timestamp | When | What It Measures |
|---|---|---|
| `resource_read_at` | Runtime reads cached resources for the decision context | When the decision cycle's input snapshot was taken |
| `model_intent_at` | Model returns the intent | Model inference latency (from context delivery to response) |
| `validation_at` | Runtime completes all safety checks | Validation overhead |
| `tool_call_at` | Runtime sends the tool call to the broker | Time between validation and submission |
| `broker_response_at` | Broker returns the result | Broker execution latency |

### Latency Deltas

The interesting numbers are the deltas between consecutive timestamps.

**`model_intent_at - resource_read_at`** — This is the model's decision time. If this is 500ms, the model is taking half a second to decide. For a fast market, that may be too slow — the quote the model saw may be stale by the time it responds. If this consistently exceeds `stale_after_ms` for the quote, the model is structurally too slow for the market being traded. See the [freshness design](./freshness-design.md) for how staleness thresholds interact with decision latency.

**`validation_at - model_intent_at`** — This should be negligible (single-digit milliseconds). If it is not, the runtime's validation logic is doing something expensive — maybe a synchronous risk check call. Validation must be fast because every millisecond here is a millisecond the quote is aging.

**`tool_call_at - validation_at`** — Also should be negligible. This is the runtime's internal overhead between approving the intent and sending the tool call.

**`broker_response_at - tool_call_at`** — This is the broker's execution latency. If this is 2000ms, the broker is slow. The agent cannot control this, but it should know about it. For a market order, 2000ms of broker latency means the fill price reflects a market that has moved for 2 seconds since the decision was made.

**`broker_response_at - resource_read_at`** — This is the total end-to-end latency: from reading the market state to receiving the execution result. This is the number the agent "pays" in market exposure. If the total is 3 seconds and the market moved 5 pips in those 3 seconds, the agent's fills will systematically differ from its decision-time prices by approximately that amount.

Record these deltas explicitly in the audit record. When debugging a losing trade, the first question after "was the data correct?" is often "was the execution fast enough?"

---

## Retention

The APEX spec does not mandate a retention period. Operational reality does.

**Regulatory requirements:** For regulated financial services, trade records must typically be retained for 5-7 years. In the EU, MiFID II requires firms to retain records of all orders and transactions for at least 5 years. In the US, SEC Rule 17a-4 requires 3-6 years depending on the record type. These requirements apply to the firms operating the agents, not to the protocol itself — but the audit trail is the record that satisfies them.

**Operational debugging:** Even for non-regulated alpha implementations with no regulatory obligation, retaining at least the last 30 days of audit records is recommended. Model behavior changes over time. A regression that started two weeks ago is invisible if you only have today's records. Thirty days gives you enough history to spot trends, compare performance across market regimes, and investigate incidents with full context.

**Capacity planning:** A single audit record is roughly 1-2 KB of JSON. An agent making one decision per minute generates approximately 1.4 million records per year — about 2-3 GB of raw JSON. This is trivial storage by modern standards. Even retaining years of records is feasible without aggressive compression or archival.

**Recommended minimums:**

| Context | Minimum Retention |
|---|---|
| Regulated production | Per regulatory requirement (typically 5-7 years) |
| Non-regulated production | 1 year |
| Alpha/development | 30 days |
| Paper trading | 7 days |

---

## Format and Storage

The APEX protocol does not mandate a storage format. It mandates the behavioral contract: every decision cycle produces a structured audit record with the normative fields, and those records are retained for an operationally appropriate period.

### Structured, Not Free-Text

The audit record must be structured (JSON, not free-text log lines). Free-text logs are human-readable but machine-hostile. When you need to answer "how many times did the agent refuse to trade due to stale quotes in the last 24 hours?" you need structured data you can query, not grep targets you hope are formatted consistently.

### Timestamped

Every record carries timestamps at each stage of the decision cycle. Use millisecond-precision Unix timestamps or ISO 8601 with milliseconds. The timestamps must come from a consistent clock source — if `resource_read_at` and `broker_response_at` are from different clocks, the latency deltas are meaningless.

### Append-Only

Audit records are immutable once written. You never update an audit record. You never delete an audit record (except per a retention policy that removes old records). This is the same invariant as a database write-ahead log or a FIX message log — the append-only property is what makes the trail trustworthy. If records can be edited after the fact, they are not an audit trail.

### Recommended Storage Options

| Storage | Characteristics | When To Use |
|---|---|---|
| JSONL files | One JSON object per line, append-only, trivial to implement | Alpha, development, simple deployments |
| Time-series database | Native timestamp indexing, efficient range queries, retention policies | Production with operational dashboards |
| Event store | Append-only by design, event sourcing patterns, replay capability | Production with event-driven architecture |
| Structured log pipeline | Fluentd/Vector/Logstash into Elasticsearch or similar | Production with existing observability infrastructure |

### Not Inline in the MCP Transcript

The audit trail should NOT be stored inline in the MCP transcript. MCP transcripts may be redacted, truncated, or subject to context window limits. The audit trail is a separate, independent record of what happened. It should survive regardless of what happens to the transcript. Store it in its own dedicated location — a file, a database, a queue — not embedded in the conversation history.

---

## Parallels

The APEX audit trail is not a novel concept. It applies the same principle that appears everywhere a system needs to explain its actions after the fact.

### FIX Message Log

The FIX protocol requires that every message sent or received is recorded in a flat-file sequential log. The log is append-only, timestamped, and includes the full message content. When a trade dispute arises, both sides produce their FIX logs, and the messages are compared. The APEX audit trail is the agent-side equivalent — it records every decision and every interaction with the broker, so that when a trade outcome is questioned, the full decision path is available for review.

### Financial Trade Blotter

Every trading desk maintains a blotter: a per-trade record that includes the instrument, quantity, price, time, counterparty, and trader identity. The blotter is the desk's official record of what was traded and why. The APEX audit record is the autonomous agent's blotter — except it also includes the input data state, the model's reasoning, and the runtime's validation result, because the "trader" is an LLM and its decision process is not self-evident.

### Airplane Black Box

A flight data recorder captures hundreds of parameters continuously: altitude, airspeed, heading, control inputs, engine readings. The cockpit voice recorder captures crew communications. Together, they reconstruct what happened and why. The APEX audit trail captures the equivalent: market state (the "flight parameters"), the model's intent (the "control inputs"), and the runtime's validation (the "crew communications"). When the trade "crashes," the audit trail is the black box.

### Database Transaction Log (WAL)

A write-ahead log records every database mutation before it is applied to the main store. If the database crashes, the WAL replays uncommitted transactions to restore consistency. The APEX audit trail serves a similar reconstruction purpose: given the sequence of decision records, you can replay the agent's behavior and understand the state it was in at every decision point. The WAL's append-only, sequential, timestamped properties are exactly the properties the audit trail requires.

### Kubernetes Audit Log

Kubernetes records every API call with the requesting user, the resource affected, the action taken, and the authorization decision. The audit log answers: who did what, when, and was it allowed? The APEX audit trail answers the same questions for autonomous trading: what data did the agent see, what did it decide, and did the runtime allow it?

### Medical Record

Every medical intervention is documented with the patient's condition, the diagnosis, the treatment decision, and the rationale. The record exists so that any future provider can understand what was done and why. The APEX audit record serves the same purpose for the agent's trading decisions — any future operator, debugger, or auditor can understand what the agent saw, what it decided, and whether the safety system was functioning.

---

## Cross-References

- [Autonomous Safety Design](./autonomous-safety-design.md) — the seven halt conditions that generate refusal records, the layered defense model, the core enforcement principle
- [Order Lifecycle Design](./order-lifecycle-design.md) — how `client_order_id` correlates placement and fill records across the order lifecycle
- [Freshness Design](./freshness-design.md) — how `as_of`, `timestamp`, and `stale_after_ms` determine whether a resource is fresh enough to trade on, and how those values appear in audit records
- [Sequence Design](./sequence-design.md) — how monotonic sequences enable gap detection, and how sequence values in audit records prove continuity at decision time
