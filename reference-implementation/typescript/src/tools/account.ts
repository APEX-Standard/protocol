import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { nowIso } from "../lib/helpers.js";
import type { ReferenceTradingState } from "../lib/resources.js";
import { InstrumentIdSchema } from "../lib/schemas.js";

export function registerAccountTools(server: McpServer, state: ReferenceTradingState): void {
  server.registerTool(
    "apex.account.summary",
    {
      description: "Current account state — balances, margin utilisation, equity.",
      inputSchema: {
        account_id: z.string(),
        currency: z.string().optional().describe("Response currency. Defaults to account base currency."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id, currency }) => {
      const summary = state.getAccountSummary();
      return {
        structuredContent: {
          ...summary,
          account_id,
          response_currency: currency ?? "USD",
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.account.positions",
    {
      description: "All open positions with live P&L.",
      inputSchema: {
        account_id: z.string(),
        instrument_id: InstrumentIdSchema.optional(),
        profile: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ instrument_id }) => {
      const positions = state.getPositions();
      return {
        structuredContent: {
          ...positions,
          positions: positions.positions.map((position) => ({
            ...position,
            instrument_id: instrument_id ?? position.instrument_id,
          })),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.account.orders",
    {
      description: "Known orders and their current lifecycle state.",
      inputSchema: {
        account_id: z.string(),
        status: z
          .enum(["working", "partially_filled", "filled", "cancelled", "rejected", "expired", "all"])
          .default("all"),
        instrument_id: InstrumentIdSchema.optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      structuredContent: state.getOrders(),
      content: [],
    }),
  );

  server.registerTool(
    "apex.account.history",
    {
      description: "Closed trades and funding events.",
      inputSchema: {
        account_id: z.string(),
        from: z.string().describe("ISO8601 start date"),
        to: z.string().describe("ISO8601 end date"),
        event_type: z.enum(["trade", "funding", "cash", "corporate_action", "all"]).default("all"),
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().optional().describe("Pagination cursor"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      structuredContent: { events: [], next_cursor: null, has_more: false },
      content: [],
    }),
  );
}
