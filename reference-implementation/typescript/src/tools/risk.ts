import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { InstrumentIdSchema, OrderTypeSchema, SideSchema } from "../lib/schemas.js";

export function registerRiskTools(server: McpServer): void {
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
    async ({ account_id }) => ({
      structuredContent: {
        account_id,
        max_position_size: 5000000,
        max_open_orders: 50,
        daily_loss_limit: -1000.0,
        daily_loss_used: -150.0,
        margin_call_level_pct: 100,
        stop_out_level_pct: 50,
        restricted_instruments: [],
        kill_switch_active: false,
      },
      content: [],
    }),
  );
}
