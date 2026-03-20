# APEX Protocol — Layer 1: Core Specification

**Version:** `0.1.0-alpha`  
**Status:** Draft — open for comment  
**Last Updated:** 2026-03-10

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

---

## 1. Session Domain

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
  "profiles": ["fx", "cfd", "crypto"],                        // active asset class profiles
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
  "apex_version": "0.1.0",
  "broker_id": "string",
  "core_tools": ["apex.session.*", "apex.account.*", "apex.order.*", "apex.market.*", "apex.risk.*"],
  "profiles": {
    "fx": "0.1.0",
    "cfd": "0.1.0",
    "crypto": "0.1.0"
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
  "supported_tif": ["GTC", "IOC", "FOK", "DAY"]
}
```

---

### `apex.session.heartbeat`

Keep-alive ping. Brokers should respond within 500ms or the hub marks the session degraded.

**Input:** `{ "timestamp": "ISO8601" }`  
**Output:** `{ "timestamp": "ISO8601", "status": "ok" }`

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
  "balance": 10000.00,
  "equity": 10250.00,
  "used_margin": 500.00,
  "free_margin": 9750.00,
  "margin_level_pct": 2050.00,
  "unrealised_pnl": 250.00,
  "realised_pnl_today": 0.00,
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
      "quantity": 100000,
      "quantity_unit": "base_units|shares|contracts",
      "broker_quantity": "1.0",
      "broker_quantity_unit": "lots",
      "open_price": 1.0850,
      "current_price": 1.0875,
      "unrealised_pnl": 250.00,
      "unrealised_pnl_currency": "USD",
      "used_margin": 500.00,
      "open_time": "ISO8601",
      "stop_loss": 1.0800,
      "take_profit": 1.1000,
      "profile_data": {}   // Profile-specific fields appended here
    }
  ],
  "total_unrealised_pnl": 250.00,
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
      "quantity": 100000,
      "quantity_unit": "base_units|shares|contracts",
      "limit_price": 1.0800,
      "stop_price": null,
      "time_in_force": "GTC",
      "status": "working|partially_filled|filled|cancelled|rejected|expired",
      "filled_quantity": 0,
      "remaining_quantity": 100000,
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
      "event_subtype": "fill|rollover|funding_fee|commission|deposit|withdrawal|dividend_adjustment|split|other",
      "instrument_id": "APEX:FX:EURUSD",
      "side": "buy|sell",
      "quantity": 100000,
      "open_price": 1.0850,
      "close_price": 1.0900,
      "pnl": 500.00,
      "pnl_currency": "USD",
      "commission": -7.00,
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
    "quantity": 100000,
    "quantity_unit": "base_units|shares|contracts",
    "time_in_force": "GTC|IOC|FOK|DAY",

    "limit_price": null,
    "stop_price": null,

    "stop_loss": {
      "type": "price|pips|percent",
      "value": 1.0800
    },
    "take_profit": {
      "type": "price|pips|percent",
      "value": 1.1200
    },
    "trailing_stop": {
      "type": "pips|percent",
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
  "fill_price": 1.0875,
  "fill_quantity": 100000,
  "remaining_quantity": 0,
  "position_id": "string",   // Present when the order immediately results in an open position
  "rejection_reason": null,
  "created_at": "ISO8601"
}
```

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
    "stop_loss": { "type": "price", "value": 1.0810 },
    "take_profit": { "type": "price", "value": 1.1100 },
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
  "bid": 1.08740,
  "ask": 1.08760,
  "mid": 1.08750,
  "spread": 0.00020,
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
      "open": 1.0850,
      "high": 1.0890,
      "low": 1.0840,
      "close": 1.0875,
      "volume": 125000
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
  "profile": "fx|cfd|crypto|derivatives|fixed_income",
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
  "pip_size": 0.0001,
  "lot_size": 100000,
  "quantity_unit": "base_units",
  "broker_quantity_unit": "lots",
  "min_quantity": 1000,
  "max_quantity": 50000000,
  "quantity_step": 1000,
  "margin_rate_pct": 0.5,
  "commission_per_lot": 0.0,
  "spread_type": "variable|fixed",
  "typical_spread_pips": 0.8,
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
    "quantity": 500000
  }
}
```

**Output:**
```json
{
  "approved": true,
  "required_margin": 2500.00,
  "available_margin": 9750.00,
  "margin_after_trade": 7250.00,
  "exposure_increase": 500000,
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
  "max_position_size": 5000000,
  "max_open_orders": 50,
  "daily_loss_limit": -1000.00,
  "daily_loss_used": -150.00,
  "margin_call_level_pct": 100,
  "stop_out_level_pct": 50,
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
    "category": "auth|validation|risk|broker|rate_limit|internal",
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
