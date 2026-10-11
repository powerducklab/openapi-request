import type { ExecResult, SendOptions, StreamEvent } from "../../core/types";
import type { ExecuteContext } from "../../core/protocol";
import { ProtoKitError, toErrorInfo } from "../../core/errors";
import { SseParser } from "../http/sse-parser";
import type { ResolvedGraphQLConfig } from "./config";

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = out[key] ? `${out[key]}, ${value}` : value;
  });
  return out;
}

function buildGetUrl(config: ResolvedGraphQLConfig): string {
  const url = new URL(config.endpoint);
  url.searchParams.set("query", config.query);
  if (config.operationName) url.searchParams.set("operationName", config.operationName);
  if (Object.keys(config.variables).length) {
    url.searchParams.set("variables", JSON.stringify(config.variables));
  }
  return url.toString();
}

/**
 * Run one GraphQL operation over HTTP.
 *
 * A GraphQL error is not a transport failure: the server still answers 200
 * with a `data`/`errors` envelope, so `ExecResult.error` is only set when the
 * call never produced a usable envelope at all (network failure, non-JSON
 * body, or `errors` with no `data`). Partial success (`data` alongside
 * `errors`) is left in `response.body` for the caller to inspect, exactly as
 * a real GraphQL client would surface it.
 */
export async function runGraphQL(
  config: ResolvedGraphQLConfig,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  // This adapter does not run the Postman sandbox. Never silently ignore hooks.
  for (const key of ["preRequest", "test", "collectionPreRequest", "collectionTest"] as const) {
    const source = options.scripts?.[key];
    if (source && (Array.isArray(source) ? source : [source]).some(item =>
      (Array.isArray(item.exec) ? item.exec.join("\n") : item.exec).trim())) {
      throw new ProtoKitError("GraphQL does not support request scripts", "GRAPHQL_SCRIPTS_UNSUPPORTED");
    }
  }
  const startedAt = Date.now();
  const signal = ctx?.signal ?? options.signal;

  const requestUrl = config.useGet ? buildGetUrl(config) : config.endpoint;
  const requestBody = config.useGet
    ? undefined
    : JSON.stringify({
        query: config.query,
        variables: config.variables,
        ...(config.operationName ? { operationName: config.operationName } : {}),
      });

  const timeoutMs =
    typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : 30_000;
  const timeoutController = new AbortController();
  const onCallerAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (signal?.aborted) onCallerAbort();
  const hardTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
  (hardTimer as any).unref?.();

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: config.useGet ? "GET" : "POST",
      headers: config.headers,
      body: requestBody,
      signal: timeoutController.signal,
      redirect: options.runner?.requester?.followRedirects === false ? "manual" : "follow",
      credentials: "omit",
    });
  } catch (e) {
    clearTimeout(hardTimer);
    signal?.removeEventListener("abort", onCallerAbort);
    const endedAt = Date.now();
    const aborted = signal?.aborted === true;
    return {
      protocol: "http",
      request: { method: config.useGet ? "GET" : "POST", url: requestUrl, headers: config.headers, body: requestBody },
      response: {
        status: 0,
        statusText: aborted ? "Aborted" : "Request failed",
        headers: {},
        timings: { startedAt, endedAt, durationMs: endedAt - startedAt },
        sizeBytes: 0,
      },
      error: aborted
        ? { message: "GraphQL request aborted", code: "ABORTED" }
        : toErrorInfo(e),
    };
  }

  const firstByteAt = Date.now();
  const contentType = response.headers.get("content-type") ?? undefined;
  const isStream = !!contentType && /text\/event-stream/i.test(contentType);

  let body: unknown;
  let text: string | undefined;
  let events: StreamEvent[] | undefined;
  let sizeBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  const maxBytes = options.maxResponseSize;
  const readChunk = async () => {
    const chunk = await reader!.read();
    sizeBytes += chunk.value?.byteLength ?? 0;
    if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && sizeBytes > maxBytes) {
      throw new ProtoKitError(`maxResponseSize (${maxBytes} bytes) exceeded`, "maxResponseSize");
    }
    return chunk;
  };
  let graphqlError: { message: string; code?: string } | undefined;

  try {
    if (isStream && response.body) {
      // Incremental delivery (@defer/@stream) or graphql-sse subscriptions:
      // reuse the SSE parser so multi-part responses collect the same way
      // streaming HTTP/SSE operations do elsewhere in this toolkit.
      const parser = new SseParser({
        maxBufferChars: options.maxBufferChars,
        maxEventChars: options.maxEventChars,
        inheritEventId: options.inheritEventId,
      });
      events = [];
      const maxEvents = typeof options.maxEvents === "number" && options.maxEvents > 0 ? options.maxEvents : 100;
      reader = response.body.getReader();
      if (typeof options.maxStreamMs === "number" && options.maxStreamMs > 0) {
        streamTimer = setTimeout(() => timeoutController.abort(), options.maxStreamMs);
        (streamTimer as any).unref?.();
      }
      for (;;) {
        const { done, value } = await readChunk();
        if (done) break;
        for (const event of parser.push(value)) {
          events.push(event);
          if (events.length >= maxEvents) break;
        }
        if (events.length >= maxEvents) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
      for (const event of parser.flush()) {
        if (events.length < maxEvents) events.push(event);
      }
    } else {
      const decoder = new TextDecoder();
      let raw = "";
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const {done, value} = await readChunk();
          if (done) break;
          raw += decoder.decode(value, {stream:true});
        }
        raw += decoder.decode();
      }
      text = raw;
      if (contentType && /json/i.test(contentType) && raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          /* Leave `text` as the only representation of a malformed JSON body. */
        }
      }
    }
  } catch (e) {
    graphqlError = signal?.aborted
      ? {message:"GraphQL request aborted",code:"ABORTED"}
      : toErrorInfo(e);
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    clearTimeout(streamTimer);
    clearTimeout(hardTimer);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  const endedAt = Date.now();

  if (!graphqlError && !isStream && isPlainRecord(body)) {
    const hasData = body.data !== undefined && body.data !== null;
    const errors = Array.isArray(body.errors) ? body.errors : undefined;
    if (!hasData && errors?.length) {
      graphqlError = {
        message: errors.map((e: any) => e?.message).filter(Boolean).join("; ") || "GraphQL request returned errors",
        code: "GRAPHQL_ERRORS",
      };
    }
  }
  if (!graphqlError && !isStream && response.ok && !isPlainRecord(body)) {
    graphqlError = {message:"GraphQL endpoint did not return a JSON response object",code:"GRAPHQL_INVALID_RESPONSE"};
  }
  if (!graphqlError && !response.ok && !isPlainRecord(body)) {
    graphqlError = { message: `GraphQL endpoint responded HTTP ${response.status}`, code: String(response.status) };
  }

  return {
    protocol: "http",
    request: {
      method: config.useGet ? "GET" : "POST",
      url: requestUrl,
      headers: config.headers,
      body: config.useGet ? undefined : { query: config.query, variables: config.variables, operationName: config.operationName },
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: headersToObject(response.headers),
      contentType,
      ...(isStream ? { events } : { body, text }),
      timings: {
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        firstByteMs: firstByteAt - startedAt,
      },
      sizeBytes,
    },
    ...(graphqlError ? { error: graphqlError } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
