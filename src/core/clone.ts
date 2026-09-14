/**
 * Cloneable: a JSON-safe projection of arbitrary runtime values.
 *
 * Events and session payloads cross process / renderer boundaries (Electron
 * preload, worker threads), so they must be deep-copied into a shape that
 * serializes cleanly. `toCloneable` handles the awkward cases — Date, URL,
 * Error (with cause), Buffer, Uint8Array, functions, symbols and cycles — so
 * the UI never receives live references into the library's internal state.
 */

export type Cloneable =
  | null
  | boolean
  | number
  | string
  | Cloneable[]
  | { [key: string]: Cloneable };

export interface CloneableError {
  name: string;
  message: string;
  stack?: string;
  cause?: Cloneable;
}

export function toCloneable(
  value: unknown,
  seen = new WeakMap<object, Cloneable>(),
): Cloneable {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Error) {
    const clone: CloneableError = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) clone.cause = toCloneable(cause, seen);
    return clone as unknown as Cloneable;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      data: Array.from(value.values()),
    };
  }

  if (value instanceof Uint8Array) {
    return {
      type: value.constructor.name,
      data: Array.from(value.values()),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => toCloneable(item, seen));
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) return seen.get(objectValue)!;
    const out: Record<string, Cloneable> = {};
    seen.set(objectValue, out);
    for (const [key, item] of Object.entries(objectValue)) {
      out[key] = toCloneable(item, seen);
    }
    return out;
  }

  return String(value);
}
