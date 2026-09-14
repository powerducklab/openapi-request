import { err } from "../core/errors";
import { deepClone } from "../core/utils";

/**
 * Symbol marker for a collapsed reference cycle. A symbol cannot leak into
 * JSON output the way a string key can.
 */
const CYCLE_MARKER = Symbol("protokit.cycle");

/** Keys that must never be traversed or assigned. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Hard ceilings that keep a hostile or pathological document from exploding. */
const MAX_DEPTH = 32;
const MAX_REF_HOPS = 100;
const MAX_NODES = 200_000;

export interface ResolverOptions {
  /** Maximum expansion depth. Defaults to 32. */
  maxDepth?: number;
  /** Maximum nodes produced by a single deepDeref call. Defaults to 200000. */
  maxNodes?: number;
}

export interface Resolver {
  /** Resolve only the top-level $ref chain, keeping sibling keys. */
  deref<T = any>(node: any): T;
  /** Fully expand a subtree, collapsing cycles into a generic object schema. */
  deepDeref(node: any): any;
  /** Resolve a local JSON pointer against the document root. */
  byPointer(pointer: string): any;
}

/**
 * Resolver for local JSON pointers. External references are rejected explicitly
 * rather than silently producing an empty schema.
 *
 * Results handed back by `deepDeref` are always freshly owned by the caller, so
 * mutating them can never corrupt the resolver cache or the source document.
 */
export function createResolver(
  root: any,
  options: ResolverOptions = {},
): Resolver {
  const maxDepth = clampPositive(options.maxDepth, MAX_DEPTH);
  const maxNodes = clampPositive(options.maxNodes, MAX_NODES);

  /** Canonical expansion per $ref. Never handed out directly. */
  const deepCache = new Map<string, any>();

  function unescapeSegment(raw: string, pointer: string): string {
    let decoded = raw;
    try {
      // Pointers embedded in URIs may be percent-encoded.
      decoded = decodeURIComponent(raw);
    } catch {
      // A malformed escape is not fatal: fall back to the literal segment.
      decoded = raw;
    }
    // RFC 6901: ~1 must be unescaped before ~0.
    const key = decoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (UNSAFE_KEYS.has(key)) {
      throw err(
        "BAD_REF",
        `Pointer "${pointer}" traverses a forbidden key "${key}"`,
      );
    }
    return key;
  }

  function byPointer(pointer: string): any {
    if (typeof pointer !== "string" || !pointer.length) {
      throw err("EXTERNAL_REF", "A $ref pointer must be a non-empty string");
    }
    // Whole-document reference.
    if (pointer === "#" || pointer === "#/") return root;
    if (!pointer.startsWith("#/")) {
      throw err(
        "EXTERNAL_REF",
        `Only local $ref pointers are supported, got: ${pointer}`,
      );
    }

    let current = root;
    for (const raw of pointer.slice(2).split("/")) {
      if (current === null || typeof current !== "object") {
        throw err("BAD_REF", `Cannot resolve pointer "${pointer}"`);
      }
      const key = unescapeSegment(raw, pointer);
      // Only own properties count; never walk up a prototype chain.
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        throw err("BAD_REF", `Pointer "${pointer}" resolves to undefined`);
      }
      current = (current as any)[key];
    }
    if (current === undefined) {
      throw err("BAD_REF", `Pointer "${pointer}" resolves to undefined`);
    }
    return current;
  }

  /**
   * Resolve the top-level $ref chain.
   * Sibling keys alongside a $ref (allowed since OpenAPI 3.1, e.g. a local
   * `description`) are layered on top of the resolved target.
   */
  function deref<T = any>(node: any): T {
    let current = node;
    const visited = new Set<string>();
    /** Sibling overrides collected along the chain, nearest wins. */
    let overrides: Record<string, any> | undefined;
    let hops = 0;

    while (
      current !== null &&
      typeof current === "object" &&
      typeof (current as any).$ref === "string"
    ) {
      const ref = (current as any).$ref;
      if (visited.has(ref) || ++hops > MAX_REF_HOPS) {
        return cycleStub() as any;
      }
      visited.add(ref);

      const siblings = collectSiblings(current);
      if (siblings) overrides = { ...siblings, ...(overrides ?? {}) };

      current = byPointer(ref);
    }

    if (!overrides) return current as T;
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      // Siblings cannot be layered onto a non-object target; the target wins.
      return current as T;
    }
    return { ...(current as Record<string, any>), ...overrides } as T;
  }

  function collectSiblings(node: any): Record<string, any> | undefined {
    let out: Record<string, any> | undefined;
    for (const key of Object.keys(node)) {
      if (key === "$ref" || UNSAFE_KEYS.has(key)) continue;
      (out ??= {})[key] = node[key];
    }
    return out;
  }

  function cycleStub(): Record<string | symbol, any> {
    return { type: "object", [CYCLE_MARKER]: true };
  }

  /** Recursive expansion. `stack` is mutated in place to stay O(depth). */
  function expand(
    node: any,
    depth: number,
    stack: Set<any>,
    budget: { nodes: number },
  ): any {
    if (node === null || typeof node !== "object") return node;
    if (depth > maxDepth) return { type: "object" };
    if (++budget.nodes > maxNodes) return { type: "object" };

    let resolved: any;
    try {
      resolved = deref(node);
    } catch (e) {
      // A single broken reference degrades to a permissive schema instead of
      // aborting the expansion of the whole document.
      if ((e as any)?.code === "EXTERNAL_REF") throw e;
      return { type: "object" };
    }

    if (resolved === null || typeof resolved !== "object") return resolved;
    if ((resolved as any)[CYCLE_MARKER]) return { type: "object" };
    if (stack.has(resolved)) return { type: "object" };

    stack.add(resolved);
    try {
      if (Array.isArray(resolved)) {
        const out: any[] = new Array(resolved.length);
        for (let i = 0; i < resolved.length; i += 1) {
          out[i] = expand(resolved[i], depth + 1, stack, budget);
        }
        return out;
      }

      const out: Record<string, any> = {};
      for (const key of Object.keys(resolved)) {
        if (UNSAFE_KEYS.has(key)) continue;
        out[key] = expand(resolved[key], depth + 1, stack, budget);
      }
      return out;
    } finally {
      stack.delete(resolved);
    }
  }

  function deepDerefUncached(node: any): any {
    return expand(node, 0, new Set<any>(), { nodes: 0 });
  }

  /**
   * Cached deep dereference, keyed by the originating $ref.
   * The cache holds a canonical copy and every caller receives its own clone,
   * so downstream mutation cannot poison later lookups.
   */
  function deepDerefCached(node: any): any {
    const ref =
      node !== null && typeof node === "object"
        ? (node as any).$ref
        : undefined;

    // Only cache a bare `{ $ref }`; sibling keys make the result ref-specific.
    const cacheable =
      typeof ref === "string" && Object.keys(node as object).length === 1;

    if (cacheable && deepCache.has(ref)) {
      return deepClone(deepCache.get(ref));
    }

    const value = deepDerefUncached(node);
    if (cacheable) {
      deepCache.set(ref, value);
      return deepClone(value);
    }
    return value;
  }

  return { deref, deepDeref: deepDerefCached, byPointer };
}

function clampPositive(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
