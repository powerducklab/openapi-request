import { isPlainObject } from "../../core/utils";

/** Media types whose payload is a sequence of items rather than one document. */
const STREAM_MEDIA_TYPES = [
  "text/event-stream",
  "application/json-seq",
  "application/x-ndjson",
  "application/ndjson",
  "application/jsonl",
  "application/x-jsonlines",
];

/** Status code keys that describe a successful outcome. */
function isSuccessStatus(key: string): boolean {
  if (key === "default") return false;
  if (/^2\d\d$/.test(key)) return true;
  // OpenAPI allows wildcard ranges such as "2XX".
  return /^2xx$/i.test(key);
}

function readAcceptHeader(values?: {
  header?: Record<string, unknown>;
}): string | undefined {
  if (!isPlainObject(values?.header)) return undefined;
  for (const [key, value] of Object.entries(values!.header!)) {
    if (key.toLowerCase() !== "accept") continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
    return value === null || value === undefined ? undefined : String(value);
  }
  return undefined;
}

/**
 * Decide, from the spec and caller intent, whether the operation is expected
 * to stream. A caller-supplied Accept header wins, then an explicit
 * `x-protocol` extension, then the declared response media types.
 */
export function isStreamingOperation(
  operation: any,
  values?: { header?: Record<string, unknown> },
): boolean {
  const accept = readAcceptHeader(values);
  if (accept && isStreamingContentType(accept)) return true;

  if (!isPlainObject(operation)) return false;

  // An explicit marker is authoritative and cheap to check.
  const declaredProtocol = operation["x-protocol"];
  if (typeof declaredProtocol === "string") {
    const lower = declaredProtocol.toLowerCase();
    if (lower === "sse" || lower === "eventsource") return true;
    // websocket and grpc are handled by their own adapters, not the SSE path.
    if (lower === "websocket" || lower === "grpc") return false;
  }
  if (isPlainObject(operation["x-sse"])) return true;

  const responses = operation.responses;
  if (!isPlainObject(responses)) return false;

  for (const [statusKey, response] of Object.entries<any>(responses)) {
    if (statusKey.startsWith("x-")) continue;
    if (!isPlainObject(response)) continue;
    // A $ref'd response was not expanded; there is nothing to inspect.
    const content = response.content;
    if (!isPlainObject(content)) continue;

    for (const [mediaType, media] of Object.entries<any>(content)) {
      const lower = mediaType.toLowerCase();
      if (lower.startsWith("text/event-stream")) return true;
      // In OpenAPI 3.2, itemSchema on a sequence media type marks a stream.
      if (
        isPlainObject(media) &&
        media.itemSchema !== undefined &&
        STREAM_MEDIA_TYPES.some((type) => lower.startsWith(type))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isSseContentType(contentType?: string): boolean {
  if (typeof contentType !== "string") return false;
  return /(^|[\s,;])text\/event-stream\b/i.test(contentType);
}

export function isStreamingContentType(contentType?: string): boolean {
  if (typeof contentType !== "string" || !contentType) return false;
  // Compare against the media types only, ignoring parameters such as charset.
  const parts = contentType
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .filter(Boolean);
  return parts.some((part) =>
    STREAM_MEDIA_TYPES.some((type) => part === type || part.startsWith(type)),
  );
}

/**
 * Build an Accept header from the declared response media types.
 *
 * Only successful responses contribute: advertising an error media type such as
 * `application/problem+json` would distort content negotiation. Streaming types
 * are listed first so a server that offers both variants picks the stream.
 */
export function acceptHeaderFor(operation: any): string | undefined {
  if (!isPlainObject(operation)) return undefined;
  const responses = operation.responses;
  if (!isPlainObject(responses)) return undefined;

  const success = new Set<string>();
  const fallback = new Set<string>();

  for (const [statusKey, response] of Object.entries<any>(responses)) {
    if (statusKey.startsWith("x-")) continue;
    if (!isPlainObject(response)) continue;
    const content = response.content;
    // Guard against a malformed document: Object.keys on a string would yield
    // numeric indices and produce a nonsense Accept header.
    if (!isPlainObject(content)) continue;

    const bucket = isSuccessStatus(statusKey) ? success : fallback;
    for (const mediaType of Object.keys(content)) {
      if (typeof mediaType !== "string" || !mediaType.trim()) continue;
      // Wildcards add no negotiation value and confuse some servers.
      if (mediaType === "*/*") continue;
      bucket.add(mediaType.trim());
    }
  }

  // Prefer 2xx media types; fall back to whatever is declared if there are none.
  const chosen = success.size ? success : fallback;
  if (!chosen.size) return undefined;

  const list = Array.from(chosen);
  list.sort((a, b) => {
    const rank = (value: string) => {
      const lower = value.toLowerCase();
      if (lower.startsWith("text/event-stream")) return 0;
      if (STREAM_MEDIA_TYPES.some((type) => lower.startsWith(type))) return 1;
      if (lower === "application/json") return 2;
      if (lower.endsWith("+json")) return 3;
      return 4;
    };
    const diff = rank(a) - rank(b);
    // Stable, deterministic ordering for equally ranked types.
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  return list.slice(0, 8).join(", ");
}

/**
 * Fire a real probe request and classify the live response as stream or not.
 *
 * The caller keeps ownership of `response` — this is deliberately not a HEAD
 * helper: many streaming servers answer GET with `text/event-stream` but HEAD
 * with an empty 200, so the probe uses the same request the real call will
 * make. UI flows use it to pre-select the renderer before committing to a
 * session.
 */
export async function probeStreamingResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  contentType?: string;
  kind: "none" | "sse" | "ndjson" | "chunked";
  response: Response;
}> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? undefined;
  const transferEncoding = response.headers.get("transfer-encoding") ?? "";
  let kind: "none" | "sse" | "ndjson" | "chunked" = "none";
  if (isSseContentType(contentType)) kind = "sse";
  else if (isStreamingContentType(contentType)) kind = "ndjson";
  // Transfer-Encoding: chunked is how Node delivers many plain bodies; only
  // treat it as a stream when the server did not say what the type is.
  else if (!contentType && /chunked/i.test(transferEncoding)) kind = "chunked";
  return {
    ok: response.ok,
    status: response.status,
    contentType,
    kind,
    response,
  };
}
