import type { Json } from "../core/types";
import { mergeSchema } from "./merge";

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URI = /^https?:\/\/\S+$/i;

/** Keys that must never be written onto an inferred `properties` map. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface InferOptions {
  /** Maximum nesting depth to inspect. Defaults to 12. */
  maxDepth?: number;
  /** Number of array elements sampled when unifying item schemas. Defaults to 20. */
  sampleArrayItems?: number;
  /** Maximum characters retained in string examples. Defaults to 120. */
  maxExampleLength?: number;
  /** Emit example values alongside the inferred schema. Defaults to true. */
  includeExamples?: boolean;
  /** Maximum properties inspected per object. Defaults to 250. */
  maxProperties?: number;
}

/**
 * Derive a JSON Schema from an observed runtime value.
 *
 * `null` yields `{ type: "null" }` because it is a real observation, while
 * `undefined` yields `{}` since the absence of a value proves nothing.
 */
export function inferSchema(
  value: Json | undefined,
  options: InferOptions = {},
  depth = 0,
): any {
  const maxDepth = options.maxDepth ?? 12;
  const withExamples = options.includeExamples !== false;

  if (depth > maxDepth) return {};
  if (value === undefined) return {};
  if (value === null) return { type: "null" };

  const kind = typeof value;

  if (kind === "boolean") {
    return withExamples
      ? { type: "boolean", examples: [value] }
      : { type: "boolean" };
  }

  if (kind === "number") {
    const numeric = value as number;
    // NaN and Infinity are not representable in JSON.
    if (!Number.isFinite(numeric)) return { type: "number" };
    const type = Number.isInteger(numeric) ? "integer" : "number";
    return withExamples ? { type, examples: [numeric] } : { type };
  }

  if (kind === "bigint") {
    // A bigint cannot survive JSON encoding; describe it as a numeric string.
    return { type: "string", format: "int64" };
  }

  if (kind === "string") {
    const text = value as string;
    const schema: Record<string, any> = { type: "string" };
    const format = detectStringFormat(text);
    if (format) schema.format = format;
    if (withExamples) {
      const limit = Math.max(1, options.maxExampleLength ?? 120);
      schema.examples = [
        text.length > limit ? `${text.slice(0, limit)}...` : text,
      ];
    }
    return schema;
  }

  if (Array.isArray(value)) {
    if (!value.length) return { type: "array", items: {} };
    const cap = Math.max(1, options.sampleArrayItems ?? 20);
    const sampleCount = Math.min(value.length, cap);
    let items = inferSchema(value[0] as Json, options, depth + 1);
    for (let i = 1; i < sampleCount; i += 1) {
      items = mergeSchema(
        items,
        inferSchema(value[i] as Json, options, depth + 1),
        0,
      );
    }
    return { type: "array", items };
  }

  if (kind === "object") {
    // A non-plain object (Date, Buffer, class instance) is not decoded JSON;
    // describing its own enumerable keys would be misleading.
    if (!isRecordLike(value)) return {};

    const properties: Record<string, any> = Object.create(null);
    const required: string[] = [];
    const limit = Math.max(1, options.maxProperties ?? 250);
    let count = 0;

    for (const [key, entry] of Object.entries(value as Record<string, Json>)) {
      // Guard against a payload carrying "__proto__" as a literal own key.
      if (UNSAFE_KEYS.has(key)) continue;
      if (++count > limit) break;
      properties[key] = inferSchema(entry, options, depth + 1);
      // A null observation does not prove the field is absent, but it is
      // weak evidence, so only non-null fields are treated as required.
      if (entry !== null && entry !== undefined) required.push(key);
    }

    const schema: Record<string, any> = {
      type: "object",
      // Re-materialize with a normal prototype so consumers can spread it.
      properties: { ...properties },
    };
    if (required.length) schema.required = required;
    return schema;
  }

  // Functions and symbols cannot appear in decoded JSON.
  return {};
}

function detectStringFormat(text: string): string | undefined {
  if (!text) return undefined;
  if (ISO_DATE_TIME.test(text)) return "date-time";
  if (ISO_DATE.test(text)) return "date";
  if (UUID.test(text)) return "uuid";
  if (URI.test(text)) return "uri";
  if (EMAIL.test(text)) return "email";
  // Checked last: a bare "12:30:00" is ambiguous enough to be low priority.
  if (ISO_TIME.test(text)) return "time";
  return undefined;
}

/** True for plain objects and null-prototype records, false for class instances. */
function isRecordLike(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Fold a list of observed values into a single unified schema. */
export function inferSchemaFromMany(
  values: Array<Json | undefined>,
  options: InferOptions = {},
): any {
  if (!Array.isArray(values) || !values.length) return {};
  let schema: any = null;
  for (const value of values) {
    const next = inferSchema(value, options);
    schema = schema === null ? next : mergeSchema(schema, next, 0);
  }
  return schema ?? {};
}
