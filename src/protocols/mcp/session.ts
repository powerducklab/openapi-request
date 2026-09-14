/**
 * Long-lived, stateful MCP manual sessions.
 *
 * One session core drives both supported transports (Streamable HTTP and
 * stdio) through the `McpTransport` adapter in "./transport". The session
 * mirrors `createWsManualSession` / `createGrpcManualSession`: open, drive
 * list/call methods by hand, then close.
 */
import type {
  JsonRpcOutcome,
  McpListing,
  McpManualSession,
  McpManualSessionOptions,
  McpRequestOptions,
  McpSessionEvent,
  McpSessionState,
  McpStdioSessionOptions,
  McpTerminateOutcome,
} from "../../core/types";
import { isPlainObject, isSecretKey, safeStringify } from "../../core/utils";
import type {
  SessionEventDTO,
  SessionSubscription,
} from "../../core/session";
import { createEventHub } from "../../core/session";
import { err, toErrorInfo } from "../../core/errors";
import { isJsonRpcError, nextRequestId } from "./jsonrpc";
import {
  createHttpMcpTransport,
  createStdioMcpTransport,
  type McpTransport,
} from "./transport";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_EVENTS = 1000;
const MAX_LIST_PAGES = 1000;

/**
 * Result key per list method.
 *
 * `resources/templates/list` answers under `resourceTemplates`, NOT
 * `resources` — reading the wrong key silently yields zero templates.
 */
const LIST_RESULT_KEY = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resourceTemplates",
} as const;

type ListMethod = keyof typeof LIST_RESULT_KEY;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Depth-limited, cycle-safe redaction so events never leak credentials. */
function redact(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > 8) return "[depth-limit]";
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      isSecretKey(k) && v != null ? "[redacted]" : redact(v, depth + 1, seen);
  }
  return out;
}

/**
 * Combine caller signals with a timeout into one signal, and hand back a
 * disposer so the timer and listeners never outlive the request.
 */
function linkSignals(
  timeoutMs: number | undefined,
  ...signals: Array<AbortSignal | undefined>
): {
  signal: AbortSignal | undefined;
  dispose: () => void;
  timedOut: () => boolean;
} {
  const live = signals.filter((s): s is AbortSignal => !!s);
  const useTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
  if (!live.length && !useTimeout) {
    return { signal: undefined, dispose: () => {}, timedOut: () => false };
  }

  const controller = new AbortController();
  let didTimeout = false;
  const cleanups: Array<() => void> = [];

  for (const s of live) {
    if (s.aborted) {
      controller.abort((s as any).reason);
      break;
    }
    const onAbort = () => controller.abort((s as any).reason);
    s.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => s.removeEventListener("abort", onAbort));
  }

  if (useTimeout && !controller.signal.aborted) {
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Do not keep the event loop alive just for a timeout.
    (timer as any)?.unref?.();
    cleanups.push(() => clearTimeout(timer));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const fn of cleanups) fn();
    },
    timedOut: () => didTimeout,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(err("MCP_ABORTED", "Aborted while waiting to send."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyTerminate(status: number): McpTerminateOutcome {
  if (status >= 200 && status < 300) return "released";
  // 405: server declines to support session termination (legal per spec).
  if (status === 405) return "unsupported";
  // 404: server no longer knows this session; there is nothing left to free.
  if (status === 404) return "already-gone";
  return "failed";
}

/* ------------------------------------------------------------------ *
 * Transport resolution
 * ------------------------------------------------------------------ */

function validateHttpEndpoint(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("not http(s)");
    }
    return endpoint;
  } catch {
    throw err(
      "BAD_MCP_ENDPOINT",
      `MCP endpoint must be an absolute http(s) URL, received: ${endpoint}`,
    );
  }
}

function resolveTransport(options: McpManualSessionOptions): McpTransport {
  const transport = options.transport ?? "streamable-http";

  if (transport === "stdio") {
    if (!options.command || !String(options.command).trim()) {
      throw err(
        "BAD_MCP_STDIO_COMMAND",
        "MCP stdio sessions require a non-empty `command`.",
      );
    }
    return createStdioMcpTransport({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
    });
  }

  if (!options.endpoint) {
    throw err(
      "BAD_MCP_ENDPOINT",
      "MCP http sessions require an `endpoint` (or set transport: \"stdio\" with a `command`).",
    );
  }
  return createHttpMcpTransport({
    endpoint: validateHttpEndpoint(options.endpoint),
    headers: options.headers,
  });
}

/* ------------------------------------------------------------------ *
 * Session core
 * ------------------------------------------------------------------ */

/**
 * Build a manual session over any transport. All state, event recording,
 * pagination and close orchestration live here; only the wire differs.
 */
export function createMcpSessionCore(
  transport: McpTransport,
  options: McpManualSessionOptions,
): McpManualSession {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const shouldRedact = options.redactSecrets !== false;
  const serialize = options.serialize === true;

  const hub = createEventHub(
    "mcp",
    options.transport ?? "http",
    `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    options.maxEvents ?? DEFAULT_MAX_EVENTS,
  );

  let state: McpSessionState = "idle";
  /** Read through a call so TS never narrows the mutable closure variable. */
  const getState = (): McpSessionState => state;
  const setState = (next: McpSessionState): void => {
    state = next;
    hub.setState(next);
  };

  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let serverInfo: { name: string; version: string } | undefined;

  let openPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  /** In-flight requests, so close() can wait for them to settle. */
  const inflight = new Set<Promise<unknown>>();

  function record(event: McpSessionEvent): void {
    const payload = shouldRedact ? redact(event.parsed) : event.parsed;
    hub.emit({
      direction: event.direction,
      kind: event.event,
      at: event.at,
      state: getState(),
      data: event.data,
      meta: payload !== undefined ? { parsed: payload } : undefined,
    });
  }

  function headersForCall(): Record<string, string> {
    return {
      ...(options.headers ?? {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
  }

  function assertOpen(what: string): void {
    const current = getState();
    if (current === "open") return;
    if (current === "idle" || current === "connecting") {
      throw err(
        "MCP_NOT_OPEN",
        `Call open() before ${what}; session is "${current}".`,
      );
    }
    throw err("MCP_SESSION_CLOSED", `Cannot ${what} on a ${current} session.`);
  }

  async function track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(tracked);
    try {
      return await work;
    } finally {
      inflight.delete(tracked);
    }
  }

  async function open(): Promise<void> {
    const current = getState();
    if (current === "open") return;
    if (current === "connecting") return openPromise!;
    if (current === "closing" || current === "closed") {
      throw err(
        "MCP_SESSION_CLOSED",
        "This session has been closed; create a new one.",
      );
    }

    setState("connecting");
    const link = linkSignals(defaultTimeoutMs, options.signal);

    openPromise = (async () => {
      try {
        const session = await transport.open({
          clientInfo: options.clientInfo,
          capabilities: options.capabilities,
          signal: link.signal,
        });

        sessionId = session.sessionId;
        protocolVersion =
          session.protocolVersion ?? protocolVersion ?? undefined;
        serverInfo = session.serverInfo;
        setState("open");

        record({
          direction: "in",
          at: Date.now(),
          event: "session",
          parsed: { sessionId, protocolVersion, serverInfo },
        });
      } catch (e) {
        setState("closed");
        resolveClosed();
        const info = toErrorInfo(e);
        record({
          direction: "meta",
          at: Date.now(),
          event: "error",
          parsed: info,
        });
        if (link.timedOut()) {
          throw err(
            "MCP_TIMEOUT",
            `initialize timed out after ${defaultTimeoutMs}ms`,
            info,
          );
        }
        throw e;
      } finally {
        link.dispose();
        openPromise = undefined;
      }
    })();

    return openPromise;
  }

  /** One raw JSON-RPC exchange. Does not interpret the result. */
  async function dispatch(
    body: Record<string, unknown>,
    opts: McpRequestOptions | undefined,
    kind: "jsonrpc" | "notification",
  ): Promise<JsonRpcOutcome> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    const link = linkSignals(timeoutMs, options.signal, opts?.signal);

    try {
      if (opts?.delayMs) await sleep(opts.delayMs, link.signal);

      record({ direction: "out", at: Date.now(), event: kind, parsed: body });

      const init = {
        signal: link.signal,
        timeoutMs,
        startedAt: Date.now(),
        protocolVersion,
        sessionId,
        headers: headersForCall(),
      };

      const outcome =
        kind === "notification"
          ? await transport.notify(body, init)
          : await transport.call(body, init);

      // A server may rotate/assign the session id mid-flight.
      if (outcome.sessionId && outcome.sessionId !== sessionId) {
        sessionId = outcome.sessionId;
        record({
          direction: "meta",
          at: Date.now(),
          event: "lifecycle",
          parsed: { sessionIdChanged: sessionId },
        });
      }

      record({
        direction: "in",
        at: Date.now(),
        event: kind,
        parsed:
          outcome.message ?? {
            status: outcome.status,
            statusText: outcome.statusText,
            empty: true,
          },
      });

      // 404 means the server dropped our session; nothing can be reused.
      if (outcome.status === 404 && sessionId) {
        setState("closed");
        resolveClosed();
        throw err(
          "MCP_SESSION_EXPIRED",
          `Server no longer recognises session ${sessionId} (HTTP 404).`,
        );
      }

      return outcome;
    } catch (e) {
      const info = toErrorInfo(e);
      record({
        direction: "meta",
        at: Date.now(),
        event: "error",
        parsed: info,
      });
      if (link.timedOut()) {
        throw err(
          "MCP_TIMEOUT",
          `${String(body.method)} timed out after ${timeoutMs}ms`,
          info,
        );
      }
      throw e;
    } finally {
      link.dispose();
    }
  }

  async function request<T = any>(
    method: string,
    params?: unknown,
    opts?: McpRequestOptions,
  ): Promise<T> {
    if (typeof method !== "string" || !method) {
      throw err(
        "BAD_MCP_METHOD",
        "request() requires a non-empty method name.",
      );
    }
    assertOpen(`request("${method}")`);

    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: nextRequestId(),
      method,
      ...(params === undefined ? {} : { params }),
    };

    const outcome = await track(dispatch(body, opts, "jsonrpc"));

    if (opts?.raw) return outcome as unknown as T;

    if (isJsonRpcError(outcome.message)) {
      throw err(
        "MCP_RPC_ERROR",
        `${method} failed (${outcome.message.error.code}): ${outcome.message.error.message}`,
        outcome.message.error,
      );
    }
    if (outcome.message === undefined) {
      throw err(
        "MCP_EMPTY_RESPONSE",
        `${method} returned no JSON-RPC message (HTTP ${outcome.status} ${outcome.statusText}).`,
      );
    }
    return outcome.message.result as T;
  }

  /** Escape hatch: send a hand-written message verbatim. */
  async function send(
    message: unknown,
    opts?: McpRequestOptions,
  ): Promise<JsonRpcOutcome> {
    assertOpen("send()");

    const payload = isPlainObject(message)
      ? message
      : typeof message === "string"
        ? { method: message }
        : undefined;

    if (!payload || typeof payload.method !== "string" || !payload.method) {
      throw err(
        "BAD_MCP_MESSAGE",
        "send() expects a method name or an object with a string `method`.",
      );
    }

    const isNotification = payload.method.startsWith("notifications/");

    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      ...payload,
      // Caller-supplied id wins; otherwise assign one unless it's a notification.
      ...(payload.id !== undefined
        ? { id: payload.id }
        : isNotification
          ? {}
          : { id: nextRequestId() }),
    };

    return track(
      dispatch(body, opts, isNotification ? "notification" : "jsonrpc"),
    );
  }

  async function notify(
    method: string,
    params?: unknown,
    opts?: McpRequestOptions,
  ): Promise<void> {
    if (typeof method !== "string" || !method) {
      throw err("BAD_MCP_METHOD", "notify() requires a non-empty method name.");
    }
    assertOpen(`notify("${method}")`);
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    await track(dispatch(body, opts, "notification"));
  }

  async function paginate(
    method: ListMethod,
    opts?: McpRequestOptions,
  ): Promise<McpListing<any>> {
    const key = LIST_RESULT_KEY[method];
    const items: any[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    for (;;) {
      const result: any = await request(method, cursor ? { cursor } : {}, opts);
      pages += 1;
      if (Array.isArray(result?.[key])) items.push(...result[key]);

      const next =
        typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!next) break;
      if (seenCursors.has(next) || pages >= MAX_LIST_PAGES) {
        record({
          direction: "meta",
          at: Date.now(),
          event: "lifecycle",
          parsed: {
            warning: `${method} pagination stopped (repeated or excessive cursors)`,
          },
        });
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }

    return { items, pages };
  }

  async function close(): Promise<void> {
    if (getState() === "closed") return;
    if (getState() === "closing") return closePromise!;
    if (getState() === "idle") {
      setState("closed");
      resolveClosed();
      await transport.dispose();
      return;
    }
    if (getState() === "connecting") {
      await openPromise?.catch(() => undefined);
      // open() may have failed and already closed us.
      if (getState() === "closed") return;
    }

    setState("closing");
    closePromise = (async () => {
      // Let outstanding requests settle before tearing the session down.
      await Promise.allSettled([...inflight]);

      if (sessionId) {
        const link = linkSignals(defaultTimeoutMs);
        try {
          const outcome = await transport.terminate({
            sessionId,
            protocolVersion,
            signal: link.signal,
            headers: options.headers,
          });
          record({
            direction: "meta",
            at: Date.now(),
            event: "lifecycle",
            parsed: {
              terminate: outcome.status,
              outcome: outcome.outcome,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
            },
          });
        } catch (e) {
          record({
            direction: "meta",
            at: Date.now(),
            event: "error",
            parsed: { terminate: "failed", reason: toErrorInfo(e).message },
          });
        } finally {
          link.dispose();
        }
      }

      await transport.dispose();

      setState("closed");
      resolveClosed();
      closePromise = undefined;
    })();

    return closePromise;
  }

  // Session-wide abort should tear things down, not leave a zombie.
  if (options.signal) {
    if (options.signal.aborted) {
      setState("closed");
      resolveClosed();
    } else {
      options.signal.addEventListener(
        "abort",
        () => void close().catch(() => undefined),
        { once: true },
      );
    }
  }

  const session: McpManualSession = {
    get protocol(): "mcp" {
      return "mcp";
    },
    get state() {
      return getState();
    },

    get events(): readonly SessionEventDTO[] {
      return hub.events;
    },

    onEvent(
      listener: (event: SessionEventDTO) => void,
    ): SessionSubscription {
      return hub.onEvent(listener);
    },
    get sessionId() {
      return sessionId;
    },
    get protocolVersion() {
      return protocolVersion;
    },
    get serverInfo() {
      return serverInfo;
    },

    open,
    request,
    send,
    notify,

    ping: (opts) => request<void>("ping", {}, opts).then(() => undefined),

    listTools: (opts) => paginate("tools/list", opts),
    listPrompts: (opts) => paginate("prompts/list", opts),
    listResources: (opts) => paginate("resources/list", opts),
    listResourceTemplates: (opts) =>
      paginate("resources/templates/list", opts),

    async listSources(opts) {
      const run = async (): Promise<
        Array<PromiseSettledResult<McpListing<any>>>
      > => {
        if (serialize) {
          const out: Array<PromiseSettledResult<McpListing<any>>> = [];
          for (const method of [
            "resources/list",
            "resources/templates/list",
          ] as const) {
            try {
              out.push({ status: "fulfilled", value: await paginate(method, opts) });
            } catch (reason) {
              out.push({ status: "rejected", reason });
            }
          }
          return out;
        }
        return Promise.allSettled([
          paginate("resources/list", opts),
          paginate("resources/templates/list", opts),
        ]);
      };

      const settled = await run();
      if (settled.every((r) => r.status === "rejected")) {
        throw (settled[0] as PromiseRejectedResult).reason;
      }

      const items: any[] = [];
      let pages = 0;
      for (const r of settled) {
        if (r.status === "fulfilled") {
          items.push(...r.value.items);
          pages += r.value.pages;
        }
      }
      return { items, pages };
    },

    callTool(nameOrCall, args, opts) {
      if (nameOrCall && typeof nameOrCall === "object") {
        const call = nameOrCall as { name: string; arguments?: Record<string, unknown>; opts?: McpRequestOptions };
        if (!call.name) throw err("BAD_MCP_TARGET", "callTool() requires a tool name.");
        return request("tools/call", { name: call.name, arguments: call.arguments ?? {} }, call.opts ?? opts);
      }
      const name = nameOrCall as string;
      if (!name) throw err("BAD_MCP_TARGET", "callTool() requires a tool name.");
      return request("tools/call", { name, arguments: (args ?? {}) as Record<string, unknown> }, opts);
    },

    getPrompt(name, args, opts) {
      if (!name) {
        throw err("BAD_MCP_TARGET", "getPrompt() requires a prompt name.");
      }
      return request("prompts/get", { name, arguments: args ?? {} }, opts);
    },

    readResource(uri, opts) {
      if (!uri) throw err("BAD_MCP_TARGET", "readResource() requires a uri.");
      return request("resources/read", { uri }, opts);
    },

    close,
    waitForClose: () => closed,
  };

  (session as any)[Symbol.asyncDispose] = () => close();
  return session;
}

/* ------------------------------------------------------------------ *
 * Public factories
 * ------------------------------------------------------------------ */

/**
 * Create a manual MCP session over either transport.
 *
 * - `{ transport: "streamable-http", endpoint }` (default)
 * - `{ transport: "stdio", command, args?, cwd?, env? }`
 */
export function createMcpManualSession(
  options: McpManualSessionOptions,
): McpManualSession {
  if (!options || typeof options !== "object") {
    throw err("BAD_MCP_ENDPOINT", "MCP session options are required.");
  }
  const transport = resolveTransport(options);
  return createMcpSessionCore(transport, options);
}

/** stdio-only convenience factory. */
export function createMcpStdioSession(
  options: McpStdioSessionOptions,
): McpManualSession {
  return createMcpManualSession({ ...options, transport: "stdio" });
}

/** @deprecated Use {@link createMcpManualSession}. */
export const runMcpManualSession = createMcpManualSession;
