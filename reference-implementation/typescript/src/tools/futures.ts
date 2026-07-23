import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { apexError, nowIso } from "../lib/helpers.js";

// Mock chain is a fixed snapshot as of 2026-11-06 (42 days before ESZ26 expiry):
// ESU26 has expired, ESZ26 is front month, ESH27 is next out.
const FUTURES_ROOT_ID = "APEX:FUT:ES";
const FUTURES_EXPIRED_ID = "APEX:FUT:ESU26";
const FUTURES_FRONT_MONTH_ID = "APEX:FUT:ESZ26";
const FUTURES_NEXT_MONTH_ID = "APEX:FUT:ESH27";

export function registerFuturesTools(server: McpServer, state: ReferenceTradingState): void {
  /* ------------------------------------------------------------------ */
  /*  apex.futures.contract_chain                                        */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.futures.contract_chain",
    {
      description:
        "List dated contracts for a futures contract root with expirations and liquidity. Reference implementation serves the E-mini S&P 500 chain.",
      inputSchema: {
        root: z.string().describe("APEX contract root ID (e.g. APEX:FUT:ES)"),
        include_expired: z.boolean().optional().describe("Include expired contracts (default: false)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ root, include_expired }) => {
      if (!root) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "root is required"),
          content: [],
        };
      }
      if (root !== FUTURES_ROOT_ID) {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unknown instrument"),
          content: [],
        };
      }

      const expired = include_expired
        ? [
            {
              instrument_id: FUTURES_EXPIRED_ID,
              contract_month: "2026-09",
              expiration_date: "2026-09-18",
              first_notice_date: null,
              settlement_type: "cash",
              is_front_month: false,
              volume: 0,
              open_interest: 0,
              status: "inactive",
            },
          ]
        : [];

      return {
        structuredContent: {
          root: FUTURES_ROOT_ID,
          contracts: [
            ...expired,
            {
              instrument_id: FUTURES_FRONT_MONTH_ID,
              contract_month: "2026-12",
              expiration_date: "2026-12-18",
              first_notice_date: null,
              settlement_type: "cash",
              is_front_month: true,
              volume: 1250000,
              open_interest: 2100000,
              status: "active",
            },
            {
              instrument_id: FUTURES_NEXT_MONTH_ID,
              contract_month: "2027-03",
              expiration_date: "2027-03-19",
              first_notice_date: null,
              settlement_type: "cash",
              is_front_month: false,
              volume: 41000,
              open_interest: 98000,
              status: "active",
            },
          ],
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.futures.margin_schedule                                       */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.futures.margin_schedule",
    {
      description:
        "Per-contract margin requirements: exchange overnight margins and broker intraday margins. Reference implementation serves the ESZ26 schedule.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        instrument_id: z
          .string()
          .optional()
          .describe("Filter by APEX canonical instrument ID (e.g. APEX:FUT:ESZ26)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id, instrument_id }) => {
      if (!account_id) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "account_id is required"),
          content: [],
        };
      }
      if (instrument_id && instrument_id !== FUTURES_FRONT_MONTH_ID) {
        return {
          structuredContent: apexError("APEX_4010", "validation", "Unknown instrument"),
          content: [],
        };
      }

      return {
        structuredContent: {
          margins: [
            {
              instrument_id: FUTURES_FRONT_MONTH_ID,
              currency: "USD",
              initial_margin: "15500.00",
              maintenance_margin: "14000.00",
              day_trading_margin: "500.00",
              day_trading_hours: [
                { day: "monday", from: "08:30", to: "15:45", timezone: "America/Chicago" },
              ],
              as_of: nowIso(),
            },
          ],
        },
        content: [],
      };
    },
  );
}
