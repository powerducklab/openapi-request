import {
  DescriptorShapeError,
  isMapEntry,
  readEnumValueNames,
  readFields,
  readNestedTypes,
  readOneofNames,
  pick,
  type FieldDescriptor,
} from "./descriptor-types.js";
import { LOADER_OPTIONS, resolveTypeName, type Catalog } from "./catalog.js";

export interface OneofHint {
  /** Dot path of the containing message; "" means the root message. */
  at: string;
  oneof: string;
  /** Field names in this oneof, in declaration order. Exactly one may be set. */
  branches: string[];
  /** Which branch the generated template pre-fills. */
  chosen: string;
  /**
   * Per-branch shape, so a UI can switch branches without re-describing the
   * method. Values are the same proto3-JSON form the example uses.
   *
   * A branch may be absent here: a message-typed branch under
   * fillMessageFields:false has no value to offer, and inventing `{}` for it
   * would claim "set with all defaults" rather than "not set".
   */
  branchValues: Record<string, unknown>;
}

export interface EnumHint {
  /** Dot path of the field. */
  at: string;
  /** Fully-qualified enum name. */
  enum: string;
  values: string[];
}

export interface CollectionHint {
  at: string;
  kind: "repeated" | "map";
  /** Element / value type, for UI display. */
  of: string;
  /** Map key type, for maps only. */
  keyOf?: string;
}

export interface PresenceHint {
  at: string;
  /**
   * Explicit-presence field: omitting it and setting it to the zero value are
   * distinguishable on the wire, so the UI must not conflate them.
   *
   * Exactly one hint is emitted per path. An `optional` message field is
   * reported as "proto3_optional" only — two entries for one path, each with
   * its own presentInExample, would leave the UI no way to pick.
   */
  reason: "proto3_optional" | "message";
  /** Whether the generated example includes this key. */
  presentInExample: boolean;
  /**
   * Value to use if the user chooses to set it. Always computed, including when
   * the example omits the key — that is the whole purpose of the hint, and
   * re-describing the method to recover it is what these hints exist to avoid.
   */
  valueIfSet: unknown;
}

export interface MessageTemplate {
  /** Fully-qualified message name, no leading dot. */
  message: string;
  /** Editable example in proto3 JSON shape. */
  example: Record<string, unknown>;
  /**
   * Which key spelling the example uses. Mirrors the loader configuration the
   * request will actually be serialised with; editing tools should not assume.
   */
  keyStyle: "declared" | "json";
  oneofs: OneofHint[];
  enums: EnumHint[];
  collections: CollectionHint[];
  presence: PresenceHint[];
  /** Truncated recursion, unresolvable types, unsupported well-known types. */
  warnings: string[];
}

/**
 * "This key must not appear at all", as distinct from undefined.
 *
 * Presence is observable on the wire, so `{ profile: undefined }` and `{}` are
 * the same request but not the same document: the first renders as a field in
 * any UI that walks Object.keys, and contradicts a presence hint that says
 * presentInExample:false.
 */
const OMIT = Symbol("omit");

const SCALAR_DEFAULTS: Record<string, unknown> = {
  TYPE_DOUBLE: 0,
  TYPE_FLOAT: 0,
  TYPE_INT32: 0,
  TYPE_UINT32: 0,
  TYPE_SINT32: 0,
  TYPE_FIXED32: 0,
  TYPE_SFIXED32: 0,
  TYPE_BOOL: false,
  TYPE_STRING: "",
  TYPE_BYTES: "",
  // 64-bit integers are strings under proto3 JSON and longs:String.
  TYPE_INT64: "0",
  TYPE_UINT64: "0",
  TYPE_SINT64: "0",
  TYPE_FIXED64: "0",
  TYPE_SFIXED64: "0",
};

/**
 * Well-known types whose proto3-JSON form is not a plain message.
 *
 * `google.protobuf.Value` is deliberately absent: its JSON form is "any JSON
 * value", and seeding `null` would be indistinguishable from "not set" in the
 * editor. It is reported as a warning instead.
 */
const WELL_KNOWN: Record<string, unknown> = {
  "google.protobuf.Timestamp": "1970-01-01T00:00:00Z",
  "google.protobuf.Duration": "0s",
  "google.protobuf.Empty": {},
  "google.protobuf.StringValue": "",
  "google.protobuf.BoolValue": false,
  "google.protobuf.Int32Value": 0,
  "google.protobuf.Int64Value": "0",
  "google.protobuf.UInt32Value": 0,
  "google.protobuf.UInt64Value": "0",
  "google.protobuf.DoubleValue": 0,
  "google.protobuf.FloatValue": 0,
  "google.protobuf.BytesValue": "",
  "google.protobuf.FieldMask": "",
  "google.protobuf.Struct": {},
  "google.protobuf.ListValue": [],
};

const FREE_FORM_WELL_KNOWN = new Set([
  "google.protobuf.Value",
  "google.protobuf.Any",
]);

function stripDot(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child;
}

export interface BuildTemplateOptions {
  /** Recursion cap for self-referential or deep messages. Default 4. */
  maxDepth?: number;
  /**
   * When true, repeated/map fields get one sample element so the user has
   * something to edit. When false they start empty. Default true.
   */
  seedCollections?: boolean;
  /**
   * When true, `optional` (explicit-presence) fields are pre-filled with their
   * zero value. Default FALSE: presence is observable on the wire, and a
   * template that silently sets every optional field would make "omitted" the
   * one state the user cannot reach by accident. The hints tell the UI what to
   * offer instead.
   */
  fillExplicitOptional?: boolean;
  /**
   * When true, singular message-typed fields are pre-filled. Message fields
   * also have explicit presence, but omitting them entirely would leave the
   * user with nothing to expand, so the default is TRUE and the presence hint
   * records that the key may be removed.
   */
  fillMessageFields?: boolean;
}

interface Ctx {
  catalog: Catalog;
  maxDepth: number;
  seedCollections: boolean;
  fillExplicitOptional: boolean;
  fillMessageFields: boolean;
  keyOf: (f: FieldDescriptor) => string;
  oneofs: OneofHint[];
  enums: EnumHint[];
  collections: CollectionHint[];
  presence: PresenceHint[];
  warnings: string[];
  /** Guards against infinite recursion on cyclic message graphs. */
  stack: string[];
  /**
   * Suppresses hint recording. Raised while probing alternative oneof branches
   * and while computing an `optional` field's valueIfSet — in both cases the
   * paths being walked are not present in the example, so hints for them would
   * point at fields the user cannot see.
   */
  hintDepth: number;
}

/**
 * Key spelling must match how the request will actually be serialised.
 *
 * proto-loader honours `keepCase` when building codecs, so a template keyed
 * the other way round produces requests whose fields are silently dropped —
 * no error, no warning, just missing data. Deriving it from LOADER_OPTIONS
 * makes the two impossible to configure apart.
 */
const KEY_STYLE: "declared" | "json" =
  LOADER_OPTIONS.keepCase === true ? "declared" : "json";

function keyForField(field: FieldDescriptor): string {
  if (KEY_STYLE === "declared") return field.name;
  return field.jsonName ?? toLowerCamel(field.name);
}

function toLowerCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Builds an editable proto3-JSON example for a message.
 *
 * The shape is fixed by the descriptor and is NOT user-editable; what the user
 * edits are the values, plus four structural choices the schema leaves open:
 * which oneof branch is set, whether an explicit-presence field is present at
 * all, how many elements a repeated field or map has, and (outside this
 * function) metadata / deadline / flow control. Those four are reported as
 * hints rather than baked into the example.
 */
export function buildMessageTemplate(
  catalog: Catalog,
  messageName: string,
  options: BuildTemplateOptions = {},
): MessageTemplate {
  const ctx: Ctx = {
    catalog,
    maxDepth: options.maxDepth ?? 4,
    seedCollections: options.seedCollections !== false,
    fillExplicitOptional: options.fillExplicitOptional === true,
    fillMessageFields: options.fillMessageFields !== false,
    keyOf: keyForField,
    oneofs: [],
    enums: [],
    collections: [],
    presence: [],
    warnings: [],
    stack: [],
    hintDepth: 0,
  };

  // The root message name comes from a resolved method, where it is already
  // fully qualified. It is still routed through the resolver so that a relative
  // input resolves rather than failing — with an empty scope the resolver
  // degrades to an exact lookup, which is the old behaviour.
  const requested = stripDot(messageName);
  const fq = resolveMessageRef(ctx, "", messageName) ?? requested;

  let example: Record<string, unknown> = {};
  try {
    example = buildMessage(ctx, fq, "", 0) ?? {};
  } catch (e) {
    if (e instanceof DescriptorShapeError) {
      ctx.warnings.push(
        `template generation stopped: ${e.message}. ` +
          `The request must be composed by hand.`,
      );
    } else {
      throw e;
    }
  }

  return {
    message: fq,
    example,
    keyStyle: KEY_STYLE,
    oneofs: ctx.oneofs,
    enums: ctx.enums,
    collections: ctx.collections,
    presence: ctx.presence,
    warnings: ctx.warnings,
  };
}

function recording(ctx: Ctx): boolean {
  return ctx.hintDepth === 0;
}

function warn(ctx: Ctx, message: string): void {
  if (recording(ctx)) ctx.warnings.push(message);
}

/** Runs `fn` with hint recording suppressed. */
function withoutHints<T>(ctx: Ctx, fn: () => T): T {
  ctx.hintDepth++;
  try {
    return fn();
  } finally {
    ctx.hintDepth--;
  }
}

/* ------------------------------------------------------------------ *
 * Symbol lookup
 *
 * Every type reference goes through catalog.resolveTypeName rather than an
 * exact `symbols.get(stripDot(typeName))`. The exact lookup only works on
 * descriptors produced by protoc; the ones this library actually receives are
 * synthesised by protobufjs and carry the reference as written in the .proto
 * source, so `common.Meta` inside package `demo.echo` never matched the
 * `demo.common.Meta` sitting in the table.
 * ------------------------------------------------------------------ */

/** Resolves a reference and confirms it names a message. */
function resolveMessageRef(
  ctx: Ctx,
  scope: string,
  ref: string,
): string | undefined {
  const fq = resolveTypeName(ctx.catalog, scope, ref);
  if (fq === undefined) return undefined;
  return ctx.catalog.symbols.get(fq)?.kind === "message" ? fq : undefined;
}

/** Resolves a reference and confirms it names an enum. */
function resolveEnumRef(
  ctx: Ctx,
  scope: string,
  ref: string,
): string | undefined {
  const fq = resolveTypeName(ctx.catalog, scope, ref);
  if (fq === undefined) return undefined;
  return ctx.catalog.symbols.get(fq)?.kind === "enum" ? fq : undefined;
}

function lookupMessage(ctx: Ctx, fq: string): unknown | undefined {
  const entry = ctx.catalog.symbols.get(fq);
  return entry?.kind === "message" ? entry.type : undefined;
}

function lookupEnum(ctx: Ctx, fq: string): unknown | undefined {
  const entry = ctx.catalog.symbols.get(fq);
  return entry?.kind === "enum" ? entry.type : undefined;
}

/**
 * Best-effort display name for a type reference that may not resolve.
 *
 * Hints are consumed by a UI, so an unresolvable reference still has to be
 * shown as something the user can recognise from their .proto — the raw
 * reference is exactly that, and inventing a qualified name would be worse.
 */
function displayType(ctx: Ctx, scope: string, field: FieldDescriptor): string {
  if (!field.typeName) return field.type;
  return (
    resolveTypeName(ctx.catalog, scope, field.typeName) ??
    stripDot(field.typeName)
  );
}

/**
 * Map fields are modelled in protobuf as a repeated synthetic nested message
 * with map_entry=true.
 *
 * The catalog deliberately does not register map-entry types as addressable
 * symbols, so the only way to read one is through the declaring message's
 * nested types. There is no global-lookup fallback: pretending there is one
 * would hide a catalog regression behind a second code path.
 *
 * An unreadable nested type returns undefined rather than throwing. One
 * unresolvable map field costs that field a warning and a degraded shape; it
 * must not empty the whole template, which is what an escaping
 * DescriptorShapeError would do.
 */
function findMapEntry(
  ctx: Ctx,
  parentFq: string,
  entryRef: string,
): { keyType: string; valueField: FieldDescriptor } | undefined {
  const parent = lookupMessage(ctx, parentFq);
  if (!parent) return undefined;

  // Only the last component is compared, because the reference may be written
  // relatively and the entry is by construction nested directly in the parent.
  const bare = stripDot(entryRef);
  const shortName = bare.slice(bare.lastIndexOf(".") + 1);

  try {
    for (const nested of readNestedTypes(parent)) {
      if (String(pick(nested, "name", "name") ?? "") !== shortName) continue;
      if (!isMapEntry(nested)) continue;
      const fields = readFields(nested);
      const key = fields.find((f) => f.name === "key");
      const value = fields.find((f) => f.name === "value");
      if (key && value) return { keyType: key.type, valueField: value };
    }
  } catch (e) {
    if (!(e instanceof DescriptorShapeError)) throw e;
    // Caller warns and degrades to a plain repeated message field.
    return undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Oneof classification
 * ------------------------------------------------------------------ */

function isSyntheticOneof(
  oneofName: string | undefined,
  members: FieldDescriptor[],
): boolean {
  if (members.length !== 1) return false;
  if (members[0].label === "LABEL_REPEATED") return false;
  // Name unknown: both signals (the proto3_optional flag and the `_x` naming
  // convention) are missing, so the group cannot be classified on evidence.
  // A single-member group is decided in favour of presence because the two
  // errors are not symmetric — misreading a real oneof merely fails to
  // pre-fill a branch, while misreading presence FABRICATES a field the user
  // never set, and that difference is observable on the wire.
  if (oneofName === undefined) return true;
  return oneofName === `_${members[0].name}`;
}

function buildMessage(
  ctx: Ctx,
  fq: string,
  path: string,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > ctx.maxDepth) {
    warn(
      ctx,
      `recursion depth ${ctx.maxDepth} reached at "${path || "(root)"}" ` +
        `(${fq}); the value is an empty message, which on the wire means ` +
        `"set with all defaults" — remove the key to leave it unset.`,
    );
    return {};
  }
  if (ctx.stack.includes(fq)) {
    warn(
      ctx,
      `cyclic reference to ${fq} at "${path}"; the value is an empty message, ` +
        `which on the wire means "set with all defaults".`,
    );
    return {};
  }

  const type = lookupMessage(ctx, fq);
  if (!type) {
    warn(
      ctx,
      `message "${fq}" is not in the symbol table (referenced at ` +
        `"${path || "(root)"}"); left as an empty object. The descriptor ` +
        `closure is incomplete — the catalog notes say which references failed.`,
    );
    return {};
  }

  ctx.stack.push(fq);
  try {
    const fields = readFields(type);
    const oneofNames = readOneofNames(type);
    const out: Record<string, unknown> = {};

    // Group every oneof member first, then classify. Classification needs the
    // whole group (a synthetic oneof is defined partly by having one member),
    // so it cannot be decided field by field during collection.
    const grouped = new Map<number, FieldDescriptor[]>();
    for (const field of fields) {
      if (field.oneofIndex === undefined) continue;
      const list = grouped.get(field.oneofIndex) ?? [];
      list.push(field);
      grouped.set(field.oneofIndex, list);
    }

    /** oneofIndex -> members, for genuine user-declared oneofs only. */
    const realOneofs = new Map<number, FieldDescriptor[]>();
    /** Fields that are explicit-presence singulars, by field name. */
    const explicitPresence = new Set<string>();

    for (const [index, members] of grouped) {
      const synthetic =
        members.every((m) => m.proto3Optional) ||
        isSyntheticOneof(oneofNames[index], members);
      if (synthetic) {
        for (const m of members) explicitPresence.add(m.name);
      } else {
        // A mixed group — some members flagged proto3_optional, some not — is
        // not a shape protoc can emit. Treating it as a real oneof would
        // pre-fill one branch; treating it as presence would pre-fill none.
        // Presence is the safe side: it can only omit, never fabricate.
        const flagged = members.filter((m) => m.proto3Optional);
        if (flagged.length > 0) {
          warn(
            ctx,
            `oneof "${oneofNames[index] ?? index}" in ${fq} mixes ` +
              `${flagged.length} explicit-presence member(s) with ` +
              `${members.length - flagged.length} plain one(s), which protoc ` +
              `does not produce. All of them are treated as optional fields ` +
              `and left unset; set at most one by hand.`,
          );
          for (const m of members) explicitPresence.add(m.name);
        } else {
          realOneofs.set(index, members);
        }
      }
    }

    const handledOneofs = new Set<number>();

    for (const field of fields) {
      const key = ctx.keyOf(field);
      const fieldPath = joinPath(path, field.name);

      // --- real oneof: pre-fill one branch, describe them all ---------------
      if (field.oneofIndex !== undefined && realOneofs.has(field.oneofIndex)) {
        if (handledOneofs.has(field.oneofIndex)) continue;
        handledOneofs.add(field.oneofIndex);

        const members = realOneofs.get(field.oneofIndex)!;
        const chosen = members[0];

        // Chosen branch contributes hints normally.
        const chosenValue = buildFieldValue(
          ctx,
          fq,
          chosen,
          joinPath(path, chosen.name),
          depth,
        );

        // Other branches are shaped for the UI but must not pollute the
        // top-level hint lists, or a user who never switches branches sees
        // enum/collection entries for paths that are not in the example.
        const branchValues: Record<string, unknown> = {};
        if (chosenValue !== OMIT) {
          branchValues[ctx.keyOf(chosen)] = chosenValue;
        }
        withoutHints(ctx, () => {
          for (const m of members.slice(1)) {
            const v = buildFieldValue(
              ctx,
              fq,
              m,
              joinPath(path, m.name),
              depth,
            );
            if (v !== OMIT) branchValues[ctx.keyOf(m)] = v;
          }
        });

        if (recording(ctx)) {
          ctx.oneofs.push({
            at: path,
            oneof: oneofNames[field.oneofIndex] ?? `oneof_${field.oneofIndex}`,
            branches: members.map((m) => m.name),
            chosen: chosen.name,
            branchValues,
          });
        }
        if (chosenValue !== OMIT) out[ctx.keyOf(chosen)] = chosenValue;
        continue;
      }

      // --- explicit presence: describe, do not silently set -----------------
      if (field.proto3Optional || explicitPresence.has(field.name)) {
        // Hints are suppressed while computing the value: this field's presence
        // is described by the entry pushed below, and a message-typed
        // `optional` would otherwise also emit a "message" hint for the same
        // path with a contradictory presentInExample. Anything inside the value
        // only exists once the user adds the field back, and its shape travels
        // in valueIfSet.
        const valueIfSet = withoutHints(ctx, () =>
          buildFieldValue(ctx, fq, field, fieldPath, depth),
        );
        if (recording(ctx)) {
          ctx.presence.push({
            at: fieldPath,
            reason: "proto3_optional",
            presentInExample: ctx.fillExplicitOptional,
            valueIfSet: valueIfSet === OMIT ? undefined : valueIfSet,
          });
        }
        if (ctx.fillExplicitOptional && valueIfSet !== OMIT) {
          out[key] = valueIfSet;
        }
        continue;
      }

      const value = buildFieldValue(ctx, fq, field, fieldPath, depth);
      if (value !== OMIT) out[key] = value;
    }

    return out;
  } finally {
    ctx.stack.pop();
  }
}

function buildFieldValue(
  ctx: Ctx,
  parentFq: string,
  field: FieldDescriptor,
  path: string,
  depth: number,
): unknown {
  const isRepeated = field.label === "LABEL_REPEATED";

  // Map field: repeated synthetic map_entry message.
  if (isRepeated && field.type === "TYPE_MESSAGE" && field.typeName) {
    const mapInfo = findMapEntry(ctx, parentFq, field.typeName);
    if (mapInfo) {
      if (recording(ctx)) {
        ctx.collections.push({
          at: path,
          kind: "map",
          of: displayType(ctx, parentFq, mapInfo.valueField),
          keyOf: mapInfo.keyType,
        });
      }
      if (!ctx.seedCollections) return {};
      const sampleKey = mapInfo.keyType === "TYPE_STRING" ? "key" : "0";
      const sampleValue = buildSingularValue(
        ctx,
        parentFq,
        mapInfo.valueField,
        `${path}.${sampleKey}`,
        depth,
      );
      // Presence applies to a field, not to a map's values: a map with one
      // entry whose value is omitted is not representable, so the sample entry
      // is dropped instead and the user starts from an empty map.
      return sampleValue === OMIT ? {} : { [sampleKey]: sampleValue };
    }
    // A repeated message whose entry type is not a readable map entry: treat as
    // a plain repeated message field, but say so — silently emitting `[]` for
    // what the user wrote as `map<...>` would be a lie about the schema.
    warn(
      ctx,
      `"${path}" is a repeated ${stripDot(field.typeName)} that could not be ` +
        `read as a map entry; treating it as a repeated message field.`,
    );
  }

  if (isRepeated) {
    if (recording(ctx)) {
      ctx.collections.push({
        at: path,
        kind: "repeated",
        of: displayType(ctx, parentFq, field),
      });
    }
    if (!ctx.seedCollections) return [];
    const element = buildSingularValue(
      ctx,
      parentFq,
      field,
      `${path}[0]`,
      depth,
    );
    // Same reasoning as maps: an omitted element means an empty list, never a
    // hole in one. `[undefined]` would serialise as a null element.
    return element === OMIT ? [] : [element];
  }

  return buildSingularValue(ctx, parentFq, field, path, depth);
}

function buildSingularValue(
  ctx: Ctx,
  parentFq: string,
  field: FieldDescriptor,
  path: string,
  depth: number,
): unknown {
  if (field.type === "TYPE_ENUM") {
    // readFields guarantees typeName for TYPE_ENUM.
    const ref = field.typeName!;
    const fq = resolveEnumRef(ctx, parentFq, ref);
    const shown = fq ?? stripDot(ref);

    let values: string[] = [];
    if (fq !== undefined) {
      const enumType = lookupEnum(ctx, fq);
      try {
        values = readEnumValueNames(enumType);
      } catch (e) {
        if (!(e instanceof DescriptorShapeError)) throw e;
        warn(ctx, `enum "${shown}" at "${path}" is unreadable: ${e.message}`);
      }
    }

    if (values.length === 0) {
      warn(
        ctx,
        fq === undefined
          ? `enum "${shown}" at "${path}" does not resolve from scope ` +
              `"${parentFq}"; the example uses an empty string, which the ` +
              `server will reject. The catalog notes list the failed references.`
          : `enum "${shown}" at "${path}" declares no values; the example uses ` +
              `an empty string, which the server will reject.`,
      );
      return "";
    }
    if (recording(ctx)) ctx.enums.push({ at: path, enum: shown, values });
    // enums:String means the JSON form is the value name.
    return values[0];
  }

  if (field.type === "TYPE_MESSAGE" || field.type === "TYPE_GROUP") {
    const ref = field.typeName!;
    // Well-known types are matched on the reference itself as well as on the
    // resolved name: they are usually written fully qualified and are often
    // absent from the symbol table, since a descriptor set need not include
    // google/protobuf/*.proto for the loader to handle them.
    const bare = stripDot(ref);
    const resolved = resolveMessageRef(ctx, parentFq, ref);
    const fq = resolved ?? bare;

    if (fq === "google.protobuf.Any" || bare === "google.protobuf.Any") {
      warn(
        ctx,
        `"${path}" is google.protobuf.Any; its payload is passed through ` +
          `unmodified and is not validated against the descriptor. ` +
          `Editing support is not available in this version.`,
      );
      return { "@type": "", value: {} };
    }
    if (FREE_FORM_WELL_KNOWN.has(fq) || FREE_FORM_WELL_KNOWN.has(bare)) {
      warn(
        ctx,
        `"${path}" is ${fq}, whose JSON form is any JSON value; ` +
          `no example can be generated without guessing. Supply it by hand.`,
      );
      return {};
    }
    if (fq in WELL_KNOWN) return WELL_KNOWN[fq];
    if (bare in WELL_KNOWN) return WELL_KNOWN[bare];

    if (resolved === undefined) {
      warn(
        ctx,
        `message "${bare}" at "${path}" does not resolve from scope ` +
          `"${parentFq}"; left as an empty object, which on the wire means ` +
          `"set with all defaults". The catalog notes list the failed ` +
          `references.`,
      );
      // Still reported as explicit presence: the field's presence semantics are
      // a property of the field, not of whether we could read its type.
      if (recording(ctx)) {
        ctx.presence.push({
          at: path,
          reason: "message",
          presentInExample: ctx.fillMessageFields,
          valueIfSet: {},
        });
      }
      return ctx.fillMessageFields ? {} : OMIT;
    }

    // Message-typed fields always have explicit presence. The value is built
    // whether or not the example keeps it: a hint whose valueIfSet is undefined
    // tells the UI nothing, and re-describing the method just to re-add a
    // removed field is exactly what these hints exist to avoid.
    const value = buildMessage(ctx, resolved, path, depth + 1) ?? {};
    if (recording(ctx)) {
      ctx.presence.push({
        at: path,
        reason: "message",
        presentInExample: ctx.fillMessageFields,
        valueIfSet: value,
      });
    }
    return ctx.fillMessageFields ? value : OMIT;
  }

  if (field.type in SCALAR_DEFAULTS) return SCALAR_DEFAULTS[field.type];

  warn(
    ctx,
    `unhandled field type ${field.type} at "${path}"; the example uses null, ` +
      `which will not serialise.`,
  );
  return null;
}
