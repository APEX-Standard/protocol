# APEX Protocol — Schema Design

**Version:** `0.3.0-alpha`

---

## Overview

APEX defines 12 normative JSON Schemas that constitute the wire format contract. These schemas define exactly what bytes go over the wire between broker and agent. Every resource read, every notification payload, every event envelope must conform to one of these schemas or be structurally compatible with one.

Getting schema design right has three consequences. First, implementations can validate payloads mechanically — a JSON Schema validator can accept or reject a message without domain logic. Second, new fields can be added without breaking existing clients — the evolution rules are explicit and enforceable. Third, the boundary between core protocol data and profile-specific extensions is clear — brokers can add FX swap points or crypto funding rates without polluting the base contract.

The schemas live in `spec/core/schemas/` and are the normative reference for all payload shapes in the protocol. The prose in `README.md` and `production.md` describes intent and requirements. The schemas describe structure.

---

## The Schema Catalog

APEX ships 12 normative schemas organized into three roles: resource schemas (the shape of data returned by MCP resource reads), event schemas (the shape of immutable execution facts), and envelope schemas (the wrapper that carries notifications over the wire).

| File | Defines | Role |
|---|---|---|
| `quote.resource.schema.json` | Live bid/ask/mid/spread for one instrument | Resource schema |
| `candle.resource.schema.json` | OHLCV candle series for one instrument and timeframe | Resource schema |
| `feature.resource.schema.json` | Derived decision-ready market state (returns, volatility, regime, execution quality) | Resource schema |
| `account-summary.resource.schema.json` | Balance, equity, margin, P&L for one account | Resource schema |
| `positions.resource.schema.json` | Open positions for one account | Resource schema |
| `orders.resource.schema.json` | Working and recent orders for one account | Resource schema |
| `fills.resource.schema.json` | Recent fills for one account | Resource schema |
| `risk.resource.schema.json` | Risk limits, kill switch state, daily loss status | Resource schema |
| `decision-context.resource.schema.json` | Assembled decision context referencing all market and account resources | Resource schema |
| `fill-event.schema.json` | A single execution fill (quantity, price, commission) | Event schema |
| `order-event.schema.json` | An order lifecycle transition (accepted, filled, rejected, etc.) | Event schema |
| `notification-envelope.schema.json` | The wrapper for all APEX-specific notifications | Envelope schema |

Nine resource schemas, two event schemas, one envelope schema.

---

## Tool Output vs Resource Schema

The spec draws a deliberate line between tool responses and resource schemas. Section 6.1 of the core spec states: "Tool responses are not required to include resource-layer metadata. When a tool returns the same conceptual data as a resource, the tool output should be structurally compatible but may omit `sequence` and `stale_after_ms`."

Walk through a concrete example. The agent calls `apex.market.quote` (a tool). The broker returns:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "bid": "1.08740",
  "ask": "1.08760",
  "mid": "1.08750",
  "spread": "0.00020",
  "timestamp": "2026-03-27T14:30:00.123Z",
  "is_tradeable": true,
  "market_status": "open"
}

```

The agent reads `apex://market/quote/APEX:FX:EURUSD` (a resource). The broker returns:

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "bid": "1.08740",
  "ask": "1.08760",
  "mid": "1.08750",
  "spread": "0.00020",
  "timestamp": "2026-03-27T14:30:00.123Z",
  "is_tradeable": true,
  "market_status": "open",
  "sequence": 184467,
  "stale_after_ms": 1000
}
```

The resource schema is a strict superset. It has every field the tool returns plus `sequence` and `stale_after_ms`. The same decoder can parse both — it just needs to treat the extra fields as optional when handling tool responses and required when handling resource reads.

Why this distinction matters: tools are for one-shot queries. The agent asks "what's the current quote?" and gets an answer. Resources are for continuous state. The agent subscribes to the quote resource and expects every update to carry a monotonic sequence for gap detection, plus a staleness window for autonomous safety enforcement. Forcing `sequence` and `stale_after_ms` into tool responses would add overhead to simple queries and confuse the semantics — a tool response is not a state snapshot in a stream, it's a point-in-time answer.

The practical rule: if you are writing a decoder, make `sequence` and `stale_after_ms` optional fields. If you are writing an autonomous runtime that reads resources, require them. If you are writing a broker, include them in resource responses, omit them from tool responses unless you have a reason to include them.

---

## The additionalProperties Policy

JSON Schema's `additionalProperties` keyword controls whether a payload may contain fields not listed in the schema. APEX schemas use both `true` (permissive) and `false` (sealed), and the choice is deliberate.

### Sealed schemas (additionalProperties: false)

Most schemas are sealed at the top level:

- `quote.resource.schema.json` — sealed
- `candle.resource.schema.json` — sealed (candle items also sealed)
- `account-summary.resource.schema.json` — sealed
- `positions.resource.schema.json` — sealed at top level
- `orders.resource.schema.json` — sealed at top level
- `fills.resource.schema.json` — sealed
- `decision-context.resource.schema.json` — sealed (with sealed `market` and `account` sub-objects)
- `fill-event.schema.json` — sealed
- `order-event.schema.json` — sealed
- `notification-envelope.schema.json` — sealed

Sealed means: the broker must not add arbitrary top-level fields. If a validator receives a payload with an unknown field, it rejects it. This protects the contract between broker and agent. The decision context is the most important example — it is the input surface that an autonomous model sees. Random top-level additions to the decision context would change the model's input shape without the spec's knowledge. That contract must be tight.

### Permissive schemas (additionalProperties: true)

Two resource schemas are permissive at the top level:

- `feature.resource.schema.json` — permissive
- `risk.resource.schema.json` — permissive

Features are permissive because brokers may expose additional derived data — book depth features, flow metrics, proprietary signals — beyond the required minimum. The feature schema requires `quote`, `returns`, `volatility`, `regime`, and `execution`, but a broker can add `book`, `flow`, `momentum`, or any other feature group as a top-level key. The agent ignores what it doesn't understand. The validator passes what it doesn't recognize.

Risk is permissive for a similar reason. Different brokers enforce different risk constraints. The schema requires the core set (kill switch, position limits, daily loss), but a broker might add `max_drawdown`, `overnight_exposure_limit`, or `leverage_tier` without breaking the base contract.

### Permissive items within sealed containers

Some schemas are sealed at the top level but permissive at the item level. Positions and orders follow this pattern. The `positions.resource.schema.json` top-level object is sealed — it has `account_id`, `as_of`, `positions`, `total_unrealised_pnl`, `sequence`, `stale_after_ms`, nothing else. But each position item within the `positions` array has `additionalProperties: true`. This lets brokers attach position-level metadata (swap rates, margin tier, broker-specific flags) without breaking the container schema.

The same pattern applies to order items. The top-level orders resource is sealed, but each order object within the array is permissive.

### Permissive sub-objects

Within the feature schema, `returns` and `volatility` use `additionalProperties` with a type constraint — any additional key must be a number. This lets brokers add `r_5s`, `r_30s`, `r_5m` to returns or `rv_15m`, `rv_1h` to volatility without schema changes, as long as the values are numeric. The `execution` sub-object is explicitly `additionalProperties: true`, allowing brokers to add execution quality metrics like `effective_spread_bps` or `fill_rate_estimate`.

The design rationale: permissive where brokers need to extend, sealed where the contract must be predictable.

---

## Required vs Optional Fields

Every resource schema has a `required` array. The fields that appear in every resource schema's required set follow a pattern.

### Identity fields

Market-scoped resources require `instrument_id`. Account-scoped resources require `account_id`. The decision context requires `instrument_id` because it is market-scoped even though it references account resources. These fields answer the question: what entity does this payload describe?

The `instrument_id` field carries a pattern constraint: `^APEX:[A-Z]+:[A-Z0-9:.]+$`. This is not just a string — it is a structured identifier with asset-class and symbol components. Every schema that includes `instrument_id` enforces the same regex. Consistency matters: an implementation that validates one schema's `instrument_id` can reuse the same validator for all of them.

### Freshness fields

Every resource requires either `timestamp` or `as_of`. The quote and decision context schemas use `timestamp`. The candle, feature, account summary, positions, orders, fills, and risk schemas use `as_of`. Both are ISO 8601 date-time strings. The semantic difference: `timestamp` marks when the data was observed (a point-in-time snapshot), while `as_of` marks when the data was computed (an aggregation boundary). In practice, both answer the same question: how old is this data?

### Integrity fields

Every resource requires `sequence` — a monotonically increasing integer (minimum 0). Sequence is the gap detection mechanism. If the agent sees sequence 184467 and then 184469, it knows it missed an update. Sequence is per resource URI instance: the counter for `apex://market/quote/APEX:FX:EURUSD` is independent of the counter for `apex://market/quote/APEX:FX:GBPJPY`.

### Staleness fields

Every resource requires `stale_after_ms` — an integer (minimum 1) declaring the freshness window in milliseconds. After `timestamp + stale_after_ms` (or `as_of + stale_after_ms`), the data is stale. Autonomous runtimes must refuse order entry against stale data. This is not advisory — it is a hard safety constraint defined in `production.md` Section 1.4.

### The common required set

| Field | Present in | Purpose |
|---|---|---|
| `instrument_id` | Market resources, decision context, event schemas | Entity identity |
| `account_id` | Account resources, event schemas | Entity identity |
| `timestamp` or `as_of` | All resources, all events | Freshness |
| `sequence` | All resources, notification envelope | Gap detection |
| `stale_after_ms` | All resources | Autonomous safety |

### Optional fields

Some fields are defined in a schema but not listed in `required`. In the positions schema, `stop_loss`, `take_profit`, `broker_quantity`, `broker_quantity_unit`, `unrealised_pnl_currency`, and `profile_data` are all optional on position items. In the orders schema, `client_order_id`, `limit_price`, and `stop_price` are optional (nullable). In the risk schema, `margin_call_level_pct` and `stop_out_level_pct` are optional — not all brokers expose margin call mechanics.

The rule: a field is required when the agent cannot make safe decisions without it. A field is optional when it adds value but its absence does not create ambiguity or safety risk.

---

## The Envelope Pattern

The `notification-envelope.schema.json` defines the wrapper for all APEX-specific notifications. Every notification pushed over the SSE stream — fills, rejections, kill switch events, candle closes — uses this envelope.

```json
{
  "event_id": "evt_a1b2c3d4",
  "event_type": "apex.order.filled",
  "account_id": "ACC_12345",
  "instrument_id": "APEX:FX:EURUSD",
  "resource_uri": "apex://account/fills/ACC_12345",
  "timestamp": "2026-03-27T14:30:00.123Z",
  "sequence": 42,
  "payload": { ... }
}
```

The envelope has four required fields (`event_id`, `event_type`, `timestamp`, `sequence`) and four optional fields (`account_id`, `instrument_id`, `resource_uri`, `payload`). The optional fields are situational — a session-level event like `replay_failed` has no `instrument_id`, while a fill event has both `account_id` and `instrument_id`.

Why a consistent envelope matters:

**Unified parsing.** Every notification, regardless of type, has the same outer shape. A consumer can deserialize the envelope, inspect `event_type`, and dispatch to the appropriate handler without knowing the full taxonomy of event types in advance. This is the same pattern as Protocol Buffers' `oneof` or a tagged union — the envelope is the discriminator.

**Correlation.** The `resource_uri` field links the event to the resource it affects. When a fill event arrives with `resource_uri: "apex://account/fills/ACC_12345"`, the agent knows to re-read that resource. The `account_id` and `instrument_id` fields enable direct correlation to positions, orders, and risk state without parsing the inner payload.

**Replay classification.** The replay mechanism (see `replay-design.md`) classifies events by their `event_type`. The envelope gives the replay engine a consistent field to inspect without deserializing the payload. Events with `event_type` matching `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`, or `apex.risk.kill_switch_engaged` are replayed. Everything else is elided into gap fill markers.

**Ordering.** The `sequence` field in the envelope carries the current sequence for the affected resource. Combined with the SSE event ID (which provides stream-level ordering), this gives the agent two orthogonal ordering guarantees: stream position and resource version.

The envelope is sealed (`additionalProperties: false`). No implementation may add top-level fields to the envelope. Extension data goes inside `payload`.

---

## Event Schemas vs Resource Schemas

The two event schemas — `fill-event.schema.json` and `order-event.schema.json` — are fundamentally different from resource schemas. Resources are mutable state snapshots: the quote changes, positions change, orders change. Events are immutable facts: a fill happened at a specific price, an order was rejected for a specific reason. Resources are overwritten. Events are appended.

### Fill events

The `fill-event.schema.json` defines the payload for a single execution fill:

```json
{
  "fill_id": "fill_001",
  "order_id": "ord_abc123",
  "account_id": "ACC_12345",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "fill_quantity": "100000",
  "fill_price": "1.08755",
  "commission": "-0.50",
  "commission_currency": "USD",
  "liquidity_flag": "taker",
  "position_id": "pos_001",
  "timestamp": "2026-03-27T14:30:00.123Z"
}
```

Every field is required. There is no `sequence` or `stale_after_ms` — fills are not stateful resources, they are historical records. A fill does not become stale. It happened.

### Order events

The `order-event.schema.json` defines the payload for an order lifecycle transition:

```json
{
  "order_id": "ord_abc123",
  "client_order_id": "agent-uuid-xxx",
  "account_id": "ACC_12345",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "order_type": "market",
  "quantity": "100000",
  "status": "filled",
  "filled_quantity": "100000",
  "remaining_quantity": "0",
  "average_fill_price": "1.08755",
  "reason": null,
  "updated_at": "2026-03-27T14:30:00.123Z"
}
```

Again, every field is required. The `reason` field is nullable — it carries a rejection reason when `status` is `rejected`, and is `null` otherwise. The `client_order_id` is also nullable — it is present when the agent provided one on order entry.

### Nesting: envelope wraps event

Events do not travel alone. They travel inside the notification envelope. The full wire shape is:

```
JSON-RPC notification
  └── method: "notifications/apex.order.filled"
  └── params: (notification envelope)
        ├── event_id, event_type, timestamp, sequence, ...
        └── payload: (fill-event schema)
              ├── fill_id, order_id, fill_price, ...
```

The envelope provides correlation and ordering metadata. The event schema provides the domain-specific facts. The separation is clean: the envelope is the same for all notification types, the payload varies by `event_type`.

### Reuse: fills resource references fill events

The `fills.resource.schema.json` uses `$ref` to reference `fill-event.schema.json` for its array items. The fills resource is a collection of fill events with resource-level metadata (`account_id`, `as_of`, `sequence`, `stale_after_ms`) wrapped around it. This means the same fill object appears in two contexts: as a notification payload (inside an envelope) and as an item in the fills resource (inside a resource wrapper). Same schema, same shape, same validation.

---

## Schema Extension Through Profiles

APEX is asset-class agnostic at the core layer, but brokers need to expose profile-specific data — FX swap points, CFD funding rates, crypto margin tiers. The extension mechanism is the `profile_data` field.

The pattern: the base schema defines `profile_data` as an optional object with no required properties. The base schema validator accepts any content in `profile_data` (or its absence). Profile-specific validators can be layered on top to enforce profile-specific constraints.

This pattern appears explicitly in the positions resource. Each position item includes:

```json
"profile_data": { "type": "object" }
```

A CFD broker might populate it with:

```json
"profile_data": {
  "funding_rate": 0.0003,
  "next_funding_time": "2026-03-28T00:00:00Z",
  "leverage_tier": 20
}
```

An FX broker might populate it with:

```json
"profile_data": {
  "swap_long": -0.42,
  "swap_short": 0.18,
  "rollover_time": "17:00 EST"
}
```

The base schema validation passes in both cases. The `profile_data` field is the designated extension point — it is where profile-specific data belongs. This is preferable to sprinkling arbitrary fields across the payload, because it keeps the core contract clean and makes the extension boundary explicit.

The order placement tool uses the same pattern. The input schema for `apex.order.place` includes `profile` (which profile this order targets — `fx`, `cfd`, `crypto`, etc.) and `profile_data` (profile-specific order parameters). The base tool handler processes the core fields. The profile-specific handler processes `profile_data`.

For schemas that use `additionalProperties: true` (features, risk), the distinction is less sharp — brokers can add top-level keys. But even in those schemas, `profile_data` remains the recommended extension point for data that is clearly profile-specific rather than generally applicable.

---

## Schema Evolution Rules

The schema evolution rules from `stability.md` Section 4 define what changes are safe during alpha and what changes are breaking.

### The four rules

1. **Required fields may only be added** if the capability or profile claim that depends on them is also tightened in the same change. You cannot add a new required field to `quote.resource.schema.json` without simultaneously updating the production capability profile to advertise that it expects the new field. This prevents a schema from requiring something that existing implementations do not provide.

2. **Existing required fields keep meaning, type, and units.** If `fill_price` is a string-encoded decimal in `fill-event.schema.json` today, it is a string-encoded decimal tomorrow. If `spread` means ask minus bid today, it means ask minus bid tomorrow. If `quantity` is in base units today, it is in base units tomorrow. Changing the meaning of an existing field — including its wire encoding — is an incompatible change, full stop.

   > **Note (v0.2.0-alpha):** All monetary, price, rate, P&L, margin, and quantity fields are encoded as **string-decimals** (JSON `string` matching `^-?[0-9]+(\.[0-9]+)?$`), never as IEEE-754 `number`. This mirrors FIX, which carries prices as ASCII decimals for exact, reproducible values. Doubles cannot exactly represent decimal prices (e.g. `1.08745`), so a trading/audit protocol must carry exact decimals. This encoding is now part of the type guarantee above. The change from JSON `number` to string-decimal was made in `0.2.0-alpha` (see the migration note in `version-stability-design.md`); from `0.2.0-alpha` onward the string-decimal encoding is frozen under this rule.

3. **Optional fields may be added freely.** Adding `margin_call_level_pct` to the risk schema as an optional field is safe — existing validators ignore it, existing consumers never depended on it. This is the primary mechanism for forward-compatible schema growth.

4. **Incompatible changes require a new schema file and an explicit migration note.** If a change cannot be made additively — renaming a field, changing a type, removing a required field — it goes into a new schema. The old schema is deprecated with a documented migration path.

### The three labels

Changes are classified with one of three labels:

| Label | Definition | Example |
|---|---|---|
| `additive` | New optional fields, new schemas, new notification types | Adding `rv_15m` to the volatility object |
| `behavior-tightening` | New required fields with corresponding capability tightening | Adding a new required risk field alongside a Production Realtime profile update |
| `incompatible` | Removes or redefines existing surface | Renaming `fill_price` to `execution_price` |

Additive changes are always safe. Behavior-tightening changes are safe if the capability advertisement mechanism is followed. Incompatible changes are never safe without a new schema and migration guidance.

This model is directly inspired by Protocol Buffers' compatibility rules (never remove required fields, never change field types) and Avro's reader/writer schema evolution (readers tolerate unknown fields, writers include all required fields). The difference is that APEX schemas are JSON Schema, not a binary IDL, so the validation tooling is widely available and the schemas are human-readable.

---

## Parallels

APEX's schema design draws on established schema systems. The parallels are instructive.

**OpenAPI/Swagger schemas.** OpenAPI uses JSON Schema to define API request and response bodies. APEX does the same for resource and event payloads. The `additionalProperties` policy, the `required` array, the `format: "date-time"` annotation — these are all standard JSON Schema patterns that OpenAPI popularized. The difference: OpenAPI schemas describe HTTP APIs, APEX schemas describe MCP resources and notifications.

**Protocol Buffers.** Protobuf enforces strict field numbering and type safety. Required fields must always be present. Optional fields may be absent. Unknown fields are preserved on the wire. APEX achieves the same guarantees through JSON Schema's `required` and `additionalProperties` keywords. The Protobuf lesson that APEX internalizes: never change the meaning of an existing field, and never remove a required field without a version break.

**Avro.** Avro's reader/writer schema model allows readers to tolerate fields they don't recognize and writers to add fields readers haven't seen yet. APEX's permissive schemas (`additionalProperties: true` on features, risk, and item-level objects) follow this principle. The base schema is the reader schema. The broker's extended payload is the writer schema. As long as the required fields are present, the reader succeeds.

**GraphQL.** GraphQL's type system supports backwards-compatible additions — new fields, new types — without breaking existing queries. APEX's additive evolution rule mirrors this: optional fields may be added freely, new schemas may be introduced, and existing consumers continue to work.

**SQL DDL.** Adding a column with `ALTER TABLE ADD COLUMN ... DEFAULT NULL` is a safe migration. Dropping a column or changing its type is a breaking migration. APEX's schema evolution rules map directly: adding an optional field is the JSON Schema equivalent of `ADD COLUMN NULL`, adding a required field is `ADD COLUMN NOT NULL` (requires coordination), and removing a field is `DROP COLUMN` (incompatible).

**XML Schema.** XML Schema distinguishes between extension (adding new elements to a type) and restriction (constraining an existing type). APEX makes the same distinction: `additionalProperties: true` enables extension, `additionalProperties: false` enforces restriction. The design choice between the two is driven by the same question XML Schema designers ask: does the consumer need a predictable shape, or does the producer need room to extend?

---

## Cross-References

- `version-stability-design.md` — evolution guarantees, alpha surface classes, deprecation policy
- `profile-layering-design.md` — how profiles extend base schemas, the `profile_data` convention
- `resource-tool-design.md` — the tool-vs-resource boundary, structural compatibility model
- `notification-architecture-design.md` — envelope design, replay classification, event taxonomy
