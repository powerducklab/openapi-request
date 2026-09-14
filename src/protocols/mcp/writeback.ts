import { deepClone, isPlainObject } from "../../core/utils";
import { err } from "../../core/errors";
import { discoverMcpCapabilities } from "./discovery";
import type { McpCapability } from "../../types";
import { generateAllMcpCalls, type GeneratedMcpCall } from "./generate";

export interface WriteMcpOptions {
  /** Overwrite an existing path for the same capability. Defaults to true. */
  overwrite?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  clientInfo?: { name: string; version: string };
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function pathFor(capability: McpCapability): string {
  const kindSegment = capability.kind === "tool" ? "tools" : capability.kind === "prompt" ? "prompts" : "resources";
  return `/mcp/${kindSegment}/${slug(capability.name)}`;
}

/**
 * "Upload" step: merge generated MCP calls into `spec.paths` as synthetic
 * POST operations carrying an `x-mcp` extension, each independently
 * addressable via `locateOperation({ operationId })` — the MCP counterpart of
 * {@link writeGraphQLOperations}.
 */
export function writeMcpOperations(
  spec: any,
  endpoint: string,
  calls: GeneratedMcpCall[],
  options: WriteMcpOptions = {},
): any {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw err("BAD_SPEC", "spec must be an object");
  }
  const overwrite = options.overwrite !== false;
  const next = deepClone(spec);
  if (!isPlainObject(next.paths)) next.paths = {};

  for (const call of calls) {
    const { capability } = call;
    const path = pathFor(capability);
    if (!overwrite && isPlainObject(next.paths[path])) continue;

    next.paths[path] = {
      post: {
        operationId: `mcp_${capability.kind}_${slug(capability.name)}`,
        summary: `MCP ${capability.kind}: ${capability.name}`,
        description: capability.description,
        "x-protocol": "mcp",
        "x-mcp": {
          endpoint,
          method: call.method,
          name: capability.kind === "resource" ? undefined : capability.name,
          uri: capability.kind === "resource" ? capability.uri ?? capability.uriTemplate : undefined,
          argumentsSchema: call.argumentsSchema,
          arguments: call.params.arguments,
        },
        requestBody: {
          content: { "application/json": { schema: call.argumentsSchema } },
        },
        responses: {
          "200": { description: "MCP JSON-RPC result." },
        },
        ...(call.notes.length ? { "x-mcp-notes": call.notes } : {}),
      },
    };
  }

  return next;
}

export interface DiscoverAndWriteMcpResult {
  spec: any;
  capabilities: McpCapability[];
  warnings: string[];
}

/**
 * One-shot "auto-fetch + upload" for MCP: handshake, list every tool,
 * resource and prompt the server exposes, sample arguments for each, and
 * merge the results into the document.
 */
export async function discoverAndWriteMcpCapabilities(
  spec: any,
  endpoint: string,
  options: WriteMcpOptions = {},
): Promise<DiscoverAndWriteMcpResult> {
  const discovery = await discoverMcpCapabilities(endpoint, options);
  const calls = generateAllMcpCalls(discovery.capabilities);
  const nextSpec = writeMcpOperations(spec, endpoint, calls, options);
  return { spec: nextSpec, capabilities: discovery.capabilities, warnings: discovery.warnings };
}
