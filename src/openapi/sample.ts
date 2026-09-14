/**
 * Produce a representative value for a JSON Schema so that required
 * parameters and request bodies are never left empty.
 *
 * Sampling is deterministic: the same schema always yields the same value, which
 * keeps generated requests reproducible across runs. Values respect declared
 * bounds (minimum, maxLength, minItems, ...) so a sample never violates the
 * schema it came from.
 */

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Fixed clock reference for date-like formats, chosen for reproducibility. */
const REFERENCE_INSTANT = "2024-01-01T00:00:00.000Z";

const MAX_DEPTH = 12;
/** Beyond this depth only required properties are emitted, to bound growth. */
const SHALLOW_DEPTH = 2;
/** Ceiling on generated array length, regardless of minItems. */
const MAX_ARRAY_ITEMS = 5;
/** Ceiling on padded string length, regardless of minLength. */
const MAX_STRING_LENGTH = 256;

export interface SampleOptions {
  /** Maximum recursion depth. Defaults to 12. */
  maxDepth?: number;
  /** Include readOnly properties. Defaults to false. */
  includeReadOnly?: boolean;
  /** Include writeOnly properties. Defaults to true. */
  includeWriteOnly?: boolean;
}

export function sampleFromSchema(
  schema: any,
  depth = 0,
  options: SampleOptions = {},
): any {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return null;
  if (depth > maxDepth) return null;

  // An unresolved $ref carries no shape information.
  if (typeof schema.$ref === "string") return null;

  /* ---- Author-provided values always win ---- */
  if (schema.example !== undefined) return schema.example;

  const fromExamples = pickExample(schema.examples);
  if (fromExamples !== undefined) return fromExamples;

  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    // Prefer a non-null branch so a required field gets a usable value.
    const nonNull = schema.enum.find((v: unknown) => v !== null);
    return nonNull !== undefined ? nonNull : schema.enum[0];
  }

  /* ---- Composition ---- */
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return sampleAllOf(schema, depth, options);
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length) {
      // Skip a bare `{ type: "null" }` branch when a real alternative exists.
      const branch =
        branches.find(
          (b: any) => b && typeof b === "object" && b.type !== "null",
        ) ?? branches[0];
      return sampleFromSchema(branch, depth + 1, options);
    }
  }

  /* ---- Effective type ---- */
  const effective = effectiveType(schema);

  switch (effective) {
    case "object":
      return sampleObject(schema, depth, options);
    case "array":
      return sampleArray(schema, depth, options);
    case "integer":
      return sampleInteger(schema);
    case "number":
      return sampleNumber(schema);
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return sampleString(schema);
  }
}

function pickExample(examples: unknown): unknown {
  if (examples === undefined || examples === null) return undefined;
  if (Array.isArray(examples)) {
    // JSON Schema style: a plain array of candidate values.
    return examples.length ? examples[0] : undefined;
  }
  if (typeof examples === "object") {
    // OpenAPI style: a map of named Example Objects.
    for (const entry of Object.values<any>(examples as Record<string, any>)) {
      if (entry === undefined) continue;
      if (entry && typeof entry === "object") {
        if ("value" in entry) return entry.value;
        // externalValue cannot be inlined; fall through to the next candidate.
        if ("externalValue" in entry) continue;
      }
      return entry;
    }
  }
  return undefined;
}

function effectiveType(schema: any): string {
  const declared = Array.isArray(schema.type)
    ? (schema.type.find(
        (t: unknown) => typeof t === "string" && t !== "null",
      ) ?? (schema.type.includes("null") ? "null" : undefined))
    : typeof schema.type === "string"
      ? schema.type
      : undefined;

  if (declared) return declared;

  // Infer from sibling keywords when `type` is absent.
  if (schema.properties || schema.additionalProperties || schema.required)
    return "object";
  if (schema.items || schema.prefixItems) return "array";
  if (
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.multipleOf !== undefined
  ) {
    return "number";
  }
  return "string";
}

function sampleAllOf(schema: any, depth: number, options: SampleOptions): any {
  let accumulated: Record<string, any> | undefined;
  let scalar: unknown;

  for (const sub of schema.allOf as any[]) {
    const value = sampleFromSchema(sub, depth + 1, options);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      accumulated = { ...(accumulated ?? {}), ...(value as object) };
    } else if (value !== null && value !== undefined) {
      // A scalar branch means the composed schema is not an object.
      scalar = value;
    }
  }

  // Properties declared directly alongside allOf also apply.
  if (schema.properties || schema.required) {
    const own = sampleObject(schema, depth, options);
    if (own && typeof own === "object") {
      accumulated = { ...(accumulated ?? {}), ...own };
    }
  }

  if (accumulated) return accumulated;
  return scalar !== undefined ? scalar : {};
}

function sampleObject(
  schema: any,
  depth: number,
  options: SampleOptions,
): Record<string, any> {
  const out: Record<string, any> = {};
  const required: string[] = Array.isArray(schema.required)
    ? schema.required.filter((k: unknown) => typeof k === "string")
    : [];
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};

  const includeReadOnly = options.includeReadOnly === true;
  const includeWriteOnly = options.includeWriteOnly !== false;

  for (const [key, sub] of Object.entries<any>(properties)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (!includeReadOnly && sub && sub.readOnly === true) continue;
    if (!includeWriteOnly && sub && sub.writeOnly === true) continue;
    // Beyond a shallow depth, keep only required fields to avoid explosion.
    if (depth > SHALLOW_DEPTH && required.length && !required.includes(key))
      continue;
    out[key] = sampleFromSchema(sub, depth + 1, options);
  }

  // A required field with no declared schema still needs to be present.
  for (const key of required) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (!(key in out)) {
      out[key] = sampleFromSchema(properties[key] ?? {}, depth + 1, options);
    }
  }

  if (
    !Object.keys(out).length &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    out.key = sampleFromSchema(schema.additionalProperties, depth + 1, options);
  }

  // Honor minProperties by padding with synthetic keys.
  const minProperties = toFiniteInt(schema.minProperties);
  if (minProperties !== undefined) {
    const filler =
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
        ? schema.additionalProperties
        : {};
    let index = 1;
    while (Object.keys(out).length < Math.min(minProperties, 20)) {
      const key = `additionalProp${index}`;
      index += 1;
      if (key in out) continue;
      out[key] = sampleFromSchema(filler, depth + 1, options);
    }
  }

  return out;
}

function sampleArray(
  schema: any,
  depth: number,
  options: SampleOptions,
): any[] {
  const out: any[] = [];

  // Tuple form: emit one value per declared position.
  if (Array.isArray(schema.prefixItems)) {
    for (const sub of schema.prefixItems) {
      out.push(sampleFromSchema(sub, depth + 1, options));
    }
  }

  const minItems = toFiniteInt(schema.minItems) ?? 1;
  const maxItems = toFiniteInt(schema.maxItems);
  let target = Math.max(minItems, out.length, 1);
  target = Math.min(target, MAX_ARRAY_ITEMS);
  if (maxItems !== undefined) target = Math.min(target, Math.max(maxItems, 0));

  // A tuple schema with no additional items should not be padded.
  const itemSchema =
    schema.items && typeof schema.items === "object" ? schema.items : undefined;
  if (!itemSchema && Array.isArray(schema.prefixItems)) {
    return out.slice(0, target === 0 ? 0 : Math.max(target, out.length));
  }

  while (out.length < target) {
    const value = sampleFromSchema(itemSchema ?? {}, depth + 1, options);
    if (schema.uniqueItems === true && out.length > 0) {
      // Repeating an identical element would violate uniqueItems, so stop.
      break;
    }
    out.push(value);
  }

  return maxItems !== undefined ? out.slice(0, Math.max(maxItems, 0)) : out;
}

function sampleInteger(schema: any): number {
  const { min, max } = numericRange(schema, true);
  let value = 0;
  if (min !== undefined && value < min) value = Math.ceil(min);
  if (max !== undefined && value > max) value = Math.floor(max);

  const multipleOf = toFiniteNumber(schema.multipleOf);
  if (multipleOf !== undefined && multipleOf > 0) {
    const aligned = Math.ceil(value / multipleOf) * multipleOf;
    if (max === undefined || aligned <= max) value = aligned;
  }
  return Math.trunc(value);
}

function sampleNumber(schema: any): number {
  const { min, max } = numericRange(schema, false);
  let value = 0;
  if (min !== undefined && value < min) value = min;
  if (max !== undefined && value > max) value = max;

  const multipleOf = toFiniteNumber(schema.multipleOf);
  if (multipleOf !== undefined && multipleOf > 0) {
    const aligned = Math.ceil(value / multipleOf) * multipleOf;
    if (max === undefined || aligned <= max) value = aligned;
  }
  return value;
}

/**
 * Resolve the inclusive range implied by minimum/maximum and their exclusive
 * counterparts, supporting both the numeric (draft 6+) and boolean (draft 4)
 * spellings.
 */
function numericRange(
  schema: any,
  integral: boolean,
): { min?: number; max?: number } {
  const step = integral ? 1 : Number.EPSILON > 0 ? 1e-6 : 1;

  let min = toFiniteNumber(schema.minimum);
  let max = toFiniteNumber(schema.maximum);

  const exMin = schema.exclusiveMinimum;
  const exMax = schema.exclusiveMaximum;

  if (typeof exMin === "number" && Number.isFinite(exMin)) {
    const bound = exMin + step;
    min = min === undefined ? bound : Math.max(min, bound);
  } else if (exMin === true && min !== undefined) {
    min += step;
  }

  if (typeof exMax === "number" && Number.isFinite(exMax)) {
    const bound = exMax - step;
    max = max === undefined ? bound : Math.min(max, bound);
  } else if (exMax === true && max !== undefined) {
    max -= step;
  }

  return { min, max };
}

function sampleString(schema: any): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  const formatted = format ? formatSample(format) : undefined;
  if (formatted !== undefined) return clampString(formatted, schema);

  // Never fabricate a value that would violate an explicit pattern; an empty
  // string signals "the caller must supply this".
  if (typeof schema.pattern === "string" && schema.pattern.length) return "";

  return clampString("string", schema);
}

function formatSample(format: string): string | undefined {
  switch (format) {
    case "date-time":
      return REFERENCE_INSTANT;
    case "date":
      return REFERENCE_INSTANT.slice(0, 10);
    case "time":
      return REFERENCE_INSTANT.slice(11, 19);
    case "duration":
      return "PT1S";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "email":
    case "idn-email":
      return "user@example.com";
    case "hostname":
    case "idn-hostname":
      return "example.com";
    case "ipv4":
      return "127.0.0.1";
    case "ipv6":
      return "::1";
    case "uri":
    case "url":
    case "iri":
      return "https://example.com";
    case "uri-reference":
    case "iri-reference":
      return "/example";
    case "uri-template":
      return "https://example.com/{id}";
    case "json-pointer":
      return "/example";
    case "relative-json-pointer":
      return "0/example";
    case "regex":
      return "^example$";
    case "byte":
      // Valid base64 so the value survives a decode step.
      return "ZXhhbXBsZQ==";
    case "binary":
      return "";
    case "password":
      return "password";
    default:
      return undefined;
  }
}

/** Enforce minLength and maxLength on a generated string. */
function clampString(value: string, schema: any): string {
  const min = toFiniteInt(schema.minLength);
  const max = toFiniteInt(schema.maxLength);

  let out = value;
  if (min !== undefined && out.length < min) {
    out = out.padEnd(Math.min(min, MAX_STRING_LENGTH), "x");
  }
  if (max !== undefined && out.length > max) {
    out = out.slice(0, Math.max(max, 0));
  }
  return out;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toFiniteInt(value: unknown): number | undefined {
  const n = toFiniteNumber(value);
  if (n === undefined) return undefined;
  const int = Math.floor(n);
  return int < 0 ? 0 : int;
}
