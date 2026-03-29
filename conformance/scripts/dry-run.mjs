import assert from "node:assert/strict";
import { assertNonEmptyString, callTool, connectClient, disconnectClient, extractPayload, printCheck, printCapturedStderr, resolveTarget } from "./common.mjs";

const target = resolveTarget(process.argv.slice(2));
const session = await connectClient(target.config, { verbose: target.verbose });
const testOptions = target.testOptions;

try {
  const { client } = session;

  const auth = extractPayload(
    await client.callTool({
      name: "apex.session.authenticate",
      arguments: { token: testOptions.validToken, token_type: testOptions.tokenType },
    }),
  );
  assertNonEmptyString(auth.account_id, "account_id");
  printCheck(`authenticated against ${target.label}`);

  const capabilities = extractPayload(
    await client.callTool({
      name: "apex.session.capabilities",
      arguments: {},
    }),
  );
  assert(capabilities.core_tools.includes("apex.order.*"));
  printCheck("loaded capability manifest");

  const details = extractPayload(
    await client.callTool({
      name: "apex.market.details",
      arguments: { instrument_id: testOptions.instrumentId },
    }),
  );
  assert.equal(details.instrument_id, testOptions.instrumentId);
  printCheck("looked up market details");

  const risk = extractPayload(
    await client.callTool({
      name: "apex.risk.check",
      arguments: {
        account_id: auth.account_id,
        order: {
          instrument_id: testOptions.instrumentId,
          side: "buy",
          order_type: "market",
          quantity: 10000,
        },
      },
    }),
  );
  assert.equal(risk.approved, true);
  printCheck("completed pre-trade risk check");

  const order = extractPayload(
    await client.callTool({
      name: "apex.order.place",
      arguments: {
        account_id: auth.account_id,
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
  assert.equal(order.status, "filled");
  assertNonEmptyString(order.position_id, "position_id");
  printCheck("placed and filled a market order");

  const modify = extractPayload(
    await client.callTool({
      name: "apex.order.modify",
      arguments: {
        account_id: auth.account_id,
        target_type: "position",
        target_id: order.position_id,
        modifications: {
          stop_loss: { type: "price", value: 1.08 },
          take_profit: { type: "price", value: 1.095 },
        },
      },
    }),
  );
  assert.equal(modify.status, "modified");
  printCheck("updated protection on the resulting position");

  const resting = extractPayload(
    await client.callTool({
      name: "apex.order.place",
      arguments: {
        account_id: auth.account_id,
        order: {
          instrument_id: testOptions.instrumentId,
          side: "buy",
          order_type: "limit",
          quantity: 10000,
          quantity_unit: "base_units",
          limit_price: 1.07,
          time_in_force: "GTC",
        },
      },
    }),
  );
  assert.equal(resting.status, "working");
  printCheck("placed a resting limit order");

  const cancelled = extractPayload(
    await client.callTool({
      name: "apex.order.cancel",
      arguments: {
        account_id: auth.account_id,
        order_id: resting.order_id,
        reason: "dry run cleanup",
      },
    }),
  );
  assert.equal(cancelled.status, "cancelled");
  printCheck("cancelled the resting order");

  // --- Concurrent orders ---

  const [concOrder1, concOrder2] = await Promise.all([
    callTool(client, "apex.order.place", {
      account_id: "ACC_12345",
      order: {
        instrument_id: testOptions.instrumentId,
        side: "buy",
        order_type: "market",
        quantity: 1000,
        quantity_unit: "base_units",
        time_in_force: "GTC",
      },
    }),
    callTool(client, "apex.order.place", {
      account_id: "ACC_12345",
      order: {
        instrument_id: testOptions.instrumentId,
        side: "sell",
        order_type: "market",
        quantity: 1000,
        quantity_unit: "base_units",
        time_in_force: "GTC",
      },
    }),
  ]);
  assert(concOrder1.order_id, "Concurrent order 1 should have order_id");
  assert(concOrder2.order_id, "Concurrent order 2 should have order_id");
  assert(concOrder1.status === "filled" || concOrder1.status === "accepted", "Concurrent order 1 should be filled or accepted");
  assert(concOrder2.status === "filled" || concOrder2.status === "accepted", "Concurrent order 2 should be filled or accepted");
  printCheck("concurrent order placement works without deadlock or corruption");

  console.log(`Dry run passed for ${target.label}`);
} catch (error) {
  printCapturedStderr(session);
  throw error;
} finally {
  await disconnectClient(session);
}
