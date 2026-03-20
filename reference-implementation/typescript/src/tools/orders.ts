import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { apexError, nowIso } from "../lib/helpers.js";
import {
  InstrumentIdSchema,
  OrderTypeSchema,
  PriceStopSchema,
  SideSchema,
  TifSchema,
  TrailingStopSchema,
} from "../lib/schemas.js";

const OrderSchema = z.object({
  instrument_id: InstrumentIdSchema,
  broker_symbol: z.string().optional(),
  side: SideSchema,
  order_type: OrderTypeSchema,
  quantity: z.number().positive(),
  quantity_unit: z.enum(["base_units", "shares", "contracts"]).default("base_units"),
  time_in_force: TifSchema.default("GTC"),
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  stop_loss: PriceStopSchema,
  take_profit: PriceStopSchema,
  trailing_stop: TrailingStopSchema,
  profile: z.string().optional(),
  profile_data: z.record(z.unknown()).optional(),
  client_order_id: z.string().optional(),
  strategy_id: z.string().optional(),
  comment: z.string().optional(),
});

const OrderModificationSchema = z.object({
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  quantity: z.number().positive().optional(),
  stop_loss: PriceStopSchema,
  take_profit: PriceStopSchema,
  trailing_stop: TrailingStopSchema,
});

export function registerOrderTools(server: McpServer): void {
  server.registerTool(
    "apex.order.place",
    {
      description: "Unified order entry across all asset classes. Profile-composable.",
      inputSchema: {
        account_id: z.string(),
        order: OrderSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ order }) => {
      if (order.order_type === "limit" && order.limit_price === undefined) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "limit_price required for limit orders"),
          content: [],
        };
      }

      const isMarketOrder = order.order_type === "market";

      return {
        structuredContent: {
          order_id: `ord_${crypto.randomUUID().slice(0, 8)}`,
          client_order_id: order.client_order_id ?? null,
          status: isMarketOrder ? "filled" : "working",
          fill_price: isMarketOrder ? 1.08755 : null,
          fill_quantity: isMarketOrder ? order.quantity : 0,
          remaining_quantity: isMarketOrder ? 0 : order.quantity,
          position_id: isMarketOrder ? "pos_001" : null,
          rejection_reason: null,
          created_at: nowIso(),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.order.modify",
    {
      description: "Amend a working order or an open position's protection settings.",
      inputSchema: {
        account_id: z.string(),
        target_type: z.enum(["order", "position"]),
        target_id: z.string(),
        modifications: OrderModificationSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ target_type, target_id, modifications }) => {
      if (
        target_type === "position" &&
        (modifications.limit_price !== undefined ||
          modifications.stop_price !== undefined ||
          modifications.quantity !== undefined)
      ) {
        return {
          structuredContent: apexError(
            "APEX_4011",
            "validation",
            "Positions may only amend stop_loss, take_profit, or trailing_stop",
          ),
          content: [],
        };
      }

      return {
        structuredContent: {
          target_type,
          target_id,
          status: "modified",
          rejection_reason: null,
          updated_at: nowIso(),
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.order.cancel",
    {
      description: "Cancel a working or partially filled order.",
      inputSchema: {
        account_id: z.string(),
        order_id: z.string(),
        reason: z.string().optional().describe("Agent-provided reason for audit trail"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ order_id }) => ({
      structuredContent: {
        order_id,
        status: "cancelled",
        rejection_reason: null,
        cancelled_at: nowIso(),
      },
      content: [],
    }),
  );

  server.registerTool(
    "apex.order.status",
    {
      description: "Query the current state of a single order.",
      inputSchema: {
        account_id: z.string(),
        order_id: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ order_id }) => ({
      structuredContent: {
        order_id,
        status: "working",
        filled_quantity: 0,
        as_of: nowIso(),
      },
      content: [],
    }),
  );
}
