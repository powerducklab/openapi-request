/**
 * UI-first client surface.
 *
 * `createClient()` is the single entry a renderer talks to. It answers the
 * questions the UI needs BEFORE anything is sent (`prepare`), routes one-shot
 * calls (`send`), opens long-lived sessions (`connect`), discovers schemas
 * (`discover`), and writes responses back into the OpenAPI document
 * (`writeback`). Everything hangs together through one options shape and one
 * event DTO, so the renderer never branches on protocol internals.
 */
import { locateOperation } from "../openapi/locate";
import {
  toResponseObject,
  writeBackResponse,
  type WriteBackOptions,
  type ToResponseOptions,
} from "../openapi/writeback";
import { createDebugger } from "./debugger";
import type {
  AnyManualSession,
  ManualSessionOptions,
  OpenApiDocument,
  OperationTarget,
  SendOptions,
  SendResult,
} from "../types";
import { discoverMcpCapabilities } from "../protocols/mcp/discovery";
import { discover as discoverGrpc } from "../protocols/grpc/discovery";
import {
  isStreamingOperation,
  probeStreamingResponse,
} from "../protocols/http/detect";
import { createManualSession } from "./manual-session";

export { probeStreamingResponse };

/** How the UI should render this call. */
export type DisplayMode = "response" | "event-list" | "duplex-session";

/** Precise streaming taxonomy used to pick a renderer / message schema. */
export type StreamKind =
  | "none"
  | "sse"
  | "ndjson"
  | "chunked"
  | "websocket"
  | "graphql-stream"
  | "grpc-unary"
  | "grpc-server-stream"
  | "grpc-client-stream"
  | "grpc-bidi"
  | "mcp-http-stream"
  | "mcp-stdio";

export interface PreparedRequest {
  protocol: string;
  transport: string;
  target?: OperationTarget;
  operation?: any;
  display: { mode: DisplayMode };
  stream: { kind: StreamKind; expected: boolean };
  openapi: {
    extensions: Record<string, unknown>;
  };
  warnings: string[];
}

export interface CreateClientOptions {
  writeBack?: WriteBackOptions;
  response?: ToResponseOptions;
}

function protocolFromOperation(operation: any): string {
  const value = String(operation?.["x-protocol"] ?? "http").toLowerCase();
  if (value === "ws") return "websocket";
  return value;
}

function transportFromOperation(protocol: string, operation: any): string {
  const value = String(operation?.["x-transport"] ?? "").toLowerCase();
  if (value) return value;
  if (protocol === "mcp") {
    return String(operation?.["x-mcp"]?.transport ?? "http").toLowerCase();
  }
  if (protocol === "websocket") return "websocket";
  if (protocol === "grpc") return "grpc";
  return "http";
}

function displayModeFor(protocol: string, streamKind: StreamKind): DisplayMode {
  if (protocol === "websocket") return "duplex-session";
  if (protocol === "mcp") return "duplex-session";
  if (streamKind === "grpc-client-stream" || streamKind === "grpc-bidi") {
    return "duplex-session";
  }
  if (streamKind === "grpc-server-stream") return "event-list";
  if (streamKind === "grpc-unary") return "response";
  if (streamKind !== "none") return "event-list";
  return "response";
}

function inferStreamKind(
  protocol: string,
  transport: string,
  operation: any,
): StreamKind {
  if (protocol === "websocket") return "websocket";
  if (protocol === "graphql") {
    return operation?.["x-response-stream"] ? "graphql-stream" : "none";
  }
  if (protocol === "mcp") {
    return transport === "stdio" ? "mcp-stdio" : "mcp-http-stream";
  }
  if (protocol === "grpc") {
    const mode = String(
      operation?.["x-grpc"]?.kind ??
        operation?.["x-grpc-mode"] ??
        "unary",
    ).toLowerCase();
    if (mode === "server_streaming" || mode === "server-streaming") {
      return "grpc-server-stream";
    }
    if (mode === "client_streaming" || mode === "client-streaming") {
      return "grpc-client-stream";
    }
    if (
      mode === "bidi_streaming" ||
      mode === "bidi-streaming" ||
      mode === "bidi"
    ) {
      return "grpc-bidi";
    }
    return "grpc-unary";
  }
  if (isStreamingOperation(operation)) return "sse";
  return "none";
}

export function createClient(options: CreateClientOptions = {}) {
  const debuggerClient = createDebugger(options);

  function prepare(sendOptions: SendOptions): PreparedRequest {
    if (!sendOptions || !sendOptions.spec) {
      throw new Error("prepare() requires an options object with spec");
    }
    const located = locateOperation(sendOptions.spec, sendOptions.target);
    const operation = located.operation;
    const protocol = protocolFromOperation(operation);
    const transport = transportFromOperation(protocol, operation);
    const streamKind = inferStreamKind(protocol, transport, operation);
    return {
      protocol,
      transport,
      target: sendOptions.target,
      operation,
      display: { mode: displayModeFor(protocol, streamKind) },
      stream: { kind: streamKind, expected: streamKind !== "none" },
      openapi: {
        extensions: {
          "x-protocol": protocol,
          "x-transport": transport,
          "x-session":
            protocol === "websocket" || protocol === "mcp" || protocol === "grpc",
          "x-discovery":
            protocol === "mcp" || protocol === "grpc" || protocol === "graphql",
          "x-message-schema": operation?.["x-message-schema"] ?? null,
          "x-response-stream":
            streamKind !== "none" ? { kind: streamKind } : null,
          "x-writeback": { protocol, transport },
        },
      },
      warnings: [],
    };
  }

  /** One-shot call through the full write-back pipeline. */
  function send(sendOptions: SendOptions): Promise<SendResult> {
    return debuggerClient.send(sendOptions);
  }

  /** Batch replay, accumulating schemas across calls. */
  function sendMany(
    spec: OpenApiDocument,
    targets: Array<
      { target: OperationTarget } & Partial<Omit<SendOptions, "spec" | "target">>
    >,
    shared: Partial<Omit<SendOptions, "spec" | "target">> = {},
  ) {
    return debuggerClient.sendMany(spec, targets, shared);
  }

  /** Open a long-lived session for websocket / mcp / grpc. */
  function connect(connectOptions: ManualSessionOptions): AnyManualSession {
    return createManualSession(connectOptions);
  }

  /** Discover capabilities / schema for mcp / grpc / graphql. */
  async function discover(discoverOptions: any): Promise<any> {
    const protocol = String(discoverOptions?.protocol ?? "").toLowerCase();
    if (protocol === "mcp") return discoverMcpCapabilities(discoverOptions);
    if (protocol === "grpc") return discoverGrpc(discoverOptions);
    throw new Error(`Unsupported discover protocol: ${protocol}`);
  }

  /** Merge one call's response into the OpenAPI document. */
  function writeback(
    spec: OpenApiDocument,
    prepared: PreparedRequest,
    result: SendResult,
    writeOptions?: Partial<WriteBackOptions>,
  ): OpenApiDocument {
    if (!prepared.target) {
      throw new Error("writeback() requires a PreparedRequest with target");
    }
    const located = locateOperation(spec, prepared.target);
    const fragment = toResponseObject(result, options.response);
    return writeBackResponse(spec, located.path, located.method, fragment, {
      ...options.writeBack,
      ...writeOptions,
    });
  }

  function dispose(): void {
    /* Sessions are owned by their callers; nothing global to release. */
  }

  return {
    prepare,
    send,
    sendMany,
    connect,
    discover,
    writeback,
    dispose,
    probeStreamingResponse,
  };
}

export type ProtoClient = ReturnType<typeof createClient>;
