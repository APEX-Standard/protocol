import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { InstrumentIdSchema, OrderTypeSchema, SideSchema } from "../lib/schemas.js";

export function registerRiskTools(server: McpServer, state: ReferenceTradingState): void {
  server.registerTool(
    "apex.risk.check",
    {
      description: "Pre-trade margin and exposure check. Call before placing large orders.",
      inputSchema: {
        account_id: z.string(),
        order: z.object({
          instrument_id: InstrumentIdSchema,
          side: SideSchema,
          order_type: OrderTypeSchema,
          quantity: z.number().positive(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ order }) => {
      const requiredMargin = (order.quantity / 100000) * 500;

      return {
        structuredContent: {
          approved: true,
          required_margin: requiredMargin,
          available_margin: 9750.0,
          margin_after_trade: 9750.0 - requiredMargin,
          exposure_increase: order.quantity,
          warnings: [],
          rejection_reason: null,
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.risk.limits",
    {
      description: "Current account-level risk limits and utilisation.",
      inputSchema: { account_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      structuredContent: state.getRisk(),
      content: [],
    }),
  );
}
