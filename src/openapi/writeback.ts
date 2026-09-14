import type { ExecResult, Json, StreamEvent } from "../core/types";
import { inferSchema } from "./infer";
import { mergeSchema } from "./merge";
import { deepClone, isPlainObject } from "../core/utils";
import { err } from "../core/errors";

/** Headers that describe the transport rather than the API contract. */
const TRANSIENT_HEADERS = new Set([
  "date",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "server",
  "set-cookie",
  "age",
  "via",
  "alt-svc",
  "report-to",
  "nel",
  "x-request-id",
  "x-trace-id",
  "x-correlation-id",
  "x-amzn-requestid",
  "x-amzn-trace-id",
  "x-amz-cf-id",
  "cf-ray",
  "cf-cache-status",
  "x-served-by",
  "x-timer",
  "x-cache",
  "x-cache-hits",
  "x-fastly-request-id",
  "x-envoy-upstream-service-time",
  "x-powered-by",
  "expires",
  "last-modified",
  "etag",
]);

/** Payloads that mark end-of-stream and carry no schema information. */
const SENTINEL_PAYLOADS = new Set(["[DONE]", "DONE", "[done]", "done"]);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSentinel(event: StreamEvent): boolean {
  const data = typeof event.data === "string" ? event.data.trim() : "";
  if (SENTINEL_PAYLOADS.has(data)) return true;
  const name = (event.event ?? "").toLowerCase();
  return name === "done" || name === "end" || name === "complete";
}

/**
 * Convert observed response headers into OpenAPI Header Objects.
 *
 * HTTP header names are case-insensitive, so entries are de-duplicated by their
 * lower-cased form while the first observed casing is kept for display.
 */
function headersToOpenApi(
  headers: Record<string, string> | undefined,
): Record<string, any> | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const out: Record<string, any> = {};
  const claimed = new Map<string, string>();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== "string" || !key.length) continue;
    if (UNSAFE_KEYS.has(key)) continue;

    const lower = key.toLowerCase();
    // content-type is expressed by the content map, not by a header entry.
    if (lower === "content-type" || TRANSIENT_HEADERS.has(lower)) continue;

    const existing = claimed.get(lower);
    if (existing) {
      // Same header seen twice with different casing: fold into the first entry.
      const previous = out[existing];
      const merged = mergeSchema(previous.schema, headerSchema(value), 0);
      out[existing] = { ...previous, schema: merged };
      continue;
    }

    claimed.set(lower, key);
    out[key] = { schema: headerSchema(value) };
  }

  return Object.keys(out).length ? out : undefined;
}

function headerSchema(value: unknown): Record<string, any> {
  return { type: "string", examples: [stringifyHeader(value)] };
}

function stringifyHeader(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeMediaType(contentType?: string): string {
  if (typeof contentType !== "string" || !contentType.trim())
    return "application/octet-stream";
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base || "application/octet-stream";
}

export interface ToResponseOptions {
  /** Cap on the size of captured example payloads, in characters. */
  maxExampleChars?: number;
  /** Include a captured example under `content[mediaType].examples`. Defaults to true. */
  includeExamples?: boolean;
  /** Cap on characters retained per non-JSON stream event. Defaults to 200. */
  maxEventPreviewChars?: number;
}

/** Convert a single execution result into an OpenAPI 3.2 Response Object. */
export function toResponseObject(
  result: ExecResult,
  options: ToResponseOptions = {},
): { statusCode: string; response: any } {
  if (
    !result ||
    typeof result !== "object" ||
    !isPlainObject(result.response)
  ) {
    // A malformed result still produces a valid, minimal fragment.
    return { statusCode: "default", response: { description: "Response" } };
  }

  const { response } = result;
  const status = typeof response.status === "number" ? response.status : 0;
  const statusCode = status > 0 ? String(status) : "default";
  const mediaType = normalizeMediaType(response.contentType);
  const includeExamples = options.includeExamples !== false;
  const maxChars = Math.max(1, options.maxExampleChars ?? 4000);

  const target: Record<string, any> = {
    description:
      (typeof response.statusText === "string" && response.statusText) ||
      describeStatus(status),
  };

  const headers = headersToOpenApi(response.headers);
  if (headers) target.headers = headers;

  /* ---- Streaming protocols: describe one item, not the whole body. ---- */
  const isStreaming =
    result.protocol === "sse" || result.protocol === "websocket";

  if (isStreaming && Array.isArray(response.events)) {
    return {
      statusCode,
      response: buildStreamResponse(result, target, mediaType, options),
    };
  }

  /* ---- Regular responses ---- */
  if (response.body !== undefined && response.body !== null) {
    const media: Record<string, any> = {
      schema: inferSchema(response.body as Json),
    };
    if (includeExamples) {
      media.examples = {
        capturedSample: {
          summary: "Captured from a live call",
          value: truncateValue(response.body, maxChars),
        },
      };
    }
    target.content = { [mediaType]: media };
  } else if (typeof response.text === "string" && response.text.length) {
    const media: Record<string, any> = { schema: { type: "string" } };
    if (includeExamples) {
      media.examples = {
        capturedSample: {
          summary: "Captured from a live call",
          value: response.text.slice(0, maxChars),
        },
      };
    }
    target.content = { [mediaType]: media };
  } else if (
    status !== 204 &&
    status !== 304 &&
    (response.sizeBytes ?? 0) > 0
  ) {
    // A body existed but could not be decoded (binary payload).
    target.content = {
      [mediaType]: { schema: { type: "string", format: "binary" } },
    };
  }

  return { statusCode, response: target };
}

function buildStreamResponse(
  result: ExecResult,
  target: Record<string, any>,
  mediaType: string,
  options: ToResponseOptions,
): Record<string, any> {
  const response = result.response;
  const events = Array.isArray(response.events) ? response.events : [];
  // Inbound frames define the response contract; outbound frames are requests.
  const inbound = events.filter((e) => e && e.direction !== "out");
  const meaningful = inbound.filter((event) => !isSentinel(event));

  if (!meaningful.length) return target;

  const previewLimit = Math.max(1, options.maxEventPreviewChars ?? 200);
  let dataSchema: any = null;
  let sawJson = false;
  let sawText = false;

  for (const event of meaningful) {
    if (event.parsed !== undefined) {
      sawJson = true;
      dataSchema = mergeSchema(
        dataSchema,
        inferSchema(event.parsed as Json),
        0,
      );
    } else {
      sawText = true;
      const raw = typeof event.data === "string" ? event.data : "";
      const text =
        raw.length > previewLimit ? `${raw.slice(0, previewLimit)}...` : raw;
      dataSchema = mergeSchema(
        dataSchema,
        { type: "string", examples: [text] },
        0,
      );
    }
  }

  const eventNames = Array.from(
    new Set(
      meaningful
        .map((event) => event.event)
        .filter((name): name is string => typeof name === "string" && !!name),
    ),
  );

  const fallbackDataSchema =
    sawJson && !sawText ? { type: "object" } : { type: "string" };

  const itemSchema: Record<string, any> = {
    type: "object",
    properties: {
      id: { type: "string" },
      event: eventNames.length
        ? { type: "string", enum: eventNames }
        : { type: "string" },
      data: dataSchema ?? fallbackDataSchema,
      retry: { type: "integer" },
    },
    required: ["data"],
  };

  const streamMediaType =
    result.protocol === "sse" ? "text/event-stream" : mediaType;

  target.content = {
    [streamMediaType]: {
      // OpenAPI 3.2 uses itemSchema to describe each element of a stream.
      itemSchema,
      "x-protokit-sample-count": meaningful.length,
      ...(response.truncated ? { "x-protokit-truncated": true } : {}),
    },
  };

  return target;
}

function truncateValue(value: unknown, maxChars: number): unknown {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string" && text.length <= maxChars) return value;
    return {
      "x-protokit-truncated": true,
      preview: String(text ?? value).slice(0, maxChars),
    };
  } catch {
    // Circular or otherwise unserializable payload.
    try {
      return String(value).slice(0, maxChars);
    } catch {
      return "[unserializable payload]";
    }
  }
}

function describeStatus(status: number): string {
  if (status >= 500) return "Server error";
  if (status >= 400) return "Client error";
  if (status >= 300) return "Redirection";
  if (status >= 200) return "Successful response";
  if (status >= 100) return "Informational response";
  return "Response";
}

export interface WriteBackOptions {
  /** 'merge' unions the new observation into the existing schema. Defaults to 'merge'. */
  strategy?: "merge" | "replace";
  /** Preserve a hand-written description instead of the HTTP reason phrase. Defaults to true. */
  keepExistingDescription?: boolean;
  /** Only write back these status codes. Empty means all. */
  allowedStatusCodes?: string[];
  /** Refuse to touch responses whose schema is a $ref to a shared component. Defaults to true. */
  protectComponentRefs?: boolean;
  /** Overwrite an existing captured example. Defaults to true. */
  overwriteExamples?: boolean;
  requirePassingTests?: boolean;
}

/**
 * Merge a response fragment into a copy of the spec.
 * The input document is never mutated.
 *
 * Note: gating on test results is the caller's responsibility; this function
 * writes whatever fragment it is handed.
 */
export function writeBackResponse(
  spec: any,
  path: string,
  method: string,
  fragment: { statusCode: string; response: any },
  options: WriteBackOptions = {},
): any {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw err("BAD_SPEC", "spec must be an object");
  if (typeof path !== "string" || !path.length)
    throw err("BAD_TARGET", "path must be a non-empty string");
  if (typeof method !== "string" || !method.length)
    throw err("BAD_TARGET", "method must be a non-empty string");
  if (
    !fragment ||
    typeof fragment !== "object" ||
    !isPlainObject(fragment.response)
  )
    throw err("BAD_FRAGMENT", "fragment.response must be an object");

  const statusCode =
    typeof fragment.statusCode === "string" && fragment.statusCode
      ? fragment.statusCode
      : "default";

  if (UNSAFE_KEYS.has(statusCode))
    throw err("BAD_FRAGMENT", `Invalid status code key "${statusCode}"`);

  const next = deepClone(spec);

  if (!isPlainObject(next.paths))
    throw err("BAD_SPEC", "spec.paths is missing or invalid");

  const pathItem = next.paths[path];
  if (!isPlainObject(pathItem))
    throw err(
      "PATH_NOT_FOUND",
      `Path "${path}" is not present in the document`,
    );

  const operation = findOperation(pathItem, method);
  if (!operation) {
    throw err(
      "OP_NOT_FOUND",
      `Operation "${method.toUpperCase()} ${path}" is not present in the document`,
    );
  }

  if (
    Array.isArray(options.allowedStatusCodes) &&
    options.allowedStatusCodes.length &&
    !options.allowedStatusCodes.includes(statusCode)
  ) {
    return next;
  }

  // A stale, non-object `responses` value would corrupt the merge.
  if (!isPlainObject(operation.responses)) operation.responses = {};

  const incoming = deepClone(fragment.response);
  const existing = operation.responses[statusCode];

  // Replace mode, a first observation, or an unusable existing entry: just set it.
  if (
    options.strategy === "replace" ||
    existing === undefined ||
    !isPlainObject(existing)
  ) {
    operation.responses[statusCode] = incoming;
    return next;
  }

  // A $ref'd response object points at a shared component; leave it alone.
  if (typeof existing.$ref === "string") return next;

  mergeResponseInto(existing, incoming, options);
  return next;
}

/**
 * Locate an operation on a Path Item, covering both fixed method fields and
 * `additionalOperations`. The lookup is case-insensitive because a document may
 * spell a custom verb as "LOCK", "lock" or "Lock".
 */
function findOperation(pathItem: Record<string, any>, method: string): any {
  const lower = method.toLowerCase();

  const fixed = pathItem[lower];
  if (isPlainObject(fixed)) return fixed;

  const additional = pathItem.additionalOperations;
  if (!isPlainObject(additional)) return undefined;

  for (const key of Object.keys(additional)) {
    if (key.toLowerCase() !== lower) continue;
    const candidate = additional[key];
    if (isPlainObject(candidate)) return candidate;
  }
  return undefined;
}

/** In-place merge of an incoming Response Object into an existing one. */
function mergeResponseInto(
  existing: Record<string, any>,
  incoming: Record<string, any>,
  options: WriteBackOptions,
): void {
  const protectRefs = options.protectComponentRefs !== false;
  const overwriteExamples = options.overwriteExamples !== false;

  /* ---- description ---- */
  const hasUsableDescription =
    typeof existing.description === "string" && existing.description.length > 0;
  if (options.keepExistingDescription === false || !hasUsableDescription) {
    if (typeof incoming.description === "string" && incoming.description) {
      existing.description = incoming.description;
    }
  }

  /* ---- headers ---- */
  if (isPlainObject(incoming.headers)) {
    if (!isPlainObject(existing.headers)) existing.headers = {};
    mergeHeaderMap(existing.headers, incoming.headers, protectRefs);
  }

  /* ---- content ---- */
  if (isPlainObject(incoming.content)) {
    if (!isPlainObject(existing.content)) existing.content = {};

    for (const [mediaType, media] of Object.entries<any>(incoming.content)) {
      if (UNSAFE_KEYS.has(mediaType)) continue;
      if (!isPlainObject(media)) continue;

      const previous = existing.content[mediaType];
      if (!isPlainObject(previous)) {
        existing.content[mediaType] = media;
        continue;
      }
      mergeMediaTypeInto(previous, media, protectRefs, overwriteExamples);
    }
  }

  /* ---- links and vendor extensions on the response itself ---- */
  if (isPlainObject(incoming.links)) {
    existing.links = {
      ...(isPlainObject(existing.links) ? existing.links : {}),
      ...incoming.links,
    };
  }
  for (const key of Object.keys(incoming)) {
    if (!key.startsWith("x-")) continue;
    if (UNSAFE_KEYS.has(key)) continue;
    existing[key] = incoming[key];
  }
}

/**
 * Merge observed headers, matching case-insensitively so a live
 * `x-ratelimit-remaining` folds into an authored `X-RateLimit-Remaining`
 * instead of creating a duplicate entry.
 */
function mergeHeaderMap(
  existing: Record<string, any>,
  incoming: Record<string, any>,
  protectRefs: boolean,
): void {
  const index = new Map<string, string>();
  for (const key of Object.keys(existing)) index.set(key.toLowerCase(), key);

  for (const [key, value] of Object.entries<any>(incoming)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (!isPlainObject(value)) continue;

    const canonical = index.get(key.toLowerCase());
    if (!canonical) {
      existing[key] = value;
      index.set(key.toLowerCase(), key);
      continue;
    }

    const previous = existing[canonical];
    if (!isPlainObject(previous)) {
      existing[canonical] = value;
      continue;
    }
    // A $ref'd header points at a shared component; leave it untouched.
    if (protectRefs && typeof previous.$ref === "string") continue;

    if (value.schema !== undefined) {
      previous.schema =
        protectRefs && typeof previous.schema?.$ref === "string"
          ? previous.schema
          : mergeSchema(previous.schema, value.schema, 0);
    }
    // Keep an authored description; only fill a missing one.
    if (
      typeof value.description === "string" &&
      typeof previous.description !== "string"
    ) {
      previous.description = value.description;
    }
  }
}

/** Merge an incoming Media Type Object into an existing one, in place. */
function mergeMediaTypeInto(
  previous: Record<string, any>,
  media: Record<string, any>,
  protectRefs: boolean,
  overwriteExamples: boolean,
): void {
  if (media.itemSchema !== undefined) {
    previous.itemSchema =
      protectRefs && typeof previous.itemSchema?.$ref === "string"
        ? previous.itemSchema
        : mergeSchema(previous.itemSchema, media.itemSchema, 0);
  }

  if (media.schema !== undefined) {
    previous.schema =
      protectRefs && typeof previous.schema?.$ref === "string"
        ? previous.schema
        : mergeSchema(previous.schema, media.schema, 0);
  }

  if (isPlainObject(media.examples)) {
    if (!isPlainObject(previous.examples)) previous.examples = {};
    for (const [name, example] of Object.entries<any>(media.examples)) {
      if (UNSAFE_KEYS.has(name)) continue;
      if (!overwriteExamples && name in previous.examples) continue;
      previous.examples[name] = example;
    }
  }

  // An authored single `example` is not overwritten by a captured sample.
  if (media.example !== undefined && previous.example === undefined) {
    previous.example = media.example;
  }

  if (isPlainObject(media.encoding)) {
    previous.encoding = {
      ...(isPlainObject(previous.encoding) ? previous.encoding : {}),
      ...media.encoding,
    };
  }

  for (const key of Object.keys(media)) {
    if (!key.startsWith("x-")) continue;
    if (UNSAFE_KEYS.has(key)) continue;
    previous[key] = media[key];
  }
}
