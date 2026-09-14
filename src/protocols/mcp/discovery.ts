import { err } from "../../core/errors";
import type {
  InitializeSessionInit,
  McpCapability,
  McpDiscoveryResult,
  McpPrompt,
  McpResource,
  McpTool,
} from "../../core/types";
import { sendJsonRpc, nextRequestId, isJsonRpcError } from "./jsonrpc";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC codes that genuinely mean "this server has no such method". */
const METHOD_NOT_SUPPORTED_CODES = new Set([-32601, -32600]);

/**
 * Result key per list method.
 *
 * `resources/templates/list` answers under `resourceTemplates`, NOT
 * `resources` — reading the wrong key silently yields zero templates.
 */
const LIST_RESULT_KEY = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resourceTemplates",
} as const;

type ListMethod = keyof typeof LIST_RESULT_KEY;

const MAX_LIST_PAGES = 1000;

/**
 * Handshake with an MCP server and establish a session.
 * Every MCP interaction begins here: `initialize` negotiates the protocol
 * version and capabilities, and the client must follow up with the
 * `notifications/initialized` notification before issuing any other call.
 */
export async function initializeSession(
  endpoint: string,
  init: InitializeSessionInit = {},
): Promise<{
  sessionId?: string;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
}> {
  const startedAt = Date.now();
  const outcome = await sendJsonRpc(
    endpoint,
    {
      jsonrpc: "2.0",
      id: nextRequestId(),
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: init.capabilities ?? {},
        clientInfo: init.clientInfo ?? { name: "protokit", version: "0.1.0" },
      },
    },
    { headers: init.headers, signal: init.signal, startedAt },
  );

  if (isJsonRpcError(outcome.message)) {
    throw err(
      "MCP_INITIALIZE_FAILED",
      `initialize failed: ${outcome.message.error.message}`,
      outcome.message.error,
    );
  }
  if (!outcome.message?.result) {
    throw err(
      "MCP_INITIALIZE_FAILED",
      `initialize returned no result (HTTP ${outcome.status}). The endpoint may not speak MCP.`,
    );
  }

  const sessionId = outcome.sessionId;
  const negotiated = outcome.message.result.protocolVersion as
    | string
    | undefined;

  // Required follow-up notification; the server does not answer it.
  await sendJsonRpc(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" } as any,
    {
      headers: {
        ...(init.headers ?? {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      signal: init.signal,
      startedAt,
      protocolVersion: negotiated,
    },
  );

  return {
    sessionId,
    serverInfo: outcome.message.result.serverInfo,
    protocolVersion: negotiated,
  };
}

/**
 * Drain one paginated list method.
 *
 * Returns `undefined` only when the server does not implement the method at
 * all. Any other JSON-RPC error (auth failure, internal error) is thrown, so
 * a 401 is never silently reported as "this server has no tools".
 */
async function list(
  endpoint: string,
  method: ListMethod,
  session: { sessionId?: string; protocolVersion?: string },
  init: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<any[] | undefined> {
  const startedAt = Date.now();
  const headers = {
    ...(init.headers ?? {}),
    ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
  };
  const key = LIST_RESULT_KEY[method];
  const items: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const outcome = await sendJsonRpc(
      endpoint,
      {
        jsonrpc: "2.0",
        id: nextRequestId(),
        method,
        params: cursor ? { cursor } : {},
      },
      {
        headers,
        signal: init.signal,
        startedAt,
        protocolVersion: session.protocolVersion,
      },
    );

    if (isJsonRpcError(outcome.message)) {
      const { code, message: text } = outcome.message.error;
      if (METHOD_NOT_SUPPORTED_CODES.has(code)) return undefined;
      throw err(
        "MCP_LIST_FAILED",
        `${method} failed (${code}): ${text}`,
        outcome.message.error,
      );
    }

    const result = outcome.message?.result;
    if (!result) {
      if (outcome.status >= 400) {
        throw err(
          "MCP_LIST_FAILED",
          `${method} returned HTTP ${outcome.status} ${outcome.statusText} with no JSON-RPC result.`,
        );
      }
      return items;
    }

    pages += 1;
    if (Array.isArray(result[key])) items.push(...result[key]);

    const next =
      typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!next) break;
    if (seenCursors.has(next) || pages >= MAX_LIST_PAGES) break;
    seenCursors.add(next);
    cursor = next;
  }

  return items;
}

/**
 * Auto-fetch everything an MCP server exposes: tools, resources, resource
 * templates and prompts. This is the MCP analogue of gRPC's reflection
 * `discover()` and GraphQL's schema introspection — one call that hands back
 * every operation the endpoint can perform.
 */
export async function discoverMcpCapabilities(
  endpoint: string,
  options: InitializeSessionInit = {},
): Promise<McpDiscoveryResult> {
  const session = await initializeSession(endpoint, options);
  const warnings: string[] = [];
  const capabilities: McpCapability[] = [];

  const tools = await list(endpoint, "tools/list", session, options);
  if (tools) {
    for (const t of tools) {
      if (!t?.name) continue;
      capabilities.push({
        kind: "tool",
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema ?? {},
        ...(t.execution && typeof t.execution === "object"
          ? { execution: t.execution }
          : {}),
      });
    }
  } else {
    warnings.push("Server does not implement tools/list.");
  }

  const resources = await list(endpoint, "resources/list", session, options);
  const templates = await list(
    endpoint,
    "resources/templates/list",
    session,
    options,
  );
  for (const r of [...(resources ?? []), ...(templates ?? [])]) {
    if (!r?.name) continue;
    capabilities.push({
      kind: "resource",
      name: r.name,
      title: r.title,
      uri: r.uri,
      uriTemplate: r.uriTemplate,
      description: r.description,
      mimeType: r.mimeType,
    });
  }
  if (!resources && !templates) {
    warnings.push(
      "Server does not implement resources/list or resources/templates/list.",
    );
  }

  const prompts = await list(endpoint, "prompts/list", session, options);
  if (prompts) {
    for (const p of prompts) {
      if (!p?.name) continue;
      capabilities.push({
        kind: "prompt",
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments,
      });
    }
  } else {
    warnings.push("Server does not implement prompts/list.");
  }

  return {
    serverInfo: session.serverInfo,
    protocolVersion: session.protocolVersion,
    sessionId: session.sessionId,
    capabilities,
    warnings,
  };
}