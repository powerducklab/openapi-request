import { err } from "../../core/errors";
import type {
  GraphQLArg,
  GraphQLFieldInfo,
  GraphQLNamedType,
  GraphQLTypeRef,
  IntrospectedSchema,
  IntrospectionResult,
} from "../../core/types";

/** Standard GraphQL introspection query (spec-October2021), trimmed of directive locations we don't use. */
export const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType { kind name }
          }
        }
      }
    }
  }
}
`.trim();

/**
 * Auto-fetch a GraphQL server's schema via the standard introspection query.
 * This is the GraphQL analogue of the gRPC reflection handshake: one round
 * trip yields every operation the endpoint exposes.
 */
export async function introspectSchema(
  endpoint: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<IntrospectionResult> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      body: JSON.stringify({
        operationName: "IntrospectionQuery",
        query: INTROSPECTION_QUERY,
      }),
      signal: init.signal,
    });
  } catch (e) {
    throw err(
      "GRAPHQL_INTROSPECTION_FAILED",
      `Could not reach GraphQL endpoint for introspection: ${(e as Error)?.message ?? e}`,
      undefined,
      { cause: e },
    );
  }

  let body: any;
  try {
    body = await response.json();
  } catch (e) {
    throw err(
      "GRAPHQL_INTROSPECTION_FAILED",
      `Introspection response was not valid JSON (HTTP ${response.status})`,
      undefined,
      { cause: e },
    );
  }

  if (!response.ok || !body?.data?.__schema) {
    const message =
      Array.isArray(body?.errors) && body.errors.length
        ? body.errors.map((e: any) => e?.message).filter(Boolean).join("; ")
        : `HTTP ${response.status}`;
    throw err(
      "GRAPHQL_INTROSPECTION_FAILED",
      `Introspection failed: ${message}. The server may have introspection disabled.`,
    );
  }

  const raw = body.data.__schema;
  const types = new Map<string, GraphQLNamedType>();
  for (const t of raw.types ?? []) {
    if (!t?.name || typeof t.name !== "string") continue;
    // The reserved __-prefixed meta types clutter operation discovery.
    if (t.name.startsWith("__")) continue;
    types.set(t.name, t);
  }

  return {
    schema: {
      queryType: raw.queryType?.name ?? undefined,
      mutationType: raw.mutationType?.name ?? undefined,
      subscriptionType: raw.subscriptionType?.name ?? undefined,
      types,
    },
    raw,
  };
}
