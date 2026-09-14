import sdk from "postman-collection";
import type {
  RuntimeRunOptions,
  SendOptions,
  RequesterOptions,
} from "../../core/types";
import { deepMerge, isPlainObject } from "../../core/utils";
import { err } from "../../core/errors";

/** Upper bound on any single timeout, guarding against absurd values. */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Headroom added on top of the request and streaming budgets. */
const GLOBAL_TIMEOUT_SLACK_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_BUDGET_MS = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 15_000;

/**
 * Coerce a millisecond duration.
 * `0` is preserved because postman-runtime reads it as "no limit".
 */
function toDuration(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

/** Build a VariableScope from a plain key/value map. */
function toVariableScope(
  values?: Record<string, string>,
  seed: Array<{ key: string; value: string }> = [],
): any {
  const entries: Array<{ key: string; value: string }> = [];

  // Seeded entries are applied last so a caller-supplied variable cannot
  // silently retarget the base URL the request was built against.
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof key !== "string" || !key) continue;
    entries.push({
      key,
      value: value === null || value === undefined ? "" : String(value),
    });
  }
  entries.push(...seed);

  const deduped = new Map<string, { key: string; value: string }>();
  for (const entry of entries) deduped.set(entry.key, entry);
  return new sdk.VariableScope({ values: Array.from(deduped.values()) });
}

/**
 * Reject requester settings that would silently break the call.
 *
 * `maxResponseSize: 0` is the important one: it reads as a zero-byte ceiling, so
 * a streaming response is cut at the first chunk and the caller sees an empty
 * event list with no error. Omit the field to leave the size unbounded.
 */
function validateRequester(requester: unknown): void {
  if (!isPlainObject(requester)) return;

  if ("maxResponseSize" in requester) {
    const raw = requester.maxResponseSize;
    if (raw !== undefined && raw !== null) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw err(
          "BAD_RUN_OPTIONS",
          "runner.requester.maxResponseSize must be a positive number of bytes. " +
            "Omit it to leave the response size unbounded.",
          { provided: raw },
        );
      }
    }
  }

  if ("maxRedirects" in requester) {
    const raw = requester.maxRedirects;
    if (raw !== undefined && raw !== null) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw err(
          "BAD_RUN_OPTIONS",
          "runner.requester.maxRedirects must be a non-negative integer.",
          { provided: raw },
        );
      }
    }
  }

  const version = requester.protocolVersion;
  if (
    version !== undefined &&
    version !== "http1" &&
    version !== "http2" &&
    version !== "auto"
  ) {
    throw err(
      "BAD_RUN_OPTIONS",
      'runner.requester.protocolVersion must be "http1", "http2" or "auto".',
      { provided: version },
    );
  }
}

export interface BuildRunOptionsInput {
  baseUrl: string;
  /** True when the operation is expected to stream, which relaxes the global timeout. */
  streaming: boolean;
}

/**
 * Compose the final postman-runtime options object.
 *
 * Precedence, lowest to highest:
 *   1. Library defaults
 *   2. Convenience fields on SendOptions (timeout, maxStreamMs, variables, ...)
 *   3. `options.runner` — every documented runtime option, passed straight through
 *
 * Variable scopes are only synthesized when the caller did not supply one.
 */
export function buildRunOptions(
  options: SendOptions,
  input: BuildRunOptionsInput,
): RuntimeRunOptions {
  if (!options || typeof options !== "object") {
    throw err("BAD_RUN_OPTIONS", "send options are required");
  }
  validateRequester(options.runner?.requester);

  /* ---- Timeout budget ---- */
  const requestTimeout =
    toDuration(options.runner?.timeout?.request) ??
    toDuration(options.timeout) ??
    DEFAULT_REQUEST_TIMEOUT_MS;

  const streamBudget = input.streaming
    ? (toDuration(options.maxStreamMs) ?? DEFAULT_STREAM_BUDGET_MS)
    : 0;

  const scriptTimeout =
    toDuration(options.runner?.timeout?.script) ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  // postman-runtime treats 0 as "no limit". A finite global budget would then
  // contradict an unlimited request budget, so the two stay consistent.
  const requestUnlimited = requestTimeout === 0;
  const globalTimeout = requestUnlimited
    ? 0
    : Math.min(
        requestTimeout + streamBudget + GLOBAL_TIMEOUT_SLACK_MS,
        MAX_TIMEOUT_MS,
      );

  /* ---- Defaults ---- */
  const defaultRequester: RequesterOptions = {
    strictSSL: true,
    followRedirects: true,
    followOriginalHttpMethod: false,
    maxRedirects: 10,
    useWhatWGUrlParser: true,
    removeRefererHeaderOnRedirect: false,
    insecureHTTPParser: false,
    // Timings and verbose history power the firstByteMs metric and replay list.
    timings: true,
    verbose: true,
    implicitCacheControl: true,
    implicitTraceHeader: true,
    disableCookies: false,
    // HTTP/1.1 is required for the chunked-transfer path the SSE reader relies
    // on; override to "auto" for an HTTP/2-only endpoint.
    protocolVersion: "http1",
    maxInvokableNestedRequests: 5,
    // Null encoding forces postman-request to emit raw Buffer chunks on the
    // `data` event. The default (utf8) may buffer the body to decode multi-byte
    // boundaries, which defeats incremental SSE / ndjson streaming.
    encoding: null,
  };

  const defaults: RuntimeRunOptions = {
    iterationCount: 1,
    // Halt gracefully so item and iteration callbacks still fire on failure.
    stopOnError: false,
    abortOnError: false,
    stopOnFailure: false,
    abortOnFailure: false,
    timeout: {
      request: requestTimeout,
      script: scriptTimeout,
      global: globalTimeout,
    },
    delay: { item: 0, iteration: 0 },
    script: { serializeLogs: false },
    ignoreProxyEnvironmentVariables: false,
    requester: defaultRequester,
  };

  /* ---- Full passthrough of caller-provided runtime options ---- */
  const final = deepMerge(defaults, options.runner ?? {});

  // deepMerge keeps a nested object, so re-validate the merged result in case
  // the caller only supplied part of the requester block.
  validateRequester(final.requester);

  /* ---- Variable scopes ---- */
  if (!final.environment) {
    final.environment = toVariableScope(options.variables, [
      { key: "baseUrl", value: input.baseUrl },
    ]);
  }
  if (!final.globals && options.globals) {
    final.globals = toVariableScope(options.globals);
  }
  if (!final.localVariables && options.localVariables) {
    final.localVariables = toVariableScope(options.localVariables);
  }

  /* ---- Iteration count must stay consistent with the supplied data set ---- */
  if (
    Array.isArray(final.data) &&
    final.data.length &&
    options.runner?.iterationCount === undefined
  ) {
    final.iterationCount = final.data.length;
  }
  const iterations = Number(final.iterationCount);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw err(
      "BAD_RUN_OPTIONS",
      "runner.iterationCount must be an integer of at least 1.",
      { provided: final.iterationCount },
    );
  }

  return final;
}
