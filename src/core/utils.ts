/** Keys that must never be assigned through a merge or clone. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/** Deep clone with a safe fallback for environments without structuredClone. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Falls through to the JSON path (e.g. when the value holds functions).
    }
  }
  return jsonClone(value);
}

/**
 * JSON-shaped clone.
 *
 * Unlike a JSON.parse(JSON.stringify(...)) round trip this:
 *  - only collapses true cycles (an ancestor back-reference) to null, so a
 *    value referenced twice in sibling positions is cloned twice instead of
 *    being silently dropped;
 *  - never throws on a circular graph or on `undefined` input;
 *  - drops prototype-polluting keys.
 */
export function jsonClone<T>(value: T): T {
  return cloneJsonLike(value, new Set<object>()) as T;
}

function cloneJsonLike(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    // NaN and +/-Infinity are not representable in JSON.
    return Number.isFinite(value as number) ? value : null;
  }
  if (type === "bigint") return (value as bigint).toString();
  // undefined, function and symbol have no JSON representation.
  if (type !== "object") return undefined;

  const obj = value as object;

  // A back-reference to an ancestor is a real cycle.
  if (ancestors.has(obj)) return null;

  // Honor toJSON (Date, Postman SDK objects, etc.) before walking properties.
  const toJSON = (obj as any).toJSON;
  if (typeof toJSON === "function") {
    let projected: unknown;
    try {
      projected = toJSON.call(obj);
    } catch {
      return null;
    }
    // Guard against a toJSON that returns the receiver itself.
    if (projected === obj) return null;
    return cloneJsonLike(projected, ancestors);
  }

  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const arr: unknown[] = new Array(obj.length);
      for (let i = 0; i < obj.length; i += 1) {
        const cloned = cloneJsonLike(obj[i], ancestors);
        // Holes and non-representable entries become null, matching JSON.
        arr[i] = cloned === undefined ? null : cloned;
      }
      return arr;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (isUnsafeKey(key)) continue;
      let raw: unknown;
      try {
        raw = (obj as any)[key];
      } catch {
        continue; // A throwing getter is skipped rather than fatal.
      }
      const cloned = cloneJsonLike(raw, ancestors);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Replace `{{name}}` placeholders using the provided variable map.
 * Unknown placeholders are left untouched so downstream consumers (Postman)
 * can still resolve them.
 */
export function interpolate(
  input: unknown,
  vars?: Record<string, unknown> | null,
): string {
  const source = toStringSafe(input);
  if (!source || source.indexOf("{{") === -1) return source;
  if (!vars) return source;

  return source.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const replacement = vars[key];
    if (replacement === undefined || replacement === null) return match;
    return toStringSafe(replacement);
  });
}

/** String coercion that never throws and never yields "[object Object]" silently. */
function toStringSafe(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : "";
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

/** Guards runaway recursion on adversarial or self-referential option objects. */
const MAX_MERGE_DEPTH = 64;

/**
 * Recursively merge `override` into `base`.
 * Arrays and class instances are replaced wholesale rather than merged, because
 * runtime options such as VariableScope or `certificates` must not be
 * structurally mixed. Prototype-polluting keys are ignored.
 */
export function deepMerge<T extends Record<string, any>>(
  base: T,
  override?: Partial<T> | null,
): T {
  return mergeInto(base, override, 0) as T;
}

function mergeInto(
  base: Record<string, any>,
  override: Record<string, any> | null | undefined,
  depth: number,
): Record<string, any> {
  if (!override || !isPlainObject(override)) return base;
  if (depth >= MAX_MERGE_DEPTH) return override;

  const out: Record<string, any> = { ...base };
  for (const key of Object.keys(override)) {
    if (isUnsafeKey(key)) continue;
    const value = override[key];
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeInto(prev, value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Guarantee a promise settles at most once, regardless of how many callbacks fire. */
export function createLatch<T>() {
  let settled = false;
  let resolveFn!: (v: T) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // Prevents an unhandled rejection warning if nobody awaits a rejected latch.
  promise.catch(() => {});
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T) {
      if (settled) return false;
      settled = true;
      resolveFn(value);
      return true;
    },
    reject(reason: unknown) {
      if (settled) return false;
      settled = true;
      rejectFn(reason);
      return true;
    },
  };
}

/** Safe timer helper that never throws on clear. */
export function safeClearTimeout(
  timer: ReturnType<typeof setTimeout> | null | undefined,
): null {
  if (timer) {
    try {
      clearTimeout(timer);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Safe interval helper, mirroring safeClearTimeout. */
export function safeClearInterval(
  timer: ReturnType<typeof setInterval> | null | undefined,
): null {
  if (timer) {
    try {
      clearInterval(timer);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Invoke a user callback without letting it break the caller's control flow. */
export function safeCall<A extends unknown[]>(
  fn: ((...args: A) => unknown) | undefined,
  ...args: A
): void {
  if (typeof fn !== "function") return;
  try {
    fn(...args);
  } catch {
    /* User callbacks must never abort execution. */
  }
}

/**
 * Coerce a value into a positive integer, returning `fallback` for anything
 * unusable. Useful for validating caps such as maxEvents or maxStreamMs.
 */
export function positiveInt(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  if (int <= 0) return fallback;
  return Math.min(int, max);
}

/**
 * Best-effort JSON.parse. Returns `undefined` for anything that is not a
 * plausible JSON payload, so callers can treat the result as a maybe-value.
 */
export function tryParseJson(
  text: string | undefined | null,
  contentType?: string,
): unknown {
  if (!text) return undefined;
  if (contentType && !/json/i.test(contentType)) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^[[{"\-\d]|^(true|false|null)$/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * JSON.stringify that never throws. Returns undefined for values JSON cannot
 * represent; anything that still fails (circular reference, throwing toJSON)
 * becomes a short descriptive marker instead of an exception.
 */
export function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * One-line, non-throwing description of an arbitrary thrown value.
 * Prefer over String() which can throw on exotic objects.
 */
export function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Keys that look like credentials; used to mark env values as secrets. */
export const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|apikey|api_key|credential|private|authorization)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Resolve a timeout after `ms`, honoring an optional abort signal.
 * The timer is unref'd so a pending sleep never keeps the process alive.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted while waiting."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    (timer as any)?.unref?.();
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
