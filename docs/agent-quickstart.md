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

// Helper: extract the APEX payload from an MCP tool result
function extractPayload(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

// Connect directly to the broker's MCP server
const transport = new StreamableHTTPClientTransport(
  new URL("https://mcp.example-broker.com/v1")
);

const client = new Client({ name: "my-trading-agent", version: "1.0.0" });
await client.connect(transport);

// Authenticate with the broker
const session = extractPayload(await client.callTool({
  name: "apex.session.authenticate",
  arguments: { token: brokerToken, token_type: "jwt" },
}));

console.log("Connected to broker:", session.broker_name);
console.log("Available profiles:", session.profiles);
```

---

## Step 4: Discover What You Can Trade

```typescript
// Search for instruments
const results = await client.callTool({
  name: "apex.market.search",
  arguments: { query: "EUR", profile: "fx", limit: 10 },
});

// Get detailed contract spec
const details = await client.callTool({
  name: "apex.market.details",
  arguments: { instrument_id: "APEX:FX:EURUSD" },
});

console.log(`Min trade size: ${details.min_quantity} ${details.quantity_unit}`);
console.log(`Broker display unit: ${details.broker_quantity_unit}`);
console.log(`Margin rate: ${details.margin_rate_pct}%`);
```

---

## Step 4A: Subscribe To Live State

APEX is designed for agent-native trading, which means your agent should maintain a live state view instead of polling `apex.market.quote` in a tight loop.

Recommended subscriptions:

- quote resource for top-of-book state
- candle resources for `M1`, `M5`, and `H1`
- account positions/orders/risk resources for execution state

```typescript
const quoteUri = "apex://market/quote/APEX:FX:EURUSD";
const candlesM1Uri = "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200";
const candlesM5Uri = "apex://market/candles/APEX:FX:EURUSD?timeframe=M5&limit=200";
const featuresUri = "apex://market/features/APEX:FX:EURUSD";
const positionsUri = `apex://account/positions/${session.account_id}`;
const riskUri = `apex://account/risk/${session.account_id}`;

await client.subscribeResource({ uri: quoteUri });
await client.subscribeResource({ uri: candlesM1Uri });
await client.subscribeResource({ uri: candlesM5Uri });
await client.subscribeResource({ uri: featuresUri });
await client.subscribeResource({ uri: positionsUri });
await client.subscribeResource({ uri: riskUri });
```

When the broker sends `notifications/resources/updated`, re-read the affected resource and update your local state cache. The exact notification registration API depends on your MCP client SDK, but the loop should look like this:

```typescript
const stateCache = new Map<string, unknown>();

async function refreshResource(uri: string) {
  const resource = await client.readResource({ uri });
  stateCache.set(uri, resource);
}

async function onResourceUpdatedNotification(notification: { params?: { uri?: unknown } }) {
  const uri = notification.params?.uri;
  if (typeof uri === "string") {
    await refreshResource(uri);
  }
}

// Register onResourceUpdatedNotification with your MCP client SDK's
// notifications/resources/updated handler mechanism.
```

For trading, keep at least these live views in memory:

- latest quote
- latest completed `M1`, `M5`, and `H1` candles
- current derived features
- open positions
- open orders
- current risk state
- quote/account freshness metadata and sequences

In production, your runtime should invalidate cached state and pause autonomous execution if:

- any execution-critical resource becomes stale
- resource sequence continuity is broken
- the SSE stream reconnects without replay continuity
- the broker risk resource reports a hard-stop condition

For deeper runtime design guidance, see:

- [agent-runtime-safety-guide.md](./agent-runtime-safety-guide.md)
- [reference-flows.md](./reference-flows.md)

---

## Step 5: Check Your Account State

```typescript
const account = await client.callTool({
  name: "apex.account.summary",
  arguments: { account_id: session.account_id },
});

console.log(`Balance: ${account.balance} ${account.response_currency}`);
console.log(`Free margin: ${account.free_margin}`);

const positions = await client.callTool({
  name: "apex.account.positions",
  arguments: { account_id: session.account_id },
});

console.log(`Open positions: ${positions.positions.length}`);
```

---

## Step 6: Pre-Trade Risk Check

Always run a risk check before placing large orders:

```typescript
const riskCheck = await client.callTool({
  name: "apex.risk.check",
  arguments: {
    account_id: session.account_id,
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 100000
    }
  },
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
const quote = await client.callTool({
  name: "apex.market.quote",
  arguments: { instrument_id: "APEX:FX:EURUSD" },
});

console.log(`Current price: ${quote.bid}/${quote.ask}`);

// Place market order with SL/TP
const order = await client.callTool({
  name: "apex.order.place",
  arguments: {
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
  },
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
const status = await client.callTool({
  name: "apex.order.status",
  arguments: {
    account_id: session.account_id,
    order_id: order.order_id
  },
});

// Modify SL/TP on the resulting position if the order opened one
await client.callTool({
  name: "apex.order.modify",
  arguments: {
    account_id: session.account_id,
    target_type: "position",
    target_id: order.position_id ?? positions.positions[0].position_id,
    modifications: {
      stop_loss: { type: "price", value: 1.0800 },
      take_profit: { type: "price", value: 1.0950 },
    }
  },
});

// Cancel a separate resting order if needed
const restingOrder = await client.callTool({
  name: "apex.order.place",
  arguments: {
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
  },
});

await client.callTool({
  name: "apex.order.cancel",
  arguments: {
    account_id: session.account_id,
    order_id: restingOrder.order_id,
    reason: "strategy exit signal"
  },
});
```

---

## Step 8A: Build A Decision Loop

For viable autonomous trading, the agent should reason over maintained state rather than raw tick text.

A practical loop is:

1. Subscribe to quote, candle, account, and risk resources.
2. Maintain a local state cache.
3. Recompute or read derived feature state on each update.
4. Trigger the decision policy on:
   - candle close
   - meaningful quote/volatility changes
   - order fill/reject events
   - scheduled review intervals
5. Refuse autonomous execution if quote/account/risk state is stale or sequences have gaps.
6. Run `apex.risk.check` before new exposure.
7. Submit or amend orders with `apex.order.*`.

Example:

```typescript
async function onDecisionTrigger(instrumentId: string) {
  const decisionContext = await client.readResource({
    uri: `apex://agent/decision-context/${instrumentId}`
  });

  const riskState = await client.readResource({
    uri: `apex://account/risk/${session.account_id}`
  });

  const quoteState = await client.readResource({
    uri: `apex://market/quote/${instrumentId}`
  });

  const now = Date.now();
  const quoteTimestamp = Date.parse(quoteState.timestamp);
  const quoteIsStale = Number.isFinite(quoteTimestamp)
    && now > quoteTimestamp + quoteState.stale_after_ms;

  if (riskState.kill_switch_active || quoteIsStale) {
    return;
  }

  // Hand decisionContext to your policy / LLM / strategy runtime here.
}
```

This is the intended production architecture: tools for actions, resources for live state, notifications for change, deterministic code for risk and feed handling, and hard rejection of stale or discontinuous execution inputs.

For production rollouts, use these documents as the implementation target:

- [Core Spec](../spec/core/README.md)
- [Production Capability Profiles](../spec/core/production.md)
- [Normative Schemas](../spec/core/schemas/)
- [Production Conformance Checklist](../conformance/production-checklist.md)

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
await broker1.callTool({ name: "apex.session.authenticate", arguments: { token: broker1Token, token_type: "jwt" } });
await broker2.callTool({ name: "apex.session.authenticate", arguments: { token: broker2Token, token_type: "jwt" } });

// Compare quotes across brokers using the same canonical instrument ID
const quote1 = await broker1.callTool({ name: "apex.market.quote", arguments: { instrument_id: "APEX:FX:EURUSD" } });
const quote2 = await broker2.callTool({ name: "apex.market.quote", arguments: { instrument_id: "APEX:FX:EURUSD" } });

console.log(`Broker 1 spread: ${quote1.spread}`);
console.log(`Broker 2 spread: ${quote2.spread}`);

// Execute on whichever has the better price
const bestBroker = quote1.ask < quote2.ask ? broker1 : broker2;
```

The APEX Standard ensures both brokers speak the same tool vocabulary and use the same instrument IDs — your agent code is identical regardless of which broker it's talking to.

---

## Error Handling

APEX Protocol errors are returned as structured payloads inside successful tool responses — they are not thrown as exceptions. Check for an `error` field in the response payload:

```typescript
const result = await client.callTool({ name: "apex.order.place", arguments: { ... } });
const payload = extractPayload(result);  // uses helper defined in Step 3

if (payload.error) {
  const { code, category, message } = payload.error;

  switch (code) {
    case "APEX_4001": // Re-authenticate
    case "APEX_4020": // Insufficient margin — reduce size
    case "APEX_4023": // Kill switch — stop trading immediately
    case "APEX_4024": // Stale state — wait for fresh data
    case "APEX_4025": // Sequence gap — re-read resources
    case "APEX_4030": // Market closed — retry after open
    case "APEX_4040": // Rate limited — back off
      // ...
  }
}
```

Use `try/catch` only for transport-level errors (connection failures, timeouts), not for APEX protocol errors.

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
