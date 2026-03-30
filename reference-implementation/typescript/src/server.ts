/**
 * APEX Protocol Reference Implementation — TypeScript
 *
 * This implementation keeps the reference behavior intentionally simple while
 * using a structure that maps more naturally to a production TypeScript service.
 *
 * Supports two transport modes:
 *   stdio  (default)     — `node dist/server.js`
 *   HTTP/SSE             — `node dist/server.js --http <port>`
 */

import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, SERVER_VERSION } from "./lib/constants.js";
import type { ApexNotification } from "./lib/notifications.js";
import { candleClosedNotification } from "./lib/notifications.js";
import { ReplayBuffer } from "./lib/replay-buffer.js";
import { ReferenceTradingState, registerReferenceResources } from "./lib/resources.js";
import { TickEngine } from "./lib/tick-engine.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMarketTools } from "./tools/market.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerFxTools } from "./tools/fx.js";
import { registerCfdTools } from "./tools/cfd.js";
import { registerCryptoTools } from "./tools/crypto.js";
import { registerSessionTools } from "./tools/session.js";

import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Argument parsing                                                   */
/* ------------------------------------------------------------------ */

function parseArgs(): { mode: "stdio" } | { mode: "http"; port: number } {
  const idx = process.argv.indexOf("--http");
  if (idx === -1) return { mode: "stdio" };
  const portStr = process.argv[idx + 1];
  const port = Number(portStr);
  if (!portStr || Number.isNaN(port) || port < 1 || port > 65535) {
    console.error("Usage: node server.js --http <port>");
    process.exit(1);
  }
  return { mode: "http", port };
}

/* ------------------------------------------------------------------ */
/*  Common setup                                                       */
/* ------------------------------------------------------------------ */

function setupCommon(server: McpServer) {
  server.server.registerCapabilities({
    resources: {
      subscribe: true,
      listChanged: true,
    },
  });

  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
  server.server.fallbackRequestHandler = async (request) => {
    if (request.method === "resources/subscribe" || request.method === "resources/unsubscribe") {
      return {};
    }
    throw new Error(`Method not found: ${request.method}`);
  };
}

/* ------------------------------------------------------------------ */
/*  Stdio mode                                                         */
/* ------------------------------------------------------------------ */

const APEX_VERSION = "0.1.0-alpha";

async function startStdio() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    apex_version: APEX_VERSION,
  } as any);
  const state = new ReferenceTradingState();

  setupCommon(server);

  registerSessionTools(server, state);
  registerReferenceResources(server, state);
  registerAccountTools(server, state);
  registerOrderTools(server, state);
  registerMarketTools(server, state);
  registerRiskTools(server, state);
  registerFxTools(server, state);
  registerCfdTools(server, state);
  registerCryptoTools(server, state);

  await server.connect(new StdioServerTransport());
  console.error(`APEX Protocol Reference Server v${SERVER_VERSION} running`);
}

/* ------------------------------------------------------------------ */
/*  HTTP/SSE mode                                                      */
/* ------------------------------------------------------------------ */

async function startHttp(port: number) {
  // Dynamic import of express to keep it out of the stdio path
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());

  const replayBuffer = new ReplayBuffer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: replayBuffer,
  });

  // Guard against SSE cancel race condition.
  // The SDK's ReadableStream cancel callback unconditionally deletes '_GET_stream'
  // from _streamMapping. If the old stream's cancel fires after a new stream is
  // registered under the same key, it removes the new stream. We intercept delete
  // to only allow it when the entry's controller matches what was most recently set.
  {
    const webTransport = (transport as any);
    const streamMapping: Map<string, any> = webTransport._streamMapping;
    if (streamMapping) {
      let currentStandaloneController: any = null;
      const standaloneSseStreamId = webTransport._standaloneSseStreamId ?? "_GET_stream";

      const originalSet = streamMapping.set.bind(streamMapping);
      const originalDelete = streamMapping.delete.bind(streamMapping);

      streamMapping.set = function(key: string, value: any) {
        if (key === standaloneSseStreamId && value?.controller) {
          currentStandaloneController = value.controller;
        }
        return originalSet(key, value);
      } as typeof streamMapping.set;

      streamMapping.delete = function(key: string) {
        if (key === standaloneSseStreamId) {
          const current = streamMapping.get(key);
          if (current && current.controller !== currentStandaloneController) {
            // Stale cancel callback — a new stream has replaced us. Skip.
            return false;
          }
        }
        return originalDelete(key);
      } as typeof streamMapping.delete;
    }
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    apex_version: APEX_VERSION,
  } as any);
  const state = new ReferenceTradingState();

  setupCommon(server);

  /* -- Notification helper ----------------------------------------- */

  const emitNotification = (notif: ApexNotification) => {
    server.server.notification({
      method: notif.method,
      params: notif.params,
    }).catch((err: unknown) => {
      console.error("Failed to send APEX notification:", err);
    });
  };

  state.emitNotification = emitNotification;

  /* -- Tick engine ------------------------------------------------- */

  const tickEngine = new TickEngine({
    onQuoteUpdate(mid, bid, ask) {
      state.updateQuote(mid, bid, ask);
      state.bumpResources(state.uris.quote, state.uris.features);
      server.server.notification({
        method: "notifications/resources/updated",
        params: { uri: state.uris.quote },
      }).catch(() => {});
      server.server.notification({
        method: "notifications/resources/updated",
        params: { uri: state.uris.features },
      }).catch(() => {});
    },

    onCandleClose(timeframe, candle) {
      const candleUri =
        timeframe === "M1" ? state.uris.candlesM1
        : timeframe === "M5" ? state.uris.candlesM5
        : state.uris.candlesH1;

      state.bumpResources(candleUri);

      const seq = (state.getCandles(timeframe as "M1" | "M5" | "H1") as Record<string, unknown>).sequence as number ?? 1;
      const notif = candleClosedNotification(
        state.instrumentId,
        timeframe,
        {
          time: candle.openTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        },
        seq,
      );
      server.server.notification({
        method: notif.method,
        params: notif.params,
      }).catch(() => {});

      server.server.notification({
        method: "notifications/resources/updated",
        params: { uri: candleUri },
      }).catch(() => {});
    },

    onCandleUpdate(timeframe) {
      const candleUri =
        timeframe === "M1" ? state.uris.candlesM1
        : timeframe === "M5" ? state.uris.candlesM5
        : state.uris.candlesH1;

      server.server.notification({
        method: "notifications/resources/updated",
        params: { uri: candleUri },
      }).catch(() => {});
    },

    onFeatureUpdate() {
      server.server.notification({
        method: "notifications/resources/updated",
        params: { uri: state.uris.features },
      }).catch(() => {});
    },
  });

  /* -- Register tools ---------------------------------------------- */

  registerSessionTools(server, state, {
    transportMode: "streamable_http",
    replayBuffer,
    onAuthenticated: () => {
      tickEngine.start();
      console.error("Tick engine started after authentication");
    },
  });
  registerReferenceResources(server, state);
  registerAccountTools(server, state);
  registerOrderTools(server, state, emitNotification);
  registerMarketTools(server, state);
  registerRiskTools(server, state);
  registerFxTools(server, state);
  registerCfdTools(server, state);
  registerCryptoTools(server, state);

  /* -- Test-only: force candle close ------------------------------- */

  server.registerTool(
    "reference.test.force_candle_close",
    {
      description: "Force-close the current partial candle for a given timeframe. Test-only.",
      inputSchema: { timeframe: z.enum(["M1", "M5", "H1"]) },
    },
    async ({ timeframe }) => {
      tickEngine.forceCandleClose(timeframe);
      return { structuredContent: { closed: true, timeframe }, content: [] };
    },
  );

  /* -- Test-only: stop tick engine ---------------------------------- */

  server.registerTool(
    "reference.test.stop_ticks",
    {
      description: "Stop the tick engine. Test-only tool for deterministic event counts.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      tickEngine.stop();
      return { structuredContent: { stopped: true }, content: [] };
    },
  );

  /* -- Express routes ---------------------------------------------- */

  app.post("/mcp", (req, res) => {
    transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (req, res) => {
    // Always close any previous standalone SSE stream before handling a new GET.
    // Client-side aborts are not reliably detected by Node.js, so the old stream
    // may still be in the mapping. This prevents 409 conflicts.
    transport.closeStandaloneSSEStream();
    transport.handleRequest(req, res);
  });
  app.delete("/mcp", (req, res) => {
    transport.handleRequest(req, res);
  });

  /* -- Cleanup on session close ------------------------------------- */

  transport.onclose = () => {
    tickEngine.stop();
    console.error("Tick engine stopped (transport closed)");
  };

  /* -- Connect and start ------------------------------------------- */

  await server.connect(transport);

  app.listen(port, () => {
    console.error(`APEX Protocol Reference Server v${SERVER_VERSION} listening on http://localhost:${port}/mcp`);
  });
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

const args = parseArgs();
if (args.mode === "http") {
  await startHttp(args.port);
} else {
  await startStdio();
}
