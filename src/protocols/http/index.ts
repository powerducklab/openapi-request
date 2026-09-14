import type {
  ProtocolAdapter,
  AdapterContext,
  ExecuteContext,
} from "../../core/protocol";
import type { SendOptions, ExecResult } from "../../core/types";
import { buildCollection, type BuiltCollection } from "./collection";
import { buildEnvironment } from "./environment";
import { isStreamingOperation } from "./detect";
import { runWithPostman } from "./runner";

export { locateOperation } from "../../openapi/locate";
export { createResolver } from "../../openapi/deref";

export interface HttpPlan extends BuiltCollection {
  environment: Record<string, any>;
  streaming: boolean;
}

/**
 * Default adapter for HTTP and Server-Sent Events.
 * Both share a single postman-runtime execution path so that scripts,
 * variable scopes, cookies and auth helpers behave identically.
 */
export class HttpAdapter implements ProtocolAdapter<HttpPlan> {
  readonly name = "http";

  /** Lowest priority: acts as the fallback when no other adapter claims the operation. */
  supports(ctx: AdapterContext): number {
    const declared = ctx.located.operation?.["x-protocol"];
    if (
      typeof declared === "string" &&
      declared !== "http" &&
      declared !== "sse"
    )
      return 0;
    return 1;
  }

  plan(ctx: AdapterContext): HttpPlan {
    const built = buildCollection(ctx.located, ctx.spec, ctx.options);
    return {
      ...built,
      environment: buildEnvironment(
        `${ctx.spec?.info?.title ?? "API"} Environment`,
        built.baseUrl,
        ctx.options.variables,
      ),
      streaming: isStreamingOperation(
        ctx.located.operation,
        ctx.options.values,
      ),
    };
  }

  execute(
    plan: HttpPlan,
    options: SendOptions,
    ctx?: ExecuteContext,
  ): Promise<ExecResult> {
    return runWithPostman(
      {
        collectionJson: plan.collection,
        baseUrl: plan.baseUrl,
        streamingHint: plan.streaming,
      },
      options,
      ctx,
    );
  }
}

export { buildCollection } from "./collection";
export { buildEnvironment, resolveServerUrl } from "./environment";
export { SseParser } from "./sse-parser";
export { buildRunOptions } from "./runner-options";
export { runWithPostman } from "./runner";
export type { RunInput, StopReason } from "./runner";
