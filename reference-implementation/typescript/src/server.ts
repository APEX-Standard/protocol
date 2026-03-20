/**
 * APEX Protocol Reference Implementation — TypeScript
 *
 * This implementation keeps the reference behavior intentionally simple while
 * using a structure that maps more naturally to a production TypeScript service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION } from "./lib/constants.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMarketTools } from "./tools/market.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerSessionTools } from "./tools/session.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

registerSessionTools(server);
registerAccountTools(server);
registerOrderTools(server);
registerMarketTools(server);
registerRiskTools(server);

await server.connect(new StdioServerTransport());
console.error(`APEX Protocol Reference Server v${SERVER_VERSION} running`);
