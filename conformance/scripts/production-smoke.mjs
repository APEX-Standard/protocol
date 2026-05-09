import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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
const session = await connectClient(target, { verbose: target.verbose });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const quoteUri = "apex://market/quote/APEX:FX:EURUSD";
const candlesM1Uri = "apex://market/candles/APEX:FX:EURUSD?timeframe=M1&limit=200";
const candlesM5Uri = "apex://market/candles/APEX:FX:EURUSD?timeframe=M5&limit=200";
const candlesH1Uri = "apex://market/candles/APEX:FX:EURUSD?timeframe=H1&limit=200";
const featuresUri = "apex://market/features/APEX:FX:EURUSD";
const accountSummaryUri = "apex://account/summary/ACC_12345";
const positionsUri = "apex://account/positions/ACC_12345";
const ordersUri = "apex://account/orders/ACC_12345";
const fillsUri = "apex://account/fills/ACC_12345";
const riskUri = "apex://account/risk/ACC_12345";
const decisionContextUri = "apex://agent/decision-context/APEX:FX:EURUSD";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name) {
  const schemaPath = path.join(repoRoot, "spec", "core", "schemas", name);
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

const quoteValidator = ajv.compile(loadSchema("quote.resource.schema.json"));
const candleValidator = ajv.compile(loadSchema("candle.resource.schema.json"));
const featureValidator = ajv.compile(loadSchema("feature.resource.schema.json"));
const decisionContextValidator = ajv.compile(loadSchema("decision-context.resource.schema.json"));
const accountSummaryValidator = ajv.compile(loadSchema("account-summary.resource.schema.json"));
const positionsValidator = ajv.compile(loadSchema("positions.resource.schema.json"));
const ordersValidator = ajv.compile(loadSchema("orders.resource.schema.json"));
const riskValidator = ajv.compile(loadSchema("risk.resource.schema.json"));
ajv.addSchema(loadSchema("fill-event.schema.json"));
const fillsValidator = ajv.compile(loadSchema("fills.resource.schema.json"));

function assertSchema(validator, payload, label) {
  assert(validator(payload), `${label} failed schema validation: ${ajv.errorsText(validator.errors)}`);
}

function parseResource(result) {
  const text = result.contents?.[0]?.text;
  assert.equal(typeof text, "string", "Expected text resource contents");
  return JSON.parse(text);
}

try {
  const { client } = session;
  const notifications = [];

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    notifications.push(notification.params.uri);
  });

  const resources = await client.listResources();
  const uris = new Set(resources.resources.map((resource) => resource.uri));
  for (const requiredUri of [quoteUri, candlesM1Uri, candlesM5Uri, candlesH1Uri, featuresUri, accountSummaryUri, positionsUri, ordersUri, fillsUri, riskUri, decisionContextUri]) {
    assert(uris.has(requiredUri), `Missing required resource: ${requiredUri}`);
  }
  printCheck(`listed production resources for ${target.label}`);

  const quote = parseResource(await client.readResource({ uri: quoteUri }));
  assert.equal(quote.instrument_id, "APEX:FX:EURUSD");
  assert.equal(typeof quote.sequence, "number");
  assertSchema(quoteValidator, quote, "quote resource");
  printCheck("read live quote resource");

  const candles = parseResource(await client.readResource({ uri: candlesM1Uri }));
  assert.equal(candles.timeframe, "M1");
  assertSchema(candleValidator, candles, "candle resource");

  const candlesM5 = parseResource(await client.readResource({ uri: candlesM5Uri }));
  assert.equal(candlesM5.timeframe, "M5");
  assertSchema(candleValidator, candlesM5, "M5 candle resource");

  const candlesH1 = parseResource(await client.readResource({ uri: candlesH1Uri }));
  assert.equal(candlesH1.timeframe, "H1");
  assertSchema(candleValidator, candlesH1, "H1 candle resource");
  printCheck("read candle resources (M1, M5, H1)");

  const features = parseResource(await client.readResource({ uri: featuresUri }));
  assert.equal(features.instrument_id, "APEX:FX:EURUSD");
  assertSchema(featureValidator, features, "feature resource");
  printCheck("read features resource");

  const decisionContext = parseResource(await client.readResource({ uri: decisionContextUri }));
  assert.equal(decisionContext.instrument_id, "APEX:FX:EURUSD");
  assert.equal(decisionContext.market.quote_resource, quoteUri);
  assertSchema(decisionContextValidator, decisionContext, "decision context resource");
  printCheck("read decision context resource");

  const accountSummary = parseResource(await client.readResource({ uri: accountSummaryUri }));
  assertSchema(accountSummaryValidator, accountSummary, "account summary resource");
  const positions = parseResource(await client.readResource({ uri: positionsUri }));
  assertSchema(positionsValidator, positions, "positions resource");
  const risk = parseResource(await client.readResource({ uri: riskUri }));
  assertSchema(riskValidator, risk, "risk resource");
  const fills = parseResource(await client.readResource({ uri: fillsUri }));
  assert.equal(fills.account_id, "ACC_12345");
  assertSchema(fillsValidator, fills, "fills resource");
  printCheck("read account, risk, and fills resources");

  await client.subscribeResource({ uri: ordersUri });
  await client.subscribeResource({ uri: decisionContextUri });
  printCheck("subscribed to order and decision resources");

  const placed = extractPayload(
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
  assert.equal(placed.status, "working");
  await delay(150);

  assert(notifications.includes(ordersUri), "Expected orders resource update notification");
  assert(notifications.includes(decisionContextUri), "Expected decision-context update notification");
  printCheck("received resource update notifications after order mutation");

  const orders = parseResource(await client.readResource({ uri: ordersUri }));
  assert(Array.isArray(orders.orders), "Expected orders array");
  assert(orders.orders.some((order) => order.order_id === placed.order_id), "Expected placed order in orders resource");
  assertSchema(ordersValidator, orders, "orders resource");
  const firstSequence = orders.sequence;
  printCheck("read updated orders resource");

  const cancelled = extractPayload(
    await client.callTool({
      name: "apex.order.cancel",
      arguments: {
        account_id: "ACC_12345",
        order_id: placed.order_id,
        reason: "production smoke cleanup",
      },
    }),
  );
  assert.equal(cancelled.status, "cancelled");
  await delay(150);
  const ordersAfterCancel = parseResource(await client.readResource({ uri: ordersUri }));
  assertSchema(ordersValidator, ordersAfterCancel, "orders resource after cancel");
  assert(ordersAfterCancel.sequence >= firstSequence, "Expected non-decreasing orders sequence");
  assert(
    ordersAfterCancel.orders.some((order) => order.order_id === placed.order_id && order.status === "cancelled"),
    "Expected cancelled order in orders resource",
  );
  printCheck("validated lifecycle progression and sequence monotonicity");

  await client.unsubscribeResource({ uri: decisionContextUri });
  await client.unsubscribeResource({ uri: ordersUri });

  console.log(`Production smoke passed for ${target.label}`);
} catch (error) {
  printCapturedStderr(session);
  throw error;
} finally {
  await disconnectClient(session);
}
