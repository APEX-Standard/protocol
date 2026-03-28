import assert from "node:assert/strict";
import {
  assertIsoCurrency,
  assertNonEmptyString,
  connectClient,
  disconnectClient,
  extractPayload,
  assertApexError,
  printCheck,
  printCapturedStderr,
  resolveTarget,
} from "./common.mjs";

const target = resolveTarget(process.argv.slice(2));
const session = await connectClient(target.config, { verbose: target.verbose });
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

  console.log(`Smoke suite passed for ${target.label}`);
} catch (error) {
  printCapturedStderr(session);
  throw error;
} finally {
  await disconnectClient(session);
}
