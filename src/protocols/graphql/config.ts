import type { SendOptions, GraphQLOptions, ResolvedGraphQLConfig } from "../../core/types";
export type { ResolvedGraphQLConfig } from "../../core/types";
import type { LocatedOperation } from "../../openapi/locate";
import { resolveServerUrl } from "../http/environment";
import { interpolate, isPlainObject, isSecretKey } from "../../core/utils";
import { sampleFromSchema } from "../../openapi/sample";
import { err } from "../../core/errors";


/**
 * Resolve the effective GraphQL call.
 *
 * Precedence for each field: `options.graphql.*` (explicit per-call override)
 * > `operation['x-graphql'].*` (the document's declared operation, normally
 * produced by {@link writeGraphQLOperations}) > a bare `POST {server}/graphql`
 * fallback with no query, which is rejected below.
 */
export function resolveGraphQLConfig(
  located: LocatedOperation,
  spec: any,
  options: SendOptions,
): ResolvedGraphQLConfig {
  const gql: GraphQLOptions = options.graphql ?? {};
  const rawExtension = located.operation?.["x-graphql"];
  const extension: Record<string, any> =
    rawExtension && typeof rawExtension === "object" ? rawExtension : {};
  const variableMap: Record<string, string> = { ...(options.variables ?? {}) };

  let endpoint: string;
  if (gql.endpoint) {
    endpoint = gql.endpoint;
  } else if (typeof extension.endpoint === "string" && extension.endpoint) {
    endpoint = extension.endpoint;
  } else {
    // Falls back to the resolved server URL; a document that serves GraphQL
    // from a dedicated path should declare `x-graphql.endpoint` explicitly.
    endpoint = resolveServerUrl(located.servers, options);
  }
  endpoint = interpolate(endpoint, variableMap);
  if (/\{\{[^}]+\}\}/.test(endpoint)) {
    throw err(
      "BAD_GRAPHQL_ENDPOINT",
      `Unresolved variable in GraphQL endpoint: ${endpoint}`,
    );
  }
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
  } catch {
    throw err(
      "BAD_GRAPHQL_ENDPOINT",
      `GraphQL endpoint must be an absolute http(s) URL, received: ${endpoint}`,
    );
  }

  const query = gql.query ?? extension.query;
  if (typeof query !== "string" || !query.trim()) {
    throw err(
      "BAD_GRAPHQL_QUERY",
      "No GraphQL query/mutation document was found. Provide options.graphql.query " +
        'or declare it on the operation as x-graphql.query (see writeGraphQLOperations).',
    );
  }

  const operationName =
    gql.operationName ?? optionalText(extension.operationName);

  // Variables: sampled defaults from the declared schema, then the document's
  // own example, then the caller's overrides — each layer wins over the last.
  const sampled = isPlainObject(extension.variablesSchema)
    ? sampleFromSchema(extension.variablesSchema)
    : undefined;
  const declaredExample = isPlainObject(extension.variables)
    ? extension.variables
    : undefined;
  const fromValues = isPlainObject(options.values?.body)
    ? (options.values!.body as Record<string, unknown>)
    : undefined;

  const variables: Record<string, unknown> = {
    ...(isPlainObject(sampled) ? sampled : {}),
    ...(declaredExample ?? {}),
    ...(fromValues ?? {}),
    ...(gql.variables ?? {}),
  };

  /* ---- Headers ---- */
  const headers: Record<string, string> = {};
  const applyHeaders = (source: unknown) => {
    if (!isPlainObject(source)) return;
    for (const [key, value] of Object.entries(source)) {
      if (value == null) continue;
      if (key === "__proto__" || key === "constructor") continue;
      headers[key] = interpolate(String(value), variableMap);
    }
  };
  applyHeaders(options.values?.header);
  applyHeaders(extension.headers);
  applyHeaders(gql.headers);
  if (!hasHeader(headers, "content-type") && !gql.useGet) {
    headers["Content-Type"] = "application/json";
  }
  if (!hasHeader(headers, "accept")) {
    headers.Accept = "application/json, text/event-stream";
  }

  const auth = options.auth;
  if (
    auth &&
    auth.type !== "none" &&
    !hasHeader(headers, "authorization")
  ) {
    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${auth.token ?? ""}`;
    } else if (auth.type === "basic") {
      const raw = `${auth.username ?? ""}:${auth.password ?? ""}`;
      headers.Authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    } else if (auth.type === "apikey" && (auth.in ?? "header") === "header") {
      headers[auth.key ?? "X-API-Key"] = auth.value ?? "";
    }
  }

  return {
    endpoint,
    query,
    operationName,
    variables,
    headers,
    useGet: gql.useGet === true,
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

export { isSecretKey as SECRET_KEY_PATTERN };
