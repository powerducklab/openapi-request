import type { ScriptSource, ScriptConfig } from "../../core/types";
import { isPlainObject } from "../../core/utils";

export interface PostmanEvent {
  listen: "prerequest" | "test";
  script: { id?: string; type: "text/javascript"; exec: string[] };
}

/**
 * Caps on scripts read from a document. A specification is often third-party
 * input, so its embedded code is bounded before it reaches the sandbox.
 */
const MAX_SPEC_SCRIPTS = 8;
const MAX_SCRIPT_LINES = 2000;
const MAX_SCRIPT_CHARS = 200_000;

/** Scope prefix keeps generated ids unique across collection and item events. */
type Scope = "collection" | "item";

function normalizeSources(
  input?: ScriptSource | ScriptSource[],
): ScriptSource[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  return list.filter(
    (entry): entry is ScriptSource =>
      isPlainObject(entry) &&
      (typeof entry.exec === "string" || Array.isArray(entry.exec)),
  );
}

function toExecLines(exec: string | string[]): string[] {
  const lines = Array.isArray(exec)
    ? exec.map((line) => (typeof line === "string" ? line : String(line ?? "")))
    : String(exec).split(/\r?\n/);

  const capped = lines.slice(0, MAX_SCRIPT_LINES);

  // Bound total size as well: many short lines can still be enormous.
  let total = 0;
  const out: string[] = [];
  for (const line of capped) {
    total += line.length + 1;
    if (total > MAX_SCRIPT_CHARS) break;
    out.push(line);
  }
  return out;
}

function toEvents(
  listen: "prerequest" | "test",
  scope: Scope,
  sources: ScriptSource[],
): PostmanEvent[] {
  const out: PostmanEvent[] = [];
  const usedIds = new Set<string>();

  sources.forEach((source, index) => {
    const exec = toExecLines(source.exec);
    // A script of only blank lines has no effect; skip it entirely.
    if (!exec.some((line) => line.trim().length > 0)) return;

    let id =
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : `protokit-${scope}-${listen}-${index}`;
    // Postman resolves scripts by id; a duplicate would shadow the earlier one.
    while (usedIds.has(id)) id = `${id}-b`;
    usedIds.add(id);

    out.push({
      listen,
      script: { id, type: "text/javascript", exec },
    });
  });

  return out;
}

/**
 * Read inline scripts from an `x-postman-scripts` extension.
 * Accepts a string, an array of lines, a ScriptSource, or an array of those.
 *
 * Security note: these scripts come from the OpenAPI document, which is often
 * not authored by the caller. They execute inside the postman-runtime sandbox on
 * every send. Set `scripts.fromSpecExtensions: false` when consuming an
 * untrusted specification.
 */
function readSpecScripts(
  node: any,
  scope: Scope,
): { pre: ScriptSource[]; test: ScriptSource[] } {
  const extension = node?.["x-postman-scripts"];
  if (!isPlainObject(extension)) return { pre: [], test: [] };

  const coerce = (value: unknown): ScriptSource[] => {
    if (value === null || value === undefined) return [];
    if (typeof value === "string") return [{ exec: value }];

    if (Array.isArray(value)) {
      if (!value.length) return [];
      // A homogeneous array of strings is one multi-line script.
      if (value.every((entry) => typeof entry === "string")) {
        return [{ exec: value as string[] }];
      }
      return value
        .filter(
          (entry): entry is ScriptSource =>
            isPlainObject(entry) &&
            (typeof entry.exec === "string" || Array.isArray(entry.exec)),
        )
        .slice(0, MAX_SPEC_SCRIPTS);
    }

    if (isPlainObject(value)) {
      const candidate = value as ScriptSource;
      if (typeof candidate.exec === "string" || Array.isArray(candidate.exec)) {
        return [candidate];
      }
    }
    return [];
  };

  // Collection-level keys are only honored at the document root; an operation
  // declaring `collectionPreRequest` would otherwise leak into item scope.
  const preSource =
    scope === "collection"
      ? (extension.collectionPreRequest ??
        extension.preRequest ??
        extension.prerequest)
      : (extension.preRequest ?? extension.prerequest);

  const testSource =
    scope === "collection"
      ? (extension.collectionTest ?? extension.test ?? extension.tests)
      : (extension.test ?? extension.tests);

  return {
    pre: coerce(preSource).slice(0, MAX_SPEC_SCRIPTS),
    test: coerce(testSource).slice(0, MAX_SPEC_SCRIPTS),
  };
}

export function buildCollectionEvents(
  spec: any,
  config?: ScriptConfig,
): PostmanEvent[] {
  const fromSpec =
    config?.fromSpecExtensions === false
      ? { pre: [], test: [] }
      : readSpecScripts(spec, "collection");

  return [
    ...toEvents("prerequest", "collection", [
      ...fromSpec.pre,
      ...normalizeSources(config?.collectionPreRequest),
    ]),
    ...toEvents("test", "collection", [
      ...fromSpec.test,
      ...normalizeSources(config?.collectionTest),
    ]),
  ];
}

export function buildItemEvents(
  operation: any,
  config?: ScriptConfig,
): PostmanEvent[] {
  const fromSpec =
    config?.fromSpecExtensions === false
      ? { pre: [], test: [] }
      : readSpecScripts(operation, "item");

  return [
    ...toEvents("prerequest", "item", [
      ...fromSpec.pre,
      ...normalizeSources(config?.preRequest),
    ]),
    ...toEvents("test", "item", [
      ...fromSpec.test,
      ...normalizeSources(config?.test),
    ]),
  ];
}

/**
 * Optional helper script that exposes the last response to subsequent requests.
 * The captured body is truncated, since an environment value is serialized in
 * full on every scope snapshot.
 */
export const BUILTIN_CAPTURE_TEST: ScriptSource = {
  id: "protokit-capture",
  exec: [
    "try {",
    "  pm.environment.set('__lastStatus', String(pm.response.code));",
    "  var contentType = pm.response.headers.get('content-type') || '';",
    "  if (/json/i.test(contentType)) {",
    "    var text = pm.response.text() || '';",
    "    if (text.length > 20000) { text = text.slice(0, 20000); }",
    "    pm.environment.set('__lastBody', text);",
    "  }",
    "} catch (error) {",
    "  console.warn('protokit capture failed: ' + (error && error.message));",
    "}",
  ],
};
