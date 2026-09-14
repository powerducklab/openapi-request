/* ================================================================== *
 * @powerduck/openapi-request - single public type surface
 *
 * Every public type lives in this one file. Protocol modules import from
 * here (usually via the "./core/types" shim) and re-export nothing of their
 * own, so the API surface is auditable in one place and the per-protocol
 * "types.ts" files that used to drift apart are gone.
 * ================================================================== */

import type {
  SessionEventDTO,
  SessionState,
  SessionSubscription,
} from "./core/session";

export type {
  SessionEventDTO,
  SessionState,
  SessionSubscription,
} from "./core/session";

/* ------------------------------------------------------------------ *
 * Core value types
 * ------------------------------------------------------------------ */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type ProtocolName =
  | "http"
  | "sse"
  | "websocket"
  | "grpc"
  | "graphql"
  | "mcp";

/**
 * An OpenAPI 3.2 document. Kept loose on purpose: the toolkit tolerates
 * partial and vendor-extended documents rather than validating them upfront.
 */
export type OpenApiDocument = Record<string, any>;

/** Identifies a single operation inside an OpenAPI document. */
export interface OperationTarget {
  /** Templated path, e.g. '/users/{id}'. Requires `method`. */
  path?: string;
  /** HTTP method, case-insensitive. Requires `path`. */
  method?: string;
  /** Alternative lookup key; takes precedence over path + method. */
  operationId?: string;
}

/** User-supplied values injected into the generated request. */
export interface RequestValues {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  header?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
  /** OpenAPI 3.2 `querystring` parameter location: a raw, pre-encoded query string. */
  querystring?: string;
  body?: unknown;
  /** Force a specific request media type when the operation declares several. */
  contentType?: string;
}

export interface AuthConfig {
  type: "bearer" | "basic" | "apikey" | "none";
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  in?: "header" | "query";
}

/* ------------------------------------------------------------------ *
 * Scripting
 * ------------------------------------------------------------------ */

export interface ScriptSource {
  /** Script body, either a single string or an array of lines. */
  exec: string | string[];
  /** Optional identifier surfaced in script results. */
  id?: string;
}

export interface ScriptConfig {
  collectionPreRequest?: ScriptSource | ScriptSource[];
  collectionTest?: ScriptSource | ScriptSource[];
  preRequest?: ScriptSource | ScriptSource[];
  test?: ScriptSource | ScriptSource[];
  /**
   * Read `x-postman-scripts` from the spec.
   *
   * @default true
   *
   * JavaScript embedded in a third-party document executes in the sandbox when
   * this is enabled, which the caller may not expect. Loading such a document
   * pushes a warning onto `BuiltCollection.warnings`. The default becomes
   * `false` in 0.2.0; set it explicitly to pin current behaviour.
   */
  fromSpecExtensions?: boolean;
  /** Append the built-in helper exposing the last response to later requests. */
  captureLastResponse?: boolean;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  index: number;
  error?: { name?: string; message: string; stack?: string };
}

export interface ConsoleLog {
  level: "log" | "info" | "warn" | "error" | "debug";
  messages: unknown[];
  at: number;
}

export interface ScriptOutcome {
  target: "prerequest" | "test";
  scriptId?: string;
  error?: { name?: string; message: string };
  /** Full variable scope snapshot after the script ran (not a diff). */
  environment?: Record<string, string>;
  globals?: Record<string, string>;
  /**
   * Values produced by pm.execution.setNextRequest / skipRequest, etc.
   * Widened to `unknown`: the runtime also returns bare strings here.
   */
  return?: unknown;
}

export interface ScriptReport {
  prerequest: ScriptOutcome[];
  test: ScriptOutcome[];
  assertions: AssertionResult[];
  console: ConsoleLog[];
  /** False when at least one non-skipped assertion failed. */
  passed: boolean;
  /** True when the item was skipped via pm.execution.skipRequest(). */
  skipped: boolean;
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

export interface StreamEvent {
  /** SSE `id` field, or a synthetic sequence number for WebSocket frames. */
  id?: string;
  /** SSE `event` field, or the WebSocket frame kind ('text' | 'binary' | 'ping'). */
  event?: string;
  data: string;
  /** Populated when `data` parses as JSON. */
  parsed?: Json;
  retry?: number;
  receivedAt: number;
  /** Message direction. WebSocket only; SSE events are always inbound. */
  direction?: "in" | "out";
}

/**
 * Why sampling ended before the peer closed the connection.
 * Absent when the stream or response completed on its own.
 */
export type StopReason =
  | "maxEvents"
  | "maxStreamMs"
  | "maxResponseSize"
  | "maxSessionMs"
  | "idleTimeout"
  | "aborted"
  | "hardTimeout";

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export interface ReplayRecord {
  url: string;
  method: string;
  status: number;
  /** Origin reported by the runtime, e.g. 'authorizer' or 'redirect'. */
  reason?: string;
}

export interface ExecResult {
  protocol: ProtocolName;
  request: {
    method: string;
    url: string;
    /** Header names keep the casing reported by the runtime. */
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    statusText: string;
    /**
     * Header names keep the casing reported by the server. HTTP header names
     * are case-insensitive, so lower-case before comparing.
     */
    headers: Record<string, string>;
    contentType?: string;
    /** Parsed body for non-streaming responses. */
    body?: unknown;
    text?: string;
    /** Collected events for streaming protocols. Never longer than `maxEvents`. */
    events?: StreamEvent[];
    timings: {
      startedAt: number;
      endedAt: number;
      /** Total wall-clock time: `endedAt - startedAt`. */
      durationMs: number;
      /** Time to first byte, relative to `startedAt`. */
      firstByteMs?: number;
      /**
       * Network exchange time as reported by postman-runtime, excluding script
       * execution and sampling overhead. Far below `durationMs` on a sampled
       * stream, which is why it is a separate field rather than `durationMs`.
       */
      networkDurationMs?: number;
    };
    /** Body bytes received. Header bytes are not counted. */
    sizeBytes: number;
    /**
     * True when sampling stopped before the stream ended naturally.
     * Absent (undefined) when the stream completed on its own.
     */
    truncated?: boolean;
    /** Set alongside `truncated` to identify which limit was reached. */
    stopReason?: StopReason;
    /**
     * Events discarded by the parser's own size caps, as opposed to those
     * withheld by `maxEvents`. A non-zero value means payload data was lost.
     */
    droppedEvents?: number;
  };
  scripts?: ScriptReport;
  cookies?: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
  }>;
  replays?: ReplayRecord[];
  error?: { message: string; code?: string; name?: string; stack?: string };
}

/* ------------------------------------------------------------------ *
 * Runtime options
 * ------------------------------------------------------------------ */

/**
 * Raw postman-runtime options. Every documented field is passed straight
 * through to `runner.run()`. Anything set here wins over the library defaults.
 */
export interface RuntimeRunOptions {
  data?: Array<Record<string, unknown>>;
  timeout?: { request?: number; script?: number; global?: number };
  iterationCount?: number;
  stopOnError?: boolean;
  abortOnError?: boolean;
  stopOnFailure?: boolean;
  abortOnFailure?: boolean;
  environment?: any;
  globals?: any;
  localVariables?: any;
  secretResolver?: (
    ctx: { secrets: Array<{ key: string; value?: string }>; url: string },
    callback: (
      error: Error | null,
      result?: Array<{
        resolvedValue?: string;
        error?: unknown;
        allowedInScript?: boolean;
      }>,
    ) => void,
  ) => void;
  entrypoint?: {
    execute?: string;
    lookupStrategy?: "idOrName" | "path";
    path?: string[];
  };
  delay?: { item?: number; iteration?: number };
  fileResolver?: unknown;
  requester?: RequesterOptions;
  script?: {
    serializeLogs?: boolean;
    requestResolver?: (
      requestId: string,
      callback: (error: Error | null, collection?: any) => void,
    ) => void;
    packageResolver?: (
      ctx: { packages: any },
      callback: (
        error: Error | null,
        packages?: Record<string, { data?: string; error?: string }>,
      ) => void,
    ) => void;
  };
  proxies?: any;
  systemProxy?: (
    url: string,
    callback: (error: Error | null, config?: any) => void,
  ) => void;
  ignoreProxyEnvironmentVariables?: boolean;
  certificates?: any;
  systemCertificate?: () => void;
  [key: string]: unknown;
}

export interface RequesterOptions {
  cookieJar?: any;
  disableCookies?: boolean;
  followRedirects?: boolean;
  followOriginalHttpMethod?: boolean;
  maxRedirects?: number;
  /**
   * Byte ceiling for the response body. This is a hard cut, not a hint:
   * a streaming call with a tiny value yields an empty event list. A value of
   * `0` is rejected with BAD_RUN_OPTIONS rather than treated as "no bytes".
   * Leave undefined for streaming operations.
   */
  maxResponseSize?: number;
  maxHeaderSize?: number;
  protocolVersion?: "http1" | "http2" | "auto";
  useWhatWGUrlParser?: boolean;
  removeRefererHeaderOnRedirect?: boolean;
  strictSSL?: boolean;
  insecureHTTPParser?: boolean;
  timings?: boolean;
  verbose?: boolean;
  implicitCacheControl?: boolean;
  implicitTraceHeader?: boolean;
  systemHeaders?: Record<string, string>;
  extendedRootCA?: string;
  network?: {
    hostLookup?: { type: string; hostIpMap?: Record<string, string> };
    restrictedAddresses?: Record<string, boolean>;
  };
  /**
   * Supplying agents disables the library's socket tracking, because tracking
   * requires owning `createConnection`. Stream cancellation then falls back to
   * `run.abort()` alone, which cannot interrupt an in-flight response body.
   */
  agents?: {
    http?:
      | { agentClass?: unknown; agentOptions?: Record<string, unknown> }
      | unknown;
    https?:
      | { agentClass?: unknown; agentOptions?: Record<string, unknown> }
      | unknown;
  };
  authorizer?: {
    refreshOAuth2Token?: (
      id: string,
      callback: (error: Error | null, token?: string) => void,
    ) => void;
  };
  maxInvokableNestedRequests?: number;
  sslKeyLogFile?: string;
  [key: string]: unknown;
}

/** WebSocket-specific execution options. */
export interface WebSocketOptions {
  /** Absolute ws:// or wss:// URL. Overrides anything derived from the spec. */
  url?: string;
  subprotocols?: string[];
  headers?: Record<string, string>;
  /** Messages sent immediately after the connection opens. */
  send?: Array<string | Record<string, unknown> | Uint8Array>;
  /** Milliseconds to wait between consecutive outbound messages. */
  sendDelayMs?: number;
  /** Stop after this many inbound messages. */
  maxMessages?: number;
  /** Hard cap on total session duration. */
  maxSessionMs?: number;
  /** Close once no message arrives within this window. */
  idleTimeoutMs?: number;
  /** Application-level ping payload sent on an interval. */
  keepAlive?: { intervalMs: number; payload?: string };
  /** Close code sent when the client terminates the session. */
  closeCode?: number;
  closeReason?: string;
  /**
   * Milliseconds to wait for the peer's close frame after sending ours before
   * destroying the socket. A peer that never completes the closing handshake
   * would otherwise keep the session open indefinitely.
   */
  closeTimeoutMs?: number;
  /** Extra options forwarded verbatim to the `ws` client constructor. */
  clientOptions?: Record<string, unknown>;
  /** Reject self-signed certificates. Defaults to true. */
  rejectUnauthorized?: boolean;
  /** Cap on retained payload size per frame, in bytes. */
  maxPayloadBytes?: number;
  handshakeTimeoutMs?: number;
}

/** GraphQL-specific execution options. */
export interface GraphQLOptions {
  /** Absolute HTTP(S) URL of the GraphQL endpoint. Overrides the resolved server URL. */
  endpoint?: string;
  /** Query or mutation document. Overrides whatever `x-graphql.query` declares. */
  query?: string;
  /** Name of the operation to run, required when `query` declares more than one. */
  operationName?: string;
  /** GraphQL variables. Merged over any sampled from `x-graphql.variablesSchema`. */
  variables?: Record<string, unknown>;
  /** Extra headers, merged over `values.header` and auth. */
  headers?: Record<string, string>;
  /**
   * Use HTTP GET with querystring-encoded `query`/`variables` instead of a
   * POST body. Some CDN-fronted endpoints require this for cached reads.
   */
  useGet?: boolean;
}

/** MCP-specific execution options, covering both supported transports. */
export interface McpOptions {
  /** Which transport to use. Defaults to "streamable-http". */
  transport?: "streamable-http" | "stdio";

  /* HTTP */
  endpoint?: string;
  headers?: Record<string, string>;

  /* stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxStderrBytes?: number;

  /* MCP */
  method?: string;
  name?: string;
  arguments?: Record<string, unknown>;

  sessionId?: string;
  protocolVersion?: string;

  clientInfo?: {
    name: string;
    version: string;
  };
}

/** Bounds applied to the incremental SSE parser itself. */
export interface StreamParserOptions {
  /**
   * Maximum characters buffered while waiting for an event boundary. A peer
   * that never terminates an event would otherwise grow the buffer without
   * bound, independently of `maxResponseSize`. Defaults to 4 Mi.
   */
  maxBufferChars?: number;
  /** Maximum characters retained in a single event's `data`. Defaults to 1 Mi. */
  maxEventChars?: number;
  /**
   * Attach the last seen `id` to events that omit one. Defaults to true.
   *
   * The specification reserves the last event id for the `Last-Event-ID`
   * header on reconnect rather than treating it as a property of later events.
   * Inheriting it aids debugging but makes `id` look universally present to
   * schema inference. Set to false for a spec-faithful stream.
   */
  inheritEventId?: boolean;
}

/* ------------------------------------------------------------------ *
 * MCP runtime wire types
 * ------------------------------------------------------------------ */

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

export interface McpTool {
  kind: "tool";
  name: string;
  /** Human-facing label, distinct from the machine `name`. */
  title?: string;
  description?: string;
  inputSchema: any;
  /** Server-declared execution constraints, e.g. `{ taskSupport: "forbidden" }`. */
  execution?: Record<string, unknown>;
}

export interface McpResource {
  kind: "resource";
  /** Resource templates use `uriTemplate`; concrete resources use `uri`. */
  uri?: string;
  uriTemplate?: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  kind: "prompt";
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type McpCapability = McpTool | McpResource | McpPrompt;

export interface McpDiscoveryResult {
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  sessionId?: string;
  capabilities: McpCapability[];
  warnings: string[];
}

export interface InitializeSessionInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  clientInfo?: { name: string; version: string };
  /** Client capabilities advertised at initialize. Default: {}. */
  capabilities?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Manual sessions (WebSocket / MCP / gRPC)
 * ------------------------------------------------------------------ */

export interface ManualMessage {
  data: unknown;
  delayMs?: number;
}


export type ManualSessionKind = "websocket" | "mcp" | "grpc";

/**
 * The minimal contract shared by every manual session. Each protocol exposes
 * a richer, protocol-specific interface (WsManualSession / McpManualSession /
 * GrpcManualSession); `ManualSession` is what `createManualSession()` returns.
 */
export interface ManualSession {
  readonly protocol: ManualSessionKind;
  readonly state: SessionState;
  readonly events: readonly SessionEventDTO[];
  onEvent(listener: (event: SessionEventDTO) => void): SessionSubscription;
  open(): Promise<void>;
  send(message: unknown, options?: unknown): Promise<void>;
  close(options?: unknown): Promise<void>;
  waitForClose(): Promise<void>;
}

/** WebSocket manual session. State mirrors the shared SessionState. */
export type WebSocketSessionState = SessionState;

export interface WebSocketSessionEvent {
  direction: "in" | "out" | "meta";
  receivedAt: number;
  event:
    | "open"
    | "text"
    | "binary"
    | "error"
    | "close"
    | "upgrade"
    | "unexpected-response";
  data?: string;
  parsed?: unknown;
  code?: number;
  reason?: string;
  protocol?: string;
  extensions?: string;
  wasClean?: boolean;
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[] | undefined>;
  error?: string;
}

export interface CreateWsManualSessionOptions {
  url: string;
  headers?: Record<string, string>;
  subprotocols?: string[];
  rejectUnauthorized?: boolean;
  /** Abort opening / pending operations from the outside. */
  signal?: AbortSignal;
  /** Handshake timeout in ms. Default 15_000. */
  openTimeoutMs?: number;
  /** Ring-buffer cap for events. 0 = unbounded. Default 1000. */
  maxEvents?: number;
}

export interface WsSendOptions {
  delayMs?: number;
  binary?: boolean;
}

export interface WsManualSession {
  readonly protocol: "websocket";
  readonly state: WebSocketSessionState;
  readonly events: readonly SessionEventDTO[];
  onEvent(listener: (event: SessionEventDTO) => void): SessionSubscription;

  open(): Promise<void>;
  send(data: unknown, options?: WsSendOptions): Promise<void>;
  close(options?: { code?: number; reason?: string }): Promise<void>;
  waitForClose(): Promise<void>;
}

/** MCP manual session. State mirrors the shared SessionState. */
export type McpSessionState = SessionState;

export interface McpSessionEvent {
  direction: "in" | "out" | "meta";
  at: number;
  event: "session" | "jsonrpc" | "notification" | "error" | "lifecycle";
  /** JSON text of `parsed`, or undefined when there was no body (202/204). */
  data?: string;
  parsed?: unknown;
}

/**
 * Options for a manual MCP session. `transport` picks the wire: HTTP
 * (Streamable HTTP, the default) or stdio (spawns `command`).
 */
export interface McpManualSessionOptions {
  /** "streamable-http" (default) or "stdio". */
  transport?: "streamable-http" | "stdio";

  /* Streamable HTTP transport */
  endpoint?: string;
  headers?: Record<string, string>;

  /* stdio transport */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxBufferBytes?: number;
  maxStderrBytes?: number;

  /* shared */
  clientInfo?: { name: string; version: string };
  /** Client capabilities advertised at initialize. Default: {}. */
  capabilities?: Record<string, unknown>;
  /** Per-request timeout in ms. 0/undefined disables. Default 30_000. */
  timeoutMs?: number;
  /** Aborts the whole session (open, in-flight sends, close). */
  signal?: AbortSignal;
  /** Ring-buffer cap for `events`. Default 1000. 0 = unbounded. */
  maxEvents?: number;
  /** Redact secret-looking values in recorded events. Default true. */
  redactSecrets?: boolean;
  /**
   * Issue list calls one at a time. Needed only for servers that cannot
   * handle concurrent requests on one session. Default false.
   */
  serialize?: boolean;
}

/** Backward-compatible alias: stdio uses the same option shape. */
export type McpStdioSessionOptions = Omit<
  McpManualSessionOptions,
  "transport" | "endpoint" | "headers"
> & {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export interface McpRequestOptions {
  delayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Return the raw outcome instead of throwing on JSON-RPC errors. */
  raw?: boolean;
}

export interface McpListing<T> {
  items: T[];
  pages: number;
}

/** How a session-termination DELETE was answered. */
export type McpTerminateOutcome =
  | "released"
  | "unsupported"
  | "already-gone"
  | "failed";

export interface McpManualSession {
  readonly protocol: "mcp";
  readonly state: McpSessionState;
  readonly sessionId: string | undefined;
  readonly protocolVersion: string | undefined;
  readonly serverInfo: { name: string; version: string } | undefined;
  readonly events: readonly SessionEventDTO[];
  onEvent(listener: (event: SessionEventDTO) => void): SessionSubscription;

  open(): Promise<void>;
  request<T = any>(
    method: string,
    params?: unknown,
    options?: McpRequestOptions,
  ): Promise<T>;
  send(message: unknown, options?: McpRequestOptions): Promise<JsonRpcOutcome>;
  notify(
    method: string,
    params?: unknown,
    options?: McpRequestOptions,
  ): Promise<void>;
  ping(options?: McpRequestOptions): Promise<void>;

  listTools(options?: McpRequestOptions): Promise<McpListing<any>>;
  listPrompts(options?: McpRequestOptions): Promise<McpListing<any>>;
  listResources(options?: McpRequestOptions): Promise<McpListing<any>>;
  listResourceTemplates(options?: McpRequestOptions): Promise<McpListing<any>>;
  /** Concrete resources + templates, merged. */
  listSources(options?: McpRequestOptions): Promise<McpListing<any>>;

  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<any>;
  getPrompt(
    name: string,
    args?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<any>;
  readResource(uri: string, options?: McpRequestOptions): Promise<any>;

  close(): Promise<void>;
  waitForClose(): Promise<void>;
  [Symbol.asyncDispose]?: () => Promise<void>;
}

/** gRPC manual session. */

export type GrpcMethodKind =
  | "unary"
  | "server_streaming"
  | "client_streaming"
  | "bidi_streaming";

export type GrpcManualSessionState = SessionState;

export type GrpcDescriptorSourceKind = "proto" | "reflection";

export interface GrpcManualSessionEvent {
  direction: "outbound" | "inbound" | "status" | "meta";
  event?: "open" | "metadata" | "data" | "status" | "error" | "end" | "close";
  payload?: unknown;
  metadata?: unknown;
  code?: number;
  details?: string;
  statusName?: string;
  error?: string;
  at: number;
}

export interface GrpcManualSessionTarget {
  address: string;
  reflection?: boolean;
  protoPaths?: string[];
  /** Extra include directories for proto-loader (defaults to the dirs of protoPaths). */
  includeDirs?: string[];
  service: string;
  method: string;
  metadata?: Record<string, string>;
  deadlineMs?: number;
  loaderOptions?: Record<string, unknown>;
  channelOptions?: Record<string, unknown>;
  tls?: unknown;
  reflectionTimeoutMs?: number;
  reflectionVersion?: "v1" | "v1alpha";
  reflectionHost?: string;
}

export interface GrpcManualSession {
  readonly protocol: "grpc";
  readonly state: GrpcManualSessionState;
  /** Resolved lazily inside open(); undefined until then. */
  readonly kind: GrpcMethodKind | undefined;
  /** Resolved lazily inside open(); undefined until then. */
  readonly source: GrpcDescriptorSourceKind | undefined;
  readonly events: readonly SessionEventDTO[];
  onEvent(listener: (event: SessionEventDTO) => void): SessionSubscription;
  readonly warnings: readonly unknown[];
  open(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  waitForClose(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * gRPC core wire types
 * ------------------------------------------------------------------ */

export interface GrpcTlsOptions {
  /**
   * CA bundle contents, not a path. Pass `await readFile(p)`; a string is
   * rejected, because grpc-js would otherwise treat the path text itself as
   * PEM data and fail with an opaque handshake error.
   */
  rootCerts?: Buffer;
  /** Client key for mTLS. Must be given together with certChain. */
  privateKey?: Buffer;
  /** Client certificate chain for mTLS. Must be given together with privateKey. */
  certChain?: Buffer;
  /**
   * Skips hostname verification only. The certificate chain is STILL verified.
   * For self-signed certs issued to a different name. Always produces a warning.
   */
  skipHostnameVerification?: boolean;
}

export interface GrpcCredentialsOptions {
  /** false/undefined = insecure; true = TLS with system roots; object = custom. */
  tls?: boolean | GrpcTlsOptions;
}

/**
 * A discriminated union rather than a flat bag of optional fields: the two
 * sources share no options at all, and a type that permits both filled in at
 * once forces a runtime rule ("reflection wins") that users have to learn from
 * a warning instead of from the compiler.
 */
export interface GrpcProtoFileSource {
  reflection?: false;
  /** .proto files or directories. Directories are walked recursively and merged. */
  protoPaths: string[];
  /**
   * Import roots. When omitted they are derived from protoPaths plus, for files
   * outside them, each file's own directory — which resolves imports more
   * loosely than protoc and is reported as a note. Set this for exact parity
   * with your build.
   */
  includeDirs?: string[];
  /** Directory names skipped while walking. Default: node_modules,.git,dist,build,out,.venv */
  ignoreDirs?: string[];
  /** Follow symlinks while walking. Default false; cycles are detected either way. */
  followSymlinks?: boolean;
  /** Cap on files collected in one scan. Default 5000. */
  maxProtoFiles?: number;
}

export interface GrpcReflectionSource {
  /** Use server reflection as the descriptor source. */
  reflection: true;
  /** Budget for the whole reflection session, not per round trip. Default 5000. */
  reflectionTimeoutMs?: number;
  /** Pin a version. Default: try v1, fall back to v1alpha when unimplemented. */
  reflectionVersion?: "v1" | "v1alpha";
  /** `host` field on reflection requests. Only for virtual-hosted servers. */
  reflectionHost?: string;
  /** Caps on the descriptor closure. Defaults: 2000 files, 32 MiB. */
  maxReflectionFiles?: number;
  maxReflectionBytes?: number;
}

/**
 * Exactly one descriptor source. `.proto` is already the authoritative IDL for
 * gRPC, and a running server can describe itself — there is no third option and
 * no lossy intermediate document worth introducing.
 */
export type GrpcDescriptorSource = GrpcProtoFileSource | GrpcReflectionSource;

/**
 * Metadata as written by a caller. Single values are allowed because writing
 * `{ "x-trace": "abc" }` is what people mean.
 */
export type GrpcMetadataInput = Record<string, string | string[]>;

/**
 * Metadata as observed on the wire. Always arrays: HTTP/2 headers may repeat,
 * and collapsing repeats would silently discard data. Binary (`-bin`) values
 * are base64-encoded so the result stays JSON-serialisable.
 */
export type GrpcMetadataOutput = Record<string, string[]>;

interface GrpcConnection extends GrpcCredentialsOptions {
  /** host:port, no scheme. */
  address: string;
  /** Sent on every call made through this endpoint, including reflection. */
  metadata?: GrpcMetadataInput;
  channelOptions?: Record<string, unknown>;
}

/** Everything needed to reach a server and read its schema, without a method. */
export type GrpcEndpoint = GrpcConnection & GrpcDescriptorSource;

/** An endpoint plus the one method to invoke. */
export type GrpcTarget = GrpcEndpoint & {
  /** Fully-qualified service name, e.g. "demo.echo.Echo". */
  service: string;
  /** Method name as declared in proto, e.g. "Say". Matched case-insensitively as a fallback. */
  method: string;
  /**
   * Per-call gRPC deadline. Enforced by the server, so exceeding it yields
   * DEADLINE_EXCEEDED with statusOrigin "server" and truncated=false — the call
   * was not cut short by this library.
   */
  deadlineMs?: number;
};

export interface GrpcSendOptions {
  /**
   * Request payloads, in proto3 JSON shape as produced by buildMessageTemplate.
   *
   * unary / server_streaming: only messages[0] is sent; extras produce a
   *   warning. When omitted an empty message is sent, which a method with
   *   required semantics will reject — a warning says so.
   * client_streaming / bidi_streaming: all are sent in order, then the write
   *   side is half-closed unless keepWriteOpen is set.
   */
  messages?: unknown[];

  /**
   * Stop after N inbound messages. 0 means "send, then stop before reading".
   * Sets truncated=true with reason "max_messages".
   */
  maxMessages?: number;
  /** No inbound message for this long -> stop. Reason "idle_timeout". */
  idleTimeoutMs?: number;
  /** Hard wall-clock cap on the whole call. Reason "max_session". */
  maxSessionMs?: number;

  /**
   * All limits are armed simultaneously and the first to fire wins; only that
   * one appears in truncatedReason. They are independent of target.deadlineMs,
   * which is enforced by the server rather than here.
   */

  /** Pause between outbound messages. client/bidi streaming only. */
  sendIntervalMs?: number;
  /**
   * bidi only. Keeps the write side open after the last message, so the call
   * can only end via the server, a limit, an abort, or the deadline. Setting it
   * with none of those available produces a warning.
   */
  keepWriteOpen?: boolean;

  signal?: AbortSignal;
  /**
   * Called for every event, in order. A throwing callback is swallowed: an
   * observer must not be able to terminate the call it is observing.
   */
  onEvent?: (event: GrpcEvent) => void;
}

/**
 * "status" is its own direction rather than a flavour of "meta".
 *
 * Response headers and the terminal status are different observations — one is
 * mid-call, the other ends it — and giving them the same discriminant means a
 * `switch (event.direction)` cannot tell them apart. The terminal status is the
 * single most important event in the log, so it is the last one that should be
 * indistinguishable from anything else.
 */
export type GrpcEventDirection = "outbound" | "inbound" | "meta" | "status";

interface GrpcEventBase {
  seq: number;
  /** epoch ms */
  at: number;
}

export interface GrpcMessageEvent extends GrpcEventBase {
  direction: "outbound" | "inbound";
  payload: unknown;
}

/** Initial metadata, i.e. response headers. */
export interface GrpcMetadataEvent extends GrpcEventBase {
  direction: "meta";
  metadata: GrpcMetadataOutput;
}

export interface GrpcStatusEvent extends GrpcEventBase {
  direction: "status";
  status: GrpcStatus;
  /**
   * Always "server" or "client" here: this event records a status that was
   * actually observed. A synthesized status never produces an event, because
   * nothing happened on the wire to record — it appears only in the result.
   */
  statusOrigin: Exclude<GrpcStatusOrigin, "synthesized">;
  /** Trailing metadata, when the status arrived with any. */
  metadata?: GrpcMetadataOutput;
}

/**
 * Discriminated on `direction`, so narrowing yields exactly the fields that
 * event carries. Consumers that switch on it should end with an exhaustiveness
 * check; a missing branch is otherwise a silently blank row in a timeline.
 */
export type GrpcEvent = GrpcMessageEvent | GrpcMetadataEvent | GrpcStatusEvent;

export interface GrpcStatus {
  code: number;
  /** e.g. "OK", "DEADLINE_EXCEEDED". Falls back to "CODE_<n>" for unknown codes. */
  codeName: string;
  details?: string;
}

/**
 * Who produced a status.
 *
 * - "server"      : the peer's trailers, or the unary/client-streaming callback.
 * - "client"      : grpc-js decided it locally without the server replying,
 *                   e.g. UNAVAILABLE on a refused connection.
 * - "synthesized" : this library stopped the call, so no wire status will ever
 *                   arrive and CANCELLED was written in. Labelled rather than
 *                   left blank, because an unlabelled synthetic status is
 *                   indistinguishable from one the peer sent.
 */
export type GrpcStatusOrigin = "server" | "client" | "synthesized";

/**
 * Why this library stopped a call that would otherwise have continued.
 *
 * That is the whole definition of `truncated`, and it is what keeps
 * target.deadlineMs off this list: a deadline is enforced by the peer, so its
 * DEADLINE_EXCEEDED is a real outcome rather than an interruption.
 */
export type GrpcTruncatedReason =
  | "max_messages"
  | "idle_timeout"
  | "max_session"
  | "aborted";

export interface GrpcResult {
  protocol: "grpc";
  /** From the descriptor, so it reflects what the method is, not what was asked for. */
  kind: GrpcMethodKind;
  target: GrpcTarget;

  /** Everything that happened, in order, including messages already in `messages`. */
  events: GrpcEvent[];
  /** Inbound payloads only, for the common case of not needing the timeline. */
  messages: unknown[];

  /**
   * Response headers. Undefined means the call never reached the point of
   * receiving them; an empty object means they arrived and were empty.
   */
  initialMetadata?: GrpcMetadataOutput;
  /** Response trailers, with the same undefined-versus-empty distinction. */
  trailers?: GrpcMetadataOutput;

  /** Undefined only when the call was cut before any outcome existed. */
  status?: GrpcStatus;
  /** Present exactly when `status` is. */
  statusOrigin?: GrpcStatusOrigin;

  truncated: boolean;
  /** Present exactly when truncated is true. */
  truncatedReason?: GrpcTruncatedReason;

  /** Human-readable failure text. Absent on success and on clean truncation. */
  error?: string;
  warnings: string[];
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * GraphQL types
 * ------------------------------------------------------------------ */

export interface GraphQLTypeRef {
  kind: string;
  name?: string | null;
  ofType?: GraphQLTypeRef | null;
}

export interface GraphQLArg {
  name: string;
  description?: string | null;
  type: GraphQLTypeRef;
  defaultValue?: string | null;
}

export interface GraphQLFieldInfo {
  name: string;
  description?: string | null;
  args: GraphQLArg[];
  type: GraphQLTypeRef;
  isDeprecated?: boolean;
}

export interface GraphQLNamedType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: GraphQLFieldInfo[];
  inputFields?: GraphQLArg[];
  enumValues?: Array<{ name: string }>;
}

export interface IntrospectedSchema {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  /** Every named type, keyed by name, for resolving arg/field types during generation. */
  types: Map<string, GraphQLNamedType>;
}

export interface IntrospectionResult {
  schema: IntrospectedSchema;
  /** Raw `__schema` payload, kept for callers that want more than this module parses. */
  raw: any;
}

export interface GeneratedOperation {
  operationType: "query" | "mutation" | "subscription";
  fieldName: string;
  operationName: string;
  /** Complete, ready-to-send document. */
  query: string;
  /** JSON Schema describing the `variables` object, for sampling and for documentation. */
  variablesSchema: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
  notes: string[];
}

export interface WriteGraphQLOptions {
  /** Overwrite an existing path for the same operation. Defaults to true. */
  overwrite?: boolean;
  /** Extra headers to send with the introspection request (auth, etc.). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DiscoverAndWriteResult {
  spec: any;
  operations: GeneratedOperation[];
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Resolved configs (outputs of each protocol's config resolver)
 * ------------------------------------------------------------------ */

export type McpTransport = "streamable-http" | "stdio";

export interface ResolvedMcpConfig {
  transport: McpTransport;
  endpoint?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxStderrBytes?: number;
  method: string;
  /** Fully-formed JSON-RPC `params` for `method`. */
  params: Record<string, unknown>;
  headers: Record<string, string>;
  sessionId?: string;
  /** Only set when the caller actually negotiated it; never guessed. */
  protocolVersion?: string;
  clientInfo: { name: string; version: string };
}

export interface ResolvedGraphQLConfig {
  endpoint: string;
  query: string;
  operationName?: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  useGet: boolean;
}

export interface ResolvedWsConfig {
  url: string;
  subprotocols: string[];
  headers: Record<string, string>;
  send: Array<string | Uint8Array>;
  sendDelayMs: number;
  maxMessages: number;
  maxSessionMs: number;
  idleTimeoutMs: number;
  keepAlive?: { intervalMs: number; payload: string };
  closeCode: number;
  closeReason: string;
  /** Grace period for the peer's close frame before the socket is destroyed. */
  closeTimeoutMs: number;
  rejectUnauthorized: boolean;
  maxPayloadBytes: number;
  clientOptions: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Send options / results
 * ------------------------------------------------------------------ */

/**
 * Callback payload delivered as soon as response headers arrive. For HTTP
 * this is the moment the UI must decide how to render: a `streaming: true`
 * flag means SSE was detected (by content-type / declared intent) and events
 * will follow over `onEvent` — switch to the list view immediately instead of
 * waiting for the call to finish.
 */
export interface ResponseStartInfo {
  status: number;
  headers: Record<string, string>;
  contentType?: string;
  /** True when the response was classified as SSE as soon as headers arrived. */
  streaming: boolean;
  /** "sse" when streaming, otherwise "http". */
  protocol: "http" | "sse";
  /** URL that was actually requested. */
  url: string;
}

export interface SendOptions extends StreamParserOptions {
  /** The complete OpenAPI 3.2 document. */
  spec: OpenApiDocument;
  target: OperationTarget;
  values?: RequestValues;

  /** Overrides `spec.servers[0].url`. */
  serverUrl?: string;
  serverVariables?: Record<string, string>;
  /** Environment variables referenced as {{name}}. */
  variables?: Record<string, string>;
  globals?: Record<string, string>;
  localVariables?: Record<string, string>;

  auth?: AuthConfig;
  scripts?: ScriptConfig;

  /** Full postman-runtime option passthrough. Highest precedence. */
  runner?: RuntimeRunOptions;
  /** WebSocket options, used by the ws adapter. */
  websocket?: WebSocketOptions;
  /** GraphQL options, used by the graphql adapter. */
  graphql?: GraphQLOptions;
  /** MCP options, used by the mcp adapter. */
  mcp?: McpOptions;
  /** gRPC options, used by the gRPC adapter. */
  grpc?: any;

  /** Convenience shortcut, equivalent to runner.timeout.request. */
  timeout?: number;
  /** Maximum number of streaming events to retain. */
  maxEvents?: number;
  /** Maximum streaming duration before sampling stops. */
  maxStreamMs?: number;
  maxResponseSize?: number;
  /**
   * Controls the OpenAPI write-back step. Set to false to skip it and leave
   * `patchedSpec` undefined; `responseFragment` is produced either way.
   */
  writeBack?: boolean;

  /** Cancels the run. Sampling stops and a partial result is still returned. */
  signal?: AbortSignal;

  /** Callbacks are invoked defensively: a throwing handler never aborts the call. */
  onEvent?: (event: StreamEvent) => void;
  onConsole?: (log: ConsoleLog) => void;
  onAssertion?: (assertion: AssertionResult) => void;
  /**
   * Fired as soon as the response starts (first bytes). `info.streaming`
   * is the early SSE classification the UI switches on.
   */
  onResponseStart?: (info: ResponseStartInfo) => void;
  /** Fired when a WebSocket connection is established. */
  onOpen?: (info: {
    url: string;
    protocol?: string;
    headers: Record<string, string>;
  }) => void;
}

export interface SendResult extends ExecResult {
  /** The generated Postman collection (v2.1). Empty for non-HTTP protocols. */
  collection?: any;
  /** The generated Postman environment. */
  environment?: any;
  /** OpenAPI 3.2 Response Object derived from the live call. */
  responseFragment: any;
  /** Status code the fragment was filed under. */
  responseStatusCode: string;
  /** Deep copy of the spec with the response merged in. Undefined when skipped. */
  patchedSpec?: OpenApiDocument;
  /** Explains why write-back did not happen. */
  writeBackSkippedReason?: string;
}

/* ------------------------------------------------------------------ *
 * Unified manual-session entry
 * ------------------------------------------------------------------ */

/**
 * Discriminated union accepted by `createManualSession()`. The `kind` field
 * routes to the right protocol factory; every branch is a superset of that
 * factory's own options.
 */
export type ManualSessionOptions =
  | ({ kind: "websocket" } & Omit<CreateWsManualSessionOptions, "url"> & {
      url: string;
    })
  | ({ kind: "grpc" } & GrpcManualSessionTarget)
  | ({ kind: "mcp" } & Omit<McpManualSessionOptions, "transport">)
  | ({
      kind: "mcp";
      transport: "stdio";
    } & Omit<McpStdioSessionOptions, "transport">);

/** The union of every concrete manual session. */
export type AnyManualSession =
  | WsManualSession
  | McpManualSession
  | GrpcManualSession;
