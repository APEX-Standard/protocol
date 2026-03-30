import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { apexError, nowIso } from "../lib/helpers.js";

const PERP_INSTRUMENT_ID = "APEX:CRYPTO:PERP:BTCUSDT";
const PERP_BROKER_SYMBOL = "BTCUSDT";

/**
 * Compute the next 8-hour funding boundary (00:00, 08:00, 16:00 UTC).
 */
function nextFundingTime(): { iso: string; countdownSeconds: number } {
  const now = new Date();
  const next = new Date(now);
  const currentHour = now.getUTCHours();
  const nextBoundary = Math.ceil((currentHour + 1) / 8) * 8;
  next.setUTCHours(nextBoundary >= 24 ? 0 : nextBoundary, 0, 0, 0);
  if (nextBoundary >= 24) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  const countdownSeconds = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
  return { iso: next.toISOString(), countdownSeconds };
}

export function registerCryptoTools(server: McpServer, state: ReferenceTradingState): void {
  /* ------------------------------------------------------------------ */
  /*  apex.crypto.funding_rate                                           */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.crypto.funding_rate",
    {
      description:
        "Query funding rate for a perpetual instrument. Returns simulated data for BTCUSDT.",
      inputSchema: {
        instrument_id: z.string().describe("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ instrument_id }) => {
      if (instrument_id !== PERP_INSTRUMENT_ID) {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unknown instrument"),
          content: [],
        };
      }

      const funding = nextFundingTime();

      return {
        structuredContent: {
          instrument_id: PERP_INSTRUMENT_ID,
          broker_symbol: PERP_BROKER_SYMBOL,
          current_rate: 0.0001,
          current_rate_annualised: 0.1095,
          predicted_rate: 0.00012,
          funding_interval_hours: 8,
          next_funding_time: funding.iso,
          countdown_seconds: funding.countdownSeconds,
          index_price: 50000.00,
          mark_price: 50050.00,
          timestamp: nowIso(),
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.crypto.liquidation_estimate                                   */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.crypto.liquidation_estimate",
    {
      description:
        "Estimate liquidation price for a perpetual position based on leverage and margin mode.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        instrument_id: z.string().describe("APEX canonical instrument ID (e.g. APEX:CRYPTO:PERP:BTCUSDT)"),
        side: z.string().describe("Position side: buy or sell"),
        quantity: z.number().describe("Position quantity"),
        leverage: z.number().describe("Leverage multiplier"),
        margin_mode: z.string().describe("Margin mode: cross or isolated"),
        entry_price: z.number().describe("Entry price"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id, instrument_id, side, quantity, leverage, margin_mode, entry_price }) => {
      if (instrument_id !== PERP_INSTRUMENT_ID) {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unknown instrument"),
          content: [],
        };
      }

      const marginRequired = (entry_price * quantity) / leverage;
      const maintenanceMargin = marginRequired / 2;

      let liquidationPrice: number;
      if (side === "buy") {
        liquidationPrice = entry_price * (1 - (1 / leverage) * 0.95);
      } else {
        liquidationPrice = entry_price * (1 + (1 / leverage) * 0.95);
      }
      liquidationPrice = Math.round(liquidationPrice * 100) / 100;

      const distancePct = Math.round((Math.abs(entry_price - liquidationPrice) / entry_price) * 100 * 100) / 100;

      return {
        structuredContent: {
          instrument_id: PERP_INSTRUMENT_ID,
          side,
          entry_price,
          liquidation_price: liquidationPrice,
          margin_required: Math.round(marginRequired * 100) / 100,
          maintenance_margin: Math.round(maintenanceMargin * 100) / 100,
          margin_currency: "USDT",
          distance_pct: distancePct,
          warnings: [],
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.crypto.transfer                                               */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.crypto.transfer",
    {
      description:
        "Transfer funds between wallets (spot, futures, funding). Reference implementation simulates instant completion.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        from_wallet: z.enum(["spot", "futures", "funding"]).describe("Source wallet"),
        to_wallet: z.enum(["spot", "futures", "funding"]).describe("Destination wallet"),
        currency: z.string().describe("Currency to transfer (e.g. USDT)"),
        amount: z.number().describe("Amount to transfer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ account_id, from_wallet, to_wallet, currency, amount }) => {
      if (!account_id) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "account_id is required"),
          content: [],
        };
      }

      if (!from_wallet || !to_wallet || !currency || amount === undefined || amount === null) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "All fields are required: from_wallet, to_wallet, currency, amount"),
          content: [],
        };
      }

      if (from_wallet === to_wallet) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "from_wallet and to_wallet must be different"),
          content: [],
        };
      }

      return {
        structuredContent: {
          transfer_id: crypto.randomUUID(),
          from_wallet,
          to_wallet,
          currency,
          amount,
          status: "completed",
          rejection_reason: null,
          completed_at: nowIso(),
        },
        content: [],
      };
    },
  );
}
