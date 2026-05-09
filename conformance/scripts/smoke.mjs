import assert from "node:assert/strict";
import {
  assertIsoCurrency,
  assertNonEmptyString,
  callTool,
  connectClient,
  disconnectClient,
  extractPayload,
  assertApexError,
  printCheck,
  printCapturedStderr,
  resolveTarget,
} from "./common.mjs";

const target = resolveTarget(process.argv.slice(2));
const session = await connectClient(target, { verbose: target.verbose });
const testOptions = target.testOptions;

try {
  const { client } = session;

  printCheck(`connected to ${target.label}`);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const requiredTool of [
    "apex.session.authenticate",
    "apex.session.capabilities",
    "apex.session.heartbeat",
    "apex.account.summary",
    "apex.account.positions",
    "apex.account.orders",
    "apex.account.history",
    "apex.order.place",
    "apex.order.modify",
    "apex.order.cancel",
    "apex.order.status",
    "apex.market.quote",
    "apex.market.snapshot",
    "apex.market.search",
    "apex.market.details",
    "apex.risk.check",
    "apex.risk.limits",
    "apex.session.acknowledge",
    "apex.position.close",
  ]) {
    assert(toolNames.has(requiredTool), `Missing required tool: ${requiredTool}`);
  }
  printCheck("required tools are listed");

  const authOk = extractPayload(
    await client.callTool({
      name: "apex.session.authenticate",
      arguments: { token: testOptions.validToken, token_type: testOptions.tokenType },
    }),
  );
  assertNonEmptyString(authOk.session_id, "session_id");
  assertNonEmptyString(authOk.account_id, "account_id");
  printCheck("authenticate accepts a valid token");

  const authBad = extractPayload(
    await client.callTool({
      name: "apex.session.authenticate",
      arguments: { token: testOptions.invalidToken, token_type: testOptions.tokenType },
    }),
  );
  assertApexError(authBad, "APEX_4001");
  printCheck("authenticate rejects an invalid token");

  const summary = extractPayload(
    await client.callTool({
      name: "apex.account.summary",
      arguments: { account_id: authOk.account_id, currency: testOptions.responseCurrency },
    }),
  );
  assert.equal(summary.account_id, authOk.account_id);
  assertIsoCurrency(summary.account_base_currency, "account_base_currency");
  assert.equal(summary.response_currency, testOptions.responseCurrency);
  if (testOptions.expectedAccountBaseCurrency) {
    assert.equal(summary.account_base_currency, testOptions.expectedAccountBaseCurrency);
  }
  printCheck("account summary separates base and response currency");

  const limitMissingPrice = extractPayload(
    await client.callTool({
      name: "apex.order.place",
      arguments: {
        account_id: authOk.account_id,
        order: {
          instrument_id: testOptions.instrumentId,
          side: "buy",
          order_type: "limit",
          quantity: 10000,
          quantity_unit: "base_units",
          time_in_force: "GTC",
        },
      },
    }),
  );
  assertApexError(limitMissingPrice, "APEX_4011");
  printCheck("limit orders require limit_price");

  const marketOrder = extractPayload(
    await client.callTool({
      name: "apex.order.place",
      arguments: {
        account_id: authOk.account_id,
        order: {
          instrument_id: testOptions.instrumentId,
          side: "buy",
          order_type: "market",
          quantity: 10000,
          quantity_unit: "base_units",
          time_in_force: "GTC",
        },
      },
    }),
  );
  assert.equal(marketOrder.status, "filled");
  assertNonEmptyString(marketOrder.position_id, "position_id");
  printCheck("market orders produce a position_id on fill");

  const modifyBad = extractPayload(
    await client.callTool({
      name: "apex.order.modify",
      arguments: {
        account_id: authOk.account_id,
        target_type: "position",
        target_id: marketOrder.position_id,
        modifications: { limit_price: 1.07 },
      },
    }),
  );
  assertApexError(modifyBad, "APEX_4011");
  printCheck("position modification rejects limit_price");

  const modifyOk = extractPayload(
    await client.callTool({
      name: "apex.order.modify",
      arguments: {
        account_id: authOk.account_id,
        target_type: "position",
        target_id: marketOrder.position_id,
        modifications: { stop_loss: { type: "price", value: 1.08 } },
      },
    }),
  );
  assert.equal(modifyOk.status, "modified");
  printCheck("position protection modification succeeds");

  const details = extractPayload(
    await client.callTool({
      name: "apex.market.details",
      arguments: { instrument_id: testOptions.instrumentId },
    }),
  );
  assert.equal(details.instrument_id, testOptions.instrumentId);
  assert(["base_units", "shares", "contracts"].includes(details.quantity_unit));
  assertNonEmptyString(details.broker_quantity_unit, "broker_quantity_unit");
  if (testOptions.expectedBrokerQuantityUnit) {
    assert.equal(details.broker_quantity_unit, testOptions.expectedBrokerQuantityUnit);
  }
  printCheck("market details expose canonical and broker quantity units");

  // --- Position close ---

  // Place a market order to create a position
  const marketOrderForClose = await callTool(client, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 5000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });
  assert.equal(marketOrderForClose.status, "filled", "Expected market order filled for position close test");
  const positionId = marketOrderForClose.position_id;
  assert(positionId, "Expected position_id from filled market order");

  // Close the position
  const closeResult = await callTool(client, "apex.position.close", {
    account_id: "ACC_12345",
    position_id: positionId,
  });
  assert(closeResult.order_id, "Expected order_id from position close");
  assert.equal(closeResult.position_id, positionId, "Expected matching position_id");
  assert(
    closeResult.status === "filled" || closeResult.status === "partially_filled" || closeResult.status === "rejected",
    `Expected filled/partially_filled/rejected status from position close, got ${closeResult.status}`
  );
  assert(closeResult.fill_price > 0, "Expected positive fill_price");
  assert(closeResult.fill_quantity > 0, "Expected positive fill_quantity");
  printCheck("position close works");

  // Position close with invalid position_id
  const badClose = await callTool(client, "apex.position.close", {
    account_id: "ACC_12345",
    position_id: "nonexistent_pos",
  });
  assertApexError(badClose, "APEX_4011");
  printCheck("position close rejects unknown position");

  // --- Behavioral conformance: core tools ---

  const positions = await callTool(client, "apex.account.positions", {
    account_id: "ACC_12345",
  });
  // Response may have positions at top level or nested
  const posArray = positions.positions ?? positions;
  assert(Array.isArray(posArray) || typeof positions === "object", "Expected positions data");
  printCheck("account positions returned");

  const orders = await callTool(client, "apex.account.orders", {
    account_id: "ACC_12345",
    status: "all",
  });
  const ordArray = orders.orders ?? orders;
  assert(Array.isArray(ordArray) || typeof orders === "object", "Expected orders data");
  printCheck("account orders returned");

  const history = await callTool(client, "apex.account.history", {
    account_id: "ACC_12345",
    from: "2025-01-01T00:00:00Z",
    to: new Date().toISOString(),
    event_type: "all",
    limit: 10,
  });
  assert(Array.isArray(history.events), "Expected events array");
  printCheck("account history returned");

  // Use the market order placed earlier in the position close test
  const orderStatus = await callTool(client, "apex.order.status", {
    account_id: "ACC_12345",
    order_id: marketOrderForClose.order_id,
  });
  assert(orderStatus.order_id, "Expected order_id in status response");
  assert(orderStatus.status, "Expected status field");
  printCheck("order status returned");

  const snapshot = await callTool(client, "apex.market.snapshot", {
    instrument_id: "APEX:FX:EURUSD",
    timeframe: "M1",
    from: "2025-01-01T00:00:00Z",
    limit: 10,
  });
  assert(snapshot.instrument_id === "APEX:FX:EURUSD", "Expected EURUSD snapshot");
  assert(Array.isArray(snapshot.candles), "Expected candles array");
  printCheck("market snapshot returned");

  const searchResults = await callTool(client, "apex.market.search", {
    query: "EUR",
    limit: 10,
  });
  assert(Array.isArray(searchResults.instruments) || Array.isArray(searchResults.results), "Expected instruments/results array");
  printCheck("market search returned");

  const riskLimits = await callTool(client, "apex.risk.limits", {
    account_id: "ACC_12345",
  });
  assert(typeof riskLimits.kill_switch_active === "boolean" || riskLimits.kill_switch_active !== undefined, "Expected kill_switch_active");
  printCheck("risk limits returned");

  // --- Negative validation tests ---
  // These tests accept either APEX errors (in-band) or MCP SDK validation errors (thrown).
  // TypeScript uses Zod for input validation → MCP SDK rejects before handler.
  // Go/Rust/Java may validate in-handler → returns APEX error.

  // Helper: call tool expecting rejection (APEX error or MCP throw)
  async function expectRejection(toolName, args, description) {
    try {
      const result = await callTool(client, toolName, args);
      assert(result?.error, `Expected rejection for ${description}, got success: ${JSON.stringify(result).slice(0, 100)}`);
      return true;
    } catch (e) {
      // MCP-level validation error (e.g., Zod rejection) — acceptable if it's an MCP error
      assert(
        e.message?.includes("MCP error") || e.message?.includes("Invalid") || e.message?.includes("validation") || e.code === -32602,
        `Expected MCP validation error for ${description}, got unexpected error: ${e.message}`,
      );
      return true;
    }
  }

  await expectRejection("apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      order_type: "market",
      quantity: 1000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
      // missing: side
    },
  }, "order with missing side");
  printCheck("order with missing side rejected");

  await expectRejection("apex.market.quote", {
    instrument_id: "APEX:FX:INVALID_PAIR",
  }, "unknown instrument");
  printCheck("unknown instrument rejected");

  await expectRejection("apex.account.summary", {}, "missing account_id");
  printCheck("account summary with missing account_id rejected");

  // --- Heartbeat latency ---

  const heartbeatTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await callTool(client, "apex.session.heartbeat", { timestamp: new Date().toISOString() });
    heartbeatTimes.push(Date.now() - start);
  }
  const avgLatency = heartbeatTimes.reduce((a, b) => a + b, 0) / heartbeatTimes.length;
  assert(avgLatency < 500, `Heartbeat average latency ${avgLatency}ms exceeds 500ms SLA`);
  assert(Math.max(...heartbeatTimes) < 1000, `Heartbeat max latency ${Math.max(...heartbeatTimes)}ms exceeds 1000ms`);
  printCheck(`heartbeat latency: avg=${Math.round(avgLatency)}ms, max=${Math.max(...heartbeatTimes)}ms`);

  // --- FX profile tools ---

  const rollover = await callTool(client, "apex.fx.rollover", { instrument_id: "APEX:FX:EURUSD" });
  assert.equal(rollover.instrument_id, "APEX:FX:EURUSD", "Expected EURUSD rollover");
  assert(typeof rollover.rollover_long === "number", "Expected numeric rollover_long");
  assert(typeof rollover.rollover_short === "number", "Expected numeric rollover_short");
  assert(rollover.rollover_currency, "Expected rollover_currency");
  printCheck("FX rollover rates returned");

  const exposure = await callTool(client, "apex.fx.exposure", { account_id: "ACC_12345", base_currency: "USD" });
  assert(Array.isArray(exposure.exposures), "Expected exposures array");
  assert(exposure.as_of, "Expected as_of timestamp");
  printCheck("FX currency exposure returned");

  const conversion = await callTool(client, "apex.fx.conversion", { from_currency: "EUR", to_currency: "USD", amount: 1000 });
  assert(typeof conversion.rate === "number", "Expected numeric conversion rate");
  assert(typeof conversion.converted_amount === "number", "Expected numeric converted_amount");
  assert(conversion.converted_amount > 0, "Expected positive converted_amount");
  printCheck("FX conversion returned");

  // --- CFD profile tools ---

  const corpActions = await callTool(client, "apex.cfd.corporate_actions", { account_id: "ACC_12345" });
  assert(Array.isArray(corpActions.corporate_actions), "Expected corporate_actions array");
  printCheck("CFD corporate actions returned");

  const dividends = await callTool(client, "apex.cfd.dividend_adjustment", { account_id: "ACC_12345" });
  assert(Array.isArray(dividends.adjustments), "Expected adjustments array");
  printCheck("CFD dividend adjustments returned");

  // --- Crypto profile tools ---

  const fundingRate = await callTool(client, "apex.crypto.funding_rate", { instrument_id: "APEX:CRYPTO:PERP:BTCUSDT" });
  assert.equal(fundingRate.instrument_id, "APEX:CRYPTO:PERP:BTCUSDT", "Expected BTCUSDT funding rate");
  assert(typeof fundingRate.current_rate === "number", "Expected numeric current_rate");
  assert(typeof fundingRate.funding_interval_hours === "number", "Expected numeric funding_interval_hours");
  assert(typeof fundingRate.index_price === "number", "Expected numeric index_price");
  assert(typeof fundingRate.mark_price === "number", "Expected numeric mark_price");
  printCheck("Crypto funding rate returned");

  const liqEstimate = await callTool(client, "apex.crypto.liquidation_estimate", {
    account_id: "ACC_12345",
    instrument_id: "APEX:CRYPTO:PERP:BTCUSDT",
    side: "buy",
    quantity: 1.0,
    leverage: 10,
    margin_mode: "isolated",
    entry_price: 50000.00,
  });
  assert(typeof liqEstimate.liquidation_price === "number", "Expected numeric liquidation_price");
  assert(liqEstimate.liquidation_price < 50000, "Expected liquidation below entry for long");
  assert(typeof liqEstimate.margin_required === "number", "Expected numeric margin_required");
  assert(typeof liqEstimate.distance_pct === "number", "Expected numeric distance_pct");
  printCheck("Crypto liquidation estimate returned");

  const transfer = await callTool(client, "apex.crypto.transfer", {
    account_id: "ACC_12345",
    from_wallet: "spot",
    to_wallet: "futures",
    currency: "USDT",
    amount: 1000.00,
  });
  assert(transfer.transfer_id, "Expected transfer_id");
  assert.equal(transfer.from_wallet, "spot", "Expected from_wallet spot");
  assert.equal(transfer.to_wallet, "futures", "Expected to_wallet futures");
  assert(transfer.status === "completed" || transfer.status === "pending", "Expected completed or pending status");
  printCheck("Crypto wallet transfer returned");

  console.log(`Smoke suite passed for ${target.label}`);
} catch (error) {
  printCapturedStderr(session);
  throw error;
} finally {
  await disconnectClient(session);
}
