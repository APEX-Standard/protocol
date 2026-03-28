/**
 * APEX Protocol Reference Implementation — TypeScript
 *
 * This implementation keeps the reference behavior intentionally simple while
 * using a structure that maps more naturally to a production TypeScript service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, SERVER_VERSION } from "./lib/constants.js";
import { ReferenceTradingState, registerReferenceResources } from "./lib/resources.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMarketTools } from "./tools/market.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerSessionTools } from "./tools/session.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});
const state = new ReferenceTradingState();

server.server.registerCapabilities({
  resources: {
    subscribe: true,
    listChanged: true,
  },
});

server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
server.server.fallbackRequestHandler = async (request) => {
  if (request.method === "resources/subscribe" || request.method === "resources/unsubscribe") {
    return {};
  }
  throw new Error(`Method not found: ${request.method}`);
};

registerSessionTools(server, state);
registerReferenceResources(server, state);
registerAccountTools(server, state);
registerOrderTools(server, state);
registerMarketTools(server, state);
registerRiskTools(server, state);

await server.connect(new StdioServerTransport());
console.error(`APEX Protocol Reference Server v${SERVER_VERSION} running`);
