import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quoteUri = "apex://market/quote/APEX:FX:EURUSD";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withMockEndpoint(test) {
  let sawReplayReconnect = false;
  let nextResourceSequence = 1;
  let nextEventId = 1;
  let nextOrderId = 1;
  let activeStreamsDuringDisconnectedOrder = null;
  const events = [];
  const sseClients = new Set();

  function appendEvent(data) {
    const event = { id: String(nextEventId++), data };
    events.push(event);
    for (const client of sseClients) {
      if (Number(event.id) > client.lastId) {
        client.res.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
    }
  }

  function writeExistingSseEvents(res, lastEventId) {
    if (!lastEventId && events.length === 0) {
      appendEvent({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: quoteUri },
      });
    }

    const lastId = lastEventId ? Number(lastEventId) : 0;
    for (const event of events.filter((candidate) => Number(candidate.id) > lastId)) {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "GET") {
      const lastEventId = req.headers["last-event-id"];
      if (lastEventId) {
        sawReplayReconnect = true;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const normalizedLastEventId = typeof lastEventId === "string" ? lastEventId : undefined;
      writeExistingSseEvents(res, normalizedLastEventId);
      const client = { res, lastId: normalizedLastEventId ? Number(normalizedLastEventId) : 0 };
      sseClients.add(client);
      req.on("close", () => {
        sseClients.delete(client);
      });
      return;
    }

    if (req.method === "DELETE") {
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
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "replay-regression-session",
        });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "production-replay-regression", version: "0.1.0" },
          },
        }));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: "apex.session.capabilities" },
              { name: "apex.session.authenticate" },
            ],
          },
        }));
        return;
      }

      if (message.method === "tools/call" && message.params?.name === "apex.session.capabilities") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              realtime_contract: {
                reconnect_mode: "session_replay",
              },
            },
          },
        }));
        return;
      }

      if (message.method === "tools/call" && message.params?.name === "apex.session.authenticate") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              session_id: "auth-session",
              account_id: "ACC_12345",
            },
          },
        }));
        return;
      }

      if (message.method === "tools/call" && message.params?.name === "apex.order.place") {
        const orderId = `replay-order-${nextOrderId++}`;
        if (orderId === "replay-order-2") {
          activeStreamsDuringDisconnectedOrder = sseClients.size;
        }
        appendEvent({
          jsonrpc: "2.0",
          method: "notifications/apex.order.filled",
          params: {
            event_id: `evt-${orderId}`,
            event_type: "order.filled",
            payload: { order_id: orderId },
          },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            structuredContent: {
              order_id: orderId,
              status: "filled",
            },
          },
        }));
        return;
      }

      if (message.method === "resources/subscribe") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }

      if (message.method === "resources/read" && message.params?.uri === quoteUri) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: [{
              uri: quoteUri,
              mimeType: "application/json",
              text: JSON.stringify({
                instrument_id: "APEX:FX:EURUSD",
                sequence: nextResourceSequence++,
              }),
            }],
          },
        }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await test({
      baseUrl,
      sawReplayReconnect: () => sawReplayReconnect,
      activeStreamsDuringDisconnectedOrder: () => activeStreamsDuringDisconnectedOrder,
    });
  } finally {
    for (const client of sseClients) {
      client.res.end();
    }
    sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
  }
}

function runProductionResilience(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, "production-resilience.mjs"),
      "--url",
      baseUrl,
      "--name",
      "production-replay-regression",
    ], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`production-resilience exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

await withMockEndpoint(async ({ baseUrl, sawReplayReconnect, activeStreamsDuringDisconnectedOrder }) => {
  await runProductionResilience(baseUrl);
  assert.equal(sawReplayReconnect(), true, "production-resilience must reconnect SSE with Last-Event-ID");
  assert.equal(
    activeStreamsDuringDisconnectedOrder(),
    0,
    "production-resilience must close all SSE streams before generating the disconnected replay probe order",
  );
});

console.log("Production replay regression passed");
