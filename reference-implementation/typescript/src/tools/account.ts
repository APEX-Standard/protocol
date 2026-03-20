import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { hoursAgo, nowIso } from "../lib/helpers.js";
import { InstrumentIdSchema } from "../lib/schemas.js";

export function registerAccountTools(server: McpServer): void {
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
    async ({ account_id, currency }) => ({
      structuredContent: {
        account_id,
        account_base_currency: "USD",
        response_currency: currency ?? "USD",
        balance: 10000.0,
        equity: 10250.0,
        used_margin: 500.0,
        free_margin: 9750.0,
        margin_level_pct: 2050.0,
        unrealised_pnl: 250.0,
        realised_pnl_today: 0.0,
        as_of: nowIso(),
      },
      content: [],
    }),
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
    async ({ instrument_id }) => ({
      structuredContent: {
        positions: [
          {
            position_id: "pos_001",
            instrument_id: instrument_id ?? "APEX:FX:EURUSD",
            broker_symbol: "EURUSD",
            side: "buy",
            quantity: 100000,
            quantity_unit: "base_units",
            broker_quantity: "1.0",
            broker_quantity_unit: "lots",
            open_price: 1.085,
            current_price: 1.0875,
            unrealised_pnl: 250.0,
            unrealised_pnl_currency: "USD",
            used_margin: 500.0,
            open_time: hoursAgo(1),
            stop_loss: 1.08,
            take_profit: 1.1,
            profile_data: {
              rollover_long_daily: -2.5,
              rollover_short_daily: 1.8,
              accrued_rollover: -7.5,
              pip_value: 10.0,
              pip_value_currency: "USD",
            },
          },
        ],
        total_unrealised_pnl: 250.0,
        as_of: nowIso(),
      },
      content: [],
    }),
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
      structuredContent: { orders: [], as_of: nowIso() },
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
