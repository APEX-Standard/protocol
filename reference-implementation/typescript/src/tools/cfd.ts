import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReferenceTradingState } from "../lib/resources.js";
import { apexError, nowIso } from "../lib/helpers.js";

export function registerCfdTools(server: McpServer, state: ReferenceTradingState): void {
  /* ------------------------------------------------------------------ */
  /*  apex.cfd.corporate_actions                                         */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.cfd.corporate_actions",
    {
      description:
        "Query upcoming corporate actions for CFD instruments. Reference implementation returns an empty array.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        instrument_id: z.string().optional().describe("Filter by APEX canonical instrument ID"),
        from: z.string().optional().describe("ISO8601 start date"),
        to: z.string().optional().describe("ISO8601 end date"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id }) => {
      if (!account_id) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "account_id is required"),
          content: [],
        };
      }

      return {
        structuredContent: {
          corporate_actions: [],
        },
        content: [],
      };
    },
  );

  /* ------------------------------------------------------------------ */
  /*  apex.cfd.dividend_adjustment                                       */
  /* ------------------------------------------------------------------ */

  server.registerTool(
    "apex.cfd.dividend_adjustment",
    {
      description:
        "Query dividend adjustments for CFD positions. Reference implementation returns an empty array.",
      inputSchema: {
        account_id: z.string().describe("Trading account ID"),
        status: z.string().optional().describe("Filter by status (default: all)"),
        from: z.string().optional().describe("ISO8601 start date"),
        to: z.string().optional().describe("ISO8601 end date"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ account_id }) => {
      if (!account_id) {
        return {
          structuredContent: apexError("APEX_4011", "validation", "account_id is required"),
          content: [],
        };
      }

      return {
        structuredContent: {
          adjustments: [],
        },
        content: [],
      };
    },
  );
}
