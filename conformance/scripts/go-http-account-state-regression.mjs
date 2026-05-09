import assert from "node:assert/strict";

import {
  httpCallTool,
  httpInitialize,
  resolveTarget,
  startHttpTarget,
  stopHttpServer,
} from "./common.mjs";

const target = resolveTarget(["go"]);
let server;

try {
  server = await startHttpTarget(target);
  const { sessionId } = await httpInitialize(server.baseUrl);

  await httpCallTool(server.baseUrl, sessionId, "apex.session.authenticate", {
    token: "valid-token-12345",
    token_type: "jwt",
    account_id: "ACC_12345",
  });

  const placed = await httpCallTool(server.baseUrl, sessionId, "apex.order.place", {
    account_id: "ACC_12345",
    order: {
      instrument_id: "APEX:FX:EURUSD",
      side: "buy",
      order_type: "market",
      quantity: 10000,
      quantity_unit: "base_units",
      time_in_force: "GTC",
    },
  });

  assert(placed.order_id, "expected market order to return order_id");
  assert(placed.position_id, "expected market order to return position_id");

  const orders = await httpCallTool(server.baseUrl, sessionId, "apex.account.orders", {
    account_id: "ACC_12345",
    status: "all",
  });
  assert(
    orders.orders?.some((order) => order.order_id === placed.order_id),
    `expected apex.account.orders to include ${placed.order_id}`,
  );

  const positions = await httpCallTool(server.baseUrl, sessionId, "apex.account.positions", {
    account_id: "ACC_12345",
  });
  assert(
    positions.positions?.some((position) => position.position_id === placed.position_id),
    `expected apex.account.positions to include ${placed.position_id}`,
  );
} finally {
  await stopHttpServer(server);
}

console.log("Go HTTP account state regression passed");
