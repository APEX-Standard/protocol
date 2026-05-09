import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { stopHttpServer } from "./common.mjs";

const sockets = new Set();
let deleteAttempted = false;

const endpoint = http.createServer((req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }

  if (req.method === "DELETE") {
    deleteAttempted = true;
    // Simulate a wedged implementation: accept the connection but never
    // complete the response.
    return;
  }

  res.writeHead(405).end();
});

endpoint.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
  });
});

function closeEndpoint() {
  for (const socket of sockets) {
    socket.destroy();
  }
  return new Promise((resolve) => endpoint.close(resolve));
}

await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${endpoint.address().port}`;

const killedSignals = [];
const fakeProcess = {
  kill(signal) {
    killedSignals.push(signal);
  },
  stdin: { destroy() {} },
  stdout: { destroy() {} },
  stderr: { destroy() {} },
};

const cleanup = stopHttpServer({
  baseUrl,
  process: fakeProcess,
  sessionIds: new Set(["wedged-session"]),
}).then(
  () => ({ status: "resolved" }),
  (error) => ({ status: "rejected", error }),
);

try {
  const result = await Promise.race([
    cleanup,
    delay(1500).then(() => ({ status: "timed-out" })),
  ]);

  assert.notEqual(result.status, "timed-out", "cleanup must not hang on a non-responsive DELETE /mcp");
  assert.equal(
    result.status,
    "resolved",
    `spawned target cleanup should not fail only because DELETE /mcp cleanup failed: ${result.error}`,
  );
  assert.equal(deleteAttempted, true, "cleanup should still attempt DELETE /mcp");
  assert(
    killedSignals.includes("SIGTERM"),
    `expected spawned process to receive SIGTERM during cleanup, got ${JSON.stringify(killedSignals)}`,
  );
} finally {
  await closeEndpoint();
  await Promise.race([cleanup, delay(1000)]).catch(() => {});
}

console.log("Cleanup timeout regression passed");
