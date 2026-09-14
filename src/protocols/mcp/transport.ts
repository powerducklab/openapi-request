/**
 * MCP transport abstraction.
 *
 * A manual MCP session is transport-agnostic: it drives initialize, JSON-RPC
 * calls, notifications and termination through a small adapter, so the same
 * session logic serves both Streamable HTTP and stdio. New transports plug in
 * by implementing this interface; the session core never branches on the wire.
 */
import type {
  InitializeSessionInit,
  JsonRpcOutcome,
  McpTerminateOutcome,
} from "../../core/types";
import { err } from "../../core/errors";
import {
  initializeSession,
  MCP_PROTOCOL_VERSION,
} from "./discovery";
import { sendJsonRpc } from "./jsonrpc";
import {
  createMcpStdioConnection,
  type McpStdioOptions,
} from "./stdio";

export interface McpTransportOpenInit {
  clientInfo?: { name: string; version: string };
  /** Client capabilities advertised at initialize. Default: {}. */
  capabilities?: Record<string, unknown>;
  /** Client protocol version to negotiate. Default: latest supported. */
  protocolVersion?: string;
  signal?: AbortSignal;
}

export interface McpTransportCallInit {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Started timestamp used for first-byte timings. */
  startedAt: number;
  /** Negotiated protocol version, when the transport needs it. */
  protocolVersion?: string;
  /** Session id from the handshake, when the transport needs it. */
  sessionId?: string;
  headers?: Record<string, string>;
}

export interface McpTransport {
  readonly transport: "streamable-http" | "stdio";

  /** Perform the MCP handshake (initialize + notifications/initialized). */
  open(
    init: McpTransportOpenInit,
  ): Promise<{
    sessionId?: string;
    serverInfo?: { name: string; version: string };
    protocolVersion?: string;
  }>;

  /** One JSON-RPC request/response exchange. Never throws on JSON-RPC errors. */
  call(
    body: Record<string, unknown>,
    init: McpTransportCallInit,
  ): Promise<JsonRpcOutcome>;

  /** One JSON-RPC notification. No response is expected. */
  notify(
    body: Record<string, unknown>,
    init: McpTransportCallInit,
  ): Promise<JsonRpcOutcome>;

  /** Best-effort session termination (HTTP DELETE / stdio no-op). */
  terminate(init: {
    sessionId?: string;
    protocolVersion?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  }): Promise<{ status?: number; outcome: McpTerminateOutcome; reason?: string }>;

  /** Release transport resources (e.g. kill the stdio child). Idempotent. */
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Streamable HTTP transport
 * ------------------------------------------------------------------ */

export function createHttpMcpTransport(options: {
  endpoint: string;
  headers?: Record<string, string>;
}): McpTransport {
  if (!options || !options.endpoint) {
    throw err("BAD_MCP_ENDPOINT", "MCP http transport requires an endpoint.");
  }
  const endpoint = options.endpoint;
  const baseHeaders = { ...(options.headers ?? {}) };

  return {
    transport: "streamable-http",

    async open(init) {
      const initOptions: InitializeSessionInit = {
        headers: baseHeaders,
        signal: init.signal,
        clientInfo: init.clientInfo,
        capabilities: init.capabilities,
      };
      const session = await initializeSession(endpoint, initOptions);
      return {
        sessionId: session.sessionId,
        serverInfo: session.serverInfo,
        protocolVersion:
          session.protocolVersion ?? init.protocolVersion ?? MCP_PROTOCOL_VERSION,
      };
    },

    call(body, callInit) {
      return sendJsonRpc(endpoint, body as any, {
        headers: { ...(callInit.headers ?? baseHeaders) },
        signal: callInit.signal,
        startedAt: callInit.startedAt,
        protocolVersion: callInit.protocolVersion,
      });
    },

    notify(body, callInit) {
      return sendJsonRpc(endpoint, body as any, {
        headers: { ...(callInit.headers ?? baseHeaders) },
        signal: callInit.signal,
        startedAt: callInit.startedAt,
        protocolVersion: callInit.protocolVersion,
      });
    },

    async terminate(init) {
      const status = await fetch(endpoint, {
        method: "DELETE",
        headers: {
          ...baseHeaders,
          ...(init.sessionId ? { "Mcp-Session-Id": init.sessionId } : {}),
          ...(init.protocolVersion
            ? { "MCP-Protocol-Version": init.protocolVersion }
            : {}),
        },
        signal: init.signal,
      }).then(
        (response) => response.status,
        () => undefined,
      );
      if (status === undefined) {
        return { outcome: "failed", reason: "terminate request failed" };
      }
      if (status >= 200 && status < 300) return { status, outcome: "released" };
      // 405: server declines session termination (legal per spec).
      if (status === 405) return { status, outcome: "unsupported" };
      // 404: server no longer knows this session; nothing left to free.
      if (status === 404) return { status, outcome: "already-gone" };
      return { status, outcome: "failed" };
    },

    async dispose() {
      // Streamable HTTP has no persistent resources beyond the session,
      // which terminate() already released.
    },
  };
}

/* ------------------------------------------------------------------ *
 * stdio transport
 * ------------------------------------------------------------------ */

export function createStdioMcpTransport(
  options: McpStdioOptions,
): McpTransport {
  const connection = createMcpStdioConnection(options);
  let disposed = false;

  return {
    transport: "stdio",

    async open(init) {
      const result: any = await connection.request(
        "initialize",
        {
          protocolVersion: init.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: init.capabilities ?? {},
          clientInfo: init.clientInfo ?? { name: "protokit", version: "0.1.0" },
        },
        init.signal,
      );
      if (!result || typeof result !== "object") {
        throw err(
          "MCP_INITIALIZE_FAILED",
          "MCP stdio initialize returned an invalid result.",
        );
      }
      await connection.notify("notifications/initialized", undefined, init.signal);
      return {
        sessionId: undefined,
        serverInfo: result.serverInfo,
        protocolVersion:
          result.protocolVersion ?? init.protocolVersion ?? MCP_PROTOCOL_VERSION,
      };
    },

    async call(body, callInit) {
      const result = await connection.request(
        body.method as string,
        body.params,
        callInit.signal,
      );
      const serialized = JSON.stringify(result);
      return {
        message: { jsonrpc: "2.0" as const, id: body.id, result },
        status: 200,
        statusText: "OK",
        headers: {},
        sizeBytes: Buffer.byteLength(serialized ?? "null", "utf8"),
        firstByteMs: 0,
      };
    },

    async notify(body, callInit) {
      await connection.notify(body.method as string, body.params, callInit.signal);
      return {
        message: undefined,
        status: 200,
        statusText: "OK",
        headers: {},
        sizeBytes: 0,
        firstByteMs: 0,
      };
    },

    async terminate() {
      return { outcome: "unsupported" };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await connection.close().catch(() => undefined);
    },
  };
}
