import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { InstrumentIdSchema } from "../lib/schemas.js";

export function registerMarketTools(server: McpServer, state: ReferenceTradingState): void {
  server.registerTool(
    "apex.market.quote",
    {
      description: "Current bid/ask/mid for an instrument.",
      inputSchema: {
        instrument_id: InstrumentIdSchema.optional(),
        broker_symbol: z.string().optional().describe("Alternative to instrument_id"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ instrument_id, broker_symbol }) => {
      const quote = state.getQuote();
      return {
        structuredContent: {
          ...quote,
          instrument_id: instrument_id ?? quote.instrument_id,
          broker_symbol: broker_symbol ?? quote.broker_symbol,
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.market.snapshot",
    {
      description: "OHLCV candle data for an instrument.",
      inputSchema: {
        instrument_id: InstrumentIdSchema,
        timeframe: z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]),
        from: z.string().describe("ISO8601 start time"),
        to: z.string().optional().describe("ISO8601 end time (defaults to now)"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ timeframe }) => ({
      structuredContent: state.getCandles(timeframe),
      content: [],
    }),
  );

  server.registerTool(
    "apex.market.search",
    {
      description: "Discover instruments by keyword, asset class, or profile.",
      inputSchema: {
        query: z.string().min(1),
        profile: z.enum(["fx", "cfd", "crypto", "derivatives", "fixed_income"]).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query }) => ({
      structuredContent: {
        instruments: [
          {
            instrument_id: "APEX:FX:EURUSD",
            broker_symbol: "EURUSD",
            display_name: "Euro / US Dollar",
            profile: "fx",
            is_tradeable: true,
          },
        ].filter(() => "EURUSD".includes(query.toUpperCase())),
      },
      content: [],
    }),
  );

  server.registerTool(
    "apex.market.details",
    {
      description: "Full contract specification for an instrument.",
      inputSchema: { instrument_id: InstrumentIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ instrument_id }) => ({
      structuredContent: {
        instrument_id,
        broker_symbol: "EURUSD",
        display_name: "Euro / US Dollar",
        profile: "fx",
        base_currency: "EUR",
        quote_currency: "USD",
        pip_size: 0.0001,
        lot_size: 100000,
        quantity_unit: "base_units",
        broker_quantity_unit: "lots",
        min_quantity: 1000,
        max_quantity: 50000000,
        quantity_step: 1000,
        margin_rate_pct: 0.5,
        commission_per_lot: 0,
        spread_type: "variable",
        typical_spread_pips: 0.8,
        trading_hours: [{ day: "monday", open: "00:00", close: "23:59", timezone: "UTC" }],
        profile_data: {},
      },
      content: [],
    }),
  );
}
