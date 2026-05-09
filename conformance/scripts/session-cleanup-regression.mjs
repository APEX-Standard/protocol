import assert from "node:assert/strict";
import http from "node:http";

import {
  connectClient,
  disconnectClient,
  httpInitialize,
  resolveTarget,
  startHttpTarget,
  stopHttpServer,
} from "./common.mjs";

async function withMockEndpoint(test) {
  const deletedSessions = [];
  let lastSessionId = null;

  const server = http.createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      return;
    }

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      deletedSessions.push(sessionId);
      res.writeHead(202).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const message = JSON.parse(body);
      if (message.method === "initialize") {
        lastSessionId = `session-${deletedSessions.length + 1}`;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": lastSessionId,
        });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "cleanup-regression", version: "0.1.0" },
          },
        }));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await test({ baseUrl, deletedSessions, getLastSessionId: () => lastSessionId });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

await withMockEndpoint(async ({ baseUrl, deletedSessions, getLastSessionId }) => {
  const target = resolveTarget(["--url", baseUrl]);
  const session = await connectClient(target);
  const sessionId = getLastSessionId();

  await disconnectClient(session);

  assert.deepEqual(deletedSessions, [sessionId]);
});

await withMockEndpoint(async ({ baseUrl, deletedSessions, getLastSessionId }) => {
  const target = resolveTarget(["--url", baseUrl]);
  const server = await startHttpTarget(target);
  await httpInitialize(server.baseUrl);
  const sessionId = getLastSessionId();

  await stopHttpServer(server);

  assert.deepEqual(deletedSessions, [sessionId]);
});

console.log("Session cleanup regression passed");
