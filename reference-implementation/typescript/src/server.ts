/**
 * APEX Protocol Reference Implementation — TypeScript
 *
 * This implementation keeps the reference behavior intentionally simple while
 * using a structure that maps more naturally to a production TypeScript service.
 *
 * Start with: `node dist/server.js` (defaults to port 8888) or
 * `node dist/server.js --http <port>`.
 */

import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

function parseArgs(): { port: number } {
  const defaultPort = 8888;
  const idx = process.argv.indexOf("--http");
  if (idx === -1) return { port: defaultPort };

  const portStr = process.argv[idx + 1];
  if (!portStr) return { port: defaultPort };

  const port = Number(portStr);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error("Usage: node server.js [--http <port>]");
    process.exit(1);
  }
  return { port };
}

/* ------------------------------------------------------------------ */
/*  Common setup                                                       */
/* ------------------------------------------------------------------ */

function setupCommon(server: McpServer): { emitResourceUpdated: (uri: string) => void } {
  server.server.registerCapabilities({
    resources: {
      subscribe: true,
      listChanged: true,
    },
  });

  /** Tracked resource subscriptions (URIs the client subscribed to). */
  const subscribedUris = new Set<string>();

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = (req.params as { uri: string }).uri;
    if (uri) subscribedUris.add(uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const uri = (req.params as { uri: string }).uri;
    if (uri) subscribedUris.delete(uri);
    return {};
  });
  server.server.fallbackRequestHandler = async (request) => {
    if (request.method === "resources/subscribe") {
      const uri = (request.params as { uri: string })?.uri;
      if (uri) subscribedUris.add(uri);
      return {};
    }
    if (request.method === "resources/unsubscribe") {
      const uri = (request.params as { uri: string })?.uri;
      if (uri) subscribedUris.delete(uri);
      return {};
    }
    throw new Error(`Method not found: ${request.method}`);
  };

  /**
   * Send a resource-updated notification only if the URI is subscribed.
   * APEX domain notifications bypass this and always broadcast.
   */
  const emitResourceUpdated = (uri: string) => {
    if (!subscribedUris.has(uri)) return;
    server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    }).catch(() => {});
  };

  return { emitResourceUpdated };
}

const APEX_VERSION = "0.2.0-alpha";

/* ------------------------------------------------------------------ */
/*  HTTP/SSE mode                                                      */
/* ------------------------------------------------------------------ */

async function startHttp(port: number) {
  const express = (await import("express")).default;

  const app = express();
  app.use(express.json());

  type ExpressRequest = import("express").Request;
  type ExpressResponse = import("express").Response;
  type HttpSessionContext = {
    sessionId?: string;
    server: McpServer;
    transport: StreamableHTTPServerTransport;
    tickEngine: TickEngine;
  };

  const sessions = new Map<string, HttpSessionContext>();

  function getSessionId(req: ExpressRequest): string | undefined {
    const value = req.headers["mcp-session-id"];
    return Array.isArray(value) ? value[0] : value;
  }

  function sendJsonRpcError(res: ExpressResponse, status: number, code: number, message: string) {
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });
  }

  function patchStandaloneSseRace(transport: StreamableHTTPServerTransport) {
    // Guard against SSE cancel race condition.
    // The SDK's ReadableStream cancel callback unconditionally deletes '_GET_stream'
    // from _streamMapping. If the old stream's cancel fires after a new stream is
    // registered under the same key, it removes the new stream. We intercept delete
    // to only allow it when the entry's controller matches what was most recently set.
    const webTransport = (transport as any)._webStandardTransport ?? (transport as any);
    const streamMapping: Map<string, any> | undefined = webTransport._streamMapping;
    if (!streamMapping) {
      return;
    }

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
          return false;
        }
      }
      return originalDelete(key);
    } as typeof streamMapping.delete;
  }

  async function createSessionContext(): Promise<HttpSessionContext> {
    const replayBuffer = new ReplayBuffer();
    let context: HttpSessionContext | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: replayBuffer,
      onsessioninitialized: (sessionId: string) => {
        if (!context) {
          throw new Error("MCP session initialized before context was ready");
        }
        context.sessionId = sessionId;
        sessions.set(sessionId, context);
      },
    });
    patchStandaloneSseRace(transport);

    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      apex_version: APEX_VERSION,
    } as any);
    const state = new ReferenceTradingState();

    const { emitResourceUpdated } = setupCommon(server);

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
    state.emitResourceUpdated = emitResourceUpdated;

    /* -- Tick engine ------------------------------------------------- */

    const tickEngine = new TickEngine({
      onQuoteUpdate(mid, bid, ask) {
        state.updateQuote(mid, bid, ask);
        state.bumpResources(state.uris.quote, state.uris.features);
        emitResourceUpdated(state.uris.quote);
        emitResourceUpdated(state.uris.features);
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

        emitResourceUpdated(candleUri);
      },

      onCandleUpdate(timeframe) {
        const candleUri =
          timeframe === "M1" ? state.uris.candlesM1
          : timeframe === "M5" ? state.uris.candlesM5
          : state.uris.candlesH1;

        emitResourceUpdated(candleUri);
      },

      onFeatureUpdate() {
        emitResourceUpdated(state.uris.features);
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

    context = { server, transport, tickEngine };
    transport.onclose = () => {
      if (context?.sessionId) {
        sessions.delete(context.sessionId);
      }
      tickEngine.stop();
      console.error("Tick engine stopped (transport closed)");
    };

    await server.connect(transport);
    return context;
  }

  function getExistingContext(req: ExpressRequest, res: ExpressResponse): HttpSessionContext | undefined {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return undefined;
    }

    const context = sessions.get(sessionId);
    if (!context) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return undefined;
    }
    return context;
  }

  /* -- Express routes ---------------------------------------------- */

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = getSessionId(req);
      if (sessionId) {
        const context = sessions.get(sessionId);
        if (!context) {
          sendJsonRpcError(res, 404, -32001, "Session not found");
          return;
        }
        await context.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        sendJsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
        return;
      }

      const context = await createSessionContext();
      await context.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });
  app.get("/mcp", async (req, res) => {
    try {
      const context = getExistingContext(req, res);
      if (!context) {
        return;
      }
      // Always close any previous standalone SSE stream before handling a new GET.
      // Client-side aborts are not reliably detected by Node.js, so the old stream
      // may still be in the mapping. This prevents 409 conflicts.
      context.transport.closeStandaloneSSEStream();
      await context.transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP GET:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });
  app.delete("/mcp", async (req, res) => {
    try {
      const context = getExistingContext(req, res);
      if (!context) {
        return;
      }
      await context.transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP DELETE:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  app.listen(port, () => {
    console.error(`APEX Protocol Reference Server v${SERVER_VERSION} listening on http://localhost:${port}/mcp`);
  });
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

const args = parseArgs();
await startHttp(args.port);
