import type { SendOptions, WebSocketOptions, ResolvedWsConfig } from "../../core/types";
export type { ResolvedWsConfig } from "../../core/types";
import type { LocatedOperation } from "../../openapi/locate";
import { resolveServerUrl } from "../http/environment";
import { interpolate } from "../../core/utils";
import { err } from "../../core/errors";


/** Convert an http(s) origin into its ws(s) equivalent. */
function toWsScheme(url: string): string {
  if (/^wss?:\/\//i.test(url)) return url;
  if (/^https:\/\//i.test(url)) return url.replace(/^https:/i, "wss:");
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, "ws:");
  // A bare host defaults to the secure scheme.
  return `wss://${url.replace(/^\/+/, "")}`;
}

function normalizePayload(
  entry: unknown,
  variables: Record<string, string>,
): string | Uint8Array | null {
  if (entry == null) return null;
  if (typeof entry === "string") return interpolate(entry, variables);
  if (entry instanceof Uint8Array) return entry;
  if (Buffer.isBuffer(entry)) return new Uint8Array(entry);
  try {
    // Interpolate after serialization so placeholders inside object values are
    // substituted too, matching how string payloads behave.
    return interpolate(JSON.stringify(entry), variables);
  } catch {
    return null;
  }
}

/**
 * Reject a WebSocket subprotocol that is not a valid HTTP token, which would
 * otherwise make the `ws` constructor throw with an opaque message.
 */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function normalizeSubprotocols(input: unknown): string[] {
  const list = Array.isArray(input) ? input : input == null ? [] : [input];
  const out: string[] = [];
  for (const entry of list) {
    if (entry == null) continue;
    const value = String(entry).trim();
    if (!value) continue;
    if (!HTTP_TOKEN.test(value)) {
      throw err(
        "BAD_WS_OPTIONS",
        `Invalid WebSocket subprotocol ${JSON.stringify(value)}: must be an HTTP token`,
      );
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * Resolve the effective WebSocket configuration.
 *
 * Precedence: options.websocket.url > operation['x-websocket'].url > server URL + path.
 */
export function resolveWsConfig(
  located: LocatedOperation,
  spec: any,
  options: SendOptions,
): ResolvedWsConfig {
  const ws: WebSocketOptions = options.websocket ?? {};
  const rawExtension = located.operation?.["x-websocket"];
  const extension: Record<string, any> =
    rawExtension && typeof rawExtension === "object" ? rawExtension : {};
  const variables: Record<string, string> = { ...(options.variables ?? {}) };

  let url: string;
  if (ws.url) {
    url = String(ws.url);
  } else if (typeof extension.url === "string" && extension.url) {
    url = extension.url;
  } else {
    const base = toWsScheme(resolveServerUrl(located.servers, options));
    // Substitute path parameters with the values the caller supplied.
    const path = located.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
      const value = options.values?.path?.[name];
      return value == null ? match : encodeURIComponent(String(value));
    });
    url = `${base.replace(/\/+$/, "")}/${path.replace(/^\//, "")}`;
  }

  // `baseUrl` is deliberately not seeded here: substituting an empty string
  // would silently erase a {{baseUrl}} placeholder instead of surfacing it.
  url = interpolate(url, variables);

  const leftover = url.match(/\{\{([^}]+)\}\}/);
  if (leftover) {
    throw err(
      "BAD_WS_URL",
      `Unresolved variable {{${leftover[1]}}} in WebSocket URL: ${url}`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw err("BAD_WS_URL", `Resolved WebSocket URL is invalid: ${url}`);
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    throw err(
      "BAD_WS_URL",
      `WebSocket URL must use ws: or wss:, received ${parsedUrl.protocol}${url}`,
    );
  }

  // Attach declared query parameters so handshake-time auth keeps working.
  for (const [key, value] of Object.entries(options.values?.query ?? {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      parsedUrl.searchParams.delete(key);
      for (const item of value) {
        if (item != null) parsedUrl.searchParams.append(key, String(item));
      }
    } else {
      parsedUrl.searchParams.set(key, String(value));
    }
  }
  if (options.auth?.type === "apikey" && options.auth.in === "query") {
    parsedUrl.searchParams.set(
      options.auth.key ?? "api_key",
      options.auth.value ?? "",
    );
  }
  url = parsedUrl.toString();

  // Every header source is interpolated, so behaviour does not depend on which
  // one a value came from.
  const headers: Record<string, string> = {};
  const applyHeaders = (source: unknown) => {
    if (!source || typeof source !== "object") return;
    for (const [key, value] of Object.entries(
      source as Record<string, unknown>,
    )) {
      if (value == null) continue;
      if (key === "__proto__" || key === "constructor") continue;
      headers[key] = interpolate(String(value), variables);
    }
  };
  applyHeaders(options.values?.header);
  applyHeaders(extension.headers);
  applyHeaders(ws.headers);

  const auth = options.auth;
  if (
    auth &&
    auth.type !== "none" &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
  ) {
    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${auth.token ?? ""}`;
    } else if (auth.type === "basic") {
      const raw = `${auth.username ?? ""}:${auth.password ?? ""}`;
      headers.Authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
    } else if (auth.type === "apikey" && (auth.in ?? "header") === "header") {
      headers[auth.key ?? "X-API-Key"] = auth.value ?? "";
    }
  }

  // Headers the handshake owns; letting a caller set them corrupts the upgrade.
  for (const reserved of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "upgrade",
    "connection",
  ]) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === reserved) delete headers[key];
    }
  }

  const rawSend = ws.send ?? extension.send ?? [];
  const send = (Array.isArray(rawSend) ? rawSend : [rawSend])
    .map((entry) => normalizePayload(entry, variables))
    .filter((entry): entry is string | Uint8Array => entry !== null);

  const keepAliveSource = ws.keepAlive ?? extension.keepAlive;

  return {
    url,
    subprotocols: normalizeSubprotocols(
      ws.subprotocols ?? extension.subprotocols,
    ),
    headers,
    send,
    // Zero is a meaningful "no delay" / "disabled" value for these two.
    sendDelayMs: nonNegative(ws.sendDelayMs, 0, "websocket.sendDelayMs"),
    idleTimeoutMs: nonNegative(ws.idleTimeoutMs, 0, "websocket.idleTimeoutMs"),
    // Zero here would mean "sample nothing", which is never the intent.
    maxMessages: strictlyPositive(
      ws.maxMessages ?? options.maxEvents,
      100,
      "websocket.maxMessages",
    ),
    maxSessionMs: strictlyPositive(
      ws.maxSessionMs ?? options.maxStreamMs,
      30_000,
      "websocket.maxSessionMs",
    ),
    keepAlive: keepAliveSource
      ? {
          intervalMs: strictlyPositive(
            keepAliveSource.intervalMs,
            15_000,
            "websocket.keepAlive.intervalMs",
          ),
          payload: String(keepAliveSource.payload ?? "ping"),
        }
      : undefined,
    closeCode: normalizeCloseCode(ws.closeCode),
    closeReason: String(ws.closeReason ?? "Client finished sampling"),
    closeTimeoutMs: strictlyPositive(
      ws.closeTimeoutMs,
      3_000,
      "websocket.closeTimeoutMs",
    ),
    rejectUnauthorized: ws.rejectUnauthorized !== false,
    maxPayloadBytes: strictlyPositive(
      ws.maxPayloadBytes,
      256 * 1024,
      "websocket.maxPayloadBytes",
    ),
    clientOptions:
      ws.clientOptions && typeof ws.clientOptions === "object"
        ? { ...ws.clientOptions }
        : {},
  };
}

/** Zero is accepted and means "disabled". */
function nonNegative(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw err(
      "BAD_WS_OPTIONS",
      `${label} must be a non-negative finite number, received ${JSON.stringify(value)}`,
    );
  }
  return Math.floor(numeric);
}

/**
 * Zero is rejected rather than defaulted: `maxMessages: 0` used to close the
 * session on the first inbound frame and `keepAlive.intervalMs: 0` produced a
 * tight ping loop, neither of which any caller intends.
 */
function strictlyPositive(
  value: unknown,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw err(
      "BAD_WS_OPTIONS",
      `${label} must be a positive finite number, received ${JSON.stringify(value)}`,
    );
  }
  return Math.floor(numeric);
}

/** Only 1000 and 3000-4999 may be sent by an endpoint. */
function normalizeCloseCode(value: unknown): number {
  if (value === undefined || value === null) return 1000;
  const code = Number(value);
  if (
    code === 1000 ||
    (Number.isInteger(code) && code >= 3000 && code <= 4999)
  ) {
    return code;
  }
  throw err(
    "BAD_WS_OPTIONS",
    `websocket.closeCode must be 1000 or within 3000-4999, received ${JSON.stringify(value)}`,
  );
}