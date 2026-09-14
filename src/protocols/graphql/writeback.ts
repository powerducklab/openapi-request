import { deepClone, isPlainObject } from "../../core/utils";
import { err } from "../../core/errors";
import type {
  GeneratedOperation,
  WriteGraphQLOptions,
  DiscoverAndWriteResult,
} from "../../core/types";
import { introspectSchema } from "./introspection";
import { generateAllOperations } from "./generate";

/** Path under which one operation is filed: `/graphql/{type}/{field}`. */
function pathFor(op: GeneratedOperation): string {
  return `/graphql/${op.operationType}/${op.fieldName}`;
}

/**
 * "Upload" step: merge generated GraphQL operations into `spec.paths` as
 * synthetic POST operations carrying an `x-graphql` extension. Each becomes
 * independently addressable via `locateOperation({ operationId })`, exactly
 * like any hand-authored REST operation — this is what lets `send()` resolve
 * to the GraphQL adapter afterward.
 */
export function writeGraphQLOperations(
  spec: any,
  endpoint: string,
  operations: GeneratedOperation[],
  options: WriteGraphQLOptions = {},
): any {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw err("BAD_SPEC", "spec must be an object");
  }
  const overwrite = options.overwrite !== false;
  const next = deepClone(spec);
  if (!isPlainObject(next.paths)) next.paths = {};

  for (const op of operations) {
    const path = pathFor(op);
    if (!overwrite && isPlainObject(next.paths[path])) continue;

    next.paths[path] = {
      post: {
        operationId: `graphql_${op.operationType}_${op.fieldName}`,
        summary: `GraphQL ${op.operationType}: ${op.fieldName}`,
        "x-protocol": "graphql",
        "x-graphql": {
          endpoint,
          operationType: op.operationType,
          operationName: op.operationName,
          query: op.query,
          variablesSchema: op.variablesSchema,
        },
        requestBody: {
          required: op.variablesSchema.required.length > 0,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: op.variablesSchema.properties,
                required: op.variablesSchema.required,
              },
            },
          },
        },
        responses: {
          "200": { description: "GraphQL response envelope (data/errors)." },
        },
        ...(op.notes.length ? { "x-graphql-notes": op.notes } : {}),
      },
    };
  }

  return next;
}

/**
 * One-shot "auto-fetch query + upload": introspect the live schema, generate
 * a runnable document for every query/mutation/subscription field, and merge
 * the results into the document. This is the GraphQL counterpart of the gRPC
 * adapter's `discover()` + `buildMessageTemplate()` pair, collapsed into a
 * single call because GraphQL introspection already returns the whole schema
 * in one round trip.
 */
export async function discoverAndWriteGraphQLSchema(
  spec: any,
  endpoint: string,
  options: WriteGraphQLOptions = {},
): Promise<DiscoverAndWriteResult> {
  const { schema } = await introspectSchema(endpoint, {
    headers: options.headers,
    signal: options.signal,
  });
  const operations = generateAllOperations(schema);
  const warnings = operations.flatMap((op) =>
    op.notes.map((note) => `${op.operationType} ${op.fieldName}: ${note}`),
  );
  if (!operations.length) {
    warnings.push("Introspection succeeded but the schema declares no query, mutation or subscription fields.");
  }
  const nextSpec = writeGraphQLOperations(spec, endpoint, operations, options);
  return { spec: nextSpec, operations, warnings };
}
