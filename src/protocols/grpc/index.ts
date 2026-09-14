/**
 * Public surface of the gRPC module.
 *
 * Every export here is side-effect free at import time: @grpc/grpc-js and
 * @grpc/proto-loader are optional peer dependencies loaded on first use, so
 * importing this module must never require them to be installed.
 *
 * Deliberately absent: `collectProtoFiles` and `deriveIncludeDirs`. Both are
 * internal back-compat shims that drop the scan's `notes`, and a note dropped
 * here is a skipped symlink or a loosened include root that the user never
 * hears about. External callers get `scanProtoFiles` and
 * `deriveIncludeDirsDetailed`, which cannot lose that information.
 */

/* ---------------------------------------------------------------- *
 * Adapter
 * ---------------------------------------------------------------- */

export { GrpcAdapter } from "./adapter.js";
export type { GrpcPlan, GrpcAdapterOptions } from "./adapter.js";

/* ---------------------------------------------------------------- *
 * Invocation
 * ---------------------------------------------------------------- */

export { grpcCall } from "./call.js";
export { resolveMethod } from "./descriptor.js";
export type { ResolvedMethod, ResolveMethodOptions } from "./descriptor.js";

/* ---------------------------------------------------------------- *
 * Discovery and request templates
 *
 * Both a self-contained and a catalog-taking form of each operation are
 * exported. The self-contained ones rebuild the catalog per call, which under
 * reflection means one handshake per method; anything describing more than a
 * single method should build the catalog once and use the *FromCatalog form.
 * ---------------------------------------------------------------- */

export {
  discover,
  discoverFromCatalog,
  describeMethod,
  describeFromCatalog,
} from "./discovery.js";
export type {
  DiscoveredMethod,
  DiscoveredService,
  DiscoveryResult,
  DescribeOptions,
  MethodDetail,
} from "./discovery.js";

export { buildMessageTemplate } from "./template.js";
export type {
  BuildTemplateOptions,
  CollectionHint,
  EnumHint,
  MessageTemplate,
  OneofHint,
  PresenceHint,
} from "./template.js";

/* ---------------------------------------------------------------- *
 * Descriptor sources
 * ---------------------------------------------------------------- */

export { buildCatalog, LOADER_OPTIONS } from "./catalog.js";
export type { Catalog, SymbolEntry, SymbolKind } from "./catalog.js";

export { scanProtoFiles, deriveIncludeDirsDetailed } from "./proto-dir.js";
export type {
  CollectProtoOptions,
  IncludeDirsResult,
  ProtoScanResult,
} from "./proto-dir.js";

export {
  fetchDescriptorSet,
  fetchFullDescriptorSet,
  listServices,
  listServicesDetailed,
  serializeDescriptorSet,
  ReflectionProtocolError,
  ReflectionUnavailableError,
} from "./reflection.js";
export type {
  DescriptorSetResult,
  FullDescriptorSetResult,
  ListServicesResult,
  ReflectionOp,
  ReflectionOutcome,
  ReflectionSessionOptions,
  ReflectionVersion,
} from "./reflection.js";

/**
 * Descriptor decoding is exported because both descriptor sources funnel
 * through it: a consumer holding FileDescriptorSet bytes from anywhere else can
 * build the same symbol table this library uses.
 */
export {
  decodeFileDescriptorProto,
  decodeFileDescriptorSet,
  DescriptorDecodeError,
} from "./file-descriptor.js";
export type {
  DecodedEnum,
  DecodedField,
  DecodedFile,
  DecodedMessage,
  DecodedMethod,
  DecodedService,
} from "./file-descriptor.js";

/**
 * DescriptorShapeError is part of the contract, not an internal detail:
 * describeFromCatalog distinguishes it from every other failure by
 * `instanceof` — turning it into a note instead of rethrowing — and a consumer
 * that wants the same distinction cannot make it by matching message text.
 */
export {
  enumName,
  isMapEntry,
  readEnumValueNames,
  readFields,
  readMethods,
  readNestedTypes,
  readOneofNames,
  DescriptorShapeError,
  LABEL_NAMES,
  TYPE_NAMES,
} from "./descriptor-types.js";
export type { FieldDescriptor, MethodDescriptor } from "./descriptor-types.js";

/* ---------------------------------------------------------------- *
 * Transport
 * ---------------------------------------------------------------- */

export {
  buildCredentials,
  buildCredentialsAsync,
  buildCredentialsChecked,
  buildCredentialsCheckedAsync,
} from "./credentials.js";
export type { CredentialsBuildResult } from "./credentials.js";
/**
 * The loader is public because buildCredentials takes a LoadedGrpc, and because
 * a host application often needs to know whether gRPC is available before it
 * offers the option at all — isGrpcAvailable answers that without throwing.
 */
export {
  loadGrpc,
  isGrpcAvailable,
  requireCapability,
  GrpcDependencyBrokenError,
  GrpcDependencyMissingError,
} from "./loader.js";
export type { GrpcCapabilities, LoadedGrpc } from "./loader.js";

/* ---------------------------------------------------------------- *
 * Types
 * ---------------------------------------------------------------- */

export type {
  // connection and target
  GrpcCredentialsOptions,
  GrpcEndpoint,
  GrpcTarget,
  GrpcTlsOptions,
  // descriptor source: exactly one of the two variants
  GrpcDescriptorSource,
  GrpcProtoFileSource,
  GrpcReflectionSource,
  // metadata: the input/output asymmetry is deliberate and both names are
  // needed, because writing the output shape by hand is where people get it
  // wrong (a repeated header collapsed to a single string).
  GrpcMetadataInput,
  GrpcMetadataOutput,
  // sending
  GrpcMethodKind,
  GrpcSendOptions,
  // events: the union plus each member, so a consumer can type a per-branch
  // handler without re-deriving it with Extract.
  GrpcEvent,
  GrpcEventDirection,
  GrpcMessageEvent,
  GrpcMetadataEvent,
  GrpcStatusEvent,
  // outcome
  GrpcResult,
  GrpcStatus,
  GrpcStatusOrigin,
  GrpcTruncatedReason,
} from "./types.js";
