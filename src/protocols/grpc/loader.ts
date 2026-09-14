import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type GrpcJs = typeof import("@grpc/grpc-js");
type ProtoLoader = typeof import("@grpc/proto-loader");

export interface LoadedGrpc {
  grpc: GrpcJs;
  protoLoader: ProtoLoader;
  /** Capabilities probed once at load time, so call sites never re-check. */
  capabilities: GrpcCapabilities;
}

export interface GrpcCapabilities {
  /** proto-loader >= 0.7. Required by reflection. */
  descriptorSetFromBuffer: boolean;
  /** Versions read from each package.json, when readable. Diagnostics only. */
  grpcVersion?: string;
  protoLoaderVersion?: string;
}

const PACKAGES = {
  grpc: "@grpc/grpc-js",
  protoLoader: "@grpc/proto-loader",
} as const;

/**
 * The optional gRPC peer dependencies are missing.
 *
 * Distinguished from every other load failure because it is the only one the
 * user can fix with an install command; telling someone to install a package
 * they already have is worse than saying nothing.
 */
export class GrpcDependencyMissingError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], cause?: unknown) {
    super(
      `gRPC support requires optional peer dependencies that are not installed: ` +
        `${missing.join(", ")}.\n` +
        `  npm i ${missing.join(" ")}`,
      { cause },
    );
    this.name = "GrpcDependencyMissingError";
    this.missing = missing;
  }
}

/**
 * The package is installed but unusable: it failed to evaluate, or its shape is
 * not what this library requires. Actionable in a completely different way from
 * a missing install, so it is a separate type.
 */
export class GrpcDependencyBrokenError extends Error {
  readonly packageName: string;

  constructor(packageName: string, reason: string, cause?: unknown) {
    super(
      `gRPC dependency "${packageName}" is installed but unusable: ${reason}`,
      { cause },
    );
    this.name = "GrpcDependencyBrokenError";
    this.packageName = packageName;
  }
}

/** True when the failure is "this specifier does not resolve", not "it threw". */
function isModuleNotFound(error: unknown, specifier: string): boolean {
  const e = error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  // A transitive dependency of grpc-js can also be missing, and that is a
  // broken install rather than an absent one. Only claim "not installed" when
  // the unresolved specifier is the package we asked for. Quoted first, because
  // the message also contains the importer's path and a substring test against
  // a bare name can match that instead.
  const message = typeof e?.message === "string" ? e.message : "";
  return (
    message.includes(`'${specifier}'`) ||
    message.includes(`"${specifier}"`) ||
    message.includes(specifier)
  );
}

/**
 * Normalises CJS/ESM interop. proto-loader and grpc-js are CommonJS; depending
 * on the loader they may arrive as a namespace with named re-exports, or with
 * everything under `default`.
 */
function unwrap<T>(namespace: unknown, probe: string, packageName: string): T {
  const candidates = [
    namespace,
    (namespace as { default?: unknown } | undefined)?.default,
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      probe in (candidate as object)
    ) {
      return candidate as T;
    }
  }
  throw new GrpcDependencyBrokenError(
    packageName,
    `its module namespace has no "${probe}" export, so the installed version ` +
      `is not the package this library expects.`,
  );
}

async function importPackage(
  specifier: string,
  probe: string,
): Promise<unknown> {
  let namespace: unknown;
  try {
    namespace = await import(specifier);
  } catch (cause) {
    if (isModuleNotFound(cause, specifier)) {
      throw new GrpcDependencyMissingError([specifier], cause);
    }
    throw new GrpcDependencyBrokenError(
      specifier,
      cause instanceof Error
        ? `it threw while loading — ${cause.message}`
        : String(cause),
      cause,
    );
  }
  return unwrap(namespace, probe, specifier);
}

/**
 * Asserts that the members this library calls are actually callable.
 *
 * The import probe only proves a key exists. Everything below is used
 * unconditionally on the call path, so a shape mismatch has to be reported
 * here, naming the member — not later, as "x is not a constructor" from inside
 * a transport.
 */
function assertMembers(
  module: unknown,
  packageName: string,
  members: Record<string, "function" | "object">,
): void {
  for (const [name, expected] of Object.entries(members)) {
    const value = (module as Record<string, unknown>)[name];
    const actual = value === null ? "null" : typeof value;
    if (actual !== expected) {
      throw new GrpcDependencyBrokenError(
        packageName,
        `expected "${name}" to be a ${expected}, found ${actual}. ` +
          `The installed package is not the one this library supports.`,
      );
    }
  }
}

/**
 * Reads a dependency's declared version from its package.json.
 *
 * Neither package exports a `version` member, so the previous property probe
 * was dead code and every "found <version>" hint rendered empty — precisely in
 * the case where knowing the version is the whole point. Resolution is done
 * from the package's main entry rather than by requiring "<pkg>/package.json",
 * which many exports maps refuse to serve.
 */
function readInstalledVersion(specifier: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(specifier));
    // Walk up to the package root. Bounded, so a pathological layout cannot
    // turn a diagnostic lookup into an unbounded filesystem walk.
    for (let depth = 0; depth < 8; depth++) {
      try {
        const raw = readFileSync(join(dir, "package.json"), "utf8");
        const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (parsed.name === specifier && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        /* keep walking */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Version reporting is a convenience. A bundled or virtualised filesystem
    // that cannot answer must not stop gRPC from working.
  }
  return undefined;
}

/**
 * Probes both packages independently so a missing one can be named exactly, and
 * so "both missing" is reported once instead of as whichever lost the race.
 */
async function performLoad(): Promise<LoadedGrpc> {
  const results = await Promise.allSettled([
    importPackage(PACKAGES.grpc, "Client"),
    importPackage(PACKAGES.protoLoader, "load"),
  ]);

  const missing: string[] = [];
  for (const result of results) {
    if (
      result.status === "rejected" &&
      result.reason instanceof GrpcDependencyMissingError
    ) {
      missing.push(...result.reason.missing);
    }
  }
  if (missing.length > 0) {
    const cause = results.find(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof GrpcDependencyMissingError,
    );
    throw new GrpcDependencyMissingError(
      missing,
      cause?.status === "rejected" ? cause.reason : undefined,
    );
  }
  // Anything left is a broken install; rethrow the first one verbatim.
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }

  const grpc = (results[0] as PromiseFulfilledResult<unknown>).value as GrpcJs;
  const protoLoader = (results[1] as PromiseFulfilledResult<unknown>)
    .value as ProtoLoader;

  assertMembers(grpc, PACKAGES.grpc, {
    Client: "function",
    Metadata: "function",
    credentials: "object",
  });
  assertMembers(protoLoader, PACKAGES.protoLoader, { load: "function" });

  return {
    grpc,
    protoLoader,
    capabilities: {
      descriptorSetFromBuffer:
        typeof (protoLoader as { loadFileDescriptorSetFromBuffer?: unknown })
          .loadFileDescriptorSetFromBuffer === "function",
      grpcVersion: readInstalledVersion(PACKAGES.grpc),
      protoLoaderVersion: readInstalledVersion(PACKAGES.protoLoader),
    },
  };
}

/**
 * The in-flight promise, not the result: concurrent first callers must observe
 * one load attempt and one error object, rather than relying on the module
 * cache underneath to deduplicate for us.
 */
let inflight: Promise<LoadedGrpc> | undefined;
let resolved: LoadedGrpc | undefined;

/**
 * Loads the optional gRPC peer dependencies on first use, so HTTP-only
 * consumers never pay for them and never need them installed.
 */
export async function loadGrpc(): Promise<LoadedGrpc> {
  if (resolved) return resolved;
  if (!inflight) {
    inflight = performLoad().then(
      (loaded) => {
        resolved = loaded;
        return loaded;
      },
      (error) => {
        // Failures are not cached: an install can happen between two calls in a
        // long-lived process, and a stale rejection would outlive the fix.
        inflight = undefined;
        throw error;
      },
    );
  }
  return inflight;
}

/** Non-throwing probe, for callers deciding whether to offer gRPC at all. */
export async function isGrpcAvailable(): Promise<boolean> {
  try {
    await loadGrpc();
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts a capability, naming the version that provides it.
 *
 * Centralised here because the loader is the only place that knows what was
 * actually loaded; probing at each call site means each new call site can
 * forget to probe.
 *
 * Unknown keys throw rather than pass. The previous early return made this a
 * no-op for anything but one capability, so adding a capability and forgetting
 * to handle it here would silently disable its check.
 */
export function requireCapability(
  loaded: LoadedGrpc,
  capability: keyof GrpcCapabilities,
): void {
  switch (capability) {
    case "descriptorSetFromBuffer": {
      if (loaded.capabilities.descriptorSetFromBuffer) return;
      const found = loaded.capabilities.protoLoaderVersion
        ? ` (found ${loaded.capabilities.protoLoaderVersion})`
        : "";
      throw new GrpcDependencyBrokenError(
        PACKAGES.protoLoader,
        `server reflection requires @grpc/proto-loader >= 0.7.0${found}; ` +
          `loadFileDescriptorSetFromBuffer is missing.`,
      );
    }
    case "grpcVersion":
    case "protoLoaderVersion":
      throw new TypeError(
        `"${capability}" is diagnostic information, not a capability; ` +
          `it cannot be required.`,
      );
    default: {
      const exhaustive: never = capability;
      throw new TypeError(`unknown gRPC capability: ${String(exhaustive)}`);
    }
  }
}

/** Test seam: install a stand-in, or clear the cache. Not part of the public API. */
export function __setLoadedGrpcForTests(loaded: LoadedGrpc | undefined): void {
  resolved = loaded;
  inflight = loaded ? Promise.resolve(loaded) : undefined;
}