import { grpcCall } from "./call.js";
import { resolveMethod, type ResolvedMethod } from "./descriptor.js";
import {
  describeFromCatalog,
  discoverFromCatalog,
  type DescribeOptions,
  type DiscoveryResult,
  type MethodDetail,
} from "./discovery.js";
import { buildCatalog, type Catalog } from "./catalog.js";
import type {
  GrpcEndpoint,
  GrpcResult,
  GrpcSendOptions,
  GrpcTarget,
} from "./types.js";

export interface GrpcPlan {
  collection: unknown;
  environment: unknown;
  warnings: string[];
  streaming: boolean;
}

interface CachedCatalog {
  catalog: Catalog;
  packageDefinition: Record<string, unknown>;
  at: number;
}

/**
 * Fingerprints TLS config without embedding certificate bytes in a cache key.
 *
 * JSON.stringify would expand a Buffer into {"type":"Buffer","data":[...]},
 * making the key hundreds of kilobytes under mTLS and re-serialising it on
 * every lookup. Lengths suffice: what the cached descriptors depend on is which
 * server was reached, and that is covered by `address`.
 */
function tlsKey(tls: GrpcEndpoint["tls"]): unknown {
  if (tls === undefined || tls === false) return false;
  if (tls === true) return "system";
  return {
    roots: tls.rootCerts?.length ?? 0,
    key: tls.privateKey?.length ?? 0,
    chain: tls.certChain?.length ?? 0,
    skipHostname: tls.skipHostnameVerification === true,
  };
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...value].filter((v): v is string => typeof v === "string").sort()
    : [];
}

/**
 * Cache key for one descriptor source.
 *
 * Deliberately excludes service and method: every method on an endpoint shares
 * one catalog, and keying per method would re-dial the server for every click
 * in a UI.
 *
 * Path arrays are read defensively rather than trusted, because this runs
 * before buildCatalog validates them and a key is not the right place to throw.
 */
function sourceKey(endpoint: GrpcEndpoint): string {
  if (endpoint.reflection === true) {
    return JSON.stringify({
      kind: "reflection",
      address: endpoint.address,
      version: endpoint.reflectionVersion ?? null,
      host: endpoint.reflectionHost ?? null,
      tls: tlsKey(endpoint.tls),
    });
  }
  return JSON.stringify({
    kind: "proto",
    address: endpoint.address,
    // Sorted: two callers naming the same tree in a different order must share
    // one catalog, otherwise the cache silently doubles the work.
    protoPaths: sortedStrings(endpoint.protoPaths),
    includeDirs: sortedStrings(endpoint.includeDirs),
    ignoreDirs: sortedStrings(endpoint.ignoreDirs),
    followSymlinks: endpoint.followSymlinks === true,
    tls: tlsKey(endpoint.tls),
  });
}

/**
 * Shape used only to inspect untrusted input.
 *
 * Deliberately not Partial<GrpcTarget>: GrpcTarget is a union, so Partial
 * distributes over it and no branch carries every field a validator needs to
 * probe. A validator must be able to look at fields that are absent, which is
 * the opposite of what the public type is for.
 */
interface TargetProbe {
  address?: unknown;
  service?: unknown;
  method?: unknown;
  reflection?: unknown;
  protoPaths?: unknown;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** The endpoint half of the probe: no service/method required. */
function hasDescriptorSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const t = value as TargetProbe;
  if (!nonEmptyString(t.address)) return false;
  if (t.reflection === true) return true;
  // Array.isArray, not a truthy .length: a bare string has a length, would
  // pass, and would then be iterated one character at a time.
  return (
    Array.isArray(t.protoPaths) &&
    t.protoPaths.length > 0 &&
    t.protoPaths.every(nonEmptyString)
  );
}

export interface GrpcAdapterOptions {
  /**
   * How long a catalog may be reused, in ms. Default 30_000.
   *
   * A server can be redeployed with a different schema, so this is a staleness
   * budget rather than a permanent cache; 0 disables reuse entirely.
   */
  catalogTtlMs?: number;
  /**
   * Maximum number of cached catalogs. Default 32.
   *
   * A descriptor set is large, and a long-lived process pointed at many
   * endpoints would otherwise grow this map without bound — a cache with a
   * staleness budget but no size budget is still a leak.
   */
  maxCachedCatalogs?: number;
}

export class GrpcAdapter {
  readonly protocol = "grpc" as const;

  private readonly catalogTtlMs: number;
  private readonly maxCachedCatalogs: number;
  /** Insertion-ordered, so the oldest key is the first one Map yields. */
  private readonly catalogs = new Map<string, CachedCatalog>();
  /** In-flight builds, so concurrent first calls dial once. */
  private readonly building = new Map<string, Promise<CachedCatalog>>();

  constructor(options: GrpcAdapterOptions = {}) {
    const ttl = options.catalogTtlMs ?? 30_000;
    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new RangeError(
        `catalogTtlMs must be a finite number >= 0; received ${ttl}.`,
      );
    }
    const max = options.maxCachedCatalogs ?? 32;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(
        `maxCachedCatalogs must be an integer >= 1; received ${max}.`,
      );
    }
    this.catalogTtlMs = ttl;
    this.maxCachedCatalogs = max;
  }

  /**
   * True only for targets this adapter can actually process. One without a
   * descriptor source is rejected here rather than accepted and then failed in
   * plan(), because claiming support for something that always throws makes the
   * dispatcher's decision meaningless.
   */
  supports(target: unknown): boolean {
    if (!hasDescriptorSource(target)) return false;
    const t = target as TargetProbe;
    return nonEmptyString(t.service) && nonEmptyString(t.method);
  }

  private assertSupported(target: unknown): GrpcTarget {
    if (!this.supports(target)) {
      throw new Error(
        "not a usable gRPC target: address, service and method are required, " +
          "plus either protoPaths (a non-empty array of files or directories) " +
          "or reflection: true.",
      );
    }
    return target as GrpcTarget;
  }
  /**
   * Guards the endpoint-only entry points.
   *
   * These are public and are reached directly by discovery UIs, so they cannot
   * rely on assertSupported having run — and they must not require a service or
   * method, which is the whole point of discovery.
   */
  private assertEndpoint(endpoint: unknown): GrpcEndpoint {
    if (!hasDescriptorSource(endpoint)) {
      throw new Error(
        "not a usable gRPC endpoint: address is required, plus either " +
          "protoPaths (a non-empty array of files or directories) or " +
          "reflection: true.",
      );
    }
    return endpoint as GrpcEndpoint;
  }

  /**
   * Builds or reuses the catalog for an endpoint.
   *
   * In-flight de-duplication applies even when caching is off. With
   * catalogTtlMs: 0 the intent is "never reuse a stale catalog", not "dial the
   * server once per concurrent caller"; the second reading would make disabling
   * the cache a way to multiply reflection round-trips.
   */
  async catalogFor(endpoint: GrpcEndpoint): Promise<CachedCatalog> {
    const key = sourceKey(endpoint);

    if (this.catalogTtlMs > 0) {
      const hit = this.catalogs.get(key);
      if (hit && Date.now() - hit.at <= this.catalogTtlMs) {
        // Refresh insertion order so eviction removes the least recently used
        // entry rather than the least recently built one.
        this.catalogs.delete(key);
        this.catalogs.set(key, hit);
        return hit;
      }
      // An expired entry is removed now: leaving it would let a later
      // Date.now() comparison be the only thing keeping it out, and it holds a
      // whole descriptor set alive in the meantime.
      if (hit) this.catalogs.delete(key);
    }

    const pending = this.building.get(key);
    if (pending) return pending;

    const build = buildCatalog(endpoint)
      .then(({ catalog, packageDefinition }) => {
        const entry: CachedCatalog = {
          catalog,
          packageDefinition,
          at: Date.now(),
        };
        if (this.catalogTtlMs > 0) {
          this.catalogs.set(key, entry);
          this.evict();
        }
        return entry;
      })
      .finally(() => {
        // Only successes are cached above, so a failed build leaves no entry
        // and the next call retries rather than replaying a stale error.
        this.building.delete(key);
      });

    this.building.set(key, build);
    return build;
  }

  /** Drops the oldest entries once the cache exceeds its size budget. */
  private evict(): void {
    while (this.catalogs.size > this.maxCachedCatalogs) {
      const oldest = this.catalogs.keys().next();
      if (oldest.done) return;
      this.catalogs.delete(oldest.value);
    }
  }

  /**
   * Drops cached descriptors, for when the server or the proto tree changed.
   *
   * In-flight builds are dropped too. A build already running was started
   * against the state the caller is now declaring stale, so handing its result
   * to the next caller would serve exactly what invalidate() was called to
   * avoid. Callers already awaiting that promise still receive it — the
   * alternative is rejecting a request that has done nothing wrong.
   */
  invalidate(endpoint?: GrpcEndpoint): void {
    if (!endpoint) {
      this.catalogs.clear();
      this.building.clear();
      return;
    }
    const key = sourceKey(endpoint);
    this.catalogs.delete(key);
    this.building.delete(key);
  }

  /** Diagnostics about the descriptor source, reported once per endpoint. */
  async sourceNotes(endpoint: GrpcEndpoint): Promise<string[]> {
    const e = this.assertEndpoint(endpoint);
    const { catalog } = await this.catalogFor(e);
    return [...catalog.notes];
  }

  /**
   * Produces an export bundle for one method.
   *
   * Unlike the HTTP adapter this performs I/O — reading the proto tree, or
   * dialling the server when reflection is the source — because a gRPC method's
   * streaming kind and message shapes exist nowhere else.
   */
  async plan(target: unknown): Promise<GrpcPlan> {
    const t = this.assertSupported(target);
    const { catalog, packageDefinition } = await this.catalogFor(t);
    const method = await resolveMethod(t, { catalog, packageDefinition });

    // Catalog notes are included here, unlike in run(): a plan is produced once
    // and describes the descriptor source as much as the method, so "these type
    // references do not resolve" is directly relevant to what gets exported.
    const sourceOnly = new Set(catalog.notes);
    const warnings = [
      ...method.notes,
      "the exported collection is not a valid Postman v2.1.0 document: gRPC " +
        'has no standard representation there, so method is written as "GRPC" ' +
        "and the invocation details live under protocolProfileBehavior. " +
        "Import support depends on the client.",
      "only address, service, method and metadata survive the export. Message " +
        "payloads, stream pacing, deadlines and truncation limits do not.",
      "gRPC results cannot be written back into an OpenAPI document; " +
        "writeBack is ignored for protocol=grpc.",
      ...describeTlsExport(t),
    ];
    // method.notes already carries the catalog's, so nothing is added twice.
    void sourceOnly;

    return {
      streaming: method.requestStream || method.responseStream,
      warnings,
      environment: { baseUrl: t.address },
      collection: buildCollection(t, method),
    };
  }

  /**
   * Invokes the method, reusing the cached descriptor source.
   *
   * Passing the catalog through is not an optimisation. Left to build its own,
   * grpcCall would re-read the proto tree or — under reflection — dial again,
   * so plan() and run() could observe two different server states, and the
   * runtime/descriptor cross-check inside resolveMethod would be comparing two
   * moments instead of two views.
   */
  async run(target: unknown, options?: unknown): Promise<GrpcResult> {
    const t = this.assertSupported(target);
    const { catalog, packageDefinition } = await this.catalogFor(t);
    return grpcCall(t, (options ?? {}) as GrpcSendOptions, {
      catalog,
      packageDefinition,
      // The endpoint's own diagnostics are available from sourceNotes(),
      // discover() and describeMethod(). Repeating them on every invocation
      // buried the warnings that were actually about the invocation.
      includeSourceNotes: false,
    });
  }

  /** Not part of ProtocolAdapter; exposed for discovery UIs. */
  async discover(endpoint: GrpcEndpoint): Promise<DiscoveryResult> {
    const e = this.assertEndpoint(endpoint);
    const { catalog, packageDefinition } = await this.catalogFor(e);
    return discoverFromCatalog(e, catalog, packageDefinition);
  }

  async describeMethod(
    endpoint: GrpcEndpoint,
    service: string,
    method: string,
    options: DescribeOptions = {},
  ): Promise<MethodDetail> {
    const e = this.assertEndpoint(endpoint);
    if (!nonEmptyString(service) || !nonEmptyString(method)) {
      throw new TypeError(
        "describeMethod needs a non-empty service and method name.",
      );
    }
    const { catalog, packageDefinition } = await this.catalogFor(e);
    return describeFromCatalog(catalog, packageDefinition, service, method, {
      includeResponse: true,
      ...options,
    });
  }
}

/** Reports what the TLS configuration loses on the way out. */
function describeTlsExport(target: GrpcTarget): string[] {
  const tls = target.tls;
  if (tls === undefined || tls === false || tls === true) return [];
  const lost: string[] = [];
  if (tls.privateKey || tls.certChain) lost.push("the client certificate");
  if (tls.rootCerts) lost.push("the custom CA bundle");
  if (tls.skipHostnameVerification) {
    lost.push(
      "skipHostnameVerification, which the importing client will not honour",
    );
  }
  if (lost.length === 0) return [];
  return [
    `the export records only that TLS is enabled; ${lost.join(" and ")} ` +
      `will be absent, so the imported request will not connect as configured.`,
  ];
}

function buildCollection(target: GrpcTarget, method: ResolvedMethod): unknown {
  const name = `${target.service}/${method.name}`;
  return {
    info: {
      name,
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name,
        request: {
          method: "GRPC",
          url: { raw: `grpc://${target.address}${method.path}` },
          description: `kind=${method.kind} source=${method.source}`,
          // flatMap, not map: a repeated metadata key must become repeated
          // headers, since joining them with ", " changes the value.
          header: Object.entries(target.metadata ?? {}).flatMap(
            ([key, value]) =>
              (Array.isArray(value) ? value : [value]).map((v) => ({
                key,
                value: Buffer.isBuffer(v) ? v.toString("base64") : String(v),
              })),
          ),
        },
        protocolProfileBehavior: {
          grpc: {
            service: target.service,
            // The descriptor's spelling, not the caller's: resolveMethod may
            // have matched case-insensitively, and exporting what the user
            // typed would record a name the server does not have.
            methodName: method.name,
            methodType: method.kind,
            url: target.address,
            tls: target.tls !== undefined && target.tls !== false,
          },
        },
      },
    ],
  };
}
