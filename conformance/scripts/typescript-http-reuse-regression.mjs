import assert from "node:assert/strict";

import {
  httpDeleteSession,
  httpInitialize,
  resolveTarget,
  startHttpTarget,
  stopHttpServer,
} from "./common.mjs";

const target = resolveTarget(["typescript"]);
let server;

try {
  server = await startHttpTarget(target);

  const first = await httpInitialize(server.baseUrl);
  assert(first.sessionId, "expected first initialize to return a session id");
  await httpDeleteSession(server.baseUrl, first.sessionId);

  const second = await httpInitialize(server.baseUrl);
  assert(second.sessionId, "expected second initialize to return a session id");
  assert.notEqual(second.sessionId, first.sessionId, "expected a fresh MCP session after DELETE");
  await httpDeleteSession(server.baseUrl, second.sessionId);
} finally {
  await stopHttpServer(server);
}

console.log("TypeScript HTTP reuse regression passed");
