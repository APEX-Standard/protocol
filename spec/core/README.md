# APEX Protocol — Layer 1: Core Specification

**Version:** `0.3.0-alpha`  
**Status:** Draft — open for comment  
**Last Updated:** 2026-07-23

---

## Overview

Layer 1 Core defines the mandatory baseline that every APEX Protocol alpha-compatible implementation must implement. It is asset-class agnostic. An implementation that supports only Layer 1 is still a valid APEX Protocol participant.

Layer 1 covers five capability domains:

| Domain | Prefix | Description |
|--------|--------|-------------|
| Session | `apex.session.*` | Authentication, capability discovery, keep-alive |
| Account | `apex.account.*` | Balances, positions, orders, history |
| Orders | `apex.order.*` | Order entry, modification, cancellation, status |
| Market Data | `apex.market.*` | Quotes, snapshots, instrument discovery |
| Risk | `apex.risk.*` | Pre-trade checks, account limits |

Layer 1 Core is tool-complete for basic interoperability, but APEX is designed for agent-native trading workflows rather than request/response polling alone. Production-grade APEX implementations should therefore expose a realtime state layer over MCP resources and notifications in addition to the mandatory tools defined below.

### Agent-Native Model

APEX adopts the following design principles for agent-native trading:

- Tools are primarily for actions and explicit queries.
- Resources are the primary interface for live state.
- MCP subscriptions and notifications are the primary interface for change.
- HTTP with SSE is the alpha interoperability transport for remote realtime sessions.
- Agents should consume structured market/account/risk state, not raw unbounded tick text streams.
- Candle series and derived features are first-class state alongside quotes and order events.

Unless otherwise stated, the tool requirements in this document remain the interoperability baseline. The resource and notification model defined in Section 6 is the production architecture for agent-native APEX sessions, even where the current executable conformance suite has not yet been expanded to test every requirement in that section.

Production capability claims and normative realtime schemas are defined in:

- [`production.md`](./production.md)
- [`stability.md`](./stability.md)
- [`execution-semantics.md`](./execution-semantics.md)
- [`operations.md`](./operations.md)
- [`schemas/`](./schemas/)

For alpha network transport compatibility, implementations may expose either:

- MCP Streamable HTTP with SSE support, or
- MCP HTTP+SSE compatibility transport

As long as they preserve the same APEX resource, tool, and notification semantics.

---

## 1. Session Domain

#### Version Advertisement

During the MCP `initialize` handshake, the server should include the APEX protocol version in the `serverInfo` metadata:

```json
{
  "serverInfo": {
    "name": "broker-name",
    "version": "1.0.0",
    "apex_version": "0.3.0-alpha"
  }
}
```

Agents should check `apex_version` in the `initialize` response before calling any APEX tools. If the version is incompatible, the agent should disconnect gracefully rather than encounter tool-not-found errors.

### `apex.session.authenticate`

Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session.

**Security requirements:**
- Brokers and clients **must** use a secure transport for remote MCP sessions (for example HTTPS/TLS).
- Tokens and other secrets passed to this tool **must not** be logged, traced, or echoed back in responses.
- Hosts that persist MCP transcripts **must** redact the `token` field before storage.
- When transport-level authentication is available, brokers may bind `apex.session.authenticate` to an already-authenticated session and treat the tool call as session activation rather than primary login.

**Input:**
```json
{
  "token": "string",           // Broker-issued JWT or OAuth token
  "token_type": "jwt|oauth2",
  "account_id": "string",      // Optional — broker may derive from token
  "hub_session_id": "string"   // Optional session reference from caller
}
```

**Output:**
```json
{
  "session_id": "string",
  "account_id": "string",
  "expires_at": "ISO8601",
  "capabilities": ["apex.session.*", "apex.account.*", "..."],  // tool namespaces available in this session
  "profiles": ["fx", "cfd", "crypto", "futures"],             // active asset class profiles
  "broker_id": "string",
  "broker_name": "string"
}
```

---

### `apex.session.capabilities`

Query the full capability manifest of a connected broker. Returns all supported tools, profiles, and vendor extensions.

**Input:** `{}`

**Output:**
```json
{
  "apex_version": "0.3.0-alpha",
  "broker_id": "string",
  "core_tools": ["apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*"],
  "profiles": {
    "fx": "0.2.0",
    "cfd": "0.2.0",
    "crypto": "0.2.0"
  },
  "vendor_extensions": {
    "namespace": "fxcm",
    "tools": ["fxcm.sentiment.index", "fxcm.signal.feed"]
  },
  "rate_limits": {
    "orders_per_second": 10,
    "market_data_per_second": 100
  },
  "supported_order_types": ["market", "limit", "stop", "stop_limit"],
  "supported_tif": ["GTC", "IOC", "FOK", "DAY"],
  "realtime_contract": {
    "transport_mode": "streamable_http",
    "reconnect_mode": "session_replay",
    "max_retention_events": 10000,
    "max_retention_seconds": 0,
    "quote_freshness_ms": 1000,
    "account_freshness_ms": 2000
  }
}
```

---

### `apex.session.heartbeat`

Keep-alive ping. Brokers should respond within 500ms or the hub marks the session degraded.

**Input:** `{ "timestamp": "ISO8601" }`
**Output:** `{ "timestamp": "ISO8601", "status": "ok" }`

---

### `apex.session.acknowledge`

Acknowledge receipt of SSE events through the given event ID. The server discards events at or before the acknowledged ID to reclaim storage.

**Annotations:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `last_event_id` | string | yes | The last SSE event ID the agent has fully processed |

**Output:**

| Field | Type | Description |
|-------|------|-------------|
| `acknowledged_through` | string | The event ID acknowledged |
| `buffer_depth` | integer | Number of unacknowledged events remaining in the event log |

---

## 2. Account Domain

### `apex.account.summary`

Current account state — balances, margin utilisation, equity.

**Input:**
```json
{
  "account_id": "string",
  "currency": "string"   // Optional — response currency. Defaults to account base currency.
}
```

**Output:**
```json
{
  "account_id": "string",
  "account_base_currency": "USD",
  "response_currency": "USD",
  "balance": "10000.00",
  "equity": "10250.00",
  "used_margin": "500.00",
  "free_margin": "9750.00",
  "margin_level_pct": "2050.00",
  "unrealised_pnl": "250.00",
  "realised_pnl_today": "0.00",
  "as_of": "ISO8601"
}
```

---

### `apex.account.positions`

All open positions with live P&L.

**Input:**
```json
{
  "account_id": "string",
  "instrument_id": "string",   // Optional filter — APEX canonical ID
  "profile": "string"          // Optional filter — e.g. "fx", "cfd"
}
```

**Output:**
```json
{
  "positions": [
    {
      "position_id": "string",
      "instrument_id": "APEX:FX:EURUSD",
      "broker_symbol": "EURUSD",
      "side": "buy|sell",
      "quantity": "100000",
      "quantity_unit": "base_units|shares|contracts",
      "broker_quantity": "1.0",
      "broker_quantity_unit": "lots",
      "open_price": "1.0850",
      "current_price": "1.0875",
      "unrealised_pnl": "250.00",
      "unrealised_pnl_currency": "USD",
      "used_margin": "500.00",
      "open_time": "ISO8601",
      "stop_loss": "1.0800",
      "take_profit": "1.1000",
      "profile_data": {}   // Profile-specific fields appended here
    }
  ],
  "total_unrealised_pnl": "250.00",
  "as_of": "ISO8601"
}
```

---

### `apex.account.orders`

Known orders and their current lifecycle state.

**Input:**
```json
{
  "account_id": "string",
  "status": "working|partially_filled|filled|cancelled|rejected|expired|all",
  "instrument_id": "string"   // Optional filter
}
```

**Output:**
```json
{
  "orders": [
    {
      "order_id": "string",
      "client_order_id": "string",
      "instrument_id": "APEX:FX:EURUSD",
      "broker_symbol": "EURUSD",
      "side": "buy|sell",
      "order_type": "limit",
      "quantity": "100000",
      "quantity_unit": "base_units|shares|contracts",
      "limit_price": "1.0800",
      "stop_price": null,
      "time_in_force": "GTC",
      "status": "working|partially_filled|filled|cancelled|rejected|expired",
      "filled_quantity": "0",
      "remaining_quantity": "100000",
      "created_at": "ISO8601",
      "updated_at": "ISO8601"
    }
  ]
}
```

---

### `apex.account.history`

Closed trades and funding events.

**Input:**
```json
{
  "account_id": "string",
  "from": "ISO8601",
  "to": "ISO8601",
  "event_type": "trade|funding|cash|corporate_action|all",
  "limit": 100,
  "cursor": "string"   // Pagination cursor
}
```

**Output:**
```json
{
  "events": [
    {
      "event_id": "string",
      "event_type": "trade|funding|cash|corporate_action",
      "event_subtype": "fill|rollover|funding_fee|variation_margin|commission|deposit|withdrawal|dividend_adjustment|split|other",
      "instrument_id": "APEX:FX:EURUSD",
      "side": "buy|sell",
      "quantity": "100000",
      "open_price": "1.0850",
      "close_price": "1.0900",
      "pnl": "500.00",
      "pnl_currency": "USD",
      "commission": "-7.00",
      "open_time": "ISO8601",
      "close_time": "ISO8601"
    }
  ],
  "next_cursor": "string",
  "has_more": true
}
```

---

## 3. Orders Domain

### `apex.order.place`

Unified order entry. The canonical order object — composable by asset class profile.

**Canonical quantity model:**
- `quantity` and `quantity_unit` use APEX-normalised sizing, not broker-native display units.
- `base_units` is the mandatory canonical unit for FX and crypto spot instruments.
- `shares` is the mandatory canonical unit for equity CFDs.
- `contracts` is the mandatory canonical unit for index CFDs, commodity CFDs, and derivatives.
- Brokers may expose broker-native sizing in read models via `broker_quantity` and `broker_quantity_unit`, but order entry must accept the canonical unit for the instrument.

**Order lifecycle:**
- `accepted` means the broker acknowledged the request but has not yet exposed a terminal or resting state.
- `working` means the order is resting and cancellable.
- `partially_filled` means the order has executed in part and may still be modified or cancelled if broker rules allow.
- `filled`, `cancelled`, `rejected`, and `expired` are terminal states.

**Input:**
```json
{
  "account_id": "string",
  "order": {
    "instrument_id": "APEX:FX:EURUSD",
    "broker_symbol": "EURUSD",
    "side": "buy|sell",
    "order_type": "market|limit|stop|stop_limit",
    "quantity": "100000",
    "quantity_unit": "base_units|shares|contracts",
    "time_in_force": "GTC|IOC|FOK|DAY",

    "limit_price": null,
    "stop_price": null,

    "stop_loss": {
      "type": "price|pips|ticks|percent",
      "value": "1.0800"
    },
    "take_profit": {
      "type": "price|pips|ticks|percent",
      "value": "1.1200"
    },
    "trailing_stop": {
      "type": "pips|ticks|percent",
      "value": 20
    },

    "profile": "fx",
    "profile_data": {},

    "client_order_id": "agent-uuid-xxx",
    "strategy_id": "optional-strategy-ref",
    "comment": "string"
  }
}
```

**Output:**
```json
{
  "order_id": "string",
  "client_order_id": "string",
  "status": "accepted|working|rejected|filled|partially_filled",
  "fill_price": "1.0875",
  "fill_quantity": "100000",
  "remaining_quantity": "0",
  "position_id": "string",   // Present when the order immediately results in an open position
  "rejection_reason": null,
  "created_at": "ISO8601"
}
```

Protective offset types are instrument-convention dependent: `pips` applies to FX-style instruments, `ticks` to tick-based instruments (listed futures — see the [Futures Profile](../profiles/futures.md)); brokers reject offset types that are not meaningful for the instrument.

#### Idempotency

Brokers must reject a duplicate `client_order_id` within the same session and return the original order response. If the agent does not provide a `client_order_id`, the broker assigns one. This prevents duplicate order submission on transport retry.

Agents must generate a unique `client_order_id` (e.g., UUID) for every order submission. If a tool call times out without a response, the agent must retry with the same `client_order_id` — the broker will either return the original result or reject the duplicate.

---

### `apex.order.modify`

Amend a working order or an open position's protection settings.

**Target-specific rules:**
- When `target_type` is `"position"`, only `stop_loss`, `take_profit`, and `trailing_stop` are valid modifications.
- When `target_type` is `"order"`, brokers may support `limit_price`, `stop_price`, and `quantity` in addition to protection fields if the order type permits amendment.
- Brokers must reject invalid field combinations with `APEX_4011`.

**Input:**
```json
{
  "account_id": "string",
  "target_type": "order|position",
  "target_id": "string",
  "modifications": {
    "limit_price": null,
    "stop_price": null,
    "quantity": null,
    "stop_loss": { "type": "price", "value": "1.0810" },
    "take_profit": { "type": "price", "value": "1.1100" },
    "trailing_stop": null
  }
}
```

**Output:**
```json
{
  "target_type": "order|position",
  "target_id": "string",
  "status": "modified|rejected",
  "rejection_reason": null,
  "updated_at": "ISO8601"
}
```

---

### `apex.order.cancel`

Cancel a working or partially filled order.

**Input:**
```json
{
  "account_id": "string",
  "order_id": "string",
  "reason": "string"   // Optional agent-provided reason for audit trail
}
```

**Output:**
```json
{
  "order_id": "string",
  "status": "cancelled|rejected",
  "rejection_reason": null,
  "cancelled_at": "ISO8601"
}
```

---

### `apex.order.status`

Query the current state of a single order.

**Input:**
```json
{
  "account_id": "string",
  "order_id": "string"
}
```

**Output:** Same schema as single order object from `apex.account.orders`.

---

### `apex.position.close`

Close an open position fully or partially. This is a convenience tool equivalent to placing an opposite-direction market order for the position's quantity. Brokers must support this as a first-class operation.

**Annotations:** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `account_id` | string | yes | Account ID |
| `position_id` | string | yes | Position to close |
| `quantity` | string (decimal) | no | Partial close quantity. If omitted, close the full position. |

**Output:**

| Field | Type | Description |
|-------|------|-------------|
| `order_id` | string | The order ID of the closing order |
| `position_id` | string | The position that was closed |
| `status` | string | `filled`, `partially_filled`, or `rejected` |
| `fill_price` | string (decimal) | Execution price |
| `fill_quantity` | string (decimal) | Quantity closed |
| `remaining_quantity` | string (decimal) | Remaining position quantity (0 if fully closed) |
| `rejection_reason` | string | Reason if rejected |
| `closed_at` | string | ISO 8601 timestamp |

---

## 4. Market Data Domain

### `apex.market.quote`

Current bid/ask/mid for an instrument.

**Input:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD"   // Optional — if instrument_id not known
}
```

**Output:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "bid": "1.08740",
  "ask": "1.08760",
  "mid": "1.08750",
  "spread": "0.00020",
  "timestamp": "ISO8601",
  "is_tradeable": true,
  "market_status": "open|closed|pre_market|post_market"
}
```

---

### `apex.market.snapshot`

OHLCV candle data.

**Input:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timeframe": "M1|M5|M15|M30|H1|H4|D1|W1|MN",
  "from": "ISO8601",
  "to": "ISO8601",
  "limit": 200
}
```

**Output:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timeframe": "H1",
  "candles": [
    {
      "time": "ISO8601",
      "open": "1.0850",
      "high": "1.0890",
      "low": "1.0840",
      "close": "1.0875",
      "volume": 125000,
      "complete": true
    }
  ]
}
```

---

### `apex.market.search`

Discover instruments by keyword, asset class, or profile.

**Input:**
```json
{
  "query": "EUR",
  "profile": "fx|cfd|crypto|futures|fixed_income",
  "limit": 20
}
```

**Output:**
```json
{
  "instruments": [
    {
      "instrument_id": "APEX:FX:EURUSD",
      "broker_symbol": "EURUSD",
      "display_name": "Euro / US Dollar",
      "profile": "fx",
      "is_tradeable": true
    }
  ]
}
```

---

### `apex.market.details`

Full contract specification for an instrument.

**Input:**
```json
{
  "instrument_id": "APEX:FX:EURUSD"
}
```

**Output:**
```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "display_name": "Euro / US Dollar",
  "profile": "fx",
  "base_currency": "EUR",
  "quote_currency": "USD",
  "pip_size": "0.0001",
  "lot_size": 100000,
  "quantity_unit": "base_units",
  "broker_quantity_unit": "lots",
  "min_quantity": "1000",
  "max_quantity": "50000000",
  "quantity_step": "1000",
  "margin_rate_pct": "0.5",
  "commission_per_lot": "0.0",
  "spread_type": "variable|fixed",
  "typical_spread_pips": "0.8",
  "trading_hours": [
    { "day": "monday", "open": "00:00", "close": "23:59", "timezone": "UTC" }
  ],
  "profile_data": {}
}
```

---

## 5. Risk Domain

### `apex.risk.check`

Pre-trade margin and exposure check. Agents should call this before placing large orders.

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

---

### `apex.risk.limits`

Current account-level risk limits and utilisation.

**Input:** `{ "account_id": "string" }`

**Output:**
```json
{
  "account_id": "string",
  "max_position_size": "5000000",
  "max_open_orders": 50,
  "daily_loss_limit": "-1000.00",
  "daily_loss_used": "-150.00",
  "margin_call_level_pct": "100",
  "stop_out_level_pct": "50",
  "restricted_instruments": [],
  "kill_switch_active": false
}
```

---

## Error Handling

All tools return errors in a consistent envelope:

```json
{
  "error": {
    "code": "APEX_4001",
    "category": "auth|validation|risk|operational|broker|rate_limit|internal",
    "message": "Human-readable description",
    "details": {},
    "request_id": "string",
    "retry_after": null   // Seconds, for rate_limit errors
  }
}
```

### Standard Error Codes

| Code | Category | Description |
|------|----------|-------------|
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

## Annotations

All APEX Protocol tools carry MCP annotations for agent guidance:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|------|---------------|-------------------|-----------------|
| `apex.session.authenticate` | false | false | true |
| `apex.session.capabilities` | true | false | true |
| `apex.session.heartbeat` | true | false | true |
| `apex.account.*` | true | false | true |
| `apex.order.place` | false | true | false |
| `apex.order.modify` | false | true | false |
| `apex.order.cancel` | false | true | true |
| `apex.order.status` | true | false | true |
| `apex.market.*` | true | false | true |
| `apex.risk.*` | true | false | true |
| `apex.fx.*` (all) | true | false | true |
| `apex.cfd.*` (all) | true | false | true |
| `apex.crypto.funding_rate` | true | false | true |
| `apex.crypto.liquidation_estimate` | true | false | true |
| `apex.crypto.transfer` | false | false | false |

---

## 6. Agent-Native Realtime State Model

### 6.1 Scope

This section defines the production architecture for realtime, agent-native APEX implementations.

The goal is to let an agent maintain live market awareness without repeatedly polling tools for every state transition. A conforming agent-native implementation must expose decision-ready state through MCP resources, support subscriptions to those resources, and deliver change events over MCP notifications.

**Tool responses vs resource schemas:** The tool output shapes defined in Sections 1–5 are the interoperability baseline. Resource schemas (in `schemas/`) extend that shape with realtime metadata fields (`sequence`, `stale_after_ms`). Tool responses are not required to include resource-layer metadata. When a tool returns the same conceptual data as a resource, the tool output should be structurally compatible but may omit `sequence` and `stale_after_ms`.

The recommended division of responsibility is:

- tools for order entry, modification, cancellation, explicit snapshots, and explicit checks
- resources for continuously changing market, account, and risk state
- notifications for resource updates and urgent event delivery
- deterministic code outside the model for feed handling, feature computation, throttling, and hard risk enforcement

### 6.2 Transport

For remote sessions, APEX recommends MCP Streamable HTTP with SSE-enabled server-to-client delivery.

- Clients should use Streamable HTTP for request/response traffic.
- Clients that require live state should open and maintain the server-to-client SSE stream.
- Servers must deliver resource updates and urgent notifications over that stream.
- Servers must support resumable streams when the underlying MCP transport supports SSE event IDs and replay semantics.
- Servers must document whether update delivery is best-effort or replayable across reconnects.
- Servers must expose enough metadata for clients to detect stale state, sequence gaps, and replay boundaries.

### 6.3 Resource Categories

Agent-native APEX servers must expose the following resource categories.

Market state:

- `apex://market/quote/{instrument_id}`
- `apex://market/candles/{instrument_id}?timeframe=M1&limit=200`
- `apex://market/candles/{instrument_id}?timeframe=M5&limit=200`
- `apex://market/candles/{instrument_id}?timeframe=H1&limit=200`
- `apex://market/features/{instrument_id}`

The `apex://market/book/` and `apex://market/trades/` URI families are reserved for future specification. Order book depth and trade flow resources are not required for alpha.

Account state:

- `apex://account/summary/{account_id}`
- `apex://account/positions/{account_id}`
- `apex://account/orders/{account_id}`
- `apex://account/fills/{account_id}`
- `apex://account/risk/{account_id}`

Agent/runtime state:

- `apex://agent/decision-context/{instrument_id}`

The `apex://agent/` namespace is reserved for agent-facing resources. Currently, only `apex://agent/decision-context/{instrument_id}` is defined. Additional agent resources (watchlist, intents, memory) are reserved for future specification.

Resource URIs are stable identifiers for current state, not append-only event logs. If a resource changes frequently, servers must emit update notifications and let clients re-read the resource rather than overloading tool calls.

### 6.4 Quote Resource

**URI:**

```text
apex://market/quote/APEX:FX:EURUSD
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "broker_symbol": "EURUSD",
  "bid": "1.08740",
  "ask": "1.08760",
  "mid": "1.08750",
  "spread": "0.00020",
  "timestamp": "ISO8601",
  "is_tradeable": true,
  "market_status": "open|closed|pre_market|post_market",
  "sequence": 184467,
  "stale_after_ms": 1000
}
```

Normative schema: [`schemas/quote.resource.schema.json`](./schemas/quote.resource.schema.json)

Notes:

- `sequence` must increase monotonically for updates within a session.
- `stale_after_ms` tells the agent when the quote must be considered stale for autonomous trading decisions.
- Servers must not mark a quote tradeable when the quote is already stale.
- If a quote is no longer suitable for execution, servers must either publish `is_tradeable: false` or transition the corresponding risk/account state such that autonomous execution is rejected deterministically.

### 6.5 Candle Resource

**URI:**

```text
apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timeframe": "M1",
  "partial_candle_included": true,
  "as_of": "ISO8601",
  "candles": [
    {
      "time": "ISO8601",
      "open": "1.0850",
      "high": "1.0890",
      "low": "1.0840",
      "close": "1.0875",
      "volume": 125000,
      "complete": true
    }
  ],
  "sequence": 1,
  "stale_after_ms": 60000
}
```

Normative schema: [`schemas/candle.resource.schema.json`](./schemas/candle.resource.schema.json)

Requirements:

- Servers must support at least `M1`, `M5`, and `H1`.
- Servers must clearly distinguish completed candles from the currently forming candle using `complete`.
- Candle updates must be emitted on candle close, and may also be emitted intrabar when partial candles are exposed.
- Candle time boundaries must be aligned to the declared timeframe in UTC unless a profile explicitly defines another market convention.
- If a partial candle is published, its `time` field must refer to the candle open time, not the last tick time.

### 6.6 Feature Resource

The feature resource is the canonical decision-ready market state object for agents.

**URI:**

```text
apex://market/features/APEX:FX:EURUSD
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "as_of": "ISO8601",
  "sequence": 1,
  "stale_after_ms": 2000,
  "quote": {
    "bid": "1.08740",
    "ask": "1.08760",
    "mid": "1.08750",
    "spread": "0.00020"
  },
  "returns": {
    "r_1s": 0.00002,
    "r_5s": 0.00005,
    "r_1m": 0.00080
  },
  "volatility": {
    "rv_1m": 0.12,
    "rv_5m": 0.37,
    "rv_30m": 0.55
  },
  "book": {
    "top_level_imbalance": 0.21,
    "depth_imbalance": 0.18,
    "microprice": 1.08753
  },
  "flow": {
    "trade_intensity_30s": 0.67,
    "aggressor_imbalance_30s": 0.44
  },
  "regime": {
    "label": "trend_up|trend_down|range|volatile|illiquid|transitional|other",
    "confidence": 0.81
  },
  "execution": {
    "liquidity_score": 0.79,
    "expected_slippage_bps": 0.6
  }
}
```

Normative schema: [`schemas/feature.resource.schema.json`](./schemas/feature.resource.schema.json)

Production implementations must expose enough derived state that an agent can reason over trend, volatility, spread, liquidity, and short-horizon flow without parsing raw event streams directly.

The following feature groups are required:

- quote state: `bid`, `ask`, `mid`, `spread`
- short-horizon returns: at least three windows including `1m`
- realized volatility: at least `1m` and `5m`
- execution quality: liquidity and expected slippage estimate
- regime classification: label plus confidence

Regime labels: `"transitional"` indicates that regime detection identifies a transition state between regimes (e.g., trend exhaustion before reversal or range breakout). `"other"` is an escape hatch for regimes outside the standard taxonomy, allowing broker-specific or strategy-specific labels to degrade gracefully.

Book and flow features are strongly recommended and should be present whenever the broker has access to the underlying market data.

### 6.7 Account and Risk Resources

For autonomous workflows, the account and risk state must also be subscribable:

- `apex://account/summary/{account_id}`
- `apex://account/positions/{account_id}`
- `apex://account/orders/{account_id}`
- `apex://account/fills/{account_id}`
- `apex://account/risk/{account_id}`

Normative schemas:
- [`schemas/account-summary.resource.schema.json`](./schemas/account-summary.resource.schema.json)
- [`schemas/positions.resource.schema.json`](./schemas/positions.resource.schema.json)
- [`schemas/orders.resource.schema.json`](./schemas/orders.resource.schema.json)
- [`schemas/fills.resource.schema.json`](./schemas/fills.resource.schema.json)
- [`schemas/risk.resource.schema.json`](./schemas/risk.resource.schema.json)

At minimum, these resources must include:

- freshness timestamp
- current positions and open orders
- available margin and margin utilisation
- current realised and unrealised P&L
- broker-enforced risk flags such as kill switch state, trading restrictions, and daily loss status
- data freshness metadata
- a monotonically increasing sequence for each resource stream

### 6.8 Decision Context Resource

The decision context resource is a required production convenience resource that packages the current market, candle, account, and risk state for one instrument into a single model-ready object.

**URI:**

```text
apex://agent/decision-context/APEX:FX:EURUSD
```

**Schema:**

```json
{
  "instrument_id": "APEX:FX:EURUSD",
  "timestamp": "ISO8601",
  "sequence": 1,
  "stale_after_ms": 5000,
  "market": {
    "quote_resource": "apex://market/quote/APEX:FX:EURUSD",
    "feature_resource": "apex://market/features/APEX:FX:EURUSD",
    "candle_resources": [
      "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
      "apex://market/candles/APEX:FX:EURUSD?timeframe=M5&limit=200",
      "apex://market/candles/APEX:FX:EURUSD?timeframe=H1&limit=200"
    ]
  },
  "account": {
    "summary_resource": "apex://account/summary/ACC_12345",
    "positions_resource": "apex://account/positions/ACC_12345",
    "orders_resource": "apex://account/orders/ACC_12345",
    "risk_resource": "apex://account/risk/ACC_12345"
  },
  "constraints": {
    "kill_switch_active": false,
    "max_position_size": "5000000",
    "max_open_orders": 50
  }
}
```

Normative schema: [`schemas/decision-context.resource.schema.json`](./schemas/decision-context.resource.schema.json)

This resource exists to reduce prompt assembly cost and to provide a stable, broker-independent context object for agent frameworks.

### 6.9 Subscription Semantics

Servers must support MCP resource subscriptions for all realtime resources in this section.

Required semantics:

- clients subscribe to the canonical resource URI
- when the underlying state changes, the server emits `notifications/resources/updated`
- the client re-reads the resource to obtain the latest value
- servers may coalesce high-frequency updates to avoid unnecessary downstream load

When updates are coalesced, a resource read returns the current state at time of read. Intermediate states that were coalesced are never recoverable through resource reads. The `sequence` value at time of read reflects the latest state, not the number of updates the client observed. Agents that need tick-by-tick history should use candle resources or fill events, not resource polling.

- if an agent requires direct push payloads in addition to resource invalidation, servers may emit APEX-specific notifications as defined below
- if updates are coalesced, `sequence` must still allow the client to detect missed intermediate states
- if a replay boundary is crossed and a full replay is not possible, the server must force the client to re-read the resource and treat cached state as potentially incomplete
- clients must assume subscriptions are level-triggered invalidation signals, not guaranteed delivery of every market micro-event, unless the server explicitly documents stronger delivery semantics

Production implementations must not require agents to poll `apex.market.quote`, `apex.account.positions`, or `apex.account.orders` on a fixed short interval when equivalent realtime resources are available.

### 6.10 Freshness And Staleness

Every realtime resource in this section must include:

- `as_of` or `timestamp`
- `sequence`
- a freshness limit expressed as `stale_after_ms` or an equivalent documented field

Autonomous agents and runtimes must treat a resource as stale when:

- current time exceeds `timestamp + stale_after_ms`
- the transport reconnects and the client cannot prove replay continuity
- sequence continuity is broken and the resource has not yet been re-read

Production APEX runtimes must refuse autonomous order entry when any required execution input is stale, including at minimum:

- quote state
- account/risk state
- instrument trading status

### 6.11 Sequencing, Replay, And Gap Handling

Production realtime feeds require explicit sequence semantics.

- Each subscribable realtime resource must expose a monotonically increasing `sequence`.

The `sequence` counter is per resource URI instance. The sequence for `apex://market/quote/APEX:FX:EURUSD` is independent of the sequence for `apex://market/quote/APEX:FX:GBPJPY`. Implementations must not share a single sequence counter across multiple resource URIs.

- Each notification that refers to a realtime resource must include the latest known `sequence` for that resource.
- Servers should preserve replay continuity across transient reconnects whenever the underlying transport supports it.
- If replay is supported, servers must document the retention window.
- If replay is not supported, servers must document that reconnection requires a full resource refresh.

Client obligations:

- detect non-monotonic or skipped sequences
- invalidate local cache on gap detection
- re-read the affected resource before using it for decisions
- halt autonomous execution when sequence continuity cannot be restored for execution-critical resources

### 6.12 APEX Notification Taxonomy

In addition to MCP-standard resource update notifications, APEX defines the following notification types. The first seven are mandatory for Production Realtime implementations. The remaining are recommended for richer agent-native workflows.

#### Mandatory Notifications

| Notification | Trigger |
|---|---|
| `notifications/apex.order.filled` | Order fills completely |
| `notifications/apex.order.partially_filled` | Order partially fills |
| `notifications/apex.order.rejected` | Order is rejected (stale data, kill switch, risk limit, etc.) |
| `notifications/apex.market.candle_closed` | A candle bar completes on a wall-clock boundary |
| `notifications/apex.risk.kill_switch_engaged` | Kill switch is activated |
| `notifications/apex.session.replay_failed` | SSE reconnect replay cannot be satisfied from the event log |
| `notifications/apex.session.gap_fill` | Consecutive ephemeral notifications were elided during replay |

#### Mandatory Payload Shapes

Each mandatory notification must include a `params` object following the event envelope structure below. The `payload` field within `params` carries event-specific data as defined here.

**`notifications/apex.order.filled`**

```json
{
  "params": {
    "event_id": "evt_a1b2c3d4",
    "event_type": "notifications/apex.order.filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.123Z",
    "sequence": 42,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08755",
      "fill_quantity": "100000",
      "commission": "-0.5",
      "position_id": "pos_001"
    }
  }
}
```

**`notifications/apex.order.partially_filled`**

```json
{
  "params": {
    "event_id": "evt_b2c3d4e5",
    "event_type": "notifications/apex.order.partially_filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.456Z",
    "sequence": 43,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08760",
      "fill_quantity": "50000",
      "remaining_quantity": "50000"
    }
  }
}
```

**`notifications/apex.order.rejected`**

```json
{
  "params": {
    "event_id": "evt_c3d4e5f6",
    "event_type": "notifications/apex.order.rejected",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/orders/ACC_12345",
    "timestamp": "2026-03-27T14:30:01.000Z",
    "sequence": 44,
    "payload": {
      "order_id": "ord_def456",
      "code": "STALE_QUOTE",
      "reason": "Quote data is stale; order rejected"
    }
  }
}
```

**`notifications/apex.market.candle_closed`**

```json
{
  "params": {
    "event_id": "evt_d4e5f6g7",
    "event_type": "notifications/apex.market.candle_closed",
    "account_id": null,
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200",
    "timestamp": "2026-03-27T14:31:00.000Z",
    "sequence": 45,
    "payload": {
      "instrument_id": "APEX:FX:EURUSD",
      "timeframe": "M1",
      "open": "1.08750",
      "high": "1.08780",
      "low": "1.08740",
      "close": "1.08765",
      "volume": 1500000,
      "complete": true
    }
  }
}
```

**`notifications/apex.risk.kill_switch_engaged`**

```json
{
  "params": {
    "event_id": "evt_e5f6g7h8",
    "event_type": "notifications/apex.risk.kill_switch_engaged",
    "account_id": "ACC_12345",
    "instrument_id": null,
    "resource_uri": "apex://account/risk/ACC_12345",
    "timestamp": "2026-03-27T14:32:00.000Z",
    "sequence": 46,
    "payload": {
      "account_id": "ACC_12345",
      "reason": "Daily loss limit exceeded"
    }
  }
}
```

**`notifications/apex.session.replay_failed`**

```json
{
  "params": {
    "event_id": "evt_f6g7h8i9",
    "event_type": "notifications/apex.session.replay_failed",
    "account_id": null,
    "instrument_id": null,
    "resource_uri": null,
    "timestamp": "2026-03-27T14:33:00.000Z",
    "sequence": null,
    "payload": {
      "reason": "event_id_outside_event_log",
      "last_available_id": 502
    }
  }
}
```

Sent when the client reconnects with a `Last-Event-ID` that has been evicted from the event log. With acknowledgment-driven retention, this only occurs when the server's maximum retention limit is exceeded with unacknowledged events. The client must treat this as a sequence discontinuity: discard cached state, re-read all resources, and re-establish baseline before resuming autonomous execution.

- `notifications/apex.session.gap_fill` — Emitted during replay to indicate that consecutive ephemeral notifications were elided. Carries `elided_count`, `from_id`, and `to_id`. The agent must re-read all resources on reconnect; the gap fill marker indicates the range of skipped resource-update notifications.

#### Replay Classification

Each notification is classified for replay behavior:

- **`required`**: `apex.order.filled`, `apex.order.partially_filled`, `apex.order.rejected`, `apex.risk.kill_switch_engaged` — replayed with original event IDs on reconnect.
- **`elide`**: `notifications/resources/updated`, `apex.market.candle_closed` — collapsed into `apex.session.gap_fill` markers during replay. Current resource state supersedes.
- **Always sent**: `apex.session.replay_failed`, `apex.session.gap_fill` — meta-notifications about the replay mechanism itself.

#### Recommended Additional Notifications

The following notifications are recommended for richer agent workflows but are not mandatory for Production Realtime compliance:

- `notifications/apex.market.quote_moved`
- `notifications/apex.market.regime_changed`
- `notifications/apex.market.volatility_spike`
- `notifications/apex.order.accepted`
- `notifications/apex.order.cancelled`
- `notifications/apex.risk.limit_warning`

#### Event Envelope

Every APEX notification follows this envelope structure. The envelope structure is formalized in [`schemas/notification-envelope.schema.json`](schemas/notification-envelope.schema.json). The complete event as sent over the wire is a JSON-RPC 2.0 notification wrapping the `params` object:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/apex.order.filled",
  "params": {
    "event_id": "evt_a1b2c3d4",
    "event_type": "notifications/apex.order.filled",
    "account_id": "ACC_12345",
    "instrument_id": "APEX:FX:EURUSD",
    "resource_uri": "apex://account/fills/ACC_12345",
    "timestamp": "2026-03-27T14:30:00.123Z",
    "sequence": 42,
    "payload": {
      "order_id": "ord_abc123",
      "side": "buy",
      "fill_price": "1.08755",
      "fill_quantity": "100000",
      "commission": "-0.5",
      "position_id": "pos_001"
    }
  }
}
```

The `event_type` field within `params` intentionally mirrors the JSON-RPC `method` field. This exists so that agents consuming `params` as a standalone payload — stripped from the JSON-RPC wrapper — still have the event type available for routing. Agents processing the full JSON-RPC envelope can use `method` instead.

Production event requirements:

- `event_id` must be unique within the session
- `event_type` must be stable and machine-routable
- `timestamp` must reflect broker event time or broker processing time; servers must document which
- `sequence` must be monotonic for the referenced resource stream (null for session-level events like `replay_failed`)
- `resource_uri` must point to the canonical resource that should be refreshed (null when no single resource applies)

#### Cross-Resource Ordering

Notification delivery order within a session's SSE stream is deterministic, but no causal ordering is guaranteed across notifications referencing different resource streams. Agents must not assume that the arrival order of notifications across different resources reflects the true temporal ordering of the underlying events. Use resource timestamps and sequences for temporal reasoning, not notification arrival order.

### 6.13 Order And Fill Event Payloads

Order and fill events are execution-critical and must have stable payloads.

For order lifecycle notifications, `payload` must include:

```json
{
  "order_id": "string",
  "client_order_id": "string|null",
  "account_id": "string",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy",
  "order_type": "market",
  "quantity": "100000",
  "status": "accepted|working|partially_filled|filled|cancelled|rejected|expired",
  "filled_quantity": "10000",
  "remaining_quantity": "0",
  "average_fill_price": "1.08755",
  "reason": null,
  "updated_at": "ISO8601"
}
```

Normative schema: [`schemas/order-event.schema.json`](./schemas/order-event.schema.json)

For fill notifications, `payload` must include:

```json
{
  "fill_id": "string",
  "order_id": "string",
  "account_id": "string",
  "instrument_id": "APEX:FX:EURUSD",
  "side": "buy|sell",
  "fill_quantity": "10000",
  "fill_price": "1.08755",
  "commission": "-0.50",
  "commission_currency": "USD",
  "liquidity_flag": "maker|taker|unknown",
  "position_id": "string|null",
  "timestamp": "ISO8601"
}
```

Normative schema: [`schemas/fill-event.schema.json`](./schemas/fill-event.schema.json)

### 6.14 Autonomous Risk Controls

Production autonomous trading requires deterministic controls outside the model.

Every production APEX implementation that permits autonomous order entry must expose and enforce:

- kill switch state
- maximum position size
- maximum open orders
- daily loss status
- restricted instruments
- market-hours gating
- stale-data rejection
- rate-limit rejection

Risk resources must surface these controls, and risk/order tools must enforce them consistently. A broker must not allow a tool call to succeed when the corresponding risk resource indicates a hard-stop condition unless the resource has already been updated to reflect a cleared state.

Recommended additional controls:

- max notional per instrument
- max aggregate exposure by asset class
- max slippage tolerance
- approval-required mode
- volatility circuit breaker

### 6.15 Decision Triggers

Production agent-native runtimes should trigger decision evaluation on a bounded set of semantically meaningful events rather than on every feed update.

Recommended trigger classes:

- candle close
- fill or partial fill
- order rejection or cancellation
- regime change
- volatility spike
- spread widening beyond configured threshold
- scheduled review interval

This trigger model should be documented per strategy/runtime and should remain deterministic outside the model.

### 6.16 Realtime Design Guidance

Agent-native APEX implementations should follow these operational rules:

- Raw market feeds should be processed by deterministic code, not directly streamed into the language model.
- Agents should reason over quotes, candles, features, positions, orders, and risk state as structured objects.
- The runtime should trigger the agent on meaningful events such as candle close, fill events, regime changes, volatility spikes, or scheduled review intervals.
- Hard controls such as size limits, kill switches, stale-data rejection, market-hours enforcement, and rate limiting must remain deterministic and outside the model.

In other words: realtime data is necessary for viable autonomous trading, but the model should consume a maintained world state, not the raw tape.
