import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { PackageDefinition, ServiceDefinition } from "@grpc/proto-loader";

import { buildCatalog } from "./catalog.js";
import { scanProtoFiles, deriveIncludeDirsDetailed } from "./proto-dir.js";
import type {
  GrpcDescriptorSourceKind,
  GrpcEndpoint,
  GrpcManualSession,
  GrpcManualSessionEvent,
  GrpcManualSessionState,
  GrpcManualSessionTarget,
  GrpcMethodKind,
} from "../../core/types.js";
import type {
  SessionEventDTO,
  SessionSubscription,
} from "../../core/session.js";
import { createEventHub } from "../../core/session.js";

/**
 * loadPackageDefinition returns a GrpcObject whose intermediate nodes are
 * namespace objects; only leaves carry a `.service` client constructor.
 */
type ServiceClientConstructor = (new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: Record<string, unknown>,
) => grpc.Client & Record<string, any>) & {
  service: ServiceDefinition;
};

interface LoadedService {
  client: grpc.Client & Record<string, any>;
  methodName: string;
  kind: GrpcMethodKind;
  source: GrpcDescriptorSourceKind;
}

function createMetadata(input?: Record<string, string>): grpc.Metadata {
  const metadata = new grpc.Metadata();

  for (const [key, value] of Object.entries(input ?? {})) {
    metadata.set(key, value);
  }

  return metadata;
}

function getCredentials(tls: unknown): grpc.ChannelCredentials {
  if (!tls) {
    return grpc.credentials.createInsecure();
  }

  return grpc.credentials.createSsl();
}

function getDeadline(deadlineMs?: number): Date | undefined {
  if (!deadlineMs || deadlineMs <= 0) {
    return undefined;
  }

  return new Date(Date.now() + deadlineMs);
}

function hasProtoPaths(target: GrpcManualSessionTarget): boolean {
  return (
    Array.isArray(target.protoPaths) &&
    target.protoPaths.some((item) => typeof item === "string" && item.trim())
  );
}

function normalizeProtoPaths(target: GrpcManualSessionTarget): string[] {
  return (target.protoPaths ?? []).filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

/**
 * buildCatalog widens the package definition to Record<string, unknown>
 * because discovery only iterates it; at runtime it is protoLoader.load()'s
 * output. Shape-check here before narrowing, so a wrong assertion cannot be
 * deferred to `new serviceCtor()`.
 */
function asPackageDefinition(
  definition: Record<string, unknown> | undefined,
): PackageDefinition {
  if (!definition || typeof definition !== "object") {
    throw new Error(
      "The gRPC descriptor source did not return a usable package definition.",
    );
  }

  for (const [key, value] of Object.entries(definition)) {
    if (!value || typeof value !== "object") {
      throw new Error(
        `gRPC package definition entry "${key}" is not an object; ` +
          "the descriptor source returned an unexpected shape.",
      );
    }
  }

  return definition as unknown as PackageDefinition;
}

function resolveServiceConstructor(
  root: grpc.GrpcObject,
  dottedPath: string,
): ServiceClientConstructor | undefined {
  if (typeof dottedPath !== "string" || !dottedPath.trim()) {
    return undefined;
  }

  const found = dottedPath
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      root,
    );

  if (typeof found !== "function") {
    return undefined;
  }

  const candidate = found as Partial<ServiceClientConstructor>;

  if (!candidate.service || typeof candidate.service !== "object") {
    return undefined;
  }

  return found as ServiceClientConstructor;
}

function resolveMethodKind(definition: {
  requestStream?: boolean;
  responseStream?: boolean;
}): GrpcMethodKind {
  if (definition.requestStream && definition.responseStream) {
    return "bidi_streaming";
  }

  if (definition.requestStream && !definition.responseStream) {
    return "client_streaming";
  }

  if (!definition.requestStream && definition.responseStream) {
    return "server_streaming";
  }

  return "unary";
}

function resolveMethodOriginalName(
  serviceCtor: ServiceClientConstructor,
  requestedMethod: string,
): string {
  if (typeof requestedMethod !== "string" || !requestedMethod.trim()) {
    throw new Error("Invalid gRPC method name");
  }

  const definitions = serviceCtor.service ?? {};

  if (definitions[requestedMethod]) {
    return requestedMethod;
  }

  const wanted = requestedMethod.toLowerCase();

  for (const [key, value] of Object.entries(definitions)) {
    const rpcPath =
      typeof (value as any)?.path === "string"
        ? ((value as any).path as string)
        : undefined;

    if (
      key.toLowerCase() === wanted ||
      rpcPath?.split("/").pop()?.toLowerCase() === wanted
    ) {
      return key;
    }
  }

  const available = Object.keys(definitions).sort();

  throw new Error(
    available.length
      ? `Unable to resolve gRPC method "${requestedMethod}". Available: ${available.join(", ")}`
      : `Unable to resolve gRPC method "${requestedMethod}"`,
  );
}

function buildClient(
  serviceCtor: ServiceClientConstructor,
  target: GrpcManualSessionTarget,
  source: GrpcDescriptorSourceKind,
): LoadedService {
  const methodName = resolveMethodOriginalName(serviceCtor, target.method);
  const methodDefinition = serviceCtor.service[methodName];

  if (!methodDefinition) {
    throw new Error(
      `Unable to resolve gRPC method "${target.service}/${target.method}"`,
    );
  }

  const client = new serviceCtor(
    target.address,
    getCredentials(target.tls),
    target.channelOptions ?? {},
  );

  return {
    client,
    methodName,
    kind: resolveMethodKind(methodDefinition),
    source,
  };
}

async function loadServiceFromProto(
  target: GrpcManualSessionTarget,
): Promise<LoadedService> {
  const protoPaths = normalizeProtoPaths(target);

  if (!protoPaths.length) {
    throw new Error(
      "protoPaths is required when loading a gRPC service from proto files.",
    );
  }

  // proto-loader accepts only real files (directories fail with EISDIR on
  // newer versions). Expand every root through the same walker discovery
  // uses, then hand it the resolved file list plus derived include roots.
  const scan = await scanProtoFiles({ paths: protoPaths });
  if (!scan.files.length) {
    throw new Error(
      "No .proto files were found under the given protoPaths.",
    );
  }
  const include = deriveIncludeDirsDetailed(scan);

  const packageDefinition = await protoLoader.load(scan.files, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: include.includeDirs,
    ...(target.loaderOptions ?? {}),
  });

  const root = grpc.loadPackageDefinition(packageDefinition);
  const serviceCtor = resolveServiceConstructor(root, target.service);

  if (!serviceCtor) {
    throw new Error(
      `Unable to resolve gRPC service "${target.service}" from the provided proto files. ` +
        'Make sure the name is fully qualified, e.g. "package.ServiceName".',
    );
  }

  return buildClient(serviceCtor, target, "proto");
}

/**
 * Reflection branch: fetch the descriptor through buildCatalog, then build the
 * runtime client from the same package definition.
 */
async function loadServiceFromReflection(
  target: GrpcManualSessionTarget,
): Promise<LoadedService> {
  const endpoint = {
    address: target.address,
    reflection: true,
    metadata: target.metadata,
    channelOptions: target.channelOptions,
    tls: target.tls,
    reflectionTimeoutMs: target.reflectionTimeoutMs,
    reflectionVersion: target.reflectionVersion,
    reflectionHost: target.reflectionHost,
    loaderOptions: target.loaderOptions,
  } as unknown as GrpcEndpoint;

  const { catalog, packageDefinition } = await buildCatalog(endpoint);

  const root = grpc.loadPackageDefinition(
    asPackageDefinition(packageDefinition as Record<string, unknown>),
  );

  const serviceCtor = resolveServiceConstructor(root, target.service);

  if (!serviceCtor) {
    const known = [
      ...new Set([
        ...((catalog as any)?.services ?? []),
        ...((catalog as any)?.invocableServices ?? []),
      ]),
    ]
      .filter((item): item is string => typeof item === "string")
      .sort();

    throw new Error(
      known.length
        ? `Unable to resolve gRPC service "${target.service}" via reflection. Available: ${known.join(", ")}`
        : `Unable to resolve gRPC service "${target.service}" via reflection; the server exposed no services.`,
    );
  }

  return buildClient(serviceCtor, target, "reflection");
}

async function loadService(
  target: GrpcManualSessionTarget,
): Promise<LoadedService> {
  const usesProto = hasProtoPaths(target);
  const usesReflection = target.reflection === true;

  if (!usesProto && !usesReflection) {
    throw new Error(
      "a gRPC endpoint needs a descriptor source: either set reflection: true, or pass protoPaths: string[] pointing at your .proto files or directories. Neither was provided.",
    );
  }

  if (usesProto) {
    return loadServiceFromProto(target);
  }

  return loadServiceFromReflection(target);
}

/**
 * Create a manual gRPC session.
 *
 * The factory is synchronous and performs no I/O: descriptor loading (proto
 * files or reflection) happens lazily inside `open()`. This keeps the manual
 * session contract uniform across protocols — construct first, drive later —
 * and avoids a constructor that can throw network errors.
 */
export function createGrpcManualSession(
  target: GrpcManualSessionTarget,
): GrpcManualSession {
  const hub = createEventHub(
    "grpc",
    "grpc",
    `grpc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    1000,
  );
  const warnings: unknown[] = [];

  let state: GrpcManualSessionState = "idle";
  let kind: GrpcMethodKind | undefined;
  let source: GrpcDescriptorSourceKind | undefined;
  let sentCount = 0;

  let loaded: LoadedService | undefined;
  let metadata: grpc.Metadata | undefined;
  let deadline: Date | undefined;

  let openPromise: Promise<void> | undefined;

  let closeResolve: () => void = () => {};

  const closePromise = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });

  let activeCall: any = null;

  function record(event: GrpcManualSessionEvent) {
    const direction =
      event.direction === "outbound"
        ? "out"
        : event.direction === "inbound"
          ? "in"
          : "meta";
    const meta: Record<string, unknown> = {};
    if (event.metadata !== undefined) meta.metadata = event.metadata;
    if (event.code !== undefined) meta.code = event.code;
    if (event.details !== undefined) meta.details = event.details;
    if (event.statusName !== undefined) meta.statusName = event.statusName;

    // Message payloads go on `data` so renderers can display them directly;
    // non-meta fields that are not the payload stay in `meta`.
    const isMessage = event.event === "data";
    hub.emit({
      direction,
      kind: event.event ?? "event",
      at: event.at,
      state: hub.state,
      data: isMessage ? event.payload : undefined,
      meta: Object.keys(meta).length ? meta : undefined,
      error: event.error,
    });
  }

  function setState(next: GrpcManualSessionState): void {
    state = next;
    hub.setState(next);
  }

  function markClosed() {
    if (state !== "closed") {
      setState("closed");
      closeResolve();
    }
  }

  function requireLoaded(): LoadedService {
    if (!loaded) {
      throw new Error("gRPC session is not open");
    }
    return loaded;
  }

  function attachSharedListeners(call: any) {
    call.on("metadata", (incomingMetadata: grpc.Metadata) => {
      record({
        direction: "meta",
        event: "metadata",
        metadata: incomingMetadata.getMap(),
        at: Date.now(),
      });
    });

    call.on("status", (status: grpc.StatusObject) => {
      // code 0 = success -> closed; any other code = error.
      // Checking the code prevents this listener from overriding an "error"
      // state that the unary/client-streaming callback already set.
      if (status.code === 0) {
        markClosed();
      } else {
        setState("error");
        closeResolve();
      }
      activeCall = null;
      record({
        direction: "status",
        event: "status",
        code: status.code,
        statusName: grpc.status[status.code],
        details: status.details,
        metadata: status.metadata?.getMap?.() ?? undefined,
        at: Date.now(),
      });
    });

    call.on("error", (error: any) => {
      setState("error");
      record({
        direction: "status",
        event: "error",
        code: error?.code,
        statusName:
          typeof error?.code === "number" ? grpc.status[error.code] : undefined,
        details: error?.details ?? error?.message,
        metadata: error?.metadata?.getMap?.() ?? undefined,
        error: error?.message ?? String(error),
        at: Date.now(),
      });

      closeResolve();
      activeCall = null;
    });

    call.on("end", () => {
      if (kind === "server_streaming" || kind === "bidi_streaming") {
        markClosed();
      }
      record({
        direction: "meta",
        event: "end",
        at: Date.now(),
      });
    });
  }

  function createCallForStreamingRequestKinds() {
    if (activeCall) {
      return activeCall;
    }

    const service = requireLoaded();
    const options: Record<string, unknown> = {};
    if (deadline) {
      options.deadline = deadline;
    }

    if (service.kind === "client_streaming") {
      activeCall = service.client[service.methodName](
        metadata,
        options,
        (error: any, response: unknown) => {
          if (error) {
            setState("error");

            record({
              direction: "status",
              event: "error",
              code: error?.code,
              statusName:
                typeof error?.code === "number"
                  ? grpc.status[error.code]
                  : undefined,
              details: error?.details ?? error?.message,
              metadata: error?.metadata?.getMap?.() ?? undefined,
              error: error?.message ?? String(error),
              at: Date.now(),
            });

            closeResolve();
            activeCall = null;
            return;
          }

          record({
            direction: "inbound",
            event: "data",
            payload: response,
            at: Date.now(),
          });

          markClosed();
          activeCall = null;
        },
      );

      attachSharedListeners(activeCall);
      return activeCall;
    }

    if (service.kind === "bidi_streaming") {
      activeCall = service.client[service.methodName](metadata, options);
      attachSharedListeners(activeCall);

      activeCall.on("data", (response: unknown) => {
        // Discard late inbound messages after the client has initiated close.
        // grpc-js may still deliver buffered frames while the call is
        // transitioning to status; recording them would confuse the UI
        // into thinking the stream is still active.
        if (state === "closing" || state === "closed") {
          return;
        }
        record({
          direction: "inbound",
          event: "data",
          payload: response,
          at: Date.now(),
        });
      });

      return activeCall;
    }

    return null;
  }

  return {
    get protocol(): "grpc" {
      return "grpc";
    },

    get state() {
      return state;
    },

    get kind() {
      return kind;
    },

    get source() {
      return source;
    },

    get events(): readonly SessionEventDTO[] {
      return hub.events;
    },

    onEvent(
      listener: (event: SessionEventDTO) => void,
    ): SessionSubscription {
      return hub.onEvent(listener);
    },

    get warnings() {
      return warnings;
    },

    async open() {
      if (openPromise) {
        return openPromise;
      }
      if (state !== "idle" && state !== "closed" && state !== "error") {
        throw new Error(`gRPC session cannot open from state "${state}"`);
      }

      setState("connecting");
      openPromise = (async () => {
        try {
          const service = await loadService(target);
          loaded = service;
          kind = service.kind;
          source = service.source;
          metadata = createMetadata(target.metadata);
          deadline = getDeadline(target.deadlineMs);

          if (kind === "client_streaming" || kind === "bidi_streaming") {
            createCallForStreamingRequestKinds();
          }

          setState("open");

          record({
            direction: "meta",
            event: "open",
            payload: {
              address: target.address,
              service: target.service,
              method: service.methodName,
              requestedMethod: target.method,
              kind,
              descriptorSource: source,
            },
            at: Date.now(),
          });
        } catch (e) {
          setState("error");
          closeResolve();
          record({
            direction: "status",
            event: "error",
            error: e instanceof Error ? e.message : String(e),
            at: Date.now(),
          });
          throw e;
        } finally {
          openPromise = undefined;
        }
      })();

      return openPromise;
    },

    async send(message: unknown) {
      if (state !== "open") {
        throw new Error("gRPC session is not open");
      }

      record({
        direction: "outbound",
        event: "data",
        payload: message,
        at: Date.now(),
      });

      const service = requireLoaded();
      const options: Record<string, unknown> = {};
      if (deadline) {
        options.deadline = deadline;
      }

      if (service.kind === "unary") {
        if (sentCount > 0) {
          throw new Error("Unary gRPC call only supports one send()");
        }

        sentCount += 1;

        await new Promise<void>((resolve, reject) => {
          const call = service.client[service.methodName](
            message,
            metadata,
            options,
            (error: any, response: unknown) => {
              if (error) {
                setState("error");

                record({
                  direction: "status",
                  event: "error",
                  code: error?.code,
                  statusName:
                    typeof error?.code === "number"
                      ? grpc.status[error.code]
                      : undefined,
                  details: error?.details ?? error?.message,
                  metadata: error?.metadata?.getMap?.() ?? undefined,
                  error: error?.message ?? String(error),
                  at: Date.now(),
                });

                closeResolve();
                activeCall = null;
                reject(error);
                return;
              }

              record({
                direction: "inbound",
                event: "data",
                payload: response,
                at: Date.now(),
              });

              // Unary success: close the session explicitly. The shared
              // status listener also calls markClosed(), but doing it here
              // guarantees the state transitions even if grpc-js reorders
              // the callback and the status event on a fast local server.
              markClosed();
              activeCall = null;

              resolve();
            },
          );

          activeCall = call;
          attachSharedListeners(call);
        });

        return;
      }

      if (service.kind === "server_streaming") {
        if (sentCount > 0) {
          throw new Error(
            "Server-streaming gRPC call only supports one send()",
          );
        }

        sentCount += 1;

        const call = service.client[service.methodName](message, metadata, options);
        activeCall = call;
        attachSharedListeners(call);

        call.on("data", (response: unknown) => {
          record({
            direction: "inbound",
            event: "data",
            payload: response,
            at: Date.now(),
          });
        });

        // send() resolves when the stream completes, not when the request is
        // written, so a caller can close() right after send() without racing.
        try {
          await new Promise<void>((resolve, reject) => {
            call.on("status", () => resolve());
            call.on("error", (error: unknown) => reject(error));
          });
        } finally {
          activeCall = null;
        }
        return;
      }

      if (service.kind === "client_streaming" || service.kind === "bidi_streaming") {
        const call = createCallForStreamingRequestKinds();

        if (!call) {
          throw new Error("Streaming gRPC call was not initialized");
        }

        await new Promise<void>((resolve, reject) => {
          call.write(message, (error: any) => {
            if (error) {
              reject(error);
              return;
            }

            sentCount += 1;
            resolve();
          });
        });

        return;
      }

      throw new Error(`Unsupported gRPC method kind: ${service.kind}`);
    },

    async close() {
      if (state === "closed") {
        return;
      }

      if (state !== "open" && state !== "error" && state !== "closing") {
        markClosed();
        return;
      }

      setState("closing");

      record({
        direction: "meta",
        event: "close",
        at: Date.now(),
      });

      if (kind === "client_streaming" || kind === "bidi_streaming") {
        if (activeCall && typeof activeCall.end === "function") {
          activeCall.end();
        } else {
          markClosed();
        }
      } else if (activeCall && typeof activeCall.cancel === "function") {
        activeCall.cancel();
      } else {
        markClosed();
      }

      await closePromise;
    },

    async waitForClose() {
      await closePromise;
    },
  };
}

export const grpcManualSession = createGrpcManualSession;
