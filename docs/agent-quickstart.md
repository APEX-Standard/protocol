# APEX Protocol — Agent Developer Quickstart

This guide gets you from zero to executing trades with an APEX alpha-compatible broker in under 30 minutes.

---

## Prerequisites

- An account with at least one APEX alpha-compatible broker
- Node.js 18+ or Python 3.10+

---

## Step 1: Discover Brokers

Find an APEX alpha-compatible broker that supports the profiles and instruments you need.

```typescript
// Query the registry for brokers supporting the crypto profile
const registry = await fetch("https://apexstandard.org/api/v1/brokers?profile=crypto");
const brokers = await registry.json();

// Each broker entry includes their MCP endpoint
console.log(brokers[0]);
// {
//   broker_id: "example-broker",
//   broker_name: "Example Broker",
//   mcp_endpoint: "https://mcp.example-broker.com/v1",
//   profiles: ["fx", "crypto"],
//   conformance_status: "alpha-validated",
//   ...
// }
```

---

## Step 2: Authenticate with Your Broker

APEX Protocol binds broker authentication to the MCP session. You authenticate directly with your broker, and secrets must be redacted from logs and traces.

```typescript
// Get a JWT from your broker's auth endpoint
const brokerToken = await fetch("https://auth.example-broker.com/token", {
  method: "POST",
  body: JSON.stringify({ username, password })
}).then(r => r.json()).then(r => r.access_token);
```

---

## Step 3: Connect Directly to the Broker's MCP Server

Your agent connects directly to the broker's APEX alpha-compatible MCP endpoint. All tool calls go agent-to-broker with no intermediary.

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Connect directly to the broker's MCP server
const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.example-broker.com/v1")
);

const client = new Client({ name: "my-trading-agent", version: "1.0.0" });
await client.connect(transport);

// Authenticate with the broker
const session = await client.callTool("apex.session.authenticate", {
  token: brokerToken,
  token_type: "jwt",
});

console.log("Connected to broker:", session.broker_name);
console.log("Available profiles:", session.profiles);
```

---

## Step 4: Discover What You Can Trade

```typescript
// Search for instruments
const results = await client.callTool("apex.market.search", {
  query: "EUR",
  profile: "fx",
  limit: 10
});

// Get detailed contract spec
const details = await client.callTool("apex.market.details", {
  instrument_id: "APEX:FX:EURUSD"
});

console.log(`Min trade size: ${details.min_quantity} ${details.quantity_unit}`);
console.log(`Broker display unit: ${details.broker_quantity_unit}`);
console.log(`Margin rate: ${details.margin_rate_pct}%`);
```

---

## Step 5: Check Your Account State

```typescript
const account = await client.callTool("apex.account.summary", {
  account_id: session.account_id
});

console.log(`Balance: ${account.balance} ${account.response_currency}`);
console.log(`Free margin: ${account.free_margin}`);

const positions = await client.callTool("apex.account.positions", {
  account_id: session.account_id
});

console.log(`Open positions: ${positions.positions.length}`);
```

---

## Step 6: Pre-Trade Risk Check

Always run a risk check before placing large orders:

```typescript
const riskCheck = await client.callTool("apex.risk.check", {
  account_id: session.account_id,
  order: {
    instrument_id: "APEX:FX:EURUSD",
    side: "buy",
    order_type: "market",
    quantity: 100000
  }
});

if (!riskCheck.approved) {
  throw new Error(`Order rejected: ${riskCheck.rejection_reason}`);
}

console.log(`Margin required: ${riskCheck.required_margin}`);
console.log(`Margin after trade: ${riskCheck.margin_after_trade}`);
```

---

## Step 7: Place an Order

```typescript
// Get current quote
const quote = await client.callTool("apex.market.quote", {
  instrument_id: "APEX:FX:EURUSD"
});

console.log(`Current price: ${quote.bid}/${quote.ask}`);

// Place market order with SL/TP
const order = await client.callTool("apex.order.place", {
  account_id: session.account_id,
  order: {
    instrument_id: "APEX:FX:EURUSD",
    side: "buy",
    order_type: "market",
    quantity: 10000,
    quantity_unit: "base_units",
    time_in_force: "GTC",
    stop_loss: { type: "pips", value: 50 },
    take_profit: { type: "pips", value: 100 },
    client_order_id: crypto.randomUUID(),
    comment: "my-strategy-v1",
  }
});

if (order.status === "accepted" || order.status === "filled") {
  console.log(`Order placed: ${order.order_id}`);
  console.log(`Fill price: ${order.fill_price}`);
} else {
  console.error(`Order rejected: ${order.rejection_reason}`);
}
```

---

## Step 8: Monitor and Manage

```typescript
// Check order status
const status = await client.callTool("apex.order.status", {
  account_id: session.account_id,
  order_id: order.order_id
});

// Modify SL/TP on the resulting position if the order opened one
await client.callTool("apex.order.modify", {
  account_id: session.account_id,
  target_type: "position",
  target_id: order.position_id ?? positions.positions[0].position_id,
  modifications: {
    stop_loss: { type: "price", value: 1.0800 },
    take_profit: { type: "price", value: 1.0950 },
  }
});

// Cancel a separate resting order if needed
const restingOrder = await client.callTool("apex.order.place", {
  account_id: session.account_id,
  order: {
    instrument_id: "APEX:FX:EURUSD",
    side: "buy",
    order_type: "limit",
    quantity: 10000,
    quantity_unit: "base_units",
    limit_price: 1.0700,
    time_in_force: "GTC",
  }
});

await client.callTool("apex.order.cancel", {
  account_id: session.account_id,
  order_id: restingOrder.order_id,
  reason: "strategy exit signal"
});
```

---

## Multi-Broker Trading

Since agents connect directly to each broker, multi-broker trading means managing multiple MCP connections:

```typescript
// Connect to two brokers simultaneously
const broker1 = new Client({ name: "my-agent", version: "1.0.0" });
await broker1.connect(new StreamableHTTPClientTransport(
  new URL("https://mcp.broker-one.com/v1")
));

const broker2 = new Client({ name: "my-agent", version: "1.0.0" });
await broker2.connect(new StreamableHTTPClientTransport(
  new URL("https://mcp.broker-two.com/v1")
));

// Authenticate with each
await broker1.callTool("apex.session.authenticate", { token: broker1Token, token_type: "jwt" });
await broker2.callTool("apex.session.authenticate", { token: broker2Token, token_type: "jwt" });

// Compare quotes across brokers using the same canonical instrument ID
const quote1 = await broker1.callTool("apex.market.quote", { instrument_id: "APEX:FX:EURUSD" });
const quote2 = await broker2.callTool("apex.market.quote", { instrument_id: "APEX:FX:EURUSD" });

console.log(`Broker 1 spread: ${quote1.spread}`);
console.log(`Broker 2 spread: ${quote2.spread}`);

// Execute on whichever has the better price
const bestBroker = quote1.ask < quote2.ask ? broker1 : broker2;
```

The APEX Standard ensures both brokers speak the same tool vocabulary and use the same instrument IDs — your agent code is identical regardless of which broker it's talking to.

---

## Error Handling

All APEX Protocol errors use a consistent structure:

```typescript
try {
  const result = await client.callTool("apex.order.place", { ... });
} catch (error) {
  if (error.structuredContent?.error) {
    const { code, category, message } = error.structuredContent.error;

    switch (code) {
      case "APEX_4001": // Re-authenticate
      case "APEX_4020": // Insufficient margin — reduce size
      case "APEX_4023": // Kill switch — stop trading immediately
      case "APEX_4030": // Market closed — retry after open
      case "APEX_4040": // Rate limited — back off
        // ...
    }
  }
}
```

---

## Using Canonical Instrument IDs

Always use APEX canonical instrument IDs rather than broker-native symbols. This ensures your agent works across all APEX-compatible brokers without modification.

```typescript
// ✅ Good — works across all brokers
instrument_id: "APEX:FX:EURUSD"

// ❌ Fragile — broker-specific
broker_symbol: "EUR/USD"  // FXCM format
broker_symbol: "EURUSD"   // IG format
```

Look up instrument IDs in the [APEX Instrument Taxonomy](https://apexstandard.org/spec#instruments) or use `apex.market.search` to discover them programmatically.

---

## Next Steps

- Read the [Core Spec](../spec/core/README.md) for complete tool documentation
- Read the [FX Profile](../spec/profiles/fx.md) for FX-specific capabilities
- Read the [Crypto Profile](../spec/profiles/crypto.md) for crypto spot and perpetuals
- Browse the [Instrument Registry](../spec/registry/README.md)
- Read the full standard at [apexstandard.org](https://apexstandard.org)
- Join the [APEX community](https://github.com/APEX-Standard/protocol/discussions)
