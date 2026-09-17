/**
 * OAuth 2.0 token acquisition and refresh.
 *
 * Postman-runtime only attaches an OAuth 2.0 access token to a request; it does
 * not talk to the authorization server. This module implements the token
 * endpoint calls (RFC 6749) so the client can obtain and renew tokens itself,
 * the same way the Postman desktop helper does before sending.
 *
 * The implementation is transport agnostic (global `fetch`, overridable via
 * `fetchImpl`) so it runs in Electron main, Node and the browser.
 */

export type OAuth2GrantType =
  | "client_credentials"
  | "password"
  | "authorization_code"
  | "refresh_token";

export interface OAuth2Token {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  /** Epoch milliseconds when the access token expires; absent if unknown. */
  expiresAt?: number;
  scope?: string;
  /** Raw token endpoint response, kept for providers that return extras. */
  raw?: Record<string, unknown>;
}

export interface OAuth2FlowConfig {
  grantType?: OAuth2GrantType;
  /** Token endpoint (RFC 6749 token URL). */
  accessTokenUrl?: string;
  /** Authorization endpoint; only used by the interactive code flow. */
  authUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Send client credentials as an HTTP Basic header or in the form body. */
  clientAuth?: "header" | "body";
  scope?: string;
  /** Resource owner credentials for the password grant. */
  username?: string;
  password?: string;
  /** Authorization code for the authorization_code grant. */
  code?: string;
  redirectUri?: string;
  /** RFC 8693 audience / resource indicators, when the provider needs them. */
  audience?: string;
  resource?: string;
  /** Cached refresh token from a previous acquisition. */
  refreshToken?: string;
  /** Cached access token from a previous acquisition. */
  accessToken?: string;
  /** Token type of the cached access token (usually "Bearer"). */
  tokenType?: string;
  /** Epoch milliseconds for the cached access token. */
  expiresAt?: number;
  /** Proactively refresh and reactively retry on 401. Defaults to true. */
  autoRefresh?: boolean;
  /** Status codes that trigger a forced refresh + one retry. Defaults to [401]. */
  refreshOnStatus?: number[];
  /** Expiry safety margin in seconds. Defaults to 30. */
  skewSeconds?: number;
  addTokenTo?: "header" | "queryParams";
  /** Authorization scheme prefix; defaults to "Bearer". */
  headerPrefix?: string;
  queryParamName?: string;
  /** Extra parameters merged into every token request body. */
  extraParams?: Record<string, string>;
  /** Override the network implementation (e.g. an undici-backed fetch). */
  fetchImpl?: typeof fetch;
}

export interface ResolvedOAuth2 {
  token: OAuth2Token;
  /** Where the token came from: cache, a fresh grant or a refresh. */
  source: "cache" | "grant" | "refresh";
}

const DEFAULT_REFRESH_STATUS = [401];
const DEFAULT_SKEW_SECONDS = 30;

function formEncode(value: unknown): string {
  return encodeURIComponent(value == null ? "" : String(value)).replace(
    /%20/g,
    "+",
  );
}

function toFormBody(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${formEncode(k)}=${formEncode(v as string)}`)
    .join("&");
}

function safeBtoa(value: string): string {
  if (typeof btoa === "function") {
    return btoa(unescape(encodeURIComponent(value)));
  }
  // Node fallback (older runtimes without global btoa).
  return Buffer.from(value, "utf8").toString("base64");
}

function parseTokenResponse(text: string): Record<string, any> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("OAuth 2.0 token endpoint returned an empty body");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeToken(raw: Record<string, any>): OAuth2Token {
  const accessToken = raw.access_token || raw.id_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error(
      `OAuth 2.0 token response missing access_token: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  const expiresIn = Number(raw.expires_in);
  return {
    accessToken,
    refreshToken: raw.refresh_token ? String(raw.refresh_token) : undefined,
    tokenType: raw.token_type ? String(raw.token_type) : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + expiresIn * 1000
      : undefined,
    scope: raw.scope ? String(raw.scope) : undefined,
    raw,
  };
}

/**
 * True when the token is missing, expired or within the skew window.
 */
export function isOAuth2TokenExpired(
  token: OAuth2Token | undefined,
  skewSeconds = DEFAULT_SKEW_SECONDS,
): boolean {
  if (!token || !token.accessToken) return true;
  if (!token.expiresAt) return false; // No expiry claim: assume valid until a 401.
  return Date.now() + skewSeconds * 1000 >= token.expiresAt;
}

/**
 * Call the token endpoint. `mode` selects a refresh_token request when a
 * refresh token is available, otherwise the configured grant.
 */
export async function acquireOAuth2Token(
  cfg: OAuth2FlowConfig,
  mode: "grant" | "refresh" = "grant",
): Promise<OAuth2Token> {
  if (!cfg.accessTokenUrl) {
    throw new Error("OAuth 2.0 auto tokens require an access token URL.");
  }
  const doFetch: typeof fetch =
    cfg.fetchImpl || (typeof fetch === "function" ? fetch : (undefined as any));
  if (typeof doFetch !== "function") {
    throw new Error("No fetch implementation available for OAuth 2.0.");
  }

  const body: Record<string, string | undefined> = {};
  const useRefresh = mode === "refresh" && !!cfg.refreshToken;

  if (useRefresh) {
    body.grant_type = "refresh_token";
    body.refresh_token = cfg.refreshToken;
    if (cfg.scope) body.scope = cfg.scope;
  } else {
    const grant = cfg.grantType || "client_credentials";
    body.grant_type = grant;
    if (grant === "password") {
      body.username = cfg.username;
      body.password = cfg.password;
      if (cfg.scope) body.scope = cfg.scope;
    } else if (grant === "authorization_code") {
      if (!cfg.code) throw new Error("Authorization code grant requires code.");
      body.code = cfg.code;
      if (cfg.redirectUri) body.redirect_uri = cfg.redirectUri;
    } else if (grant === "client_credentials") {
      if (cfg.scope) body.scope = cfg.scope;
    }
  }

  if (cfg.audience) body.audience = cfg.audience;
  if (cfg.resource) body.resource = cfg.resource;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  // Client authentication: Basic header by default, form body when requested.
  if (cfg.clientAuth === "body") {
    if (cfg.clientId) body.client_id = cfg.clientId;
    if (cfg.clientSecret) body.client_secret = cfg.clientSecret;
  } else if (cfg.clientId) {
    headers.Authorization =
      "Basic " + safeBtoa(`${cfg.clientId}:${cfg.clientSecret || ""}`);
  }

  if (cfg.extraParams) {
    for (const [k, v] of Object.entries(cfg.extraParams)) body[k] = v;
  }

  let response: Response;
  try {
    response = await doFetch(cfg.accessTokenUrl as string, {
      method: "POST",
      headers,
      body: toFormBody(body),
    });
  } catch (networkError: any) {
    throw new Error(
      `OAuth 2.0 token request to ${cfg.accessTokenUrl} failed: ${
        networkError?.message || networkError}`,
    );
  }

  const text = await response.text();
  let parsed: Record<string, any>;
  try {
    parsed = parseTokenResponse(text);
  } catch {
    throw new Error(
      `OAuth 2.0 token endpoint returned a non-token response (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  if (!response.ok) {
    const detail = parsed.error_description || parsed.error || `HTTP ${response.status}`;
    throw new Error(`OAuth 2.0 token request rejected: ${detail}`);
  }

  const token = normalizeToken(parsed);
  // Providers often omit a rotated refresh token; keep the one we already have.
  if (!token.refreshToken && cfg.refreshToken) {
    token.refreshToken = cfg.refreshToken;
  }
  return token;
}

/**
 * Return a usable token, using the cached one while valid and otherwise
 * acquiring or refreshing as needed.
 */
export async function resolveOAuth2Token(
  cfg: OAuth2FlowConfig,
): Promise<ResolvedOAuth2> {
  const skew = cfg.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const cached: OAuth2Token | undefined = cfg.accessToken
    ? {
        accessToken: cfg.accessToken,
        refreshToken: cfg.refreshToken,
        tokenType: cfg.tokenType,
        expiresAt: cfg.expiresAt,
      }
    : undefined;

  if (!isOAuth2TokenExpired(cached, skew)) {
    return { token: cached as OAuth2Token, source: "cache" };
  }

  if (cached && cfg.refreshToken) {
    try {
      const token = await acquireOAuth2Token(cfg, "refresh");
      return { token, source: "refresh" };
    } catch (refreshError) {
      // Fall through to a fresh grant when the refresh token is rejected.
      if (cfg.grantType === "refresh_token") throw refreshError;
    }
  }

  const token = await acquireOAuth2Token(cfg, "grant");
  return { token, source: cached ? "refresh" : "grant" };
}

/** Status codes that should force a token refresh and single retry. */
export function oauth2RefreshStatuses(cfg: OAuth2FlowConfig): number[] {
  return Array.isArray(cfg.refreshOnStatus) && cfg.refreshOnStatus.length
    ? cfg.refreshOnStatus
    : DEFAULT_REFRESH_STATUS;
}

/**
 * Build a static, collection-builder-compatible AuthConfig that places the
 * resolved access token on the request. Header placement uses the Bearer
 * helper (or a literal Authorization header for non-Bearer schemes); query
 * placement uses the API-key helper with the configured parameter name.
 */
export function authFromOAuth2Token(
  token: OAuth2Token,
  cfg: OAuth2FlowConfig = {},
): Record<string, any> {
  if (cfg.addTokenTo === "queryParams") {
    return {
      type: "apikey",
      key: cfg.queryParamName || "access_token",
      value: token.accessToken,
      in: "query",
    };
  }
  const prefix = (cfg.headerPrefix ?? "Bearer").trim();
  if (!prefix || /^bearer$/i.test(prefix)) {
    return { type: "bearer", token: token.accessToken };
  }
  return {
    type: "apikey",
    key: "Authorization",
    value: `${prefix} ${token.accessToken}`,
    in: "header",
  };
}
