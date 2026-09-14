/**
 * Minimal protobuf wire decoder for descriptor.proto.
 *
 * Why hand-rolled: the descriptor bytes arrive from two places — a reflection
 * response and proto-loader's `fileDescriptorProtos` — and both must produce
 * one identical symbol table. Decoding them ourselves is the only way to
 * guarantee that without depending on proto-loader internals (the previous
 * implementation matched on its private `format` string, which meant a service
 * could vanish from the catalog without any error).
 *
 * Output convention: plain objects with snake_case keys, matching
 * descriptor.proto field names. Repeated containers are ALWAYS present (empty
 * array when absent) so downstream shape guards can distinguish "no methods"
 * from "not a descriptor at all". Enums stay numeric; the readers in
 * descriptor-types.ts normalise them.
 */

/* ------------------------------------------------------------------ *
 * Wire format
 * ------------------------------------------------------------------ */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_GROUP_START = 3;
const WIRE_GROUP_END = 4;
const WIRE_32BIT = 5;

export class DescriptorDecodeError extends Error {
  constructor(message: string) {
    super(`descriptor decode failed: ${message}`);
    this.name = "DescriptorDecodeError";
  }
}

interface Cursor {
  buf: Uint8Array;
  pos: number;
  end: number;
}

function readVarint(c: Cursor): bigint {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (c.pos >= c.end) throw new DescriptorDecodeError("truncated varint");
    const byte = c.buf[c.pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
    if (shift > 70n) throw new DescriptorDecodeError("varint too long");
  }
}

function skipField(c: Cursor, wireType: number, depth: number): void {
  switch (wireType) {
    case WIRE_VARINT:
      readVarint(c);
      return;
    case WIRE_64BIT:
      advance(c, 8);
      return;
    case WIRE_32BIT:
      advance(c, 4);
      return;
    case WIRE_LEN: {
      const len = Number(readVarint(c));
      advance(c, len);
      return;
    }
    case WIRE_GROUP_START: {
      if (depth > 32) throw new DescriptorDecodeError("group nesting too deep");
      for (;;) {
        if (c.pos >= c.end) {
          throw new DescriptorDecodeError("unterminated group");
        }
        const tag = Number(readVarint(c));
        const wt = tag & 7;
        if (wt === WIRE_GROUP_END) return;
        skipField(c, wt, depth + 1);
      }
    }
    default:
      throw new DescriptorDecodeError(`unsupported wire type ${wireType}`);
  }
}

function advance(c: Cursor, n: number): void {
  if (n < 0 || c.pos + n > c.end) {
    throw new DescriptorDecodeError("length exceeds buffer");
  }
  c.pos += n;
}

interface RawField {
  wireType: number;
  /** varint value, when wireType is VARINT */
  varint?: bigint;
  /** payload slice, when wireType is LEN */
  bytes?: Uint8Array;
}

/** Groups one message's fields by field number, preserving repetition order. */
function decodeMessage(buf: Uint8Array): Map<number, RawField[]> {
  const c: Cursor = { buf, pos: 0, end: buf.length };
  const out = new Map<number, RawField[]>();

  while (c.pos < c.end) {
    const tag = Number(readVarint(c));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNumber === 0) {
      throw new DescriptorDecodeError("field number 0 is invalid");
    }

    let entry: RawField;
    if (wireType === WIRE_VARINT) {
      entry = { wireType, varint: readVarint(c) };
    } else if (wireType === WIRE_LEN) {
      const len = Number(readVarint(c));
      if (len < 0 || c.pos + len > c.end) {
        throw new DescriptorDecodeError("length-delimited field overruns");
      }
      entry = { wireType, bytes: buf.subarray(c.pos, c.pos + len) };
      c.pos += len;
    } else {
      const before = c.pos;
      skipField(c, wireType, 0);
      entry = { wireType, bytes: buf.subarray(before, c.pos) };
    }

    const list = out.get(fieldNumber);
    if (list) list.push(entry);
    else out.set(fieldNumber, [entry]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Typed accessors
 * ------------------------------------------------------------------ */

const decoder = new TextDecoder("utf-8", { fatal: true });

function str(fields: Map<number, RawField[]>, n: number): string | undefined {
  const f = fields.get(n)?.at(-1);
  if (!f?.bytes) return undefined;
  try {
    return decoder.decode(f.bytes);
  } catch {
    throw new DescriptorDecodeError(`field ${n} is not valid UTF-8`);
  }
}

function int(fields: Map<number, RawField[]>, n: number): number | undefined {
  const f = fields.get(n)?.at(-1);
  if (f?.varint === undefined) return undefined;
  // Descriptor ints are small; a value outside safe range means misparse.
  const v = f.varint;
  if (v > 0x7fffffffn) {
    return Number(BigInt.asIntN(32, v));
  }
  return Number(v);
}

function bool(fields: Map<number, RawField[]>, n: number): boolean {
  const f = fields.get(n)?.at(-1);
  return f?.varint !== undefined && f.varint !== 0n;
}

function subs(fields: Map<number, RawField[]>, n: number): Uint8Array[] {
  const list = fields.get(n);
  if (!list) return [];
  return list.map((f) => {
    if (!f.bytes) {
      throw new DescriptorDecodeError(
        `field ${n} was expected to be length-delimited`,
      );
    }
    return f.bytes;
  });
}

function sub(
  fields: Map<number, RawField[]>,
  n: number,
): Uint8Array | undefined {
  return subs(fields, n).at(-1);
}

/* ------------------------------------------------------------------ *
 * descriptor.proto shapes
 * ------------------------------------------------------------------ */

export interface DecodedFile {
  name?: string;
  package?: string;
  syntax?: string;
  dependency: string[];
  message_type: DecodedMessage[];
  enum_type: DecodedEnum[];
  service: DecodedService[];
}

export interface DecodedMessage {
  name: string;
  field: DecodedField[];
  nested_type: DecodedMessage[];
  enum_type: DecodedEnum[];
  oneof_decl: { name: string }[];
  options: { map_entry: boolean };
}

export interface DecodedField {
  name: string;
  number: number;
  label: number;
  type: number;
  type_name?: string;
  json_name?: string;
  oneof_index?: number;
  proto3_optional: boolean;
}

export interface DecodedEnum {
  name: string;
  value: { name: string; number: number }[];
}

export interface DecodedService {
  name: string;
  method: DecodedMethod[];
}

export interface DecodedMethod {
  name: string;
  input_type: string;
  output_type: string;
  client_streaming: boolean;
  server_streaming: boolean;
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") {
    throw new DescriptorDecodeError(`${what} is missing or empty`);
  }
  return value;
}

function decodeField(buf: Uint8Array): DecodedField {
  const f = decodeMessage(buf);
  const label = int(f, 4);
  const type = int(f, 5);
  if (label === undefined) {
    throw new DescriptorDecodeError("FieldDescriptorProto.label is missing");
  }
  if (type === undefined) {
    throw new DescriptorDecodeError("FieldDescriptorProto.type is missing");
  }
  return {
    name: required(str(f, 1), "FieldDescriptorProto.name"),
    number: int(f, 3) ?? 0,
    label,
    type,
    type_name: str(f, 6),
    json_name: str(f, 10),
    oneof_index: int(f, 9),
    proto3_optional: bool(f, 17),
  };
}

function decodeEnum(buf: Uint8Array): DecodedEnum {
  const e = decodeMessage(buf);
  return {
    name: required(str(e, 1), "EnumDescriptorProto.name"),
    value: subs(e, 2).map((b) => {
      const v = decodeMessage(b);
      return {
        name: required(str(v, 1), "EnumValueDescriptorProto.name"),
        number: int(v, 2) ?? 0,
      };
    }),
  };
}

function decodeMessageType(buf: Uint8Array, depth = 0): DecodedMessage {
  if (depth > 64) {
    throw new DescriptorDecodeError("message nesting too deep");
  }
  const m = decodeMessage(buf);
  const optionsBuf = sub(m, 7);
  const options = optionsBuf ? decodeMessage(optionsBuf) : undefined;

  return {
    name: required(str(m, 1), "DescriptorProto.name"),
    field: subs(m, 2).map(decodeField),
    nested_type: subs(m, 3).map((b) => decodeMessageType(b, depth + 1)),
    enum_type: subs(m, 4).map(decodeEnum),
    oneof_decl: subs(m, 8).map((b) => ({
      name: required(str(decodeMessage(b), 1), "OneofDescriptorProto.name"),
    })),
    options: { map_entry: options ? bool(options, 7) : false },
  };
}

function decodeService(buf: Uint8Array): DecodedService {
  const s = decodeMessage(buf);
  return {
    name: required(str(s, 1), "ServiceDescriptorProto.name"),
    method: subs(s, 2).map((b) => {
      const m = decodeMessage(b);
      return {
        name: required(str(m, 1), "MethodDescriptorProto.name"),
        input_type: required(str(m, 2), "MethodDescriptorProto.input_type"),
        output_type: required(str(m, 3), "MethodDescriptorProto.output_type"),
        client_streaming: bool(m, 5),
        server_streaming: bool(m, 6),
      };
    }),
  };
}

function utf8(bytes: Uint8Array, what: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new DescriptorDecodeError(`${what} is not valid UTF-8`);
  }
}

/** Decodes a single FileDescriptorProto. */
export function decodeFileDescriptorProto(buf: Uint8Array): DecodedFile {
  const f = decodeMessage(buf);
  return {
    name: str(f, 1),
    package: str(f, 2),
    syntax: str(f, 12),
    dependency: subs(f, 3).map((b) =>
      utf8(b, "FileDescriptorProto.dependency"),
    ),
    message_type: subs(f, 4).map((b) => decodeMessageType(b)),
    enum_type: subs(f, 5).map(decodeEnum),
    service: subs(f, 6).map(decodeService),
  };
}

export function decodeFileDescriptorSet(buf: Uint8Array): DecodedFile[] {
  const s = decodeMessage(buf);
  const files = subs(s, 1);

  // A FileDescriptorSet has exactly one field. Anything else means these bytes
  // are a different message — in practice a bare FileDescriptorProto, whose
  // field 1 is `name` rather than `file`, so it would otherwise decode as one
  // garbage "file" built from the filename's own bytes.
  const stray = [...s.keys()].filter((n) => n !== 1);
  if (stray.length > 0) {
    throw new DescriptorDecodeError(
      `expected a FileDescriptorSet but the message also carries field(s) ` +
        `${stray.sort((a, b) => a - b).join(", ")}. These bytes are most ` +
        `likely a bare FileDescriptorProto; decode it with ` +
        `decodeFileDescriptorProto instead.`,
    );
  }

  if (files.length === 0) {
    // Distinguished from the above on purpose: an empty set is a well-formed
    // answer meaning "nothing to describe", and the caller reports it as such.
    return [];
  }
  return files.map(decodeFileDescriptorProto);
}
