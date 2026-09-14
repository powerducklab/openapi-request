import { sampleFromSchema } from "../../openapi/sample";
import type { McpCapability } from "../../types";

export interface GeneratedMcpCall {
  capability: McpCapability;
  /** JSON-RPC method for this capability. */
  method: "tools/call" | "resources/read" | "prompts/get";
  /** Sampled params, ready to send as-is or edit. */
  params: Record<string, unknown>;
  /** JSON Schema describing the editable portion of `params`. */
  argumentsSchema: any;
  notes: string[];
}

/**
 * Turn one discovered capability into a runnable call, sampling its
 * argument schema the same way the HTTP adapter samples request bodies.
 * This is the MCP counterpart of the gRPC adapter's `buildMessageTemplate`.
 */
export function generateMcpCall(capability: McpCapability): GeneratedMcpCall {
  const notes: string[] = [];

  if (capability.kind === "tool") {
    const schema = capability.inputSchema ?? { type: "object", properties: {} };
    const sampled = sampleFromSchema(schema);
    return {
      capability,
      method: "tools/call",
      params: { name: capability.name, arguments: sampled && typeof sampled === "object" ? sampled : {} },
      argumentsSchema: schema,
      notes,
    };
  }

  if (capability.kind === "prompt") {
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const arg of capability.arguments ?? []) {
      properties[arg.name] = { type: "string", description: arg.description };
      if (arg.required) required.push(arg.name);
    }
    const schema = { type: "object", properties, required };
    const sampled = sampleFromSchema(schema);
    return {
      capability,
      method: "prompts/get",
      params: { name: capability.name, arguments: sampled && typeof sampled === "object" ? sampled : {} },
      argumentsSchema: schema,
      notes,
    };
  }

  // Resource: identified by URI, not by a schema-shaped argument set. A
  // template (`uriTemplate`) still needs its `{placeholders}` filled in by
  // the caller, so it is surfaced as a note rather than guessed at.
  if (!capability.uri && capability.uriTemplate) {
    notes.push(`Resource "${capability.name}" is a template (${capability.uriTemplate}); fill in its placeholders before calling.`);
  }
  return {
    capability,
    method: "resources/read",
    params: { uri: capability.uri ?? capability.uriTemplate ?? "" },
    argumentsSchema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
    notes,
  };
}

export function generateAllMcpCalls(capabilities: McpCapability[]): GeneratedMcpCall[] {
  return capabilities.map(generateMcpCall);
}
