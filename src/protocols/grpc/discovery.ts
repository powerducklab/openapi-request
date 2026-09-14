import { buildCatalog, type Catalog } from "./catalog.js";
import { buildMessageTemplate, type MessageTemplate } from "./template.js";
import {
  DescriptorShapeError,
  readMethods,
  type MethodDescriptor,
} from "./descriptor-types.js";
import type { GrpcEndpoint, GrpcMethodKind } from "./types.js";

export interface DiscoveredMethod {
  /** Method name as declared in proto. */
  name: string;
  /** "/pkg.Service/Method" */
  path: string;
  kind: GrpcMethodKind;
  /**
   * Fully-qualified request message name, or undefined when only the runtime
   * view was available. Undefined means "unknown", never "empty" — a template
   * cannot be generated for it.
   */
  inputType?: string;
  /** Fully-qualified response message name. See inputType. */
  outputType?: string;
  requestStream: boolean;
  responseStream: boolean;
  /** False when the method appears in the descriptor but has no runtime codec. */
  invocable: boolean;
}

export interface DiscoveredService {
  /** Fully-qualified service name. */
  name: string;
  /** Proto package, "" when the service is at the top level. */
  package: string;
  methods: DiscoveredMethod[];
  /**
   * Which views contributed. "both" is the healthy case; anything else means
   * the corresponding capability is degraded and `notes` explains why.
   */
  views: "both" | "descriptor_only" | "runtime_only";
}

export interface DiscoveryResult {
  address: string;
  source: "proto" | "reflection";
  services: DiscoveredService[];
  /** Files loaded, when source === "proto". */
  files?: string[];
  notes: string[];
}

/** Stable, locale-independent ordering for anything shown to a user. */
const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function kindOf(req: boolean, res: boolean): GrpcMethodKind {
  if (req && res) return "bidi_streaming";
  if (req) return "client_streaming";
  if (res) return "server_streaming";
  return "unary";
}

function stripDot(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

function packageOf(fqService: string): string {
  const idx = fqService.lastIndexOf(".");
  return idx === -1 ? "" : fqService.slice(0, idx);
}

interface RuntimeMethodView {
  key: string;
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  hasCodecs: boolean;
}

/** Trailing method name of "/pkg.Service/Method". */
function methodNameFromPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Reads the runtime (proto-loader) view of one service.
 *
 * Keyed by the wire method name rather than the definition key, because
 * proto-loader has historically keyed definitions by both the declared name
 * and its lowerCamelCase form. The wire path is the authority.
 */
function readRuntimeMethods(
  packageDefinition: Record<string, unknown>,
  fqService: string,
): Map<string, RuntimeMethodView> {
  const out = new Map<string, RuntimeMethodView>();
  const def = packageDefinition[fqService];
  if (!def || typeof def !== "object") return out;

  for (const [key, raw] of Object.entries(def as Record<string, unknown>)) {
    const m = raw as {
      path?: unknown;
      requestStream?: unknown;
      responseStream?: unknown;
      requestSerialize?: unknown;
      responseDeserialize?: unknown;
    } | null;
    if (!m || typeof m !== "object" || typeof m.path !== "string") continue;

    const view: RuntimeMethodView = {
      key,
      path: m.path,
      requestStream: m.requestStream === true,
      responseStream: m.responseStream === true,
      hasCodecs:
        typeof m.requestSerialize === "function" &&
        typeof m.responseDeserialize === "function",
    };
    // Duplicate spellings collapse onto the wire name; keep the one whose key
    // matches it so diagnostics show the declared spelling.
    const wireName = methodNameFromPath(view.path);
    const existing = out.get(wireName);
    if (!existing || existing.key !== wireName) out.set(wireName, view);
  }
  return out;
}

/** Reads the descriptor view of one service, degrading to undefined loudly. */
function readDescriptorMethods(
  catalog: Catalog,
  fqService: string,
  notes: string[],
): MethodDescriptor[] | undefined {
  const descriptor = catalog.serviceDescriptors.get(fqService);
  if (descriptor === undefined) return undefined;
  try {
    return readMethods(descriptor);
  } catch (e) {
    notes.push(
      `descriptor for ${fqService} is unreadable, so request templates and ` +
        `type names are unavailable for it: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/**
 * Merges the descriptor and runtime views of one service.
 *
 * Neither view is authoritative on its own: the descriptor knows message types
 * and is the only source for streaming kind, while the runtime view is the
 * only thing that can actually place a call. Where they disagree, both facts
 * are surfaced rather than one silently winning.
 */
function mergeService(
  fqService: string,
  described: MethodDescriptor[] | undefined,
  runtime: Map<string, RuntimeMethodView>,
  notes: string[],
): DiscoveredService {
  const methods: DiscoveredMethod[] = [];
  const seen = new Set<string>();

  for (const m of described ?? []) {
    seen.add(m.name);
    const rt = runtime.get(m.name);

    if (rt) {
      const declaredKind = kindOf(m.clientStreaming, m.serverStreaming);
      const runtimeKind = kindOf(rt.requestStream, rt.responseStream);
      if (declaredKind !== runtimeKind) {
        // Not resolved here: resolveMethod refuses to dial in this state,
        // because half-closing a stream that must stay open (or the reverse)
        // is not a recoverable guess.
        notes.push(
          `streaming flags disagree for ${fqService}/${m.name}: ` +
            `descriptor says ${declaredKind}, runtime says ${runtimeKind}. ` +
            `Calls to this method will be refused.`,
        );
      }
    }

    methods.push({
      name: m.name,
      path: rt?.path ?? `/${fqService}/${m.name}`,
      kind: kindOf(m.clientStreaming, m.serverStreaming),
      inputType: stripDot(m.inputType),
      outputType: stripDot(m.outputType),
      requestStream: m.clientStreaming,
      responseStream: m.serverStreaming,
      invocable: rt?.hasCodecs === true,
    });
  }

  // Methods only the runtime knows about. These are callable but cannot be
  // templated, so the absence of type names is stated, not rendered as blank.
  const runtimeOnly: string[] = [];
  for (const [wireName, rt] of runtime) {
    if (seen.has(wireName)) continue;
    runtimeOnly.push(wireName);
    methods.push({
      name: wireName,
      path: rt.path,
      kind: kindOf(rt.requestStream, rt.responseStream),
      inputType: undefined,
      outputType: undefined,
      requestStream: rt.requestStream,
      responseStream: rt.responseStream,
      invocable: rt.hasCodecs,
    });
  }
  if (runtimeOnly.length) {
    notes.push(
      `${fqService}: ${runtimeOnly.sort().join(", ")} ` +
        `${runtimeOnly.length === 1 ? "is" : "are"} callable but absent from ` +
        `the descriptor; no request template can be generated for ` +
        `${runtimeOnly.length === 1 ? "it" : "them"}.`,
    );
  }

  const notInvocable = methods.filter((m) => !m.invocable).map((m) => m.name);
  if (notInvocable.length && described) {
    notes.push(
      `${fqService}: ${notInvocable.sort().join(", ")} ` +
        `${notInvocable.length === 1 ? "is" : "are"} declared but not ` +
        `invocable; the loaded definition has no codecs for ` +
        `${notInvocable.length === 1 ? "it" : "them"}.`,
    );
  }

  methods.sort(byName);
  return {
    name: fqService,
    package: packageOf(fqService),
    methods,
    views:
      described && runtime.size > 0
        ? "both"
        : described
          ? "descriptor_only"
          : "runtime_only",
  };
}

export interface MethodDetail extends DiscoveredMethod {
  service: string;
  /** Editable request body plus the structural choices the schema leaves open. */
  request?: MessageTemplate;
  /** Shape of the response, for display. */
  response?: MessageTemplate;
  notes: string[];
}

export interface DescribeOptions {
  includeResponse?: boolean;
  maxDepth?: number;
  seedCollections?: boolean;
  fillExplicitOptional?: boolean;
  fillMessageFields?: boolean;
}

/**
 * Discovery plus a generated request template, i.e. everything needed to render
 * a request editor for one method.
 *
 * Each call rebuilds the catalog, which under reflection means a full handshake
 * per method. Callers that describe many methods should build the catalog once
 * and use `describeFromCatalog`. No cache lives here on purpose: adding one
 * later is a minor change, while shipping the wrong invalidation rule is a
 * breaking one.
 */
export async function describeMethod(
  endpoint: GrpcEndpoint,
  service: string,
  method: string,
  options: DescribeOptions = {},
): Promise<MethodDetail> {
  const { catalog, packageDefinition } = await buildCatalog(endpoint);
  return describeFromCatalog(
    catalog,
    packageDefinition,
    service,
    method,
    options,
  );
}

/**
 * Builds a method-not-found message that names the view each candidate came
 * from.
 *
 * The previous implementation listed runtime keys after failing a descriptor
 * lookup, which produced messages of the form
 * `method "Say" not found. Available: ..., Say, ...` — the report contradicted
 * itself and pointed the user at their own spelling instead of at the broken
 * descriptor path.
 */
function methodNotFound(
  service: string,
  method: string,
  source: string,
  described: MethodDescriptor[] | undefined,
  runtime: Map<string, RuntimeMethodView>,
): Error {
  const describedNames = (described ?? []).map((m) => m.name).sort();
  const runtimeNames = [...runtime.keys()].sort();

  if (described === undefined) {
    return new Error(
      `cannot describe "${service}/${method}": no readable descriptor for ` +
        `${service} (source: ${source}), so no method metadata is available. ` +
        `The method may still be callable — the runtime view lists ` +
        `${runtimeNames.join(", ") || "(none)"}.`,
    );
  }

  const onlyRuntime = runtimeNames.filter((n) => !describedNames.includes(n));
  const inRuntime = runtime.has(method);

  if (inRuntime) {
    return new Error(
      `method "${method}" is callable on ${service} but missing from its ` +
        `descriptor (source: ${source}), so no request template can be built. ` +
        `Described: ${describedNames.join(", ") || "(none)"}.` +
        (onlyRuntime.length
          ? ` Also undescribed: ${onlyRuntime.filter((n) => n !== method).join(", ") || "(none)"}.`
          : ""),
    );
  }

  return new Error(
    `method "${method}" not found on ${service} (source: ${source}). ` +
      `Described: ${describedNames.join(", ") || "(none)"}` +
      (onlyRuntime.length
        ? `; callable but undescribed: ${onlyRuntime.join(", ")}`
        : "") +
      `.`,
  );
}

export function describeFromCatalog(
  catalog: Catalog,
  packageDefinition: Record<string, unknown>,
  service: string,
  method: string,
  options: DescribeOptions = {},
): MethodDetail {
  const known =
    catalog.serviceDescriptors.has(service) ||
    catalog.invocableServices.includes(service);
  if (!known) {
    const all = [
      ...new Set([...catalog.services, ...catalog.invocableServices]),
    ].sort();
    throw new Error(
      `service "${service}" not found (source: ${catalog.source}). ` +
        `Available: ${all.join(", ") || "(none)"}`,
    );
  }

  const notes = [...catalog.notes];
  const described = readDescriptorMethods(catalog, service, notes);
  const runtime = readRuntimeMethods(packageDefinition, service);

  let found = described?.find((m) => m.name === method);
  if (!found && described) {
    const ci = described.filter(
      (m) => m.name.toLowerCase() === method.toLowerCase(),
    );
    if (ci.length === 1) {
      notes.push(
        `method matched case-insensitively: requested "${method}", ` +
          `using "${ci[0].name}".`,
      );
      found = ci[0];
    } else if (ci.length > 1) {
      throw new Error(
        `method "${method}" is ambiguous on ${service}: ` +
          `${ci
            .map((m) => m.name)
            .sort()
            .join(", ")}. ` +
          `Use the exact declared name.`,
      );
    }
  }

  if (!found) {
    throw methodNotFound(service, method, catalog.source, described, runtime);
  }

  const rt = runtime.get(found.name);
  const base: DiscoveredMethod = {
    name: found.name,
    path: rt?.path ?? `/${service}/${found.name}`,
    kind: kindOf(found.clientStreaming, found.serverStreaming),
    inputType: stripDot(found.inputType),
    outputType: stripDot(found.outputType),
    requestStream: found.clientStreaming,
    responseStream: found.serverStreaming,
    invocable: rt?.hasCodecs === true,
  };

  if (!base.invocable) {
    notes.push(
      `${service}/${found.name} can be described but not called: the loaded ` +
        `definition has no codecs for it.`,
    );
  }

  const templateOptions = {
    maxDepth: options.maxDepth,
    seedCollections: options.seedCollections,
    fillExplicitOptional: options.fillExplicitOptional,
    fillMessageFields: options.fillMessageFields,
  };

  // readMethods guarantees non-empty type names, so these are unconditional.
  let request: MessageTemplate | undefined;
  if (base.inputType === undefined) {
    notes.push(
      `the request type of ${service}/${base.name} is unknown, so no template ` +
        `can be built.`,
    );
  } else {
    try {
      request = buildMessageTemplate(catalog, base.inputType, templateOptions);
    } catch (e) {
      if (e instanceof DescriptorShapeError) {
        notes.push(`request template unavailable: ${e.message}`);
      } else throw e;
    }
  }

  let response: MessageTemplate | undefined;
  if (options.includeResponse) {
    if (base.outputType === undefined) {
      notes.push(
        `the response type of ${service}/${base.name} is unknown, so its shape ` +
          `is unavailable.`,
      );
    } else {
      try {
        response = buildMessageTemplate(
          catalog,
          base.outputType,
          templateOptions,
        );
      } catch (e) {
        if (e instanceof DescriptorShapeError) {
          notes.push(`response shape unavailable: ${e.message}`);
        } else throw e;
      }
    }
  }

  return { ...base, service, request, response, notes };
}

/**
 * Enumerates services from an already-built catalog.
 *
 * Split out so a caller holding a catalog — the adapter's cache, or a UI that
 * already listed services — never rebuilds it just to re-enumerate. Under
 * reflection a rebuild also means observing a server that may have been
 * redeployed in between, so the two results could legitimately disagree.
 */
export function discoverFromCatalog(
  endpoint: GrpcEndpoint,
  catalog: Catalog,
  packageDefinition: Record<string, unknown>,
): DiscoveryResult {
  const notes = [...catalog.notes];

  const allServices = [
    ...new Set([...catalog.services, ...catalog.invocableServices]),
  ].sort();

  const services = allServices.map((fqService) =>
    mergeService(
      fqService,
      readDescriptorMethods(catalog, fqService, notes),
      readRuntimeMethods(packageDefinition, fqService),
      notes,
    ),
  );

  return {
    address: endpoint.address,
    source: catalog.source,
    services,
    files: catalog.files,
    notes,
  };
}

/** Builds a catalog for the endpoint, then enumerates it. */
export async function discover(
  endpoint: GrpcEndpoint,
): Promise<DiscoveryResult> {
  const { catalog, packageDefinition } = await buildCatalog(endpoint);
  return discoverFromCatalog(endpoint, catalog, packageDefinition);
}
