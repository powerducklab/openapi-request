import http from "node:http";
import https from "node:https";
import runtime from "postman-runtime";
import sdk from "postman-collection";
import type {
  SendOptions,
  ExecResult,
  StreamEvent,
  ScriptReport,
  AssertionResult,
  ConsoleLog,
  ScriptOutcome,
  ReplayRecord,
} from "../../core/types";
import type { ExecuteContext } from "../../core/protocol";
import { err, toErrorInfo } from "../../core/errors";
import {
  createLatch,
  jsonClone,
  positiveInt,
  safeClearTimeout,
  tryParseJson,
} from "../../core/utils";
import { SseParser } from "./sse-parser";
import { isSseContentType, isStreamingContentType } from "./detect";
import { buildRunOptions } from "./runner-options";

/**
 * Lifecycle of a single HTTP run.
 *
 * initialized -> headers -> streaming -> stopping -> finalized
 *
 * Every exit path funnels through `finalize()`, which is idempotent, so a
 * watchdog firing concurrently with `done` cannot produce two results or flush
 * the parser twice.
 */
type RunPhase =
  | "initialized"
  | "headers"
  | "streaming"
  | "stopping"
  | "finalized";

/** Why sampling ended, surfaced on the result so callers can distinguish causes. */
export type StopReason =
  | "maxEvents"
  | "maxStreamMs"
  | "maxResponseSize"
  | "aborted"
  | "hardTimeout";

/** Flatten a Postman HeaderList into a plain object. */
function headersOf(headerList: any): Record<string, string> {
  const out: Record<string, string> = {};
  const all = typeof headerList?.all === "function" ? headerList.all() : [];
  for (const entry of all ?? []) {
    if (!entry || entry.disabled) continue;
    const key = String(entry.key ?? "");
    if (!key) continue;
    // Repeated headers are joined, matching how HTTP semantics treat them.
    out[key] = out[key]
      ? `${out[key]}, ${String(entry.value ?? "")}`
      : String(entry.value ?? "");
  }
  return out;
}

/** Snapshot a VariableScope as a plain key/value map. */
function scopeToObject(scope: any): Record<string, string> | undefined {
  if (!scope) return undefined;
  try {
    const source = scope.values ?? scope;
    const list = typeof source.toJSON === "function" ? source.toJSON() : source;
    if (!Array.isArray(list)) return undefined;
    const out: Record<string, string> = {};
    for (const entry of list) {
      if (!entry || entry.enabled === false || entry.key == null) continue;
      const key = String(entry.key);
      // Never let a scope key land on Object.prototype.
      if (key === "__proto__" || key === "constructor") continue;
      out[key] = entry.value == null ? "" : String(entry.value);
    }
    return out;
  } catch {
    return undefined;
  }
}


function extractRequestBody(request: any): unknown {
  const body = request?.body;
  if (!body) return undefined;
  try {
    if (body.mode === "raw") return body.raw;
    if (typeof body.toString === "function") {
      const text = body.toString();
      return text || undefined;
    }
    return jsonClone(body);
  } catch {
    return undefined;
  }
}

/**
 * Agents that remember every socket they open.
 *
 * `run.abort()` only stops the runtime from scheduling further work; the socket
 * belonging to the in-flight request keeps streaming, which is why an endless
 * SSE response used to hang until the hard timeout. Owning the sockets gives us
 * a real cancellation primitive.
 */
interface SocketTracker {
  agents: { http: http.Agent; https: https.Agent };
  destroyAll(): number;
}

function createSocketTracker(): SocketTracker | null {
  try {
    const sockets = new Set<any>();

    const remember = (socket: any) => {
      if (!socket || typeof socket.destroy !== "function") return socket;
      sockets.add(socket);
      const forget = () => sockets.delete(socket);
      socket.once?.("close", forget);
      socket.once?.("error", forget);
      return socket;
    };

    // keepAlive stays off: a pooled socket could outlive the run and be handed
    // to an unrelated request after we destroyed it.
    const httpAgent = new http.Agent({ keepAlive: false });
    const httpsAgent = new https.Agent({ keepAlive: false });

    (httpAgent as any).createConnection = function (opts: any, cb: any) {
      return remember(
        http.Agent.prototype.createConnection.call(this, opts, cb),
      );
    };
    (httpsAgent as any).createConnection = function (opts: any, cb: any) {
      return remember(
        https.Agent.prototype.createConnection.call(this, opts, cb),
      );
    };

    return {
      agents: { http: httpAgent, https: httpsAgent },
      destroyAll() {
        let count = 0;
        for (const socket of Array.from(sockets)) {
          try {
            socket.destroy();
            count += 1;
          } catch {
            /* Already closed. */
          }
        }
        sockets.clear();
        try {
          httpAgent.destroy();
          httpsAgent.destroy();
        } catch {
          /* ignore */
        }
        return count;
      },
    };
  } catch {
    // If the agent shape ever changes, fall back to abort-only behaviour.
    return null;
  }
}

export interface RunInput {
  collectionJson: any;
  baseUrl: string;
  /** Derived from the spec; the live content-type still has the final say. */
  streamingHint: boolean;
}

export function runWithPostman(
  input: RunInput,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  const latch = createLatch<ExecResult>();

  // ---- Run state ----
  const startedAt = Date.now();
  let phase: RunPhase = "initialized";
  let firstByteAt: number | undefined;
  let streaming = input.streamingHint;
  let truncated = false;
  let stopReason: StopReason | undefined;
  let networkDurationMs: number | undefined;

  const maxEvents = positiveInt(options.maxEvents, 100);
  const maxStreamMs = positiveInt(options.maxStreamMs, 30_000);
  const requestTimeout = positiveInt(
    options.runner?.timeout?.request ?? options.timeout,
    30_000,
  );
  const maxResponseSize =
    typeof options.maxResponseSize === "number"
      ? options.maxResponseSize
      : undefined;

  const parser = new SseParser({
    maxBufferChars: options.maxBufferChars,
    maxEventChars: options.maxEventChars,
    inheritEventId: options.inheritEventId,
  });
  const events: StreamEvent[] = [];
  const bodyChunks: Buffer[] = [];
  let receivedBytes = 0;
  let sawResponseData = false;

  const report: ScriptReport = {
    prerequest: [],
    test: [],
    assertions: [],
    console: [],
    passed: true,
    skipped: false,
  };
  const replays: ReplayRecord[] = [];

  let captured: ExecResult | null = null;
  let runHandle: any = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let stopFuse: ReturnType<typeof setTimeout> | null = null;
  let detachSignal: (() => void) | null = null;

  const tracker = hasUserAgents(options) ? null : createSocketTracker();

  const note = (level: ConsoleLog["level"], message: string) => {
    report.console.push({ level, messages: [message], at: Date.now() });
  };

  const unref = (timer: unknown) => {
    if (timer && typeof (timer as any).unref === "function") {
      (timer as any).unref();
    }
    return timer as ReturnType<typeof setTimeout>;
  };

  /**
   * Terminate the run.
   *
   * Order matters: ask the runtime to stop first so it will not schedule another
   * item, then tear down the transport so the in-flight response actually ends.
   * A short fuse guarantees finalization even if neither callback fires.
   */
  const stop = (reason: StopReason, message?: string) => {
    if (phase === "stopping" || phase === "finalized") return;
    phase = "stopping";
    stopReason = reason;
    truncated = true;
    note("debug", `[protokit] stopping run: ${message ?? reason}`);

    try {
      runHandle?.abort?.();
    } catch {
      /* The run may already be finished. */
    }

    const destroyed = tracker?.destroyAll() ?? 0;
    if (destroyed > 0) {
      note("debug", `[protokit] destroyed ${destroyed} open socket(s)`);
    }

    // If the runtime swallows the abort we still resolve promptly instead of
    // waiting for the hard timeout.
    stopFuse = unref(
      setTimeout(() => {
        if (phase !== "finalized") {
          note(
            "warn",
            "[protokit] runtime did not report completion after stop",
          );
          finalize();
        }
      }, 250),
    );
  };

  const toScriptOutcome = (
    entry: any,
    target: "prerequest" | "test",
  ): ScriptOutcome => ({
    target,
    scriptId: entry?.script?.id ?? entry?.event?.script?.id,
    error: entry?.error
      ? { name: entry.error.name, message: entry.error.message }
      : undefined,
    environment: scopeToObject(entry?.result?.environment),
    globals: scopeToObject(entry?.result?.globals),
    return: entry?.result?.return,
  });

  const finalize = () => {
    if (phase === "finalized") return;
    phase = "finalized";

    streamTimer = safeClearTimeout(streamTimer);
    hardTimer = safeClearTimeout(hardTimer);
    stopFuse = safeClearTimeout(stopFuse);
    detachSignal?.();
    detachSignal = null;
    tracker?.destroyAll();

    if (streaming) {
      // Emit whatever is still buffered. Events past the cap are counted but
      // not delivered, so `events.length` never exceeds `maxEvents`.
      for (const event of parser.flush()) {
        if (events.length < maxEvents) {
          events.push(event);
          safeInvoke(() => options.onEvent?.(event));
        } else {
          truncated = true;
        }
      }
      if (parser.truncated) truncated = true;
    }

    const endedAt = Date.now();

    if (!captured) {
      const sampled = !!stopReason && events.length > 0;
      captured = {
        protocol: streaming ? "sse" : "http",
        request: { method: "", url: "", headers: {} },
        response: {
          status: sampled ? 200 : 0,
          statusText: sampled
            ? "Stream sampling stopped"
            : "No response received",
          headers: {},
          contentType: streaming ? "text/event-stream" : undefined,
          ...(streaming ? { events } : {}),
          timings: {
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
            firstByteMs: firstByteAt ? firstByteAt - startedAt : undefined,
          },
          sizeBytes: receivedBytes,
          ...(truncated ? { truncated: true } : {}),
        },
        ...(sampled
          ? {}
          : {
              error: {
                message:
                  stopReason === "aborted"
                    ? "Run aborted before a response was received"
                    : "Runner finished without a response",
                code: stopReason,
              },
            }),
      };
    } else {
      // Re-attach: flush() may have produced events after `request` ran, and the
      // stop reason is often only known at that point.
      if (streaming) captured.response.events = events;
      if (truncated) captured.response.truncated = true;
      captured.response.timings = {
        ...captured.response.timings,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        firstByteMs: firstByteAt ? firstByteAt - startedAt : undefined,
        ...(networkDurationMs !== undefined ? { networkDurationMs } : {}),
      };
    }

    if (stopReason) captured.response.stopReason = stopReason;
    if (parser.droppedEvents) {
      captured.response.droppedEvents = parser.droppedEvents;
    }
    captured.scripts = report;
    latch.resolve(captured);
  };

  // External cancellation, e.g. an AbortSignal owned by the caller.
  if (ctx?.signal) {
    const signal = ctx.signal;
    if (signal.aborted) {
      // Still return a well-formed result rather than throwing asynchronously.
      stop("aborted", "signal already aborted");
      finalize();
      return latch.promise;
    }
    const onAbort = () => stop("aborted", "caller aborted the request");
    signal.addEventListener("abort", onAbort, { once: true });
    detachSignal = () => signal.removeEventListener("abort", onAbort);
  }

  // Absolute safety net: never let the promise hang if the runtime goes silent.
  hardTimer = unref(
    setTimeout(
      () => {
        if (phase === "finalized") return;
        note("error", "[protokit] hard timeout reached, forcing completion");
        stopReason ??= "hardTimeout";
        truncated = true;
        try {
          runHandle?.abort?.();
        } catch {
          /* ignore */
        }
        tracker?.destroyAll();
        finalize();
      },
      requestTimeout + maxStreamMs + 30_000,
    ),
  );

  const failFast = (code: string, message: string, cause: unknown) => {
    phase = "finalized";
    hardTimer = safeClearTimeout(hardTimer);
    detachSignal?.();
    tracker?.destroyAll();
    return Promise.reject(err(code as any, message, cause));
  };

  let collection: any;
  try {
    collection = new sdk.Collection(jsonClone(input.collectionJson));
  } catch (e) {
    return failFast(
      "BAD_COLLECTION",
      `Failed to construct collection: ${toErrorInfo(e).message}`,
      e,
    );
  }

  let runOptions: any;
  try {
    runOptions = buildRunOptions(options, {
      baseUrl: input.baseUrl,
      streaming: input.streamingHint,
    });
    if (tracker) {
      runOptions.requester = {
        ...(runOptions.requester ?? {}),
        agents: tracker.agents,
      };
    }
  } catch (e) {
    return failFast(
      "BAD_RUN_OPTIONS",
      `Failed to build runtime options: ${toErrorInfo(e).message}`,
      e,
    );
  }

  let runner: any;
  try {
    runner = new runtime.Runner();
  } catch (e) {
    return failFast(
      "RUNTIME_INIT",
      `Failed to create runner: ${toErrorInfo(e).message}`,
      e,
    );
  }

  runner.run(collection, runOptions, (initError: any, run: any) => {
    if (initError) {
      phase = "finalized";
      hardTimer = safeClearTimeout(hardTimer);
      detachSignal?.();
      tracker?.destroyAll();
      latch.reject(
        err(
          "RUNTIME_INIT",
          initError.message ?? "Runner initialization failed",
          initError,
        ),
      );
      return;
    }
    runHandle = run;

    // A signal that fired between run() and its callback would otherwise be lost.
    if (phase === "stopping") {
      try {
        run.abort?.();
      } catch {
        /* ignore */
      }
      tracker?.destroyAll();
    }

    run.start({
      console(_cursor: any, level: any, ...logs: unknown[]) {
        const log: ConsoleLog = {
          level: (typeof level === "string"
            ? level
            : "log") as ConsoleLog["level"],
          messages: logs,
          at: Date.now(),
        };
        report.console.push(log);
        safeInvoke(() => options.onConsole?.(log));
      },

      assertion(_cursor: any, assertions: any[]) {
        for (const raw of assertions ?? []) {
          const assertion: AssertionResult = {
            name: raw?.name ?? "assertion",
            passed: !raw?.error && !raw?.skipped,
            skipped: !!raw?.skipped,
            index: typeof raw?.index === "number" ? raw.index : 0,
            error: raw?.error
              ? {
                  name: raw.error.name,
                  message: raw.error.message ?? String(raw.error),
                  stack: raw.error.stack,
                }
              : undefined,
          };
          if (!assertion.passed && !assertion.skipped) report.passed = false;
          report.assertions.push(assertion);
          safeInvoke(() => options.onAssertion?.(assertion));
        }
      },

      prerequest(_error: any, _cursor: any, results: any[]) {
        for (const entry of results ?? [])
          report.prerequest.push(toScriptOutcome(entry, "prerequest"));
      },

      test(_error: any, _cursor: any, results: any[]) {
        for (const entry of results ?? [])
          report.test.push(toScriptOutcome(entry, "test"));
      },

      item(
        _error: any,
        _cursor: any,
        _item: any,
        _visualizer: any,
        result: any,
      ) {
        if (result?.isSkipped) report.skipped = true;
      },

      // Fires as soon as headers arrive, before the body is complete.
      // The `streaming` flag is the early SSE classification the UI switches
      // on: it reflects the spec hint OR the live content-type, whichever
      // declared the stream first.
      responseStart(_error: any, _cursor: any, response: any) {
        if (phase === "initialized") phase = "headers";
        firstByteAt ??= Date.now();
        const contentType = safeGetHeader(response, "content-type");
        if (
          isSseContentType(contentType) ||
          isStreamingContentType(contentType)
        )
          streaming = true;

        safeInvoke(() =>
          options.onResponseStart?.({
            status: response?.code ?? 0,
            headers: headersOf(response?.headers),
            contentType,
            streaming,
            protocol: streaming ? "sse" : "http",
            url: input.baseUrl,
          }),
        );

        if (streaming) {
          if (phase === "headers") phase = "streaming";
          if (!streamTimer) {
            streamTimer = unref(
              setTimeout(
                () =>
                  stop("maxStreamMs", `maxStreamMs (${maxStreamMs}ms) reached`),
                maxStreamMs,
              ),
            );
          }
        }
      },

      // Fires for every complete server-sent event, or for each body chunk.
      responseData(_cursor: any, data: any) {
        if (phase === "finalized" || data == null) return;

        let chunk: Buffer;
        try {
          chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        } catch {
          return; // Undecodable chunk, skip rather than crash the run.
        }
        sawResponseData = true;
        receivedBytes += chunk.length;

        if (
          maxResponseSize !== undefined &&
          receivedBytes > maxResponseSize &&
          phase !== "stopping"
        ) {
          // Feed the chunk first so the parser can still complete the event that
          // crossed the threshold, then stop.
          if (streaming) collectEvents(chunk);
          stop(
            "maxResponseSize",
            `maxResponseSize (${maxResponseSize} bytes) exceeded`,
          );
          return;
        }

        if (!streaming) {
          bodyChunks.push(chunk);
          return;
        }

        // Keep parsing while stopping: the sockets are already being torn down,
        // and this is what lets `flush()` surface the trailing partial frame.
        collectEvents(chunk);
      },

      // Fires once the request completes, including any replays.
      request(
        requestError: any,
        _cursor: any,
        response: any,
        request: any,
        _item: any,
        cookies: any,
      ) {
        const endedAt = Date.now();
        const requestInfo = {
          method: request?.method ?? "",
          url: safeUrlString(request),
          headers: headersOf(request?.headers),
          body: extractRequestBody(request),
        };
        if (typeof response?.responseTime === "number") {
          networkDurationMs = response.responseTime;
        }

        // A socket we destroyed on purpose surfaces here as ECONNRESET or
        // ERR_STREAM_PREMATURE_CLOSE. That is a successful sample, not a failure.
        const deliberate = phase === "stopping" || !!stopReason;

        if (requestError && !deliberate) {
          captured = {
            protocol: streaming ? "sse" : "http",
            request: requestInfo,
            response: {
              status: 0,
              statusText: "Request failed",
              headers: {},
              timings: {
                startedAt,
                endedAt,
                durationMs: endedAt - startedAt,
                firstByteMs: firstByteAt ? firstByteAt - startedAt : undefined,
                ...(networkDurationMs !== undefined
                  ? { networkDurationMs }
                  : {}),
              },
              sizeBytes: receivedBytes,
            },
            error: toErrorInfo(requestError),
            replays,
          };
          return;
        }

        if (requestError) {
          note(
            "debug",
            `[protokit] transport closed by sampler: ${toErrorInfo(requestError).message}`,
          );
        }

        const contentType = safeGetHeader(response, "content-type");
        if (
          isSseContentType(contentType) ||
          isStreamingContentType(contentType)
        )
          streaming = true;

        let text: string | undefined;
        let body: unknown;
        let bodyBytes = 0;
        if (!streaming) {
          const buffer = bodyChunks.length
            ? Buffer.concat(bodyChunks)
            : toBuffer(response?.stream);
          bodyBytes = buffer.length;
          // Reject binary payloads instead of producing mojibake.
          text = looksBinary(buffer) ? undefined : buffer.toString("utf8");
          body = tryParseJson(text, contentType);
        }

        captured = {
          protocol: streaming ? "sse" : "http",
          request: requestInfo,
          response: {
            status: typeof response?.code === "number" ? response.code : 0,
            statusText: safeReason(response),
            headers: headersOf(response?.headers),
            contentType,
            ...(streaming
              ? {
                  streaming: true,
                  events,
                  body: Object.assign(
                    {},
                    ...events.map((event) => event.parsed),
                  ),
                }
              : { body, text }),
            timings: {
              startedAt,
              endedAt,
              // Wall-clock duration, so it can never be below firstByteMs.
              durationMs: endedAt - startedAt,
              firstByteMs: firstByteAt ? firstByteAt - startedAt : undefined,
              ...(networkDurationMs !== undefined ? { networkDurationMs } : {}),
            },
            // `receivedBytes` counts body bytes only; responseSize includes
            // headers, so it is a last resort rather than a peer value.
            sizeBytes: sawResponseData ? receivedBytes : bodyBytes,
            ...(truncated ? { truncated: true } : {}),
          },
          cookies: Array.isArray(cookies)
            ? cookies.map((cookie: any) => ({
                name: String(cookie?.name ?? ""),
                value: String(cookie?.value ?? ""),
                domain: cookie?.domain,
                path: cookie?.path,
              }))
            : [],
          replays,
        };
      },

      // Captures auxiliary traffic such as OAuth token refreshes and redirects.
      io(_error: any, _cursor: any, trace: any, response: any, request: any) {
        if (trace?.type !== "http") return;
        if (!trace.source || trace.source === "collection") return;
        replays.push({
          url: safeUrlString(request),
          method: request?.method ?? "",
          status: typeof response?.code === "number" ? response.code : 0,
          reason: String(trace.source),
        });
      },

      exception(_cursor: any, exception: any) {
        note("error", `[exception] ${toErrorInfo(exception).message}`);
      },

      done(doneError: any) {
        // Stopping on purpose is a normal termination for sampled streams.
        const deliberate = !!stopReason || phase === "stopping";
        if (doneError && !captured && !deliberate) {
          phase = "finalized";
          streamTimer = safeClearTimeout(streamTimer);
          hardTimer = safeClearTimeout(hardTimer);
          stopFuse = safeClearTimeout(stopFuse);
          detachSignal?.();
          tracker?.destroyAll();
          latch.reject(
            err("RUNTIME_RUN", doneError.message ?? "Run failed", doneError),
          );
          return;
        }
        finalize();
      },
    });
  });

  /** Parse a chunk and deliver events until the cap is reached. */
  function collectEvents(chunk: Buffer): void {
    let produced: StreamEvent[];
    try {
      produced = parser.push(chunk);
    } catch (e) {
      note("error", `[protokit] SSE parse failure: ${toErrorInfo(e).message}`);
      return;
    }
    for (const event of produced) {
      if (events.length >= maxEvents) {
        truncated = true;
        stop("maxEvents", `maxEvents (${maxEvents}) reached`);
        return;
      }
      events.push(event);
      safeInvoke(() => options.onEvent?.(event));
      if (events.length >= maxEvents) {
        stop("maxEvents", `maxEvents (${maxEvents}) reached`);
        return;
      }
    }
  }

  return latch.promise;
}


/** Respect caller-supplied agents; socket tracking is opt-out by conflict. */
function hasUserAgents(options: SendOptions): boolean {
  const requester = options.runner?.requester as any;
  return !!(requester?.agents || requester?.agent);
}

/** Invoke a user callback without letting it break the run. */
function safeInvoke(fn: () => void): void {
  try {
    fn();
  } catch {
    /* User callbacks must never abort execution. */
  }
}

function toBuffer(value: unknown): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  try {
    return Buffer.from(value as any);
  } catch {
    return Buffer.alloc(0);
  }
}

function safeGetHeader(response: any, name: string): string | undefined {
  try {
    const value = response?.headers?.get?.(name);
    return value == null ? undefined : String(value);
  } catch {
    return undefined;
  }
}

function safeReason(response: any): string {
  try {
    return typeof response?.reason === "function"
      ? String(response.reason() ?? "")
      : String(response?.status ?? "");
  } catch {
    return "";
  }
}

function safeUrlString(request: any): string {
  try {
    return typeof request?.url?.toString === "function"
      ? request.url.toString()
      : "";
  } catch {
    return "";
  }
}

/** Heuristic binary detection based on NULL bytes in the leading window. */
function looksBinary(buffer: Buffer): boolean {
  const window = Math.min(buffer.length, 1024);
  for (let i = 0; i < window; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
