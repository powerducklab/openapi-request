/**
 * The full-featured debugger entry: adapter registry + protocol dispatch +
 * OpenAPI write-back pipeline, plus `sendMany` and `toCollection`.
 *
 * `createClient` in "./client" is the UI-first surface (prepare/connect/
 * discover); this one stays as the workhorse for scripted flows. Both share
 * the same adapters and the same write-back machinery.
 */
import { AdapterRegistry } from "./registry";
import type { ProtocolAdapter, ExecuteContext } from "./protocol";
import { HttpAdapter } from "../protocols/http";
import { WebSocketAdapter } from "../protocols/ws";
import { GraphQLAdapter } from "../protocols/graphql";
import { McpAdapter } from "../protocols/mcp";
import { GrpcProtocolAdapter } from "../protocols/grpc/openapi";
import { locateOperation, type LocatedOperation } from "../openapi/locate";
import {
  toResponseObject,
  writeBackResponse,
  type WriteBackOptions,
  type ToResponseOptions,
} from "../openapi/writeback";
import type {
  SendOptions,
  SendResult,
  OperationTarget,
  ExecResult,
  ProtocolName,
} from "../types";
import { err, ProtoKitError, toErrorInfo } from "./errors";

export interface DebuggerOptions {
  adapters?: ProtocolAdapter<any>[];
  extraAdapters?: ProtocolAdapter<any>[];
  writeBack?: WriteBackOptions;
  response?: ToResponseOptions;

  /**
   * Write back a schema inferred from a truncated stream.
   *
   * @default true
   */
  writeBackTruncated?: boolean;
}

export interface PlanResult {
  protocol: ProtocolName | string;
  located: LocatedOperation;
  collection?: any;
  environment?: any;
  streaming?: boolean;
  warnings?: string[];
  plan: unknown;
}

export interface SendManyFailure {
  target: OperationTarget;
  error: string;
}

export interface SendManyResult {
  spec: any;
  results: Array<SendResult | SendManyFailure>;
}

export function createDebugger(config: DebuggerOptions = {}) {
  const registry = new AdapterRegistry();

  const base = config.adapters ?? [
    new HttpAdapter(),
    new WebSocketAdapter(),
    new GraphQLAdapter(),
    new McpAdapter(),
    new GrpcProtocolAdapter(),
  ];

  for (const adapter of [...base, ...(config.extraAdapters ?? [])]) {
    registry.register(adapter);
  }

  const prepare = (options: SendOptions) => {
    if (!options || typeof options !== "object") {
      throw err("BAD_OPTIONS", "send() requires an options object");
    }

    if (!options.spec || typeof options.spec !== "object") {
      throw err("BAD_OPTIONS", "send() requires options.spec");
    }

    const located = locateOperation(options.spec, options.target);

    const ctx = {
      spec: options.spec,
      options,
      located,
    };

    const adapter = registry.resolve(ctx);
    const plan = adapter.plan(ctx);

    return {
      located,
      adapter,
      plan,
    };
  };

  const execute = async (
    adapter: ProtocolAdapter<any>,
    plan: unknown,
    options: SendOptions,
  ): Promise<ExecResult> => {
    const ctx: ExecuteContext | undefined = options.signal
      ? { signal: options.signal }
      : undefined;

    try {
      return await adapter.execute(plan, options, ctx);
    } catch (error) {
      if (ProtoKitError.isProtoKitError(error)) {
        throw error;
      }

      throw err(
        "EXECUTION_FAILED",
        `Adapter "${adapter.name}" failed: ${toErrorInfo(error).message}`,
        error,
      );
    }
  };

  function toCollection(
    spec: any,
    target: OperationTarget,
    overrides: Partial<Omit<SendOptions, "spec" | "target">> = {},
  ): PlanResult {
    const options = {
      ...overrides,
      spec,
      target,
    } as SendOptions;

    const { located, adapter, plan } = prepare(options);

    const anyPlan = plan as any;

    return {
      protocol: adapter.name,
      located,
      collection: anyPlan?.collection,
      environment: anyPlan?.environment,
      streaming: anyPlan?.streaming,
      warnings: Array.isArray(anyPlan?.warnings) ? anyPlan.warnings : undefined,
      plan,
    };
  }

  async function send(options: SendOptions): Promise<SendResult> {
    const { located, adapter, plan } = prepare(options);

    const result = await execute(adapter, plan, options);

    const anyPlan = plan as any;

    const warnings: string[] = Array.isArray(anyPlan?.warnings)
      ? [...anyPlan.warnings]
      : [];

    let fragment: {
      response: any;
      statusCode: string;
    };

    let fragmentError: string | undefined;

    try {
      fragment = toResponseObject(result, config.response);
    } catch (error) {
      fragmentError = `response fragment error: ${toErrorInfo(error).message}`;

      fragment = {
        response: {
          description: "Fragment generation failed",
        },
        statusCode: String(result.response.status || "default"),
      };

      warnings.push(fragmentError);
    }

    let patchedSpec: any;
    let writeBackSkippedReason: string | undefined;

    if (fragmentError) {
      writeBackSkippedReason = fragmentError;
    } else if (options.writeBack === false) {
      writeBackSkippedReason = "disabled by options.writeBack";
    } else if (result.response.status <= 0) {
      writeBackSkippedReason = "no response was received";
    } else if (result.scripts?.skipped) {
      writeBackSkippedReason = "request was skipped by a script";
    } else if (
      config.writeBack?.requirePassingTests !== false &&
      result.scripts?.passed === false
    ) {
      writeBackSkippedReason = "one or more assertions failed";
    } else if (
      result.response.truncated &&
      config.writeBackTruncated === false
    ) {
      writeBackSkippedReason = `stream was truncated (${
        result.response.stopReason ?? "unknown limit"
      })`;
    } else {
      if (result.response.truncated) {
        warnings.push(
          `Schema inferred from a truncated stream (${
            result.response.stopReason ?? "unknown limit"
          }); fields appearing later were not observed.`,
        );
      }

      if (result.response.droppedEvents) {
        warnings.push(
          `${
            result.response.droppedEvents
          } event(s) exceeded the size caps and were not fully retained.`,
        );
      }

      try {
        patchedSpec = writeBackResponse(
          options.spec,
          located.path,
          located.method,
          fragment,
          config.writeBack,
        );
      } catch (error) {
        writeBackSkippedReason = `write-back error: ${
          toErrorInfo(error).message
        }`;
      }
    }

    return {
      ...result,
      collection: anyPlan?.collection,
      environment: anyPlan?.environment,
      responseFragment: fragment.response,
      responseStatusCode: fragment.statusCode,
      patchedSpec,
      writeBackSkippedReason,
      ...(warnings.length ? { writeBackWarnings: warnings } : {}),
    };
  }

  async function sendMany(
    spec: any,
    targets: Array<
      {
        target: OperationTarget;
      } & Partial<Omit<SendOptions, "spec" | "target">>
    >,
    shared: Partial<Omit<SendOptions, "spec" | "target">> = {},
  ): Promise<SendManyResult> {
    if (!Array.isArray(targets)) {
      throw err("BAD_OPTIONS", "sendMany() requires an array of targets");
    }

    let working = spec;

    const results: Array<SendResult | SendManyFailure> = [];

    for (const entry of targets) {
      const signal = entry.signal ?? shared.signal;

      if (signal?.aborted) {
        results.push({
          target: entry.target,
          error: "aborted",
        });
        continue;
      }

      try {
        const result = await send({
          ...shared,
          ...entry,
          spec: working,
        } as SendOptions);

        if (result.patchedSpec) {
          working = result.patchedSpec;
        }

        results.push(result);
      } catch (error) {
        results.push({
          target: entry.target,
          error: toErrorInfo(error).message,
        });
      }
    }

    return {
      spec: working,
      results,
    };
  }

  return {
    registry,
    toCollection,
    send,
    sendMany,
  };
}

export type ProtoKit = ReturnType<typeof createDebugger>;
