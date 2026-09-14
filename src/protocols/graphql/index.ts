import type {
  ProtocolAdapter,
  AdapterContext,
  ExecuteContext,
} from "../../core/protocol";
import type { SendOptions, ExecResult } from "../../core/types";
import { resolveGraphQLConfig, type ResolvedGraphQLConfig } from "./config";
import { runGraphQL } from "./client";
import { isSecretKey } from "../../core/utils";

export interface GraphQLPlan {
  config: ResolvedGraphQLConfig;
  environment: Record<string, any>;
}


/**
 * GraphQL adapter.
 *
 * An operation is claimed when it declares `x-protocol: graphql`, carries an
 * `x-graphql` extension (normally produced by
 * {@link writeGraphQLOperations}), or the caller passes `options.graphql`.
 * GraphQL is transported over plain HTTP, but the request/response shape
 * (a single query document plus a data/errors envelope) does not fit the
 * Postman-collection pipeline the HTTP adapter is built around, so it gets
 * its own adapter — the same reasoning that gives WebSocket its own.
 */
export class GraphQLAdapter implements ProtocolAdapter<GraphQLPlan> {
  readonly name = "graphql";

  supports(ctx: AdapterContext): number {
    const operation = ctx.located.operation ?? {};
    if (operation["x-protocol"] === "graphql") return 20;
    if (isPlainObject(operation["x-graphql"])) return 15;
    if (ctx.options.graphql?.query || ctx.options.graphql?.endpoint) return 15;
    if (ctx.located.pathItem?.["x-protocol"] === "graphql") return 12;
    return 0;
  }

  plan(ctx: AdapterContext): GraphQLPlan {
    const config = resolveGraphQLConfig(ctx.located, ctx.spec, ctx.options);
    const values = [
      { key: "graphqlEndpoint", value: config.endpoint, type: "default", enabled: true },
      ...Object.entries(ctx.options.variables ?? {})
        .filter(([key]) => key !== "graphqlEndpoint")
        .map(([key, value]) => ({
          key,
          value: value == null ? "" : String(value),
          type: isSecretKey(key) ? "secret" : "default",
          enabled: true,
        })),
    ];

    return {
      config,
      environment: {
        id: `protokit-graphql-env-${Date.now().toString(36)}-${(
          (Math.random() * 0xffffff) |
          0
        ).toString(36)}`,
        name: `${ctx.spec?.info?.title ?? "API"} GraphQL Environment`,
        values,
        _postman_variable_scope: "environment",
        _postman_exported_at: new Date().toISOString(),
      },
    };
  }

  execute(
    plan: GraphQLPlan,
    options: SendOptions,
    ctx?: ExecuteContext,
  ): Promise<ExecResult> {
    return runGraphQL(plan.config, options, ctx);
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export { resolveGraphQLConfig } from "./config";
export { runGraphQL } from "./client";
export { introspectSchema, INTROSPECTION_QUERY } from "./introspection";
export { generateOperation, generateAllOperations } from "./generate";
export {
  writeGraphQLOperations,
  discoverAndWriteGraphQLSchema,
} from "./writeback";
export type {
  DiscoverAndWriteResult,
  GeneratedOperation,
  GraphQLArg,
  GraphQLFieldInfo,
  GraphQLNamedType,
  GraphQLTypeRef,
  IntrospectedSchema,
  IntrospectionResult,
  WriteGraphQLOptions,
} from "../../types";
