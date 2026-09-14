import type { SendOptions, RequestValues, AuthConfig } from "../../core/types";
import type { LocatedOperation } from "../../openapi/locate";
import { sampleFromSchema } from "../../openapi/sample";
import { isPlainObject } from "../../core/utils";
import { resolveServerUrl } from "./environment";
import { acceptHeaderFor } from "./detect";
import { buildCollectionEvents, buildItemEvents } from "./scripts";

/** Methods postman-runtime handles through its standard request pipeline. */
const STANDARD_METHODS = new Set([
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
]);

/** Headers whose value is decided by the body, negotiation or the auth helper. */
const RESERVED_HEADER = /^(accept|content-type|authorization)$/i;

/** Monotonic suffix so two collections built in the same millisecond differ. */
let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter = (idCounter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `${prefix}-${time}-${idCounter.toString(36)}${rand}`;
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* Content type negotiation                                            */
/* ------------------------------------------------------------------ */

/** Rank candidate request media types, preferring plain JSON. */
function rankMediaType(mediaType: string): number {
  const lower = mediaType.toLowerCase();
  if (lower === "application/json") return 0;
  // A sequence type is a streaming framing, not a plain JSON document.
  if (lower.includes("json-seq") || lower.includes("ndjson")) return 40;
  if (lower.endsWith("+json")) return 10;
  if (lower.includes("json")) return 20;
  if (lower.includes("x-www-form-urlencoded")) return 30;
  if (lower.includes("multipart/form-data")) return 35;
  return 50;
}

interface ContentTypeChoice {
  contentType?: string;
  /** True when the caller forced a type the operation does not declare. */
  undeclared: boolean;
}

function pickContentType(
  operation: any,
  values: RequestValues,
): ContentTypeChoice {
  const content = operation?.requestBody?.content;
  const declared = isPlainObject(content) ? Object.keys(content) : [];

  const forced = optionalText(values.contentType);
  if (forced) {
    const lower = forced.split(";")[0].trim().toLowerCase();
    const matches = declared.some((key) => key.toLowerCase() === lower);
    return { contentType: forced, undeclared: declared.length > 0 && !matches };
  }

  if (!declared.length) return { contentType: undefined, undeclared: false };

  const sorted = declared
    .slice()
    .sort((a, b) => rankMediaType(a) - rankMediaType(b));
  return { contentType: sorted[0], undeclared: false };
}

/** Locate the schema for a media type, tolerating a case mismatch. */
function schemaForContentType(
  requestBody: any,
  contentType: string,
): any | undefined {
  const content = requestBody?.content;
  if (!isPlainObject(content)) return undefined;
  if (isPlainObject(content[contentType])) return content[contentType].schema;

  const lower = contentType.split(";")[0].trim().toLowerCase();
  for (const key of Object.keys(content)) {
    if (key.toLowerCase() !== lower) continue;
    const media = content[key];
    if (isPlainObject(media)) return media.schema;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Value stringification                                               */
/* ------------------------------------------------------------------ */

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  const kind = typeof value;
  if (kind === "string") return value as string;
  if (kind === "number" || kind === "boolean" || kind === "bigint")
    return String(value);
  if (kind === "object") {
    try {
      const json = JSON.stringify(value);
      return typeof json === "string" ? json : "";
    } catch {
      return "";
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Parameter serialization                                             */
/* ------------------------------------------------------------------ */

const ARRAY_SEPARATOR: Record<string, string> = {
  spaceDelimited: " ",
  pipeDelimited: "|",
  form: ",",
  simple: ",",
};

/** Serialize a query parameter according to its style and explode settings. */
function serializeQueryParam(
  parameter: any,
  value: unknown,
): Array<{ key: string; value: string }> {
  const name = String(parameter.name);
  const style = optionalText(parameter.style) ?? "form";
  const explode =
    typeof parameter.explode === "boolean"
      ? parameter.explode
      : style === "form" || style === "deepObject";

  if (Array.isArray(value)) {
    if (!value.length) {
      // An empty array still signals the parameter was supplied.
      return [{ key: name, value: "" }];
    }
    if (explode && style !== "deepObject") {
      return value.map((entry) => ({ key: name, value: stringify(entry) }));
    }
    if (style === "deepObject") {
      return value.map((entry, index) => ({
        key: `${name}[${index}]`,
        value: stringify(entry),
      }));
    }
    const separator = ARRAY_SEPARATOR[style] ?? ",";
    return [{ key: name, value: value.map(stringify).join(separator) }];
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [{ key: name, value: "" }];

    if (style === "deepObject") {
      return entries.map(([key, entry]) => ({
        key: `${name}[${key}]`,
        value: stringify(entry),
      }));
    }
    if (explode) {
      // form + explode spreads the object into top-level parameters.
      return entries.map(([key, entry]) => ({
        key,
        value: stringify(entry),
      }));
    }
    return [
      {
        key: name,
        value: entries
          .flatMap(([key, entry]) => [key, stringify(entry)])
          .join(","),
      },
    ];
  }

  return [{ key: name, value: stringify(value) }];
}

/** Serialize a path parameter. Defaults to the `simple` style. */
function serializePathParam(parameter: any, value: unknown): string {
  const style = optionalText(parameter.style) ?? "simple";
  const explode = parameter.explode === true;
  const name = String(parameter.name);

  const joinArray = (list: unknown[], sep: string) =>
    list.map(stringify).join(sep);

  if (style === "label") {
    if (Array.isArray(value))
      return `.${joinArray(value, explode ? "." : ",")}`;
    if (isPlainObject(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      return explode
        ? entries.map(([k, v]) => `.${k}=${stringify(v)}`).join("")
        : `.${entries.flatMap(([k, v]) => [k, stringify(v)]).join(",")}`;
    }
    return `.${stringify(value)}`;
  }

  if (style === "matrix") {
    if (Array.isArray(value)) {
      return explode
        ? value.map((v) => `;${name}=${stringify(v)}`).join("")
        : `;${name}=${joinArray(value, ",")}`;
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      return explode
        ? entries.map(([k, v]) => `;${k}=${stringify(v)}`).join("")
        : `;${name}=${entries.flatMap(([k, v]) => [k, stringify(v)]).join(",")}`;
    }
    return `;${name}=${stringify(value)}`;
  }

  // simple
  if (Array.isArray(value)) return joinArray(value, ",");
  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return explode
      ? entries.map(([k, v]) => `${k}=${stringify(v)}`).join(",")
      : entries.flatMap(([k, v]) => [k, stringify(v)]).join(",");
  }
  return stringify(value);
}

/** Serialize a header parameter using the `simple` style. */
function serializeHeaderParam(parameter: any, value: unknown): string {
  const explode = parameter.explode === true;
  if (Array.isArray(value)) return value.map(stringify).join(",");
  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return explode
      ? entries.map(([k, v]) => `${k}=${stringify(v)}`).join(",")
      : entries.flatMap(([k, v]) => [k, stringify(v)]).join(",");
  }
  return stringify(value);
}

/** Serialize a cookie parameter. Cookies use the `form` style. */
function serializeCookieParam(
  parameter: any,
  value: unknown,
): Array<[string, string]> {
  const name = String(parameter.name);
  const explode = parameter.explode === true;

  if (Array.isArray(value)) {
    return explode
      ? value.map((v) => [name, stringify(v)] as [string, string])
      : [[name, value.map(stringify).join(",")]];
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return explode
      ? entries.map(([k, v]) => [k, stringify(v)] as [string, string])
      : [[name, entries.flatMap(([k, v]) => [k, stringify(v)]).join(",")]];
  }
  return [[name, stringify(value)]];
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function buildAuth(auth?: AuthConfig): Record<string, any> | undefined {
  if (!auth || typeof auth !== "object" || auth.type === "none")
    return undefined;
  switch (auth.type) {
    case "bearer":
      return {
        type: "bearer",
        bearer: [{ key: "token", value: auth.token ?? "", type: "string" }],
      };
    case "basic":
      return {
        type: "basic",
        basic: [
          { key: "username", value: auth.username ?? "", type: "string" },
          { key: "password", value: auth.password ?? "", type: "string" },
        ],
      };
    case "apikey":
      return {
        type: "apikey",
        apikey: [
          { key: "key", value: auth.key ?? "X-API-Key", type: "string" },
          { key: "value", value: auth.value ?? "", type: "string" },
          {
            key: "in",
            value: auth.in === "query" ? "query" : "header",
            type: "string",
          },
        ],
      };
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Query string parsing                                                */
/* ------------------------------------------------------------------ */

/**
 * Split a raw query string into Postman query entries.
 * Values are kept exactly as written: `querystring` is documented as
 * pre-encoded, so re-encoding would corrupt it.
 */
function parseRawQuery(
  input: string,
): Array<{ key: string; value: string; __raw: true }> {
  const out: Array<{ key: string; value: string; __raw: true }> = [];
  const trimmed = input.replace(/^[?&]+/, "");
  if (!trimmed) return out;

  for (const pair of trimmed.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) {
      out.push({ key: pair, value: "", __raw: true });
    } else {
      out.push({
        key: pair.slice(0, eq),
        value: pair.slice(eq + 1),
        __raw: true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface BuiltCollection {
  collection: Record<string, any>;
  baseUrl: string;
  contentType?: string;
  isCustomMethod: boolean;
  /**
   * Non-fatal problems detected while building the request, such as a required
   * path value that had to be synthesized. Surfaced so callers can log them
   * instead of debugging a silently malformed URL.
   */
  warnings: string[];
}

export function buildCollection(
  located: LocatedOperation,
  spec: any,
  options: SendOptions,
): BuiltCollection {
  const values: RequestValues = options.values ?? {};
  const warnings: string[] = [];
  const baseUrl = resolveServerUrl(located.servers, options);

  const parameters = Array.isArray(located.parameters)
    ? located.parameters
    : [];
  const byLocation = (where: string) =>
    parameters.filter(
      (p) =>
        p &&
        typeof p === "object" &&
        p.in === where &&
        typeof p.name === "string",
    );

  const { contentType, undeclared } = pickContentType(
    located.operation,
    values,
  );
  if (undeclared && contentType) {
    warnings.push(
      `Content type "${contentType}" is not declared by the operation's requestBody.`,
    );
  }

  /* ---- Path parameters ---- */
  const pathVariables: Array<{ key: string; value: string }> = [];
  for (const parameter of byLocation("path")) {
    const provided = values.path?.[parameter.name];
    const supplied = provided !== undefined && provided !== null;
    const value = supplied
      ? provided
      : sampleFromSchema(parameter.schema ?? {});

    const serialized = serializePathParam(parameter, value);
    if (!serialized) {
      // An empty path segment would leave ":name" unresolved in the final URL.
      warnings.push(
        `Path parameter "${parameter.name}" resolved to an empty value; ` +
          `pass values.path["${parameter.name}"] to control it.`,
      );
    } else if (!supplied) {
      warnings.push(
        `Path parameter "${parameter.name}" was synthesized from its schema as "${serialized}".`,
      );
    }
    pathVariables.push({ key: parameter.name, value: serialized });
  }

  const pathSegments = String(located.path)
    .replace(/^\//, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      segment.replace(/\{([^}]+)\}/g, (_match, name: string) => `:${name}`),
    );

  /* ---- Query parameters ---- */
  const query: Array<{
    key: string;
    value: string;
    disabled?: boolean;
    __raw?: true;
  }> = [];
  const declaredQueryNames = new Set<string>();

  for (const parameter of byLocation("query")) {
    declaredQueryNames.add(parameter.name);
    const hasValue =
      isPlainObject(values.query) &&
      Object.prototype.hasOwnProperty.call(values.query, parameter.name);
    const raw = hasValue ? values.query![parameter.name] : undefined;

    if (hasValue && raw !== undefined) {
      // An explicit null means "send it empty", not "omit it".
      query.push(...serializeQueryParam(parameter, raw === null ? "" : raw));
      continue;
    }

    if (parameter.required === true) {
      const sampled = sampleFromSchema(parameter.schema ?? {});
      // A required parameter is always emitted, even if the sample is empty.
      query.push(
        ...serializeQueryParam(parameter, sampled === null ? "" : sampled),
      );
      continue;
    }

    if (parameter.allowEmptyValue === true) {
      query.push({ key: parameter.name, value: "" });
      continue;
    }

    // Keep optional parameters visible but disabled for discoverability.
    query.push({ key: parameter.name, value: "", disabled: true });
  }

  if (isPlainObject(values.query)) {
    for (const [key, value] of Object.entries(values.query)) {
      if (declaredQueryNames.has(key) || value === undefined || value === null)
        continue;
      if (Array.isArray(value)) {
        for (const entry of value) query.push({ key, value: stringify(entry) });
      } else {
        query.push({ key, value: stringify(value) });
      }
    }
  }

  // A pre-encoded querystring must reach url.query, otherwise the Postman SDK
  // rebuilds the URL from the structured fields and drops it entirely.
  if (typeof values.querystring === "string" && values.querystring.length) {
    query.push(...parseRawQuery(values.querystring));
  }

  /* ---- Headers ---- */
  const header: Array<{ key: string; value: string }> = [];
  const seenHeaders = new Set<string>();
  const addHeader = (key: string, value: string) => {
    if (!key) return;
    const lower = key.toLowerCase();
    if (seenHeaders.has(lower)) return;
    seenHeaders.add(lower);
    header.push({ key, value });
  };

  // Caller-supplied headers take precedence over anything derived from the spec.
  if (isPlainObject(values.header)) {
    for (const [key, value] of Object.entries(values.header)) {
      if (value === undefined || value === null) continue;
      addHeader(key, stringify(value));
    }
  }

  for (const parameter of byLocation("header")) {
    if (RESERVED_HEADER.test(parameter.name)) continue;
    if (parameter.required !== true) continue;
    const sampled = sampleFromSchema(parameter.schema ?? {});
    if (sampled === null || sampled === undefined) continue;
    const serialized = serializeHeaderParam(parameter, sampled);
    if (serialized !== "") addHeader(parameter.name, serialized);
  }

  if (contentType) addHeader("Content-Type", contentType);
  const accept = acceptHeaderFor(located.operation);
  if (accept) addHeader("Accept", accept);

  /* ---- Cookies ---- */
  const cookieParameters = byLocation("cookie");
  const cookiePairs: string[] = [];
  const pushCookie = (name: string, value: string) => {
    // Cookie values may not contain a semicolon or whitespace unquoted.
    cookiePairs.push(`${name}=${encodeURIComponent(value)}`);
  };

  for (const parameter of cookieParameters) {
    const provided = values.cookie?.[parameter.name];
    const supplied = provided !== undefined && provided !== null;
    const value = supplied
      ? provided
      : parameter.required === true
        ? sampleFromSchema(parameter.schema ?? {})
        : undefined;
    if (value === undefined || value === null) continue;
    for (const [name, serialized] of serializeCookieParam(parameter, value)) {
      pushCookie(name, serialized);
    }
  }

  if (isPlainObject(values.cookie)) {
    for (const [key, value] of Object.entries(values.cookie)) {
      if (cookieParameters.some((p) => p.name === key)) continue;
      if (value === undefined || value === null) continue;
      pushCookie(key, stringify(value));
    }
  }
  if (cookiePairs.length) addHeader("Cookie", cookiePairs.join("; "));

  /* ---- Body ---- */
  const body = buildBody(located.operation, values, contentType, warnings);

  /* ---- URL assembly ---- */
  // `raw` is a display field: the Postman SDK reconstructs the effective URL
  // from host/path/query, so both must describe the same request.
  const activeQuery = query.filter((entry) => !entry.disabled);
  const queryString = activeQuery
    .map((entry) =>
      entry.__raw
        ? `${entry.key}${entry.value === "" ? "" : `=${entry.value}`}`
        : `${encodeURIComponent(entry.key)}=${encodeURIComponent(entry.value)}`,
    )
    .join("&");

  let raw = `{{baseUrl}}/${pathSegments.join("/")}`;
  if (queryString) raw += `?${queryString}`;

  const url: Record<string, any> = {
    raw,
    host: ["{{baseUrl}}"],
    path: pathSegments,
  };
  if (query.length) {
    url.query = query.map(({ __raw, ...entry }) => entry);
  }
  if (pathVariables.length) url.variable = pathVariables;

  const methodUpper = String(located.method).toUpperCase();
  const request: Record<string, any> = {
    method: methodUpper,
    header,
    url,
  };
  const description =
    optionalText(located.operation?.description) ??
    optionalText(located.operation?.summary);
  if (description) request.description = description;
  if (body) request.body = body;

  const itemEvents = buildItemEvents(located.operation, options.scripts) ?? [];
  const collectionEvents = buildCollectionEvents(spec, options.scripts) ?? [];
  const auth = buildAuth(options.auth);

  const itemName =
    optionalText(located.operation?.operationId) ??
    `${methodUpper} ${located.path}`;

  const collection: Record<string, any> = {
    info: {
      _postman_id: uniqueId("protokit"),
      name: safeText(spec?.info?.title, "OpenAPI Debug Session"),
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: itemName,
        ...(itemEvents.length ? { event: itemEvents } : {}),
        request,
        response: [],
      },
    ],
    variable: [{ key: "baseUrl", value: baseUrl }],
  };

  const specDescription = optionalText(spec?.info?.description);
  if (specDescription) collection.info.description = specDescription;
  if (auth) collection.auth = auth;
  if (collectionEvents.length) collection.event = collectionEvents;

  return {
    collection,
    baseUrl,
    contentType,
    isCustomMethod: !STANDARD_METHODS.has(methodUpper),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Body construction                                                   */
/* ------------------------------------------------------------------ */

function buildBody(
  operation: any,
  values: RequestValues,
  contentType: string | undefined,
  warnings: string[],
): Record<string, any> | undefined {
  const requestBody = operation?.requestBody;
  const hasExplicitBody = values.body !== undefined;

  if (!requestBody && !hasExplicitBody) return undefined;

  // A caller-supplied body must never be dropped just because the document
  // failed to declare a media type for it.
  const effectiveType =
    contentType ?? (hasExplicitBody ? "application/json" : undefined);
  if (!effectiveType) {
    if (requestBody) {
      warnings.push(
        "The operation declares a requestBody but no media type could be resolved; no body was sent.",
      );
    }
    return undefined;
  }
  if (!contentType && hasExplicitBody) {
    warnings.push(
      "No request media type was declared; defaulted to application/json for the supplied body.",
    );
  }

  const schema = schemaForContentType(requestBody, effectiveType);
  const payload = hasExplicitBody
    ? values.body
    : sampleFromSchema(schema ?? {});

  const lower = effectiveType.split(";")[0].trim().toLowerCase();
  const isSequence = lower.includes("json-seq") || lower.includes("ndjson");

  if (
    !isSequence &&
    (lower === "application/json" ||
      lower.endsWith("+json") ||
      lower.includes("json"))
  ) {
    let rawText: string;
    if (typeof payload === "string") {
      rawText = payload;
    } else if (payload === undefined) {
      rawText = "{}";
    } else {
      try {
        rawText = JSON.stringify(payload, null, 2) ?? "null";
      } catch {
        warnings.push("The request body could not be serialized as JSON.");
        rawText = "{}";
      }
    }
    return {
      mode: "raw",
      raw: rawText,
      options: { raw: { language: "json" } },
    };
  }

  if (lower.includes("x-www-form-urlencoded")) {
    return {
      mode: "urlencoded",
      urlencoded: toFieldList(payload).map(([key, value]) => ({
        key,
        value: stringify(value),
        type: "text",
      })),
    };
  }

  if (lower.includes("multipart/form-data")) {
    return {
      mode: "formdata",
      formdata: toFieldList(payload).map(([key, value]) =>
        isPlainObject(value) && "__file" in value
          ? { key, type: "file", src: String((value as any).__file) }
          : { key, type: "text", value: stringify(value) },
      ),
    };
  }

  if (lower.includes("xml") || lower.startsWith("text/") || isSequence) {
    return {
      mode: "raw",
      raw: typeof payload === "string" ? payload : stringify(payload),
      ...(lower.includes("xml")
        ? { options: { raw: { language: "xml" } } }
        : {}),
    };
  }

  return {
    mode: "raw",
    raw: typeof payload === "string" ? payload : stringify(payload),
  };
}

function toFieldList(payload: unknown): Array<[string, unknown]> {
  if (!isPlainObject(payload)) return [];
  return Object.entries(payload as Record<string, unknown>);
}
