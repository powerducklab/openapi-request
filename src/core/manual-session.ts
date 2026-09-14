/**
 * Unified manual-session entry.
 *
 * `createManualSession(options)` routes by `options.kind` to the matching
 * protocol factory (WebSocket / MCP / gRPC). The factories themselves stay
 * protocol-specific so their richer contracts are preserved; this entry is
 * for callers that want one surface across all three.
 */
import type { AnyManualSession, ManualSessionOptions } from "../types";
import { createWsManualSession } from "../protocols/ws/session";
import { createMcpManualSession } from "../protocols/mcp/session";
import { createGrpcManualSession } from "../protocols/grpc/session";

export function createManualSession(
  options: ManualSessionOptions,
): AnyManualSession {
  if (!options || typeof options !== "object") {
    throw new Error("createManualSession requires an options object");
  }

  switch (options.kind) {
    case "websocket":
      return createWsManualSession(options);
    case "mcp":
      return createMcpManualSession(options);
    case "grpc":
      return createGrpcManualSession(options);
    default:
      throw new Error(
        `Unknown manual session kind: ${String((options as any).kind)}`,
      );
  }
}
