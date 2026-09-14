/**
 * @powerduck/openapi-request - single public surface.
 *
 * Everything a renderer or a script needs hangs off this one entry:
 *   - `createClient()`  : UI-first client (prepare / send / connect / discover
 *                         / writeback / probeStreamingResponse)
 *   - `createDebugger()`: scripted workhorse (send / sendMany / toCollection)
 *   - `createManualSession()`: unified long-lived sessions (ws / mcp / grpc)
 *   - per-protocol factories & adapters for power users
 *
 * All public types come from "./types" (one auditable surface). The old
 * per-protocol "types.ts" files are gone.
 */

/* ------------------------------------------------------------------ *
 * Core
 * ------------------------------------------------------------------ */

export * from "./types";
export * from "./core/clone";
export * from "./core/session";

export { createClient, probeStreamingResponse } from "./core/client";
export type {
  CreateClientOptions,
  DisplayMode,
  PreparedRequest,
  ProtoClient,
  StreamKind,
} from "./core/client";

export { createDebugger } from "./core/debugger";
export type {
  DebuggerOptions,
  PlanResult,
  ProtoKit,
  SendManyFailure,
  SendManyResult,
} from "./core/debugger";

export { createManualSession } from "./core/manual-session";
export { AdapterRegistry } from "./core/registry";
export { ProtoKitError } from "./core/errors";

export type {
  ProtocolAdapter,
  AdapterContext,
  ExecuteContext,
} from "./core/protocol";

/* ------------------------------------------------------------------ *
 * OpenAPI helpers
 * ------------------------------------------------------------------ */

export { locateOperation } from "./openapi/locate";
export type { LocatedOperation } from "./openapi/locate";

export { inferSchema, inferSchemaFromMany } from "./openapi/infer";
export { mergeSchema } from "./openapi/merge";
export { sampleFromSchema } from "./openapi/sample";
export { toResponseObject, writeBackResponse } from "./openapi/writeback";
export type { WriteBackOptions, ToResponseOptions } from "./openapi/writeback";

/* ------------------------------------------------------------------ *
 * HTTP / SSE
 * ------------------------------------------------------------------ */

export { HttpAdapter } from "./protocols/http";
export { BUILTIN_CAPTURE_TEST } from "./protocols/http/scripts";
export { SseParser } from "./protocols/http/sse-parser";
export {
  isStreamingOperation,
  isSseContentType,
  isStreamingContentType,
  acceptHeaderFor,
} from "./protocols/http/detect";

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

export {
  WebSocketAdapter,
  createWsManualSession,
  createWsManualSession as runWebSocketSession,
  createWsManualSession as wsManualSession,
} from "./protocols/ws";

/* ------------------------------------------------------------------ *
 * GraphQL
 * ------------------------------------------------------------------ */

export { GraphQLAdapter } from "./protocols/graphql";
export { resolveGraphQLConfig } from "./protocols/graphql/config";
export { runGraphQL } from "./protocols/graphql/client";
export {
  introspectSchema,
  INTROSPECTION_QUERY,
} from "./protocols/graphql/introspection";
export {
  generateOperation,
  generateAllOperations,
} from "./protocols/graphql/generate";
export {
  writeGraphQLOperations,
  discoverAndWriteGraphQLSchema,
} from "./protocols/graphql/writeback";

/* ------------------------------------------------------------------ *
 * MCP (Streamable HTTP + stdio)
 * ------------------------------------------------------------------ */

export { McpAdapter } from "./protocols/mcp";
export {
  createMcpManualSession,
  createMcpManualSession as mcpManualSession,
  createMcpStdioSession,
  /** @deprecated Use `createMcpManualSession`. */
  runMcpManualSession,
} from "./protocols/mcp/session";
export { resolveMcpConfig } from "./protocols/mcp/config";
export {
  initializeSession as initializeMcpSession,
  discoverMcpCapabilities,
  MCP_PROTOCOL_VERSION,
} from "./protocols/mcp/discovery";
export { generateMcpCall, generateAllMcpCalls } from "./protocols/mcp/generate";
export {
  writeMcpOperations,
  discoverAndWriteMcpCapabilities,
} from "./protocols/mcp/writeback";
export {
  createHttpMcpTransport,
  createStdioMcpTransport,
} from "./protocols/mcp/transport";

/* ------------------------------------------------------------------ *
 * gRPC (unary / server / client / bidi)
 * ------------------------------------------------------------------ */

export {
  GrpcProtocolAdapter,
  writeGrpcOperations,
  discoverAndWriteGrpcOperations,
} from "./protocols/grpc/openapi";

export {
  discover as grpcDiscover,
  discover as discoverGrpc,
} from "./protocols/grpc/discovery";

export type {
  DiscoveryResult as GrpcDiscoveryResult,
  DiscoveredMethod as GrpcDiscoveredMethod,
  DiscoveredService as GrpcDiscoveredService,
} from "./protocols/grpc/discovery";

export {
  createGrpcManualSession,
  createGrpcManualSession as grpcManualSession,
} from "./protocols/grpc/session";

export { GrpcAdapter } from "./protocols/grpc/adapter";
export { grpcCall } from "./protocols/grpc/call";
export { resolveMethod } from "./protocols/grpc/descriptor";
export { buildMessageTemplate } from "./protocols/grpc/template";
export { buildCatalog, LOADER_OPTIONS } from "./protocols/grpc/catalog";
export { scanProtoFiles, deriveIncludeDirsDetailed } from "./protocols/grpc/proto-dir";
export {
  fetchDescriptorSet,
  fetchFullDescriptorSet,
  listServices,
  listServicesDetailed,
  serializeDescriptorSet,
  ReflectionProtocolError,
  ReflectionUnavailableError,
} from "./protocols/grpc/reflection";
export {
  decodeFileDescriptorProto,
  decodeFileDescriptorSet,
  DescriptorDecodeError,
} from "./protocols/grpc/file-descriptor";
export {
  buildCredentials,
  buildCredentialsAsync,
  buildCredentialsChecked,
  buildCredentialsCheckedAsync,
} from "./protocols/grpc/credentials";
export {
  loadGrpc,
  isGrpcAvailable,
  requireCapability,
  GrpcDependencyBrokenError,
  GrpcDependencyMissingError,
} from "./protocols/grpc/loader";
