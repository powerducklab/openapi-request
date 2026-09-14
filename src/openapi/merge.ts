/**
 * Least-upper-bound merge for two JSON Schemas.
 *
 * The guiding rule is that merging must never lose information a user wrote by
 * hand. Keywords this module does not explicitly understand are carried over
 * verbatim instead of being dropped, because `mergeSchema` is also used to fold
 * a live observation into an author-maintained document.
 */

const TYPE_ORDER = [
  "null",
  "boolean",
  "integer",
  "number",
  "string",
  "array",
  "object",
];

/** Keys handled by dedicated logic below; everything else is passed through. */
const HANDLED_KEYS = new Set([
  "$ref",
  "type",
  "format",
  "properties",
  "required",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "enum",
  "const",
  "examples",
  "example",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "nullable",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_DEPTH = 20;
const MAX_ENUM = 50;
const MAX_EXAMPLES = 3;

const asTypeArray = (type: unknown): string[] => {
  if (type == null) return [];
  if (Array.isArray(type)) return type.filter((t) => typeof t === "string");
  return typeof type === "string" ? [type] : [];
};

const isObj = (v: unknown): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** True for a schema carrying no constraint at all. */
function isEmptySchema(schema: any): boolean {
  if (!isObj(schema)) return false;
  for (const key of Object.keys(schema)) {
    if (!UNSAFE_KEYS.has(key)) return false;
  }
  return true;
}

/**
 * Merge two JSON Schemas into their least upper bound.
 *
 * Types become a union, object properties are unioned, `required` shrinks to the
 * intersection so optional fields stay optional, and numeric or length bounds
 * widen to cover both inputs. Unknown keywords and `x-` extensions survive.
 */
export function mergeSchema(a: any, b: any, depth = 0): any {
  // Absent side: the other schema is already the upper bound.
  if (a === undefined || a === null) return b === undefined ? a : b;
  if (b === undefined || b === null) return a;
  if (!isObj(a)) return isObj(b) ? b : a;
  if (!isObj(b)) return a;
  if (a === b) return a;
  if (depth > MAX_DEPTH) return a;

  // Merging with a constraint-free schema must not erase the other side.
  if (isEmptySchema(b)) return a;
  if (isEmptySchema(a)) return b;

  // Preserve an existing $ref rather than inlining live observations over it.
  if (typeof a.$ref === "string") return a;
  if (typeof b.$ref === "string") return b;

  const out: Record<string, any> = {};

  /* ---------------- type ---------------- */
  let types = Array.from(
    new Set([...asTypeArray(a.type), ...asTypeArray(b.type)]),
  );
  // An integer is a number; keep only the wider type when both are present.
  if (types.includes("integer") && types.includes("number")) {
    types = types.filter((t) => t !== "integer");
  }
  types.sort((x, y) => {
    const ix = TYPE_ORDER.indexOf(x);
    const iy = TYPE_ORDER.indexOf(y);
    // Unrecognized type names sort last but are still preserved.
    return (
      (ix < 0 ? TYPE_ORDER.length : ix) - (iy < 0 ? TYPE_ORDER.length : iy)
    );
  });
  if (types.length === 1) out.type = types[0];
  else if (types.length > 1) out.type = types;

  /* ---------------- format ---------------- */
  // A format only survives when both sides agree, since a union of two formats
  // has no single representation.
  if (a.format !== undefined && a.format === b.format) {
    out.format = a.format;
  } else if (a.format !== undefined && b.format === undefined) {
    // The other side simply did not observe a format; keep what we know.
    out.format = a.format;
  } else if (b.format !== undefined && a.format === undefined) {
    out.format = b.format;
  }

  /* ---------------- nullable (OpenAPI 3.0 carry-over) ---------------- */
  if (a.nullable === true || b.nullable === true) out.nullable = true;

  /* ---------------- object shape ---------------- */
  if (a.properties !== undefined || b.properties !== undefined) {
    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries<any>(
      isObj(a.properties) ? a.properties : {},
    )) {
      if (UNSAFE_KEYS.has(key)) continue;
      properties[key] = value;
    }
    for (const [key, value] of Object.entries<any>(
      isObj(b.properties) ? b.properties : {},
    )) {
      if (UNSAFE_KEYS.has(key)) continue;
      properties[key] =
        properties[key] !== undefined
          ? mergeSchema(properties[key], value, depth + 1)
          : value;
    }
    out.properties = properties;

    const requiredA: string[] = Array.isArray(a.required)
      ? a.required.filter((k: unknown) => typeof k === "string")
      : [];
    const requiredB: string[] = Array.isArray(b.required)
      ? b.required.filter((k: unknown) => typeof k === "string")
      : [];

    if (isObj(a.properties) && isObj(b.properties)) {
      // Both sides describe the shape, so a field is only required when both agree.
      const setB = new Set(requiredB);
      const intersection = requiredA.filter((key) => setB.has(key));
      if (intersection.length) out.required = intersection;
    } else {
      // Only one side described properties; trust its required list as-is.
      const inherited = isObj(a.properties) ? requiredA : requiredB;
      if (inherited.length) out.required = inherited;
    }
  } else if (Array.isArray(a.required) || Array.isArray(b.required)) {
    // No properties on either side; keep the intersection of any stated lists.
    const ra = Array.isArray(a.required) ? a.required : [];
    const rb = Array.isArray(b.required) ? b.required : [];
    if (!ra.length) {
      if (rb.length) out.required = rb.slice();
    } else if (!rb.length) {
      out.required = ra.slice();
    } else {
      const setB = new Set(rb);
      const intersection = ra.filter((k: string) => setB.has(k));
      if (intersection.length) out.required = intersection;
    }
  }

  if (
    a.additionalProperties !== undefined ||
    b.additionalProperties !== undefined
  ) {
    const av = a.additionalProperties;
    const bv = b.additionalProperties;
    if (isObj(av) && isObj(bv)) {
      out.additionalProperties = mergeSchema(av, bv, depth + 1);
    } else if (av === true || bv === true) {
      // The permissive side wins: true is the upper bound.
      out.additionalProperties = true;
    } else {
      out.additionalProperties = av !== undefined ? av : bv;
    }
  }

  if (isObj(a.patternProperties) || isObj(b.patternProperties)) {
    const patterns: Record<string, any> = {
      ...(isObj(a.patternProperties) ? a.patternProperties : {}),
    };
    for (const [key, value] of Object.entries<any>(
      isObj(b.patternProperties) ? b.patternProperties : {},
    )) {
      patterns[key] = patterns[key]
        ? mergeSchema(patterns[key], value, depth + 1)
        : value;
    }
    out.patternProperties = patterns;
  }

  if (a.propertyNames !== undefined || b.propertyNames !== undefined) {
    out.propertyNames = mergeSchema(
      a.propertyNames,
      b.propertyNames,
      depth + 1,
    );
  }

  /* ---------------- array shape ---------------- */
  if (a.items !== undefined || b.items !== undefined) {
    out.items = mergeSchema(a.items, b.items, depth + 1);
  }

  if (Array.isArray(a.prefixItems) || Array.isArray(b.prefixItems)) {
    const pa: any[] = Array.isArray(a.prefixItems) ? a.prefixItems : [];
    const pb: any[] = Array.isArray(b.prefixItems) ? b.prefixItems : [];
    const length = Math.max(pa.length, pb.length);
    const prefix: any[] = [];
    for (let i = 0; i < length; i += 1) {
      prefix.push(
        pa[i] !== undefined && pb[i] !== undefined
          ? mergeSchema(pa[i], pb[i], depth + 1)
          : (pa[i] ?? pb[i]),
      );
    }
    out.prefixItems = prefix;
  }

  // uniqueItems is a restriction, so it only holds when both sides assert it.
  if (a.uniqueItems === true && b.uniqueItems === true) out.uniqueItems = true;

  /* ---------------- widening bounds ---------------- */
  // Lower bounds relax downward, upper bounds relax upward. When only one side
  // states a bound, dropping it is the correct least-upper-bound behaviour.
  assignLooser(out, "minimum", a, b, Math.min);
  assignLooser(out, "exclusiveMinimum", a, b, Math.min);
  assignLooser(out, "minLength", a, b, Math.min);
  assignLooser(out, "minItems", a, b, Math.min);
  assignLooser(out, "minProperties", a, b, Math.min);

  assignLooser(out, "maximum", a, b, Math.max);
  assignLooser(out, "exclusiveMaximum", a, b, Math.max);
  assignLooser(out, "maxLength", a, b, Math.max);
  assignLooser(out, "maxItems", a, b, Math.max);
  assignLooser(out, "maxProperties", a, b, Math.max);

  // multipleOf and pattern have no meaningful union; keep them only on agreement.
  if (typeof a.multipleOf === "number" && a.multipleOf === b.multipleOf) {
    out.multipleOf = a.multipleOf;
  }
  if (typeof a.pattern === "string" && a.pattern === b.pattern) {
    out.pattern = a.pattern;
  } else if (typeof a.pattern === "string" && b.pattern === undefined) {
    out.pattern = a.pattern;
  } else if (typeof b.pattern === "string" && a.pattern === undefined) {
    out.pattern = b.pattern;
  }

  /* ---------------- enumerations ---------------- */
  // An enum is a closed set. Widening it to a union is only sound when both
  // sides declare one; if either side is open, the result must stay open.
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    out.enum = dedupe([...a.enum, ...b.enum]).slice(0, MAX_ENUM);
  }

  if (a.const !== undefined && b.const !== undefined) {
    if (sameValue(a.const, b.const)) {
      out.const = a.const;
    } else {
      // Two different constants form a two-value enum.
      out.enum = dedupe([a.const, b.const]);
    }
  }

  /* ---------------- annotations ---------------- */
  const examples = dedupe([
    ...(Array.isArray(a.examples) ? a.examples : []),
    ...(Array.isArray(b.examples) ? b.examples : []),
  ]).slice(0, MAX_EXAMPLES);
  if (examples.length) out.examples = examples;

  // OpenAPI 3.0 style single example.
  if (a.example !== undefined || b.example !== undefined) {
    out.example = a.example !== undefined ? a.example : b.example;
  }
  if (a.default !== undefined || b.default !== undefined) {
    out.default = a.default !== undefined ? a.default : b.default;
  }

  for (const key of ["title", "description"] as const) {
    if (a[key] !== undefined || b[key] !== undefined) {
      out[key] = a[key] !== undefined ? a[key] : b[key];
    }
  }
  // A boolean flag only survives when both sides agree it applies.
  for (const key of ["deprecated", "readOnly", "writeOnly"] as const) {
    if (a[key] === true && b[key] === true) out[key] = true;
  }

  /* ---------------- composition ---------------- */
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const la = Array.isArray(a[key]) ? a[key] : undefined;
    const lb = Array.isArray(b[key]) ? b[key] : undefined;
    if (!la && !lb) continue;
    if (la && lb) {
      // Concatenating branches keeps both authored alternatives reachable.
      out[key] = dedupeSchemas([...la, ...lb]);
    } else {
      out[key] = (la ?? lb)!.slice();
    }
  }
  if (a.not !== undefined || b.not !== undefined) {
    // `not` is a restriction; only keep it when both sides agree exactly.
    if (a.not !== undefined && sameValue(a.not, b.not)) out.not = a.not;
  }

  /* ---------------- passthrough ---------------- */
  // Anything this function does not model explicitly, including every `x-`
  // extension, is preserved so a write-back never silently strips a keyword.
  for (const source of [b, a]) {
    for (const key of Object.keys(source)) {
      if (UNSAFE_KEYS.has(key)) continue;
      if (HANDLED_KEYS.has(key)) continue;
      // `a` is applied last so it wins on conflict.
      out[key] = source[key];
    }
  }

  return out;
}

/**
 * Write `key` only when both sides state it, using `pick` to choose the looser
 * bound. When only one side constrains the value, the union is unconstrained.
 */
function assignLooser(
  out: Record<string, any>,
  key: string,
  a: any,
  b: any,
  pick: (x: number, y: number) => number,
): void {
  const av = a[key];
  const bv = b[key];
  const aNum = typeof av === "number" && Number.isFinite(av);
  const bNum = typeof bv === "number" && Number.isFinite(bv);
  if (aNum && bNum) {
    out[key] = pick(av, bv);
    return;
  }
  // JSON Schema draft 4 allowed a boolean exclusiveMinimum/Maximum.
  if (typeof av === "boolean" && av === bv) out[key] = av;
}

function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  try {
    return JSON.stringify(x) === JSON.stringify(y);
  } catch {
    return false;
  }
}

function dedupe(list: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of list) {
    let key: string;
    try {
      const json = JSON.stringify(item);
      // Values with no JSON form (undefined, functions) are skipped.
      if (typeof json !== "string") continue;
      key = json;
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeSchemas(list: any[]): any[] {
  return dedupe(list.filter((entry) => entry !== undefined)) as any[];
}
