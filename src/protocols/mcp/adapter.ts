import type {
  ProtocolAdapter,
  AdapterContext,
  ExecuteContext,
} from "../../core/protocol";
import type { SendOptions, ExecResult } from "../../core/types";
import { resolveMcpConfig, type ResolvedMcpConfig } from "./config";
import { runMcp } from "./client";
import { isPlainObject, isSecretKey } from "../../core/utils";

export interface McpPlan {
  config: ResolvedMcpConfig;
  environment: Record<string, any>;
}


/**
 * MCP (Model Context Protocol) adapter, supporting Streamable HTTP and stdio transports.
 *
 * An operation is claimed when it declares `x-protocol: mcp`, carries an
 * `x-mcp` extension (normally produced by {@link writeMcpOperations}), or the
 * caller passes `options.mcp`. Like GraphQL, MCP is one JSON-RPC call over
 * plain HTTP rather than a Postman-shaped request/response, so it gets its
 * own adapter instead of routing through the HTTP one.
 */
export class McpAdapter implements ProtocolAdapter<McpPlan> {
  readonly name = "mcp";

  supports(ctx: AdapterContext): number {
    const operation = ctx.located.operation ?? {};
    if (operation["x-protocol"] === "mcp") return 20;
    if (isPlainObject(operation["x-mcp"])) return 15;
    if (ctx.options.mcp?.method || ctx.options.mcp?.endpoint || ctx.options.mcp?.command || ctx.options.mcp?.transport) return 15;
    if (ctx.located.pathItem?.["x-protocol"] === "mcp") return 12;
    return 0;
  }

  plan(ctx: AdapterContext): McpPlan {
    const config = resolveMcpConfig(ctx.located, ctx.spec, ctx.options);
    const values = [
      ...(config.transport === "streamable-http" ? [{ key: "mcpEndpoint", value: config.endpoint ?? "", type: "default", enabled: true }] : [{ key: "mcpTransport", value: "stdio", type: "default", enabled: true }, { key: "mcpCommand", value: config.command ?? "", type: "default", enabled: true }, { key: "mcpArgs", value: JSON.stringify(config.args ?? []), type: "default", enabled: true }, ...(config.cwd ? [{ key: "mcpCwd", value: config.cwd, type: "default", enabled: true }] : [])]),
      ...Object.entries(ctx.options.variables ?? {})
        .filter(([key]) => !["mcpEndpoint", "mcpTransport", "mcpCommand", "mcpArgs", "mcpCwd"].includes(key))
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
        id: `protokit-mcp-env-${Date.now().toString(36)}-${(
          (Math.random() * 0xffffff) |
          0
        ).toString(36)}`,
        name: `${ctx.spec?.info?.title ?? "API"} MCP Environment`,
        values,
        _postman_variable_scope: "environment",
        _postman_exported_at: new Date().toISOString(),
      },
    };
  }

  execute(
    plan: McpPlan,
    options: SendOptions,
    ctx?: ExecuteContext,
  ): Promise<ExecResult> {
    return runMcp(plan.config, options, ctx);
  }
}

export { resolveMcpConfig } from "./config";
export { runMcp } from "./client";
export {
  initializeSession,
  discoverMcpCapabilities,
  MCP_PROTOCOL_VERSION,
} from "./discovery";
export type {
  McpCapability,
  McpTool,
  McpResource,
  McpPrompt,
  McpDiscoveryResult,
} from "../../types";
export { generateMcpCall, generateAllMcpCalls } from "./generate";
export type { GeneratedMcpCall } from "./generate";
export { writeMcpOperations, discoverAndWriteMcpCapabilities } from "./writeback";
export type { WriteMcpOptions, DiscoverAndWriteMcpResult } from "./writeback";