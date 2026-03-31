import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

export const servers = {
  typescript: {
    cwd: path.join(repoRoot, "reference-implementation", "typescript"),
    command: "node",
    args: ["dist/server.js"],
  },
  go: {
    cwd: path.join(repoRoot, "reference-implementation", "go"),
    command: "go",
    args: ["run", "."],
  },
  rust: {
    cwd: path.join(repoRoot, "reference-implementation", "rust"),
    command: "./target/debug/apex-reference",
    args: [],
  },
  java: {
    cwd: path.join(repoRoot, "reference-implementation", "java"),
    command: "java",
    args: ["-jar", "target/apex-reference-java-0.1.0.jar"],
  },
};

export function getServerConfig(name) {
  const config = servers[name];
  assert(config, `Unknown server target: ${name}`);
  return config;
}

function normalizeConfig(config) {
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
    return {
      label: config.name ?? path.basename(configPath),
      config: normalizeConfig(config),
      testOptions: normalizeTestOptions(options, config),
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
  assert(serverName, "Usage: node <script> <typescript|go|rust|java> or --command <cmd> [--args '[...]'] [--cwd <dir>] or --config <path>");
  return {
    label: serverName,
    config: normalizeConfig(getServerConfig(serverName)),
    testOptions: normalizeTestOptions(options),
    verbose: Boolean(options.verbose),
  };
}

export function formatCommand(config) {
  const renderedArgs = config.args.map((arg) => JSON.stringify(arg)).join(" ");
  return [config.command, renderedArgs].filter(Boolean).join(" ");
}

export async function connectClient(target, options = {}) {
  const config = normalizeConfig(target);
  const verbose = Boolean(options.verbose);

  if (verbose) {
    printCheck(`starting server: ${formatCommand(config)} (cwd: ${config.cwd})`);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    stderr: "pipe",
  });

  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (verbose) {
      process.stderr.write(text);
    }
  });

  const client = new Client({
    name: "apex-conformance-runner",
    version: "0.1.0",
  });

  await client.connect(transport);

  return {
    client,
    transport,
    getStderr: () => stderr.trim(),
  };
}

export async function disconnectClient(session) {
  await session.transport.close();
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

/* ------------------------------------------------------------------ */
/*  HTTP/SSE transport infrastructure                                  */
/* ------------------------------------------------------------------ */

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
  assert(config, `Unknown HTTP server target: ${name}`);
  return config;
}

export async function spawnHttpServer(name, options = {}) {
  const config = getHttpServerConfig(name);
  const port = 10000 + Math.floor(Math.random() * 50000);
  const args = [...config.args, String(port)];
  const verbose = Boolean(options.verbose);

  if (verbose) {
    printCheck(`starting HTTP server: ${config.command} ${args.map((a) => JSON.stringify(a)).join(" ")} (cwd: ${config.cwd})`);
  }

  const child = spawn(config.command, args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
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

  return {
    baseUrl: `http://localhost:${port}`,
    process: child,
    port,
    getStderr: () => stderr.trim(),
  };
}

export function stopHttpServer(server) {
  if (server?.process) {
    server.process.kill("SIGTERM");
    // Destroy stdio pipes so Node won't block on a grandchild process
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

export function openSseStream(baseUrl, sessionId, lastEventId) {
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
