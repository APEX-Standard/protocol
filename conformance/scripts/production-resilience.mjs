import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { fileURLToPath } from "node:url";

import {
  connectClient,
  disconnectClient,
  extractPayload,
  printCheck,
  printCapturedStderr,
  resolveTarget,
} from "./common.mjs";

const target = resolveTarget(process.argv.slice(2));
const quoteUri = "apex://market/quote/APEX:FX:EURUSD";
const ordersUri = "apex://account/orders/ACC_12345";
const fillsUri = "apex://account/fills/ACC_12345";
const riskUri = "apex://account/risk/ACC_12345";
const decisionContextUri = "apex://agent/decision-context/APEX:FX:EURUSD";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name) {
  const schemaPath = path.join(repoRoot, "spec", "core", "schemas", name);
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

const orderEventValidator = ajv.compile(loadSchema("order-event.schema.json"));
const fillEventValidator = ajv.compile(loadSchema("fill-event.schema.json"));

function parseResource(result) {
  return JSON.parse(result.contents[0].text);
}

function assertSchema(validator, payload, label) {
  assert(validator(payload), `${label} failed schema validation: ${ajv.errorsText(validator.errors)}`);
}

function toOrderEventPayload(order) {
  return {
    order_id: order.order_id,
    client_order_id: order.client_order_id ?? null,
    account_id: order.account_id,
    instrument_id: order.instrument_id,
    side: order.side,
    order_type: order.order_type,
    quantity: order.quantity,
    status: order.status,
    filled_quantity: order.filled_quantity,
    remaining_quantity: order.remaining_quantity,
    average_fill_price: order.average_fill_price ?? null,
    reason: order.reason ?? null,
    updated_at: order.updated_at,
  };
}

function toFillEventPayload(fill) {
  return {
    fill_id: fill.fill_id,
    order_id: fill.order_id,
    account_id: fill.account_id,
    instrument_id: fill.instrument_id,
    side: fill.side,
    fill_quantity: fill.fill_quantity,
    fill_price: fill.fill_price,
    commission: fill.commission,
    commission_currency: fill.commission_currency,
    liquidity_flag: fill.liquidity_flag,
    position_id: fill.position_id ?? null,
    timestamp: fill.timestamp,
  };
}

async function setRealtimeFault(client, args) {
  return extractPayload(
    await client.callTool({
      name: "reference.test.set_realtime_state",
      arguments: args,
    }),
  );
}

async function main() {
  let session = await connectClient(target.config, { verbose: target.verbose });

  try {
    let { client } = session;
    const tools = await client.listTools();
    const hasFaultTool = tools.tools.some((tool) => tool.name === "reference.test.set_realtime_state");

    const capabilities = extractPayload(
      await client.callTool({
        name: "apex.session.capabilities",
        arguments: {},
      }),
    );
    assert.equal(capabilities.realtime_contract?.reconnect_mode, "no_replay");
    printCheck(`verified reconnect contract for ${target.label}`);

    const quoteBeforeReconnect = JSON.parse((await client.readResource({ uri: quoteUri })).contents[0].text);
    assert.equal(typeof quoteBeforeReconnect.sequence, "number");

    await disconnectClient(session);
    session = await connectClient(target.config, { verbose: target.verbose });
    client = session.client;

    const quoteAfterReconnect = JSON.parse((await client.readResource({ uri: quoteUri })).contents[0].text);
    assert.equal(quoteAfterReconnect.instrument_id, "APEX:FX:EURUSD");
    printCheck("reconnected and rebuilt no-replay baseline");

    if (!hasFaultTool) {
      printCheck("fault injection tool unavailable; skipped stale/gap resilience checks");
      console.log(`Production resilience passed for ${target.label}`);
      return;
    }

    await setRealtimeFault(client, { quote_stale: true, risk_stale: false, force_sequence_gap: false });
    const staleQuoteOrder = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
            side: "buy",
            order_type: "market",
            quantity: 10000,
            quantity_unit: "base_units",
            time_in_force: "GTC",
          },
        },
      }),
    );
    assert.equal(staleQuoteOrder.error?.code, "APEX_4024");
    printCheck("rejected order entry on stale quote state");

    await setRealtimeFault(client, { quote_stale: false, risk_stale: true, force_sequence_gap: false });
    const staleRiskOrder = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
            side: "buy",
            order_type: "market",
            quantity: 10000,
            quantity_unit: "base_units",
            time_in_force: "GTC",
          },
        },
      }),
    );
    assert.equal(staleRiskOrder.error?.code, "APEX_4024");
    printCheck("rejected order entry on stale risk state");

    await setRealtimeFault(client, {
      quote_stale: false,
      risk_stale: false,
      force_sequence_gap: false,
      kill_switch_active: true,
    });
    const killSwitchOrder = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
            side: "buy",
            order_type: "market",
            quantity: 10000,
            quantity_unit: "base_units",
            time_in_force: "GTC",
          },
        },
      }),
    );
    assert.equal(killSwitchOrder.error?.code, "APEX_4023");

    const riskWithKillSwitch = parseResource(await client.readResource({ uri: riskUri }));
    assert.equal(riskWithKillSwitch.kill_switch_active, true, "kill switch must surface in risk resource");

    const dcWithKillSwitch = parseResource(await client.readResource({ uri: decisionContextUri }));
    assert.equal(dcWithKillSwitch.constraints.kill_switch_active, true, "kill switch must surface in decision context");

    printCheck("rejected order entry when kill switch is active and verified in risk/decision-context resources");

    await setRealtimeFault(client, {
      quote_stale: false,
      risk_stale: false,
      force_sequence_gap: false,
      kill_switch_active: false,
      partial_fill_next_order: true,
    });
    const partialFillOrder = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
            side: "buy",
            order_type: "market",
            quantity: 10000,
            quantity_unit: "base_units",
            time_in_force: "GTC",
          },
        },
      }),
    );
    assert.equal(partialFillOrder.status, "partially_filled");
    assert.equal(partialFillOrder.fill_quantity, 5000);
    assert.equal(partialFillOrder.remaining_quantity, 5000);

    const ordersAfterPartialFill = parseResource(await client.readResource({ uri: ordersUri }));
    const partialOrderEvent = ordersAfterPartialFill.orders.find((order) => order.order_id === partialFillOrder.order_id);
    assert(partialOrderEvent, "Expected partial fill order to be present in orders resource");
    assertSchema(orderEventValidator, toOrderEventPayload(partialOrderEvent), "order event");

    const fillsAfterPartialFill = parseResource(await client.readResource({ uri: fillsUri }));
    const partialFillEvent = fillsAfterPartialFill.fills.find((fill) => fill.order_id === partialFillOrder.order_id);
    assert(partialFillEvent, "Expected partial fill event to be present in fills resource");
    assertSchema(fillEventValidator, toFillEventPayload(partialFillEvent), "fill event");
    // Note: Reference implementations simulate a single partial fill per order.
    // A full two-fill lifecycle (partial -> filled) would require broker-side
    // fill simulation beyond the current reference scope.
    printCheck("validated partial-fill lifecycle and event schemas");

    await setRealtimeFault(client, {
      quote_stale: false,
      risk_stale: false,
      force_sequence_gap: false,
      kill_switch_active: false,
      partial_fill_next_order: false,
    });
    const restingOrder = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
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
    const ordersBeforeGap = parseResource(await client.readResource({ uri: ordersUri }));

    await setRealtimeFault(client, { force_sequence_gap: true });
    await client.callTool({
      name: "apex.order.cancel",
      arguments: {
        account_id: "ACC_12345",
        order_id: restingOrder.order_id,
        reason: "gap injection",
      },
    });
    const ordersAfterGap = parseResource(await client.readResource({ uri: ordersUri }));
    assert(ordersAfterGap.sequence - ordersBeforeGap.sequence > 1, "Expected injected sequence gap");
    printCheck("detected injected sequence gap");

    await setRealtimeFault(client, { force_sequence_gap: true });
    const gapRejected = extractPayload(
      await client.callTool({
        name: "apex.order.place",
        arguments: {
          account_id: "ACC_12345",
          order: {
            instrument_id: "APEX:FX:EURUSD",
            side: "buy",
            order_type: "market",
            quantity: 10000,
            quantity_unit: "base_units",
            time_in_force: "GTC",
          },
        },
      }),
    );
    assert.equal(gapRejected.error?.code, "APEX_4025");
    printCheck("rejected order entry when sequence continuity is broken");

    await setRealtimeFault(client, {
      quote_stale: false,
      risk_stale: false,
      force_sequence_gap: false,
      kill_switch_active: false,
      partial_fill_next_order: false,
    });

    console.log(`Production resilience passed for ${target.label}`);
  } catch (error) {
    printCapturedStderr(session);
    throw error;
  } finally {
    await disconnectClient(session);
  }
}

await main();
