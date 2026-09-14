import type { ExecResult, ReplayRecord, SendOptions } from "../../core/types";
import type { ExecuteContext } from "../../core/protocol";
import { toErrorInfo } from "../../core/errors";
import { sendJsonRpc, nextRequestId, isJsonRpcError } from "./jsonrpc";
import { initializeSession, MCP_PROTOCOL_VERSION } from "./discovery";
import { createMcpStdioConnection } from "./stdio";
import type { ResolvedMcpConfig } from "./config";

export async function runMcp(
  config: ResolvedMcpConfig,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  if (config.transport === "stdio") return runMcpStdio(config, options, ctx);
  return runMcpHttp(config, options, ctx);
}

async function runMcpStdio(
  config: ResolvedMcpConfig,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  const startedAt = Date.now(),
    replays: ReplayRecord[] = [],
    signal = ctx?.signal ?? options.signal;
  const requestBody = {
    jsonrpc: "2.0" as const,
    id: nextRequestId(),
    method: config.method,
    params: config.params,
  };
  const conn = createMcpStdioConnection({
    command: config.command!,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    timeoutMs: config.timeoutMs,
    maxBufferBytes: config.maxBufferBytes,
  });
  try {
    const init = await conn.request<any>(
      "initialize",
      {
        protocolVersion: config.protocolVersion ?? MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: config.clientInfo,
      },
      signal,
    );
    if (!init || typeof init !== "object") {
      throw new Error("MCP initialize returned an invalid result.");
    }
    replays.push({
      url: `stdio://${config.command}`,
      method: "initialize",
      status: 200,
      reason: "mcp-stdio-handshake",
    });
    await conn.notify("notifications/initialized", undefined, signal);
    const body = await conn.request<any>(config.method, config.params, signal);
    const endedAt = Date.now();
    return {
      protocol: "mcp",
      request: {
        method: "STDIO",
        url: `stdio://${config.command}`,
        headers: {},
        body: requestBody,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        body,
        text: JSON.stringify(body),
        timings: { startedAt, endedAt, durationMs: endedAt - startedAt },
        sizeBytes: Buffer.byteLength(JSON.stringify(body)),
      },
      replays,
    };
  } catch (e) {
    const endedAt = Date.now();
    return {
      protocol: "mcp",
      request: {
        method: "STDIO",
        url: `stdio://${config.command}`,
        headers: {},
        body: requestBody,
      },
      response: {
        status: 0,
        statusText: "MCP stdio failed",
        headers: {},
        timings: { startedAt, endedAt, durationMs: endedAt - startedAt },
        sizeBytes: 0,
      },
      error: toErrorInfo(e),
      replays,
    };
  } finally {
    await conn.close().catch(() => undefined);
  }
}

// Existing Streamable HTTP implementation should remain here unchanged.
// Re-exporting this helper makes the transport branch explicit and testable.
async function runMcpHttp(
  config: ResolvedMcpConfig,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  const startedAt = Date.now(),
    signal = ctx?.signal ?? options.signal,
    replays: ReplayRecord[] = [];
  let sessionId = config.sessionId,
    protocolVersion = config.protocolVersion;
  if (!sessionId) {
    try {
      const session = await initializeSession(config.endpoint!, {
        headers: config.headers,
        signal,
        clientInfo: config.clientInfo,
      });
      sessionId = session.sessionId;
      protocolVersion = session.protocolVersion;
      replays.push({
        url: config.endpoint!,
        method: "initialize",
        status: 200,
        reason: "mcp-handshake",
      });
    } catch (e) {
      const endedAt = Date.now();
      return {
        protocol: "mcp",
        request: {
          method: "POST",
          url: config.endpoint!,
          headers: config.headers,
          body: { method: "initialize" },
        },
        response: {
          status: 0,
          statusText: "Handshake failed",
          headers: {},
          timings: { startedAt, endedAt, durationMs: endedAt - startedAt },
          sizeBytes: 0,
        },
        error: toErrorInfo(e),
        replays,
      };
    }
  }
  const headers = {
    ...config.headers,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const requestBody = {
    jsonrpc: "2.0" as const,
    id: nextRequestId(),
    method: config.method,
    params: config.params,
  };
  try {
    const outcome = await sendJsonRpc(config.endpoint!, requestBody, {
      headers,
      signal,
      startedAt,
      protocolVersion,
    });
    const endedAt = Date.now(),
      rpcError = isJsonRpcError(outcome.message)
        ? outcome.message.error
        : undefined;
    return {
      protocol: "mcp",
      request: {
        method: "POST",
        url: config.endpoint!,
        headers,
        body: requestBody,
      },
      response: {
        status: outcome.status,
        statusText: outcome.statusText,
        headers: outcome.headers,
        contentType: outcome.contentType,
        body: rpcError ? outcome.message : outcome.message?.result,
        text: outcome.rawText,
        timings: {
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          firstByteMs: outcome.firstByteMs,
        },
        sizeBytes: outcome.sizeBytes,
      },
      ...(rpcError
        ? { error: { message: rpcError.message, code: String(rpcError.code) } }
        : {}),
      replays,
    };
  } catch (e) {
    const endedAt = Date.now();
    return {
      protocol: "mcp",
      request: {
        method: "POST",
        url: config.endpoint!,
        headers,
        body: requestBody,
      },
      response: {
        status: 0,
        statusText: "Request failed",
        headers: {},
        timings: { startedAt, endedAt, durationMs: endedAt - startedAt },
        sizeBytes: 0,
      },
      error: toErrorInfo(e),
      replays,
    };
  }
}
