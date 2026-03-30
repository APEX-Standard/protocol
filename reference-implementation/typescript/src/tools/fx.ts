import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { apexError, nowIso } from "../lib/helpers.js";

/**
 * Compute the next 21:00 UTC rollover time from the current moment.
 */
function nextRolloverTime(): string {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(21, 0, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

export function registerFxTools(server: McpServer, state: ReferenceTradingState): void {
  /* ------------------------------------------------------------------ */
  /*  apex.fx.rollover                                                   */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.fx.rollover",
    {
      description:
        "Query swap/rollover rates for an FX instrument. Rates are expressed in account currency per lot per night.",
      inputSchema: {
        instrument_id: z.string().describe("APEX canonical instrument ID (e.g. APEX:FX:EURUSD)"),
        as_of: z.string().optional().describe("ISO8601 timestamp — defaults to now"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ instrument_id }) => {
      if (instrument_id !== "APEX:FX:EURUSD") {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unknown instrument"),
          content: [],
        };
      }

      return {
        structuredContent: {
          instrument_id: "APEX:FX:EURUSD",
          broker_symbol: "EURUSD",
          rollover_long: -0.5,
          rollover_short: 0.3,
          rollover_currency: "USD",
          rollover_per: "lot",
          lot_size: 100000,
          triple_rollover_day: "Wednesday",
          next_rollover_time: nextRolloverTime(),
          as_of: nowIso(),
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.fx.exposure                                                   */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.fx.exposure",
    {
      description:
        "Net currency exposure across open FX positions. Critical for agents managing portfolio-level currency risk.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        base_currency: z.string().describe("Denominate all exposures in this currency"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id, base_currency }) => {
      if (!account_id) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "account_id is required"),
          content: [],
        };
      }

      // Get current positions from state
      const positionsPayload = state.getPositions();
      const positions = (positionsPayload as Record<string, unknown>).positions as Array<Record<string, unknown>> ?? [];

      // Compute EUR exposure from open EURUSD positions
      let eurNetUnits = 0;
      const contributingPositions: string[] = [];

      for (const pos of positions) {
        if (pos.instrument_id === "APEX:FX:EURUSD") {
          const qty = pos.quantity as number;
          const side = pos.side as string;
          eurNetUnits += side === "buy" ? qty : -qty;
          contributingPositions.push(pos.position_id as string);
        }
      }

      const rate = 1.0875; // reference mid price
      const valueInBase = base_currency === "EUR"
        ? eurNetUnits
        : eurNetUnits * rate;

      const netDirection = eurNetUnits > 0 ? "long" : eurNetUnits < 0 ? "short" : "flat";

      return {
        structuredContent: {
          account_id,
          base_currency,
          exposures: [
            {
              currency: "EUR",
              net_units: eurNetUnits,
              net_direction: netDirection,
              value_in_base: valueInBase,
              contributing_positions: contributingPositions,
            },
          ],
          total_gross_exposure: Math.abs(valueInBase),
          as_of: nowIso(),
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.fx.conversion                                                 */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.fx.conversion",
    {
      description:
        "Real-time cross-currency conversion rate. Used by agents to calculate P&L in a target currency.",
      inputSchema: {
        from_currency: z.string().describe("Source currency code (e.g. EUR)"),
        to_currency: z.string().describe("Target currency code (e.g. USD)"),
        amount: z.number().describe("Amount to convert"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ from_currency, to_currency, amount }) => {
      if (!from_currency || !to_currency || amount === undefined || amount === null) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "from_currency, to_currency, and amount are all required"),
          content: [],
        };
      }

      const midRate = 1.0875; // reference EUR/USD mid
      let rate: number;

      if (from_currency === to_currency) {
        rate = 1.0;
      } else if (from_currency === "EUR" && to_currency === "USD") {
        rate = midRate;
      } else if (from_currency === "USD" && to_currency === "EUR") {
        rate = 1.0 / midRate;
      } else {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unsupported currency pair"),
          content: [],
        };
      }

      return {
        structuredContent: {
          from_currency,
          to_currency,
          rate: Math.round(rate * 10000000) / 10000000,
          converted_amount: Math.round(amount * rate * 100) / 100,
          timestamp: nowIso(),
        },
        content: [],
      };
    },
  );
}
