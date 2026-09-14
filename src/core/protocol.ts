import type { SendOptions, ExecResult, ProtocolName } from "./types";
import type { LocatedOperation } from "../openapi/locate";

export interface AdapterContext {
  spec: any;
  options: SendOptions;
  located: LocatedOperation;
}

/**
 * Extra runtime facilities handed to `execute()`.
 * Optional so existing adapters keep compiling, but new adapters should honor
 * `signal` so long-lived streams can be cancelled deterministically.
 */
export interface ExecuteContext {
  /**
   * Aborted when the caller wants execution to stop. Adapters must tear down
   * sockets and settle their promise promptly, resolving with whatever has been
   * collected so far rather than rejecting.
   */
  signal?: AbortSignal;
}

/**
 * Every protocol implements this contract. `plan()` must be pure and
 * synchronous so callers can inspect or export the plan without side effects.
 */
export interface ProtocolAdapter<TPlan = unknown> {
  readonly name: string;

  /**
   * Return 0 (or any non-positive / non-finite value) when unsupported;
   * higher finite numbers win the resolution race. Must not throw — a throwing
   * adapter is treated as "unsupported".
   */
  supports(ctx: AdapterContext): number;

  plan(ctx: AdapterContext): TPlan;

  /**
   * Perform the call. Must always resolve for protocol-level failures and
   * report them via `ExecResult.error`; reject only for programming errors.
   */
  execute(
    plan: TPlan,
    options: SendOptions,
    ctx?: ExecuteContext,
  ): Promise<ExecResult>;

  /** Optional cleanup for adapters holding process-wide resources. */
  dispose?(): void | Promise<void>;
}

export interface SessionProtocolAdapter<TPlan, TSession> {
  readonly name: ProtocolName;

  supports(ctx: AdapterContext): number;

  plan(ctx: AdapterContext): TPlan;

  createSession(
    plan: TPlan,
    options: SendOptions,
    ctx?: ExecuteContext,
  ): TSession;
}
