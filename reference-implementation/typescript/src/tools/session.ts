import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  CORE_TOOL_CAPABILITIES,
  SERVER_VERSION,
  SUPPORTED_ORDER_TYPES,
  SUPPORTED_PROFILES,
  SUPPORTED_TIF,
} from "../lib/constants.js";
import { apexError, hoursFromNow, nowIso } from "../lib/helpers.js";
import type { ReferenceTradingState } from "../lib/resources.js";
import { z } from "zod";

export function registerSessionTools(server: McpServer, state: ReferenceTradingState): void {
  server.registerTool(
    "apex.session.authenticate",
    {
      description:
        "Establish an authenticated trading session. The broker validates credentials directly and binds the result to the MCP session.",
      inputSchema: {
        token: z.string().describe("Broker-issued JWT or OAuth token"),
        token_type: z.enum(["jwt", "oauth2"]).default("jwt"),
        account_id: z.string().optional().describe("Optional — broker may derive from token"),
        hub_session_id: z.string().optional().describe("Optional session reference from caller"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ token, account_id }) => {
      if (token.length < 10) {
        return {
          structuredContent: apexError("APEX_4001", "auth", "Invalid or expired token"),
          content: [],
        };
      }

      return {
        structuredContent: {
          session_id: crypto.randomUUID(),
          account_id: account_id ?? "ACC_12345",
          expires_at: hoursFromNow(1),
          capabilities: [...CORE_TOOL_CAPABILITIES],
          profiles: [...SUPPORTED_PROFILES],
          broker_id: "reference-broker",
          broker_name: "APEX Reference Broker",
        },
        content: [],
      };
    },
  );

  server.registerTool(
    "apex.session.capabilities",
    {
      description: "Query the full capability manifest of this broker implementation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      structuredContent: {
        apex_version: SERVER_VERSION,
        broker_id: "reference-broker",
        core_tools: [...CORE_TOOL_CAPABILITIES],
        profiles: { fx: SERVER_VERSION },
        vendor_extensions: null,
        rate_limits: { orders_per_second: 10, market_data_per_second: 100 },
        supported_order_types: [...SUPPORTED_ORDER_TYPES],
        supported_tif: [...SUPPORTED_TIF],
        realtime_contract: {
          reconnect_mode: "no_replay",
          quote_freshness_ms: 1000,
          account_freshness_ms: 2000,
        },
      },
      content: [],
    }),
  );

  server.registerTool(
    "apex.session.heartbeat",
    {
      description: "Keep-alive ping. Hub marks session degraded if response exceeds 500ms.",
      inputSchema: { timestamp: z.string().describe("ISO8601 timestamp") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({
      structuredContent: { timestamp: nowIso(), status: "ok" },
      content: [],
    }),
  );

  server.registerTool(
    "reference.test.set_realtime_state",
    {
      description: "Reference-only fault injection for conformance and resilience testing.",
      inputSchema: {
        quote_stale: z.boolean().optional(),
        risk_stale: z.boolean().optional(),
        force_sequence_gap: z.boolean().optional(),
        kill_switch_active: z.boolean().optional(),
        partial_fill_next_order: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      state.setRealtimeFaults(input);
      return {
        structuredContent: {
          ok: true,
          faults: state.currentFaults(),
        },
        content: [],
      };
    },
  );
}
