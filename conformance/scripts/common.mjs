import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
    command: "cargo",
    args: ["run", "--quiet"],
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
