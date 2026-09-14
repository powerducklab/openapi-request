import { SseParser } from "../http/sse-parser";
import { err, toErrorInfo } from "../../core/errors";
import { isPlainObject } from "../../core/utils";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcOutcome {
  /** The JSON-RPC response object, when the server sent one back. */
  message: any | undefined;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType?: string;
  sessionId?: string;
  /** Raw text body, kept for non-JSON-RPC diagnostics. */
  rawText?: string;
  sizeBytes: number;
  firstByteMs: number;
}

let idCounter = 0;
export function nextRequestId(): number {
  idCounter += 1;
  return idCounter;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = out[key] ? `${out[key]}, ${value}` : value;
  });
  return out;
}

/**
 * Send one JSON-RPC message (request or notification) over the MCP
 * Streamable HTTP transport and wait for the matching response.
 *
 * A notification (no `id`) has no response by definition; the server
 * typically answers 202 with an empty body, which is treated as success.
 * A request may come back as a single JSON body or as a `text/event-stream`
 * carrying one or more SSE-framed JSON-RPC messages — the last one whose
 * `id` matches the request is treated as the answer, mirroring how a real
 * MCP client drains the stream.
 */
export async function sendJsonRpc(
  endpoint: string,
  message: JsonRpcRequest,
  init: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    startedAt: number;
    protocolVersion?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
  },
): Promise<JsonRpcOutcome> {
  const controller = new AbortController();
  let detachAbort: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  if (init.signal) {
    const onAbort = () => controller.abort(init.signal?.reason);
    if (init.signal.aborted) {
      onAbort();
    } else {
      init.signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => init.signal?.removeEventListener("abort", onAbort);
    }
  }

  if (typeof init.timeoutMs === "number" && init.timeoutMs > 0) {
    timeout = setTimeout(() => {
      controller.abort(new Error(`MCP request timed out after ${init.timeoutMs}ms`));
    }, init.timeoutMs);
    if (typeof (timeout as any)?.unref === "function") {
      (timeout as any).unref();
    }
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(init.protocolVersion ? { "MCP-Protocol-Version": init.protocolVersion } : {}),
        ...(init.headers ?? {}),
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
  } catch (e) {
    throw err("MCP_TRANSPORT_FAILED", `Could not reach MCP endpoint: ${(e as Error)?.message ?? e}`, undefined, {
      cause: e,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    detachAbort?.();
  }

  const firstByteMs = Date.now() - init.startedAt;
  const headers = headersToObject(response.headers);
  const contentType = response.headers.get("content-type") ?? undefined;
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;

  // Notification, or a request the server chose not to answer inline
  // (202 Accepted with nothing to parse).
  if (response.status === 202 || response.status === 204) {
    return {
      message: undefined,
      status: response.status,
      statusText: response.statusText,
      headers,
      contentType,
      sessionId,
      sizeBytes: 0,
      firstByteMs,
    };
  }

  if (contentType && /text\/event-stream/i.test(contentType) && response.body) {
    const parser = new SseParser();
    const reader = response.body.getReader();
    let bytes = 0;
    const maxResponseBytes =
      typeof init.maxResponseBytes === "number" && init.maxResponseBytes > 0
        ? init.maxResponseBytes
        : 0;
    let matched: any;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (maxResponseBytes > 0 && bytes > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw err(
          "MCP_RESPONSE_TOO_LARGE",
          `MCP response exceeded ${maxResponseBytes} bytes while reading event stream.`,
        );
      }
      for (const event of parser.push(value)) {
        if (event.parsed && typeof event.parsed === "object") {
          const candidate = event.parsed as any;
          if (message.id === undefined || candidate.id === message.id) {
            matched = candidate;
          }
        }
      }
      // The response we're waiting for has arrived; no need to keep the
      // stream open for whatever the server sends afterward.
      if (matched !== undefined) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    if (matched === undefined) {
      for (const event of parser.flush()) {
        if (event.parsed && typeof event.parsed === "object") matched = event.parsed;
      }
    }
    return {
      message: matched,
      status: response.status,
      statusText: response.statusText,
      headers,
      contentType,
      sessionId,
      sizeBytes: bytes,
      firstByteMs,
    };
  }

  let rawText: string | undefined;
  let parsed: any;
  try {
    rawText = await response.text();
    if (
      typeof init.maxResponseBytes === "number" &&
      init.maxResponseBytes > 0 &&
      rawText.length > init.maxResponseBytes
    ) {
      throw err(
        "MCP_RESPONSE_TOO_LARGE",
        `MCP response exceeded ${init.maxResponseBytes} bytes.`,
      );
    }
    if (rawText.trim()) parsed = JSON.parse(rawText);
  } catch (e) {
    return {
      message: undefined,
      status: response.status,
      statusText: response.statusText,
      headers,
      contentType,
      sessionId,
      rawText,
      sizeBytes: rawText?.length ?? 0,
      firstByteMs,
    };
  }

  return {
    message: parsed,
    status: response.status,
    statusText: response.statusText,
    headers,
    contentType,
    sessionId,
    rawText,
    sizeBytes: rawText?.length ?? 0,
    firstByteMs,
  };
}

export function isJsonRpcError(message: any): message is { error: { code: number; message: string; data?: unknown } } {
  return !!message && typeof message === "object" && isPlainObject(message.error);
}


export { toErrorInfo };
