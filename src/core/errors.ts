/**
 * Unified error type for the whole toolkit.
 * `code` is a stable machine-readable identifier; `message` is human-facing.
 */

/**
 * Brand used to identify our errors across module realms. Relying on
 * `instanceof` alone is unsafe: a consumer may end up loading both the ESM and
 * the CJS build, which creates two distinct classes.
 */
const PROTOKIT_ERROR_BRAND = Symbol.for("@powerduck/openapi-request.ProtoKitError");

export class ProtoKitError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  /** Brand marker; see PROTOKIT_ERROR_BRAND. */
  public readonly [PROTOKIT_ERROR_BRAND] = true as const;

  constructor(
    message: string,
    code: string,
    details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ProtoKitError";
    this.code = typeof code === "string" && code ? code : "UNKNOWN";
    this.details = details;

    // `cause` is only standard from ES2022 onward; assign defensively so the
    // property exists on older targets without breaking the constructor.
    if (options && "cause" in options) {
      try {
        Object.defineProperty(this, "cause", {
          value: options.cause,
          configurable: true,
          writable: true,
          enumerable: false,
        });
      } catch {
        /* ignore */
      }
    }

    // Restore the prototype chain when compiled down to ES5.
    Object.setPrototypeOf(this, ProtoKitError.prototype);
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, ProtoKitError);
    }
  }

  /**
   * Realm-safe replacement for `instanceof ProtoKitError`.
   * Use this everywhere instead of a bare instanceof check.
   */
  static isProtoKitError(value: unknown): value is ProtoKitError {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as any)[PROTOKIT_ERROR_BRAND] === true
    );
  }

  /** Plain, serializable projection. Safe to log or send over a wire. */
  toJSON(): { name: string; code: string; message: string; details?: unknown } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function err(
  code: string,
  message: string,
  details?: unknown,
  options?: { cause?: unknown },
): ProtoKitError {
  return new ProtoKitError(message, code, details, options);
}

/** Best-effort single-line description of an arbitrary value. */
function describeUnknown(value: unknown): string {
  const type = typeof value;
  if (value === null) return "null";
  if (type === "undefined") return "undefined";
  if (type === "function") {
    const name = (value as Function).name;
    return name ? `[Function: ${name}]` : "[Function (anonymous)]";
  }
  if (type === "symbol") return String(value);
  if (type === "bigint") return `${String(value)}n`;
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for values it cannot represent.
    if (typeof json === "string") return json;
  } catch {
    /* fall through */
  }
  try {
    return String(value);
  } catch {
    return "[unserializable value]";
  }
}

/**
 * Normalize any thrown value into a plain, serializable shape.
 * `message` is always a non-empty string.
 */
export function toErrorInfo(e: unknown): {
  message: string;
  code?: string;
  name?: string;
} {
  if (ProtoKitError.isProtoKitError(e)) {
    return {
      message: e.message || "Unknown ProtoKitError",
      code: e.code,
      name: e.name,
    };
  }

  if (e instanceof Error) {
    const raw = (e as any).code;
    const code =
      typeof raw === "string" || typeof raw === "number"
        ? String(raw)
        : undefined;
    return {
      message: e.message || e.name || "Unknown error",
      ...(code ? { code } : {}),
      name: e.name || "Error",
    };
  }

  // Duck-typed error-like objects (common with cross-realm or serialized errors).
  if (
    typeof e === "object" &&
    e !== null &&
    typeof (e as any).message === "string"
  ) {
    const anyErr = e as any;
    const code =
      typeof anyErr.code === "string" || typeof anyErr.code === "number"
        ? String(anyErr.code)
        : undefined;
    return {
      message: anyErr.message || "Unknown error",
      ...(code ? { code } : {}),
      ...(typeof anyErr.name === "string" ? { name: anyErr.name } : {}),
    };
  }

  if (typeof e === "string") return { message: e || "Unknown error" };

  return { message: describeUnknown(e) };
}
