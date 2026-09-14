import type { SendOptions } from "../../core/types";
import { err } from "../../core/errors";
import { isPlainObject, isSecretKey } from "../../core/utils";

/** Placeholder for a `{{name}}` sequence while single-brace cleanup runs. */
const GUARD_OPEN = "\u0000PK_OPEN\u0000";
const GUARD_CLOSE = "\u0000PK_CLOSE\u0000";

let envCounter = 0;
function uniqueId(prefix: string): string {
  envCounter = (envCounter + 1) % 0xffff;
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `${prefix}-${time}-${envCounter.toString(36)}${rand}`;
}

export interface ResolveServerOptions {
  /** Index into the server list. Defaults to 0. */
  serverIndex?: number;
}

/**
 * Resolve the effective base URL, expanding OpenAPI server variables.
 *
 * A relative server URL (`/` or `/v1`) cannot be used to make a real request,
 * so it is rejected with an actionable error rather than producing a
 * protocol-relative URL that silently resolves to the wrong host.
 */
export function resolveServerUrl(
  servers: any[],
  options: SendOptions & ResolveServerOptions,
): string {
  const explicit =
    typeof options.serverUrl === "string" ? options.serverUrl.trim() : "";
  if (explicit) {
    return finalizeUrl(stripTrailingSlash(explicit), "options.serverUrl");
  }

  const list = Array.isArray(servers) ? servers.filter(isPlainObject) : [];
  const index = Number.isInteger(options.serverIndex)
    ? Math.max(0, options.serverIndex as number)
    : 0;
  const server = list[index] ?? list[0];

  let url =
    server && typeof server.url === "string" && server.url.trim()
      ? server.url.trim()
      : "";

  if (!url) {
    throw err(
      "NO_SERVER_URL",
      "The document declares no usable server URL. Pass options.serverUrl to specify one.",
    );
  }

  url = expandServerVariables(url, server?.variables, options.serverVariables);
  return finalizeUrl(stripTrailingSlash(url), "spec.servers");
}

/** Substitute `{name}` server variables using overrides, defaults, then enums. */
function expandServerVariables(
  url: string,
  definitions: unknown,
  overrides: Record<string, string> | undefined,
): string {
  const variables = isPlainObject(definitions) ? definitions : {};
  let out = url;

  for (const [name, definition] of Object.entries<any>(variables)) {
    const override = overrides?.[name];

    let value: unknown;
    if (override !== undefined && override !== null) {
      value = override;
      // An override outside the declared enum would produce an invalid URL.
      if (
        Array.isArray(definition?.enum) &&
        definition.enum.length &&
        !definition.enum.some(
          (entry: unknown) => String(entry) === String(override),
        )
      ) {
        throw err(
          "BAD_SERVER_VARIABLE",
          `Server variable "${name}" must be one of: ${definition.enum.join(", ")}`,
          { provided: override, allowed: definition.enum },
        );
      }
    } else if (definition?.default !== undefined) {
      value = definition.default;
    } else if (Array.isArray(definition?.enum) && definition.enum.length) {
      value = definition.enum[0];
    } else {
      // The specification requires `default`; treat its absence as fatal rather
      // than silently emptying a path segment.
      throw err(
        "BAD_SERVER_VARIABLE",
        `Server variable "${name}" has no default; pass serverVariables["${name}"].`,
      );
    }

    out = out.split(`{${name}}`).join(String(value ?? ""));
  }

  // Any override for an undeclared variable is still applied, since a document
  // may template its URL without formally declaring the variable.
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (Object.prototype.hasOwnProperty.call(variables, name)) continue;
    if (value === undefined || value === null) continue;
    out = out.split(`{${name}}`).join(String(value));
  }

  return out;
}

/**
 * Strip unresolved single-brace placeholders while preserving `{{name}}`
 * sequences, which are Postman variables resolved later by the runtime.
 */
function stripUnresolvedPlaceholders(url: string): string {
  if (url.indexOf("{") === -1) return url;

  const guarded = url
    .split("{{")
    .join(GUARD_OPEN)
    .split("}}")
    .join(GUARD_CLOSE);
  const cleaned = guarded.replace(/\{[^{}]*\}/g, "");
  return cleaned.split(GUARD_OPEN).join("{{").split(GUARD_CLOSE).join("}}");
}

function stripTrailingSlash(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  return stripped || url;
}

/** Validate the shape of the resolved URL and reject unusable results. */
function finalizeUrl(url: string, source: string): string {
  const cleaned = stripUnresolvedPlaceholders(url);

  if (!cleaned) {
    throw err("BAD_SERVER_URL", `${source} resolved to an empty URL`);
  }

  // A Postman variable may stand in for the whole origin; defer validation.
  if (cleaned.includes("{{")) return cleaned;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    throw err(
      "RELATIVE_SERVER_URL",
      `${source} resolved to the relative URL "${cleaned}". ` +
        "A request needs an absolute origin; pass options.serverUrl.",
      { url: cleaned },
    );
  }

  return cleaned;
}

export interface BuildEnvironmentOptions {
  /** Mark values whose key looks like a credential as secret. Defaults to true. */
  maskSecrets?: boolean;
  /** Allow `variables.baseUrl` to override the resolved base URL. Defaults to false. */
  allowBaseUrlOverride?: boolean;
}

export function buildEnvironment(
  name: string,
  baseUrl: string,
  variables: Record<string, string> = {},
  options: BuildEnvironmentOptions = {},
): Record<string, any> {
  const maskSecrets = options.maskSecrets !== false;
  const allowOverride = options.allowBaseUrlOverride === true;
  const source = isPlainObject(variables) ? variables : {};

  const values: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  const push = (key: string, value: unknown, type: string) => {
    if (typeof key !== "string" || !key) return;
    if (seen.has(key)) return;
    seen.add(key);
    values.push({
      key,
      value: value === null || value === undefined ? "" : String(value),
      type,
      enabled: true,
    });
  };

  // baseUrl is claimed first unless the caller explicitly allows an override,
  // which keeps this function consistent with the runtime variable scope.
  if (!allowOverride) {
    push("baseUrl", baseUrl, "default");
  }

  for (const [key, value] of Object.entries(source)) {
    push(
      key,
      value,
      maskSecrets && isSecretKey(key) ? "secret" : "default",
    );
  }

  if (allowOverride) {
    push("baseUrl", baseUrl, "default");
  }

  return {
    id: uniqueId("protokit-env"),
    name: typeof name === "string" && name.trim() ? name : "protokit",
    values,
    _postman_variable_scope: "environment",
    _postman_exported_at: new Date().toISOString(),
  };
}
