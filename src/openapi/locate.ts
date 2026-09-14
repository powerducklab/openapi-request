import { err } from "../core/errors";
import { createResolver } from "./deref";
import type { OperationTarget } from "../core/types";

/** Methods defined as fixed fields on a Path Item Object. */
const FIXED_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  // OpenAPI 3.2 promotes QUERY to a fixed field.
  "query",
] as const;

export interface LocatedOperation {
  path: string;
  /** Lower-cased method name; custom verbs come from `additionalOperations`. */
  method: string;
  /** True when the method came from `additionalOperations`. */
  isCustomMethod: boolean;
  /** The key used inside `additionalOperations`, preserving its original case. */
  customMethodKey?: string;
  /** Fully dereferenced Operation Object. */
  operation: any;
  pathItem: any;
  /** Path-level and operation-level parameters merged, operation wins. */
  parameters: any[];
  /** Effective servers, honoring operation > pathItem > document precedence. */
  servers: any[];
  security?: any[];
}

interface Candidate {
  path: string;
  method: string;
  rawOperation: any;
  pathItem: any;
  isCustomMethod: boolean;
  customMethodKey?: string;
}

export function locateOperation(
  spec: any,
  target: OperationTarget,
): LocatedOperation {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw err("BAD_SPEC", "spec must be an object");
  if (typeof spec.openapi !== "string" || !spec.openapi.trim())
    throw err("BAD_SPEC", "spec.openapi version string is required");
  if (!target || typeof target !== "object")
    throw err("BAD_TARGET", "target is required");

  const resolver = createResolver(spec);
  const paths = spec.paths;
  if (!paths || typeof paths !== "object" || Array.isArray(paths))
    throw err("BAD_SPEC", "spec.paths is missing or invalid");

  const candidates = collectCandidates(paths, resolver);
  if (!candidates.length)
    throw err("EMPTY_SPEC", "The document does not declare any operation");

  const hit = target.operationId
    ? findByOperationId(candidates, resolver, target.operationId)
    : findByPathAndMethod(candidates, target);

  // Fully expand the operation. `deepDeref` hands back a caller-owned copy, so
  // downstream mutation cannot leak back into the source document.
  const operation = resolver.deepDeref(hit.rawOperation) ?? {};
  const pathItem = hit.pathItem ?? {};

  return {
    path: hit.path,
    method: hit.method,
    isCustomMethod: hit.isCustomMethod,
    ...(hit.customMethodKey ? { customMethodKey: hit.customMethodKey } : {}),
    operation,
    pathItem,
    parameters: mergeParameters(resolver, pathItem, operation),
    servers: resolveServers(spec, pathItem, operation),
    security: Array.isArray(operation.security)
      ? operation.security
      : Array.isArray(spec.security)
        ? spec.security
        : undefined,
  };
}

function collectCandidates(
  paths: any,
  resolver: ReturnType<typeof createResolver>,
) {
  const candidates: Candidate[] = [];

  for (const [pathKey, rawPathItem] of Object.entries<any>(paths)) {
    // Vendor extensions live alongside paths and are not operations.
    if (pathKey.startsWith("x-")) continue;

    let pathItem: any;
    try {
      pathItem = resolver.deref(rawPathItem);
    } catch {
      continue; // A broken path item should not abort the whole lookup.
    }
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem))
      continue;

    for (const method of FIXED_METHODS) {
      const operation = pathItem[method];
      if (
        operation &&
        typeof operation === "object" &&
        !Array.isArray(operation)
      ) {
        candidates.push({
          path: pathKey,
          method,
          rawOperation: operation,
          pathItem,
          isCustomMethod: false,
        });
      }
    }

    // OpenAPI 3.2 introduces additionalOperations for verbs such as LOCK or MKCOL.
    const additional = pathItem.additionalOperations;
    if (
      additional &&
      typeof additional === "object" &&
      !Array.isArray(additional)
    ) {
      for (const [methodKey, operation] of Object.entries<any>(additional)) {
        if (
          !operation ||
          typeof operation !== "object" ||
          Array.isArray(operation)
        )
          continue;
        candidates.push({
          path: pathKey,
          method: methodKey.toLowerCase(),
          rawOperation: operation,
          pathItem,
          isCustomMethod: true,
          customMethodKey: methodKey,
        });
      }
    }
  }

  return candidates;
}

function findByOperationId(
  candidates: Candidate[],
  resolver: ReturnType<typeof createResolver>,
  operationId: string,
): Candidate {
  const matches = candidates.filter((c) => {
    try {
      return resolver.deref(c.rawOperation)?.operationId === operationId;
    } catch {
      return false;
    }
  });

  if (!matches.length) {
    throw err("OP_NOT_FOUND", `operationId "${operationId}" was not found`, {
      available: uniqueOperationIds(candidates, resolver),
    });
  }
  if (matches.length > 1) {
    // operationId must be unique per the specification. Report it rather than
    // silently picking one, since the choice would be arbitrary.
    throw err(
      "AMBIGUOUS_OPERATION_ID",
      `operationId "${operationId}" is declared ${matches.length} times`,
      {
        matches: matches.map((m) => `${m.method.toUpperCase()} ${m.path}`),
      },
    );
  }
  return matches[0];
}

function uniqueOperationIds(
  candidates: Candidate[],
  resolver: ReturnType<typeof createResolver>,
): string[] {
  const out = new Set<string>();
  for (const c of candidates) {
    try {
      const id = resolver.deref(c.rawOperation)?.operationId;
      if (typeof id === "string" && id) out.add(id);
    } catch {
      /* ignore */
    }
  }
  return Array.from(out).slice(0, 50);
}

function findByPathAndMethod(
  candidates: Candidate[],
  target: OperationTarget,
): Candidate {
  if (!target.path || !target.method) {
    throw err(
      "BAD_TARGET",
      "Provide either operationId, or both path and method",
    );
  }
  const method = String(target.method).toLowerCase();
  const wanted = String(target.path);

  // Exact match first, then tolerate a missing or extra leading slash.
  const variants = [
    wanted,
    wanted.startsWith("/") ? wanted.slice(1) : `/${wanted}`,
  ];

  for (const candidatePath of variants) {
    const hit = candidates.find(
      (c) => c.path === candidatePath && c.method === method,
    );
    if (hit) return hit;
  }

  throw err(
    "OP_NOT_FOUND",
    `Operation "${String(target.method).toUpperCase()} ${wanted}" was not found`,
    {
      available: candidates
        .map((c) => `${c.method.toUpperCase()} ${c.path}`)
        .slice(0, 50),
    },
  );
}

/**
 * Operation-level parameters override path-level ones with the same in+name key.
 * The operation is read from its dereferenced form, so a `$ref`d operation does
 * not silently lose its parameters.
 */
function mergeParameters(
  resolver: ReturnType<typeof createResolver>,
  pathItem: any,
  operation: any,
): any[] {
  const merged = new Map<string, any>();

  const collect = (list: any) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      let resolved: any;
      try {
        resolved = resolver.deepDeref(entry);
      } catch {
        continue; // A broken parameter ref is skipped, not fatal.
      }
      if (
        resolved &&
        typeof resolved === "object" &&
        typeof resolved.name === "string" &&
        resolved.name.length > 0 &&
        typeof resolved.in === "string"
      ) {
        // The in+name pair is the identity of a parameter per the spec.
        merged.set(`${resolved.in.toLowerCase()}:${resolved.name}`, resolved);
      }
    }
  };

  collect(pathItem?.parameters);
  // Read from the resolved operation so a $ref'd operation keeps its parameters.
  collect(operation?.parameters);

  return Array.from(merged.values());
}

/** Effective servers: operation > pathItem > document, falling back to '/'. */
function resolveServers(spec: any, pathItem: any, operation: any): any[] {
  const pick = (list: unknown): any[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const usable = list.filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as any).url === "string" &&
        (entry as any).url.length > 0,
    );
    return usable.length ? usable : undefined;
  };

  return (
    pick(operation?.servers) ??
    pick(pathItem?.servers) ??
    pick(spec?.servers) ?? [{ url: "/" }]
  );
}
