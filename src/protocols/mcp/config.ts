import type {
  McpTransport,
  SendOptions,
  McpOptions,
  ResolvedMcpConfig,
} from "../../core/types";
export type { ResolvedMcpConfig } from "../../core/types";
import type { LocatedOperation } from "../../openapi/locate";
import { resolveServerUrl } from "../http/environment";
import { interpolate, isPlainObject, isSecretKey } from "../../core/utils";
export { isSecretKey as SECRET_KEY_PATTERN };
import { sampleFromSchema } from "../../openapi/sample";
import { err } from "../../core/errors";


const KNOWN_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

/**
 * Resolve the effective MCP call.
 *
 * Precedence: `options.mcp.*` (per-call override) > `operation['x-mcp'].*`
 * (the document's declared capability, normally produced by
 * {@link writeMcpOperations}).
 */
export function resolveMcpConfig(
  located: LocatedOperation,
  spec: any,
  options: SendOptions,
): ResolvedMcpConfig {
  const mcp: McpOptions = options.mcp ?? {};
  const rawExtension = located.operation?.["x-mcp"];
  const extension: Record<string, any> =
    rawExtension && typeof rawExtension === "object" ? rawExtension : {};
  const variableMap: Record<string, string> = { ...(options.variables ?? {}) };

  const rawTransport =
    mcp.transport ?? extension.transport ?? "streamable-http";
  if (rawTransport !== "streamable-http" && rawTransport !== "stdio") {
    throw err(
      "BAD_MCP_TRANSPORT",
      `Unsupported MCP transport: ${JSON.stringify(rawTransport)}`,
    );
  }
  const transport: McpTransport = rawTransport;

  let endpoint: string | undefined;
  let command: string | undefined;
  let stdioArgs: string[] | undefined;
  let cwd: string | undefined;
  let env: Record<string, string | undefined> | undefined;
  let timeoutMs: number | undefined;
  let maxBufferBytes: number | undefined;
  let maxStderrBytes: number | undefined;

  if (transport === "streamable-http") {
    endpoint =
      mcp.endpoint ||
      (typeof extension.endpoint === "string"
        ? extension.endpoint
        : resolveServerUrl(located.servers, options));
    endpoint = interpolate(endpoint, variableMap);
    if (/\{\{[^}]+\}\}/.test(endpoint))
      throw err(
        "BAD_MCP_ENDPOINT",
        `Unresolved variable in MCP endpoint: ${endpoint}`,
      );
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("not http(s)");
    } catch {
      throw err(
        "BAD_MCP_ENDPOINT",
        `MCP endpoint must be an absolute http(s) URL, received: ${endpoint}`,
      );
    }
  } else {
    const rawCommand = mcp.command ?? extension.command;
    if (typeof rawCommand !== "string" || !rawCommand.trim())
      throw err(
        "BAD_MCP_STDIO_COMMAND",
        "MCP stdio transport requires command.",
      );
    command = interpolate(rawCommand.trim(), variableMap);
    if (/\{\{[^}]+\}\}/.test(command))
      throw err(
        "BAD_MCP_STDIO_COMMAND",
        `Unresolved variable in MCP command: ${command}`,
      );
    const rawArgs = mcp.args ?? extension.args;
    if (rawArgs != null) {
      if (!Array.isArray(rawArgs) || rawArgs.some((v) => typeof v !== "string"))
        throw err(
          "BAD_MCP_STDIO_CONFIG",
          "MCP stdio args must be an array of strings.",
        );
      stdioArgs = rawArgs.map((v) => interpolate(v, variableMap));
    }
    const rawCwd = mcp.cwd ?? extension.cwd;
    if (rawCwd != null) {
      if (typeof rawCwd !== "string" || !rawCwd)
        throw err(
          "BAD_MCP_STDIO_CONFIG",
          "MCP stdio cwd must be a non-empty string.",
        );
      cwd = interpolate(rawCwd, variableMap);
    }
    const rawEnv = mcp.env ?? extension.env;
    if (rawEnv != null) {
      if (!isPlainObject(rawEnv))
        throw err("BAD_MCP_STDIO_CONFIG", "MCP stdio env must be an object.");
      env = {};
      for (const [k, v] of Object.entries(rawEnv)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype")
          continue;
        env[k] = v == null ? undefined : interpolate(String(v), variableMap);
      }
    }
    for (const [key, value] of [
      ["timeoutMs", mcp.timeoutMs ?? extension.timeoutMs],
      ["maxBufferBytes", mcp.maxBufferBytes ?? extension.maxBufferBytes],
      ["maxStderrBytes", mcp.maxStderrBytes ?? extension.maxStderrBytes],
    ] as const) {
      if (value != null) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
          throw err(
            "BAD_MCP_STDIO_CONFIG",
            `${key} must be a positive finite number.`,
          );
        if (key === "timeoutMs") timeoutMs = value;
        else if (key === "maxBufferBytes") maxBufferBytes = value;
        else maxStderrBytes = value;
      }
    }
  }

  const method = mcp.method ?? extension.method;
  if (typeof method !== "string" || !KNOWN_METHODS.has(method)) {
    throw err(
      "BAD_MCP_METHOD",
      `options.mcp.method (or x-mcp.method) must be one of: ${Array.from(
        KNOWN_METHODS,
      ).join(", ")}. Received: ${JSON.stringify(method)}`,
    );
  }

  const name = mcp.name ?? extension.name;
  const declaredArgs = isPlainObject(extension.arguments)
    ? extension.arguments
    : undefined;
  const declaredSchema = isPlainObject(extension.argumentsSchema)
    ? extension.argumentsSchema
    : undefined;
  const sampledArgs = declaredSchema
    ? sampleFromSchema(declaredSchema)
    : undefined;
  const fromValues = isPlainObject(options.values?.body)
    ? (options.values!.body as Record<string, unknown>)
    : undefined;

  const args: Record<string, unknown> = {
    ...(isPlainObject(sampledArgs) ? sampledArgs : {}),
    ...(declaredArgs ?? {}),
    ...(fromValues ?? {}),
    ...(mcp.arguments ?? {}),
  };

  let params: Record<string, unknown>;
  if (method === "tools/call") {
    if (!name) {
      throw err(
        "BAD_MCP_TARGET",
        "tools/call requires options.mcp.name (or x-mcp.name).",
      );
    }
    params = { name, arguments: args };
  } else if (method === "prompts/get") {
    if (!name) {
      throw err(
        "BAD_MCP_TARGET",
        "prompts/get requires options.mcp.name (or x-mcp.name).",
      );
    }
    params = { name, arguments: args };
  } else if (method === "resources/read") {
    const uri = (args as any).uri ?? extension.uri ?? mcp.arguments?.uri;
    if (typeof uri !== "string" || !uri) {
      throw err(
        "BAD_MCP_TARGET",
        "resources/read requires a `uri` (via options.mcp.arguments.uri or x-mcp.uri).",
      );
    }
    params = { uri };
  } else {
    // The three *_list methods take an optional cursor and nothing else.
    params = args;
  }

  /* ---- Headers ---- */
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const applyHeaders = (source: unknown) => {
    if (!isPlainObject(source)) return;
    for (const [key, value] of Object.entries(source)) {
      if (value == null) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      headers[key] = interpolate(String(value), variableMap);
    }
  };
  applyHeaders(options.values?.header);
  applyHeaders(extension.headers);
  applyHeaders(mcp.headers);

  const auth = options.auth;
  if (auth && auth.type !== "none" && !hasHeader(headers, "Authorization")) {
    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${auth.token ?? ""}`;
    } else if (auth.type === "basic") {
      const raw = `${auth.username ?? ""}:${auth.password ?? ""}`;
      headers.Authorization = `Basic ${Buffer.from(raw, "utf8").toString(
        "base64",
      )}`;
    } else if (auth.type === "apikey" && (auth.in ?? "header") === "header") {
      headers[auth.key ?? "X-API-Key"] = auth.value ?? "";
    }
  }
  return {
    transport,

    ...(transport === "streamable-http" && endpoint ? { endpoint } : {}),

    ...(transport === "stdio" && command
      ? {
          command,
          ...(stdioArgs ? { args: stdioArgs } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
          ...(timeoutMs != null ? { timeoutMs } : {}),
          ...(maxBufferBytes != null ? { maxBufferBytes } : {}),
          ...(maxStderrBytes != null ? { maxStderrBytes } : {}),
        }
      : {}),

    method,
    params,
    headers,

    sessionId: mcp.sessionId ?? optionalText(extension.sessionId),

    protocolVersion:
      mcp.protocolVersion ?? optionalText(extension.protocolVersion),

    clientInfo: mcp.clientInfo ?? {
      name: "protokit",
      version: "0.1.0",
    },
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/** Case-insensitive on both sides, so callers may pass any casing. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}
