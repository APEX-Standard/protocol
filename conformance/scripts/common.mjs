import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const httpTargetsByBaseUrl = new Map();
const deleteSessionTimeoutMs = 1000;

export const httpServers = {
  typescript: {
    cwd: path.join(repoRoot, "reference-implementation", "typescript"),
    command: "node",
    args: ["dist/server.js", "--http"],
  },
  go: {
    cwd: path.join(repoRoot, "reference-implementation", "go"),
    command: "go",
    args: ["run", ".", "--http"],
  },
  rust: {
    cwd: path.join(repoRoot, "reference-implementation", "rust"),
    command: "./target/debug/apex-reference",
    args: ["--http"],
  },
  java: {
    cwd: path.join(repoRoot, "reference-implementation", "java"),
    command: "java",
    args: ["-jar", "target/apex-reference-java-0.1.0.jar", "--http"],
  },
};

export function getHttpServerConfig(name) {
  const config = httpServers[name];
  assert(config, `Unknown server target: ${name}`);
  return config;
}

function normalizeConfig(config) {
  if (config?.url) {
    return {
      url: config.url.replace(/\/$/, ""),
    };
  }

  assert(config?.command, "Server config must include a command");
  return {
    command: config.command,
    args: Array.isArray(config.args) ? config.args : [],
    cwd: config.cwd ?? process.cwd(),
  };
}

function parseArgs(argv) {
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (key === "verbose") {
      options.verbose = true;
      continue;
    }

    const value = argv[i + 1];
    assert(value && !value.startsWith("--"), `Missing value for --${key}`);
    options[key] = value;
    i += 1;
  }

  return { options, positional };
}

function pick(value, fallback) {
  return value === undefined ? fallback : value;
}

function normalizeTestOptions(options = {}, config = {}) {
  const source = config.test_options ?? {};
  return {
    validToken: pick(options["auth-token"], pick(source.auth_token, "valid-token-12345")),
    invalidToken: pick(options["invalid-token"], pick(source.invalid_token, "short")),
    tokenType: pick(options["token-type"], pick(source.token_type, "jwt")),
    instrumentId: pick(options["instrument-id"], pick(source.instrument_id, "APEX:FX:EURUSD")),
    responseCurrency: pick(options.currency, pick(source.currency, "EUR")),
    expectedAccountBaseCurrency: pick(
      options["expected-account-base-currency"],
      pick(source.expected_account_base_currency, null),
    ),
    expectedBrokerQuantityUnit: pick(
      options["expected-broker-quantity-unit"],
      pick(source.expected_broker_quantity_unit, null),
    ),
  };
}

export function resolveTarget(argv) {
  const { options, positional } = parseArgs(argv);

  if (options.config) {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const normalized = normalizeConfig(config);
    return {
      label: config.name ?? path.basename(configPath),
      config: normalized.url ? null : normalized,
      baseUrl: normalized.url,
      testOptions: normalizeTestOptions(options, config),
      verbose: Boolean(options.verbose),
    };
  }

  if (options.url) {
    return {
      label: options.name ?? options.url,
      config: null,
      baseUrl: options.url.replace(/\/$/, ""),
      testOptions: normalizeTestOptions(options),
      verbose: Boolean(options.verbose),
    };
  }

  if (options.command) {
    const parsedArgs = options.args ? JSON.parse(options.args) : [];
    assert(Array.isArray(parsedArgs), "--args must be a JSON array");
    return {
      label: options.name ?? "custom",
      config: normalizeConfig({
        command: options.command,
        args: parsedArgs,
        cwd: options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd(),
      }),
      testOptions: normalizeTestOptions(options),
      verbose: Boolean(options.verbose),
    };
  }

  const serverName = positional[0];
  assert(serverName, "Usage: node <script> <typescript|go|rust|java> or --url <http://host:port> or --command <cmd> [--args '[...]'] [--cwd <dir>] or --config <path>");
  return {
    label: serverName,
    config: normalizeConfig(getHttpServerConfig(serverName)),
    testOptions: normalizeTestOptions(options),
    verbose: Boolean(options.verbose),
  };
}

export function formatCommand(config) {
  const renderedArgs = config.args.map((arg) => JSON.stringify(arg)).join(" ");
  return [config.command, renderedArgs].filter(Boolean).join(" ");
}

async function httpJsonRpc(baseUrl, sessionId, method, params = {}) {
  const { json } = await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: nextId(),
    method,
    params,
  });
  if (json?.error) {
    const error = new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    error.code = json.error.code;
    error.data = json.error.data;
    throw error;
  }
  return json?.result ?? {};
}

export async function connectClient(target, options = {}) {
  const server = await startHttpTarget(target, options);
  const { sessionId } = await httpInitialize(server.baseUrl);
  const notificationHandlers = [];
  const sse = openSseStream(server.baseUrl, sessionId, undefined, (event) => {
    if (!event.data?.method) return;
    for (const handler of notificationHandlers) {
      handler(event.data);
    }
  });

  await delay(50);

  let notificationStreamClosed = false;
  async function closeNotificationStream() {
    if (notificationStreamClosed) {
      return;
    }
    notificationStreamClosed = true;
    await sse.close();
  }

  const client = {
    listTools: () => httpJsonRpc(server.baseUrl, sessionId, "tools/list"),
    listResources: () => httpJsonRpc(server.baseUrl, sessionId, "resources/list"),
    readResource: ({ uri }) => httpJsonRpc(server.baseUrl, sessionId, "resources/read", { uri }),
    subscribeResource: ({ uri }) => httpJsonRpc(server.baseUrl, sessionId, "resources/subscribe", { uri }),
    unsubscribeResource: ({ uri }) => httpJsonRpc(server.baseUrl, sessionId, "resources/unsubscribe", { uri }),
    callTool: ({ name, arguments: args }) => httpJsonRpc(server.baseUrl, sessionId, "tools/call", { name, arguments: args }),
    setNotificationHandler: (_schema, handler) => {
      notificationHandlers.push(handler);
    },
  };

  return {
    client,
    server,
    sessionId,
    getStderr: () => server.getStderr?.() ?? "",
    closeNotificationStream,
    close: async () => {
      await closeNotificationStream();
      await stopHttpServer(server);
    },
  };
}

export async function disconnectClient(session) {
  await session.close?.();
}

export function extractPayload(result) {
  if (result?.structuredContent) {
    return result.structuredContent;
  }

  const text = result?.content?.find((item) => item.type === "text")?.text;
  assert(text, "Expected either structuredContent or text content");
  return JSON.parse(text);
}

export async function callTool(client, name, args) {
  return extractPayload(
    await client.callTool({ name, arguments: args }),
  );
}

export function assertApexError(payload, code) {
  assert(payload?.error, `Expected APEX error payload, got ${JSON.stringify(payload)}`);
  assert.equal(payload.error.code, code);
  return payload.error;
}

export function assertIsoCurrency(value, fieldName) {
  assert.equal(typeof value, "string", `${fieldName} must be a string`);
  assert.match(value, /^[A-Z]{3}$/, `${fieldName} must be a 3-letter ISO currency code`);
}

export function assertNonEmptyString(value, fieldName) {
  assert.equal(typeof value, "string", `${fieldName} must be a string`);
  assert(value.trim().length > 0, `${fieldName} must be non-empty`);
}

// APEX 0.2.0-alpha: monetary/price/rate/quantity values are string-encoded
// decimals (`^-?[0-9]+(\.[0-9]+)?$`), never JSON numbers. Asserts the wire type
// and returns the parsed numeric value for range checks.
export function assertDecimalString(value, fieldName) {
  assert.equal(typeof value, "string", `${fieldName} must be a string-encoded decimal`);
  assert.match(value, /^-?[0-9]+(\.[0-9]+)?$/, `${fieldName} must match the APEX decimal pattern ^-?[0-9]+(\\.[0-9]+)?$`);
  return Number(value);
}

export function printCheck(label) {
  process.stdout.write(`- ${label}\n`);
}

export function printCapturedStderr(session) {
  const stderr = session.getStderr();
  if (!stderr) {
    return;
  }

  process.stderr.write("\n[server stderr]\n");
  process.stderr.write(`${stderr}\n`);
}

export async function startHttpTarget(target, options = {}) {
  if (target.baseUrl) {
    return trackHttpTarget({
      baseUrl: target.baseUrl,
      process: null,
      port: null,
      sessionIds: new Set(),
      getStderr: () => "",
    });
  }

  return spawnHttpServer(target.config, options);
}

export async function spawnHttpServer(target, options = {}) {
  const config = typeof target === "string" ? getHttpServerConfig(target) : normalizeConfig(target);
  const port = 10000 + Math.floor(Math.random() * 50000);
  const args = [...config.args, String(port)];
  const verbose = Boolean(options.verbose);

  if (verbose) {
    printCheck(`starting HTTP server: ${config.command} ${args.map((a) => JSON.stringify(a)).join(" ")} (cwd: ${config.cwd})`);
  }

  const child = spawn(config.command, args, {
    cwd: config.cwd,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (verbose) {
      process.stderr.write(text);
    }
  });

  // Wait for the server to signal it is listening
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`HTTP server did not start within 30 seconds. stderr: ${stderr}`));
    }, 30000);

    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => {
      if (line.includes(String(port)) || line.toLowerCase().includes("listening")) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      rl.close();
      reject(err);
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        rl.close();
        reject(new Error(`HTTP server exited with code ${code}. stderr: ${stderr}`));
      }
    });
  });

  return trackHttpTarget({
    baseUrl: `http://localhost:${port}`,
    process: child,
    port,
    sessionIds: new Set(),
    getStderr: () => stderr.trim(),
  });
}

function trackHttpTarget(server) {
  httpTargetsByBaseUrl.set(server.baseUrl, server);
  return server;
}

export async function stopHttpServer(server) {
  if (!server) {
    return;
  }

  const hasSpawnedProcess = Boolean(server.process);
  const cleanupErrors = [];
  try {
    for (const sessionId of server.sessionIds ?? []) {
      try {
        await httpDeleteSession(server.baseUrl, sessionId);
        server.sessionIds.delete(sessionId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } finally {
    httpTargetsByBaseUrl.delete(server.baseUrl);
  }

  if (server?.process) {
    server.process.kill("SIGTERM");
    // Destroy process pipes so Node won't block on a grandchild process
    // (`go run` spawns a child binary that inherits the pipes).
    server.process.stdin?.destroy();
    server.process.stdout?.destroy();
    server.process.stderr?.destroy();
    // Force-kill after a grace period, but don't keep the event loop alive for it.
    const timer = setTimeout(() => {
      try {
        server.process.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 2000);
    timer.unref();
  }

  if (cleanupErrors.length > 0 && !hasSpawnedProcess) {
    throw new AggregateError(cleanupErrors, "Failed to delete one or more MCP sessions");
  }
}

export async function httpPost(baseUrl, sessionId, body) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") ?? "";

  // The Streamable HTTP transport may return SSE even for POST requests.
  // When it does, extract the JSON-RPC response from the SSE data fields.
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const blocks = text.split("\n\n").filter((b) => b.trim());
    let json = null;
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed?.data && typeof parsed.data === "object" && parsed.data.jsonrpc) {
        json = parsed.data;
      }
    }
    return { json, headers: response.headers, status: response.status };
  }

  // For notifications (no response body expected), handle 202/204 gracefully
  if (response.status === 202 || response.status === 204) {
    return { json: null, headers: response.headers, status: response.status };
  }

  const json = await response.json();
  return { json, headers: response.headers, status: response.status };
}

export async function httpDeleteSession(baseUrl, sessionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, deleteSessionTimeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "Mcp-Session-Id": sessionId },
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`DELETE /mcp timed out after ${deleteSessionTimeoutMs}ms for session ${sessionId}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  // 404 means the session was already gone; cleanup is idempotent from the
  // harness perspective.
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE /mcp failed for session ${sessionId}: HTTP ${response.status}`);
  }
}

export function openSseStream(baseUrl, sessionId, lastEventId, onEvent) {
  const headers = { Accept: "text/event-stream" };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  if (lastEventId) {
    headers["Last-Event-ID"] = lastEventId;
  }

  const controller = new AbortController();
  const events = [];
  let waiters = [];

  const streamPromise = fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers,
    signal: controller.signal,
  }).then(async (response) => {
    assert(response.ok, `SSE stream returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines to get individual SSE events
        const parts = buffer.split("\n\n");
        // Keep the last partial chunk in the buffer
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const event = parseSseBlock(part);
          if (event) {
            events.push(event);
            onEvent?.(event);
            // Resolve any waiters
            for (const waiter of waiters) {
              if (events.length >= waiter.count) {
                waiter.resolve(events.slice(0));
              }
            }
            waiters = waiters.filter((w) => events.length < w.count);
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
  }).catch((err) => {
    if (err.name !== "AbortError") {
      // Reject all pending waiters
      for (const waiter of waiters) {
        waiter.reject(err);
      }
      waiters = [];
    }
  });

  function waitForEvents(count, timeoutMs = 5000) {
    if (events.length >= count) {
      return Promise.resolve(events.slice(0));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out waiting for ${count} SSE events (got ${events.length} so far)`));
      }, timeoutMs);
      waiters.push({
        count,
        resolve: (evts) => {
          clearTimeout(timer);
          resolve(evts);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  function close() {
    controller.abort();
    return streamPromise.catch(() => {}); // swallow AbortError
  }

  return { events, waitForEvents, close, streamPromise };
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let id = undefined;
  let eventType = undefined;
  let data = "";
  for (const line of lines) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const chunk = line.slice(5);
      // SSE spec: if there's a space after "data:", skip it
      data += (chunk.startsWith(" ") ? chunk.slice(1) : chunk);
    }
  }
  if (!data) return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = data;
  }
  return { id, event: eventType, data: parsed };
}

let rpcId = 1;
function nextId() {
  return rpcId++;
}

export async function httpInitialize(baseUrl) {
  const { json, headers } = await httpPost(baseUrl, null, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "apex-conformance-runner", version: "0.1.0" },
    },
  });
  const sessionId = headers.get("mcp-session-id");
  assert(sessionId, "Expected Mcp-Session-Id header in initialize response");
  httpTargetsByBaseUrl.get(baseUrl)?.sessionIds.add(sessionId);

  // Send initialized notification
  await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  return { sessionId, response: json };
}

export async function httpCallTool(baseUrl, sessionId, name, args) {
  const { json } = await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert(!json.error, `JSON-RPC error from tools/call ${name}: ${JSON.stringify(json.error)}`);
  return extractPayload(json.result);
}

export async function httpSubscribe(baseUrl, sessionId, uri) {
  const { json } = await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "resources/subscribe",
    params: { uri },
  });
  return json;
}

export async function httpUnsubscribe(baseUrl, sessionId, uri) {
  const { json } = await httpPost(baseUrl, sessionId, {
    jsonrpc: "2.0",
    id: nextId(),
    method: "resources/unsubscribe",
    params: { uri },
  });
  return json;
}
