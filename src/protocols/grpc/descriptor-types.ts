/**
 * Descriptor field access.
 *
 * proto-loader and the reflection path both surface descriptors as
 * protobufjs `toObject()` output, where key casing (camelCase vs snake_case)
 * and enum representation (numeric vs string) are not guaranteed across
 * versions. Every read goes through these helpers.
 *
 * Design rule: these helpers NEVER substitute a default for a shape they did
 * not understand. A missing container throws `DescriptorShapeError`; a missing
 * scalar throws too. Defaulting is what previously let an entire descriptor
 * source degrade to "every service has zero methods" without a single warning.
 *
 * The only tolerated absence is a genuinely optional descriptor field
 * (`type_name`, `json_name`, `oneof_index`), which is modelled as `undefined`.
 */

/** Raised when a descriptor object does not have the shape we require. */
export class DescriptorShapeError extends Error {
  readonly expected: string;
  readonly observedKeys: string[];

  constructor(expected: string, observed: unknown, hint?: string) {
    const keys =
      observed && typeof observed === "object"
        ? Object.keys(observed as object).sort()
        : [];
    const shown = keys.length ? keys.slice(0, 24).join(", ") : "(none)";
    super(
      `descriptor shape mismatch: expected ${expected}, ` +
        `got ${describeValue(observed)} with keys [${shown}]` +
        (keys.length > 24 ? ` ...+${keys.length - 24} more` : "") +
        (hint ? `. ${hint}` : ""),
    );
    this.name = "DescriptorShapeError";
    this.expected = expected;
    this.observedKeys = keys;
  }
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  const t = typeof v;
  if (t === "object") return (v as object).constructor?.name ?? "object";
  return t;
}

/* ------------------------------------------------------------------ *
 * Key access
 * ------------------------------------------------------------------ */

/**
 * Reads a field that may be spelled camelCase or snake_case.
 *
 * Presence is decided by key existence, not by nullishness, so a legitimate
 * `false` / `0` / `""` is returned as-is and an explicit `null` does not leak
 * into the other spelling.
 */
export function pick<T = unknown>(
  obj: unknown,
  camel: string,
  snake: string,
): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(o, camel)) return o[camel] as T;
  if (camel !== snake && Object.prototype.hasOwnProperty.call(o, snake)) {
    return o[snake] as T;
  }
  return undefined;
}

/** True when either spelling of the key exists, regardless of its value. */
export function has(obj: unknown, camel: string, snake: string): boolean {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(o, camel) ||
    (camel !== snake && Object.prototype.hasOwnProperty.call(o, snake))
  );
}

/** Reads a repeated field. Absent is `[]`; present-but-not-an-array throws. */
function readRepeated(
  container: unknown,
  camel: string,
  snake: string,
  expectedOwner: string,
): unknown[] {
  if (!has(container, camel, snake)) return [];
  const v = pick(container, camel, snake);
  if (v === undefined) return [];
  if (v === null || !Array.isArray(v)) {
    throw new DescriptorShapeError(
      `${expectedOwner}.${snake} to be a repeated field`,
      container,
      `field "${snake}" is ${describeValue(v)}.`,
    );
  }
  return v;
}

function requireString(
  obj: unknown,
  camel: string,
  snake: string,
  owner: string,
): string {
  const v = pick(obj, camel, snake);
  if (typeof v !== "string" || v.length === 0) {
    throw new DescriptorShapeError(
      `${owner}.${snake} to be a non-empty string`,
      obj,
      `got ${describeValue(v)}.`,
    );
  }
  return v;
}

function requireNumber(
  obj: unknown,
  camel: string,
  snake: string,
  owner: string,
): number {
  const v = pick(obj, camel, snake);
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new DescriptorShapeError(
      `${owner}.${snake} to be a number`,
      obj,
      `got ${describeValue(v)}.`,
    );
  }
  return n;
}

/** Descriptor bools are frequently omitted when false — that is legitimate. */
function readBool(obj: unknown, camel: string, snake: string): boolean {
  const v = pick(obj, camel, snake);
  return v === true || v === 1 || v === "true";
}

/* ------------------------------------------------------------------ *
 * Enum tables
 * ------------------------------------------------------------------ */

export const TYPE_NAMES: Record<number, string> = {
  1: "TYPE_DOUBLE",
  2: "TYPE_FLOAT",
  3: "TYPE_INT64",
  4: "TYPE_UINT64",
  5: "TYPE_INT32",
  6: "TYPE_FIXED64",
  7: "TYPE_FIXED32",
  8: "TYPE_BOOL",
  9: "TYPE_STRING",
  10: "TYPE_GROUP",
  11: "TYPE_MESSAGE",
  12: "TYPE_BYTES",
  13: "TYPE_UINT32",
  14: "TYPE_ENUM",
  15: "TYPE_SFIXED32",
  16: "TYPE_SFIXED64",
  17: "TYPE_SINT32",
  18: "TYPE_SINT64",
};

export const LABEL_NAMES: Record<number, string> = {
  1: "LABEL_OPTIONAL",
  2: "LABEL_REQUIRED",
  3: "LABEL_REPEATED",
};

const TYPE_VALUES = new Set(Object.values(TYPE_NAMES));
const LABEL_VALUES = new Set(Object.values(LABEL_NAMES));

/**
 * Normalises a descriptor enum that may arrive as a number or as its name.
 * Unknown input throws rather than defaulting: guessing `TYPE_STRING` for an
 * unreadable type produces a request template that is confidently wrong.
 */
function requireEnum(
  raw: unknown,
  table: Record<number, string>,
  valid: Set<string>,
  owner: string,
  field: string,
): string {
  if (typeof raw === "string") {
    if (valid.has(raw)) return raw;
    throw new DescriptorShapeError(
      `${owner}.${field} to be a known enum name`,
      raw,
      `"${raw}" is not one of [${[...valid].join(", ")}].`,
    );
  }
  if (typeof raw === "number") {
    const name = table[raw];
    if (name) return name;
    throw new DescriptorShapeError(
      `${owner}.${field} to be a known enum number`,
      raw,
      `${raw} has no mapping; the descriptor may use a newer protobuf revision.`,
    );
  }
  throw new DescriptorShapeError(
    `${owner}.${field} to be present`,
    raw,
    `got ${describeValue(raw)}.`,
  );
}

/** Best-effort enum name for diagnostics only. Never feeds behaviour. */
export function enumName(
  value: unknown,
  table: Record<number, string>,
): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return table[value];
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Shape guards
 * ------------------------------------------------------------------ */

/**
 * A `DescriptorProto` is recognised by declaring at least one of the
 * containers a message descriptor is allowed to have. A message with no
 * fields at all still carries `name`, so `name` plus object-ness is the
 * minimum bar; the container check catches "this is a runtime object, not a
 * descriptor proto".
 */
export function isMessageDescriptor(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (!has(v, "name", "name")) return false;
  // ServiceDescriptorProto: only it has `method`.
  if (has(v, "method", "method")) return false;
  // EnumDescriptorProto: `value` is its members. A message never has one.
  if (has(v, "value", "value")) return false;
  // proto-loader runtime objects carry no `name` at all, but check anyway:
  // the failure this guards against is worth two comparisons.
  return !looksLikeRuntimeServiceObject(v);
}

export function isServiceDescriptor(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return has(v, "name", "name") && has(v, "method", "method");
}

export function isEnumDescriptor(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return has(v, "name", "name") && has(v, "value", "value");
}

/**
 * Distinguishes a proto-loader *runtime* service object (the thing with
 * `path` / `requestSerialize`) from a `ServiceDescriptorProto`. Passing the
 * former where the latter is expected was the original defect, so it gets a
 * dedicated, actionable message.
 */
export function looksLikeRuntimeServiceObject(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).some((m) => {
    const entry = m as { path?: unknown; requestSerialize?: unknown } | null;
    return (
      !!entry &&
      typeof entry === "object" &&
      typeof entry.path === "string" &&
      typeof entry.requestSerialize === "function"
    );
  });
}

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

export interface FieldDescriptor {
  name: string;
  number: number;
  /** TYPE_* */
  type: string;
  /** LABEL_* */
  label: string;
  /** Fully-qualified with a leading dot, e.g. ".demo.common.Meta" */
  typeName?: string;
  jsonName?: string;
  oneofIndex?: number;
  /** True only for `optional` in proto3 (explicit presence). */
  proto3Optional: boolean;
}

export function readFields(messageType: unknown): FieldDescriptor[] {
  assertMessageDescriptor(messageType);
  const owner = "DescriptorProto";
  const raw = readRepeated(messageType, "field", "field", owner);

  return raw.map((f, i) => {
    const fieldOwner = `FieldDescriptorProto[${i}]`;
    const typeName = pick<unknown>(f, "typeName", "type_name");
    const jsonName = pick<unknown>(f, "jsonName", "json_name");
    const oneofIndex = pick<unknown>(f, "oneofIndex", "oneof_index");

    const type = requireEnum(
      pick(f, "type", "type"),
      TYPE_NAMES,
      TYPE_VALUES,
      fieldOwner,
      "type",
    );

    if (
      (type === "TYPE_MESSAGE" ||
        type === "TYPE_ENUM" ||
        type === "TYPE_GROUP") &&
      typeof typeName !== "string"
    ) {
      throw new DescriptorShapeError(
        `${fieldOwner}.type_name to be present for ${type}`,
        f,
        `a ${type} field cannot be resolved without its type name.`,
      );
    }

    return {
      name: requireString(f, "name", "name", fieldOwner),
      number: requireNumber(f, "number", "number", fieldOwner),
      type,
      label: requireEnum(
        pick(f, "label", "label"),
        LABEL_NAMES,
        LABEL_VALUES,
        fieldOwner,
        "label",
      ),
      typeName: typeof typeName === "string" && typeName ? typeName : undefined,
      jsonName: typeof jsonName === "string" && jsonName ? jsonName : undefined,
      oneofIndex:
        typeof oneofIndex === "number" && Number.isFinite(oneofIndex)
          ? oneofIndex
          : undefined,
      proto3Optional: readBool(f, "proto3Optional", "proto3_optional"),
    };
  });
}

function assertMessageDescriptor(messageType: unknown): void {
  if (isMessageDescriptor(messageType)) return;
  throw new DescriptorShapeError(
    "a DescriptorProto (message descriptor)",
    messageType,
    looksLikeRuntimeServiceObject(messageType)
      ? "this looks like a proto-loader runtime object, not a descriptor proto. " +
          "Descriptor protos come from loadFileDescriptorSetFromBuffer or from reflection."
      : "the descriptor source did not produce descriptor protos.",
  );
}

/* ------------------------------------------------------------------ *
 * Oneofs, nesting, maps, enums
 * ------------------------------------------------------------------ */

export function readOneofNames(messageType: unknown): string[] {
  assertMessageDescriptor(messageType);
  const raw = readRepeated(
    messageType,
    "oneofDecl",
    "oneof_decl",
    "DescriptorProto",
  );
  return raw.map((o, i) =>
    requireString(o, "name", "name", `OneofDescriptorProto[${i}]`),
  );
}

export function readNestedTypes(messageType: unknown): unknown[] {
  assertMessageDescriptor(messageType);
  return readRepeated(
    messageType,
    "nestedType",
    "nested_type",
    "DescriptorProto",
  );
}

export function isMapEntry(messageType: unknown): boolean {
  if (!messageType || typeof messageType !== "object") return false;
  const options = pick(messageType, "options", "options");
  return readBool(options, "mapEntry", "map_entry");
}

export function readEnumValueNames(enumType: unknown): string[] {
  if (!isEnumDescriptor(enumType)) {
    throw new DescriptorShapeError(
      "an EnumDescriptorProto",
      enumType,
      "the descriptor source did not produce enum descriptors.",
    );
  }
  const raw = readRepeated(enumType, "value", "value", "EnumDescriptorProto");
  return raw.map((v, i) =>
    requireString(v, "name", "name", `EnumValueDescriptorProto[${i}]`),
  );
}

/* ------------------------------------------------------------------ *
 * Methods
 * ------------------------------------------------------------------ */

export interface MethodDescriptor {
  name: string;
  /** Fully-qualified with a leading dot. */
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

export function readMethods(serviceType: unknown): MethodDescriptor[] {
  if (!isServiceDescriptor(serviceType)) {
    throw new DescriptorShapeError(
      "a ServiceDescriptorProto",
      serviceType,
      looksLikeRuntimeServiceObject(serviceType)
        ? "this is a proto-loader runtime service object (entries carry `path` " +
            "and `requestSerialize`), which contains no method descriptors. " +
            "Load a FileDescriptorSet or use reflection to obtain them."
        : "the descriptor source did not produce service descriptors.",
    );
  }

  const raw = readRepeated(
    serviceType,
    "method",
    "method",
    "ServiceDescriptorProto",
  );

  return raw.map((m, i) => {
    const owner = `MethodDescriptorProto[${i}]`;
    return {
      name: requireString(m, "name", "name", owner),
      inputType: requireString(m, "inputType", "input_type", owner),
      outputType: requireString(m, "outputType", "output_type", owner),
      clientStreaming: readBool(m, "clientStreaming", "client_streaming"),
      serverStreaming: readBool(m, "serverStreaming", "server_streaming"),
    };
  });
}
