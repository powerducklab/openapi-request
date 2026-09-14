import { loadGrpc } from "./loader.js";
import { messageOf } from "../../core/utils.js";

/* ================================================================== *
 * Minimal protobuf wire codec.
 *
 * Scope is deliberately tiny: the reflection request/response envelope,
 * plus the two FileDescriptorProto fields needed to walk the dependency
 * graph (name, dependency). Full descriptor decoding is NOT done here —
 * catalog.ts decodes the resulting FileDescriptorSet once, and decoding
 * every file twice would be wasted work.
 * ================================================================== */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

/** 2 ** (7 * n) for n = 0..9, so varint accumulation needs no exponentiation. */
const SHIFT_MULTIPLIER: readonly number[] = [
  1, 128, 16384, 2097152, 268435456, 34359738368, 4398046511104,
  562949953421312, 72057594037927936, 9223372036854775808,
];

class Reader {
  constructor(
    readonly buf: Buffer,
    public pos = 0,
  ) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /**
   * Reads a base-128 varint.
   *
   * Values beyond Number.MAX_SAFE_INTEGER are rejected rather than silently
   * rounded: every varint this codec reads is a tag, a length, or an error
   * code, so a value that large means the buffer is not what we think it is.
   */
  varint(): number {
    let result = 0;
    let index = 0;
    let byte: number;
    do {
      if (this.pos >= this.buf.length) {
        throw new Error(`truncated varint at offset ${this.pos}`);
      }
      if (index >= SHIFT_MULTIPLIER.length) {
        throw new Error("varint longer than 10 bytes");
      }
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * SHIFT_MULTIPLIER[index++];
    } while ((byte & 0x80) !== 0);

    if (!Number.isSafeInteger(result)) {
      throw new Error("varint exceeds Number.MAX_SAFE_INTEGER");
    }
    return result;
  }

  /** Reads a length-delimited field as a copy, so it can outlive `buf`. */
  bytes(): Buffer {
    return Buffer.from(this.view());
  }

  /** Reads a length-delimited field without copying. Caller must not retain it. */
  view(): Buffer {
    const length = this.varint();
    const end = this.pos + length;
    if (end > this.buf.length) {
      throw new Error(
        `length-delimited field runs past end of buffer ` +
          `(need ${length} bytes at ${this.pos}, have ${this.buf.length - this.pos})`,
      );
    }
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  string(): string {
    return this.view().toString("utf8");
  }

  /** Advances past an unrecognised field, with bounds checking. */
  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.advance(8);
        return;
      case WIRE_BYTES:
        this.view();
        return;
      case WIRE_FIXED32:
        this.advance(4);
        return;
      default:
        // Groups (3/4) are not emitted by any reflection implementation, and
        // guessing would desynchronise the whole message.
        throw new Error(`unsupported wire type ${wire} at offset ${this.pos}`);
    }
  }

  private advance(count: number): void {
    const end = this.pos + count;
    if (end > this.buf.length) {
      throw new Error(`fixed-width field runs past end of buffer`);
    }
    this.pos = end;
  }
}

/**
 * Walks the fields of a message.
 *
 * `visit` returns true if it consumed the field's value, false to have it
 * skipped. A visitor that claims a field without consuming it is a bug that
 * would otherwise desynchronise the parser silently and produce garbage, so
 * it is caught here instead.
 */
function eachField(
  buf: Buffer,
  visit: (field: number, wire: number, r: Reader) => boolean,
): void {
  const r = new Reader(buf);
  while (!r.eof) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (field === 0) throw new Error("field number 0 is not valid");

    const before = r.pos;
    if (visit(field, wire, r)) {
      if (r.pos === before) {
        throw new Error(
          `decoder claimed field ${field} (wire ${wire}) without consuming it`,
        );
      }
    } else {
      r.skip(wire);
    }
  }
}

function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`cannot encode ${value} as an unsigned varint`);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function tag(field: number, wire: number): Buffer {
  return encodeVarint(field * 8 + wire);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([
    tag(field, WIRE_BYTES),
    encodeVarint(payload.length),
    payload,
  ]);
}

function stringField(field: number, value: string): Buffer {
  return lengthDelimited(field, Buffer.from(value, "utf8"));
}

/* ================================================================== *
 * Request keys
 *
 * Every request carries a stable key, and every reply is mapped back to
 * one, so the session never has to guess which question a reply answers.
 * ================================================================== */

type RequestKey = "list" | `file:${string}` | `sym:${string}`;

interface PendingRequest {
  key: RequestKey;
  /**
   * Primary requests are what the caller asked for; failing one fails the
   * session. Dependency requests are discovered while walking the graph and
   * are reported as warnings instead.
   */
  primary: boolean;
}

/** Human-readable subject of a request key, without its scheme prefix. */
function subjectOf(key: RequestKey): string {
  if (key === "list") return "the service list";
  return key.slice(key.indexOf(":") + 1);
}

/* ================================================================== *
 * ServerReflectionRequest
 *
 * message ServerReflectionRequest {
 *   string host = 1;
 *   oneof message_request {
 *     string file_by_filename = 3;
 *     string file_containing_symbol = 4;
 *     string list_services = 7;
 *   }
 * }
 * ================================================================== */

function encodeRequest(key: RequestKey, host: string): Buffer {
  const parts: Buffer[] = [];
  if (host) parts.push(stringField(1, host));

  if (key === "list") {
    // The string value of list_services is ignored by every known server,
    // but the field must be present for the oneof to be set.
    parts.push(stringField(7, "*"));
  } else if (key.startsWith("file:")) {
    parts.push(stringField(3, key.slice(5)));
  } else {
    parts.push(stringField(4, key.slice(4)));
  }
  return Buffer.concat(parts);
}

/** Recovers the request key a server echoed back in `original_request`. */
function decodeRequestKey(buf: Buffer): RequestKey | undefined {
  let key: RequestKey | undefined;
  eachField(buf, (field, wire, r) => {
    if (wire !== WIRE_BYTES) return false;
    if (field === 3) {
      key = `file:${r.string()}`;
      return true;
    }
    if (field === 4) {
      key = `sym:${r.string()}`;
      return true;
    }
    if (field === 7) {
      r.view();
      key = "list";
      return true;
    }
    return false;
  });
  return key;
}

/* ================================================================== *
 * ServerReflectionResponse
 *
 * message ServerReflectionResponse {
 *   string valid_host = 1;
 *   ServerReflectionRequest original_request = 2;
 *   oneof message_response {
 *     FileDescriptorResponse file_descriptor_response = 4;
 *     ExtensionNumberResponse all_extension_numbers_response = 5;
 *     ListServiceResponse list_services_response = 6;
 *     ErrorResponse error_response = 7;
 *   }
 * }
 * ================================================================== */

type ReplyBody =
  | { kind: "files"; descriptors: Buffer[] }
  | { kind: "services"; services: string[] }
  | { kind: "error"; code: number; message: string }
  | { kind: "other"; field: number };

interface Reply {
  /** Undefined when the server omitted original_request. */
  answers?: RequestKey;
  body: ReplyBody;
}

function decodeReply(buf: Buffer): Reply {
  let answers: RequestKey | undefined;
  let body: ReplyBody = { kind: "other", field: 0 };

  eachField(buf, (field, wire, r) => {
    if (wire !== WIRE_BYTES) return false;

    switch (field) {
      case 2:
        answers = decodeRequestKey(r.view());
        return true;

      case 4: {
        // FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
        const descriptors: Buffer[] = [];
        eachField(r.view(), (f, w, rr) => {
          if (f === 1 && w === WIRE_BYTES) {
            descriptors.push(rr.bytes());
            return true;
          }
          return false;
        });
        body = { kind: "files", descriptors };
        return true;
      }

      case 6: {
        // ListServiceResponse { repeated ServiceResponse service = 1; }
        // ServiceResponse    { string name = 1; }
        const services: string[] = [];
        eachField(r.view(), (f, w, rr) => {
          if (f === 1 && w === WIRE_BYTES) {
            eachField(rr.view(), (g, gw, rrr) => {
              if (g === 1 && gw === WIRE_BYTES) {
                services.push(rrr.string());
                return true;
              }
              return false;
            });
            return true;
          }
          return false;
        });
        body = { kind: "services", services };
        return true;
      }

      case 7: {
        // ErrorResponse { int32 error_code = 1; string error_message = 2; }
        let code = 2;
        let message = "";
        eachField(r.view(), (f, w, rr) => {
          if (f === 1 && w === WIRE_VARINT) {
            code = rr.varint();
            return true;
          }
          if (f === 2 && w === WIRE_BYTES) {
            message = rr.string();
            return true;
          }
          return false;
        });
        body = { kind: "error", code, message };
        return true;
      }

      case 5:
        r.view();
        body = { kind: "other", field: 5 };
        return true;

      default:
        return false;
    }
  });

  return { answers, body };
}

/* ================================================================== *
 * FileDescriptorProto, partial
 *
 * Only `name` (1) and `dependency` (3) are read; everything else is the
 * job of the descriptor decoder that consumes the finished set.
 * ================================================================== */

interface FileMeta {
  name: string;
  dependencies: string[];
}

function peekFileMeta(buf: Buffer): FileMeta {
  let name = "";
  const dependencies: string[] = [];
  eachField(buf, (field, wire, r) => {
    if (wire !== WIRE_BYTES) return false;
    if (field === 1) {
      name = r.string();
      return true;
    }
    if (field === 3) {
      dependencies.push(r.string());
      return true;
    }
    return false;
  });
  return { name, dependencies };
}

/* ================================================================== *
 * Errors
 * ================================================================== */

/**
 * The server could not be asked at all: no reflection service on either
 * version. Distinct from "reflection works and the answer is empty", which
 * is a legitimate (if unhelpful) reply and must not be reported the same way.
 */
export class ReflectionUnavailableError extends Error {
  readonly address: string;
  readonly versionsTried: readonly ReflectionVersion[];

  constructor(
    address: string,
    versionsTried: readonly ReflectionVersion[],
    cause?: unknown,
  ) {
    super(
      `server at ${address} answered but does not implement the gRPC ` +
        `reflection service (${versionsTried.join(" and ")} both reported ` +
        `UNIMPLEMENTED/NOT_FOUND). Register the reflection service on the ` +
        `server, or pass protoPaths instead.`,
      { cause },
    );
    this.name = "ReflectionUnavailableError";
    this.address = address;
    this.versionsTried = versionsTried;
  }
}

/**
 * The reflection stream could not be established or was lost in transport.
 *
 * Separate from ReflectionUnavailableError on purpose. "nothing is listening on
 * this port" and "something is listening but serves no reflection" call for
 * completely different fixes, and a bare `14 UNAVAILABLE` from grpc-js names
 * neither the operation that failed nor which of the two it was.
 */
export class ReflectionTransportError extends Error {
  readonly address: string;
  readonly code?: number;

  constructor(address: string, code: number | undefined, detail: string) {
    super(
      `could not complete the reflection handshake with ${address}` +
        (code !== undefined ? ` (gRPC status ${code})` : "") +
        `: ${detail}. This is a connectivity or transport failure, not a ` +
        `missing reflection service — nothing was reached that could answer.`,
    );
    this.name = "ReflectionTransportError";
    this.address = address;
    this.code = code;
  }
}

/** The reflection service answered, but the answer was an error or unusable. */
export class ReflectionProtocolError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(detail ? `${message} (${detail})` : message);
    this.name = "ReflectionProtocolError";
    this.detail = detail;
  }
}

/* ================================================================== *
 * Session
 * ================================================================== */

export type ReflectionVersion = "v1" | "v1alpha";

export interface ReflectionSessionOptions {
  address: string;
  credentials: import("@grpc/grpc-js").ChannelCredentials;
  metadata?: Record<string, string | string[] | Buffer | Buffer[]>;
  /** Wall-clock budget for the whole session. Default 5000. */
  timeoutMs?: number;
  channelOptions?: Record<string, unknown>;
  /** Pin a version. Omit to try v1 then fall back to v1alpha. */
  version?: ReflectionVersion;
  /** `host` field on each request. Only meaningful for virtual-hosted servers. */
  host?: string;
  /** Hard cap on files pulled in one session. Default 2000. */
  maxFiles?: number;
  /** Hard cap on total descriptor bytes. Default 32 MiB. */
  maxBytes?: number;
}

const REFLECTION_PATHS: Record<ReflectionVersion, string> = {
  v1: "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
  v1alpha: "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

const GRPC_UNIMPLEMENTED = 12;
const GRPC_NOT_FOUND = 5;

/** What the session should ask for. */
export type ReflectionOp =
  /** list_services only. */
  | { kind: "list" }
  /** Descriptor closure for the given symbols. */
  | { kind: "symbols"; symbols: string[] }
  /**
   * list_services, then the closure for everything it returned — on one
   * stream, so the two halves cannot disagree about what the server exposes.
   */
  | { kind: "list_then_symbols" };

export interface ReflectionOutcome {
  /** Present iff the op asked for a service list. */
  services?: string[];
  /** filename -> raw FileDescriptorProto bytes. */
  descriptors: Map<string, Buffer>;
  /** Which version actually answered. */
  version: ReflectionVersion;
  /** Non-fatal facts the caller should surface. */
  notes: string[];
}

interface CallHandle {
  write: (b: Buffer) => void;
  end: () => void;
  cancel: () => void;
  on: (ev: string, fn: (...a: unknown[]) => void) => void;
}

/**
 * A stream that failed before the server said anything a reflection service
 * would say.
 *
 * The flag matters more than the status code. A version fallback is only sound
 * while the server has not yet demonstrated that it speaks this version of the
 * protocol; once it has answered even once, retrying on another version would
 * discard everything received so far and then blame a missing service for a
 * failure that happened mid-conversation.
 */
interface VersionProbeFailure {
  readonly versionMissing: true;
  readonly cause: unknown;
}

function isProbeFailure(e: unknown): e is VersionProbeFailure {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { versionMissing?: unknown }).versionMissing === true
  );
}

function statusCodeOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}


/* ================================================================== *
 * Option validation
 * ================================================================== */

function assertPositive(name: string, value: unknown, min: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new RangeError(
      `${name} must be a finite number >= ${min}; received ` +
        `${typeof value === "number" ? value : typeof value}.`,
    );
  }
}

function validateSessionOptions(options: ReflectionSessionOptions): void {
  if (typeof options.address !== "string" || options.address === "") {
    throw new TypeError("reflection requires a non-empty address.");
  }
  assertPositive("timeoutMs", options.timeoutMs, 1);
  assertPositive("maxFiles", options.maxFiles, 1);
  assertPositive("maxBytes", options.maxBytes, 1);
  if (
    options.version !== undefined &&
    options.version !== "v1" &&
    options.version !== "v1alpha"
  ) {
    throw new TypeError(
      `reflectionVersion must be "v1" or "v1alpha"; received ` +
        `${String(options.version)}.`,
    );
  }
}

/**
 * Builds request metadata, attributing a rejected header to its key.
 *
 * grpc-js validates key syntax inside `add` and its error names neither the key
 * nor the operation, so one bad header used to surface as an unexplained
 * rejection that the version-fallback logic then had to guess about.
 */
function buildMetadata(
  grpc: { Metadata: new () => { add: (k: string, v: never) => void } },
  source: ReflectionSessionOptions["metadata"],
): { add: (k: string, v: never) => void } {
  const md = new grpc.Metadata();
  for (const [key, value] of Object.entries(source ?? {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== "string" && !Buffer.isBuffer(item)) {
        throw new TypeError(
          `reflection metadata["${key}"] must be a string, a Buffer, or an ` +
            `array of those; received ${item === null ? "null" : typeof item}.`,
        );
      }
      try {
        md.add(key, item as never);
      } catch (e) {
        throw new TypeError(
          `reflection metadata key "${key}" was rejected by grpc-js: ` +
            `${messageOf(e)}. Keys must match [0-9a-z_.-]+, and only keys ` +
            `ending in "-bin" may carry Buffers.`,
        );
      }
    }
  }
  return md;
}

/* ================================================================== *
 * Version negotiation
 * ================================================================== */

async function withVersionFallback(
  options: ReflectionSessionOptions,
  op: ReflectionOp,
): Promise<ReflectionOutcome> {
  const versions: ReflectionVersion[] = options.version
    ? [options.version]
    : ["v1", "v1alpha"];

  let lastMissing: unknown;
  for (const [index, version] of versions.entries()) {
    try {
      const outcome = await runSession(options, op, version);
      if (index > 0) {
        outcome.notes.unshift(
          `reflection ${versions[0]} was unimplemented; used ${version}.`,
        );
      }
      return outcome;
    } catch (e) {
      // Only a pre-answer UNIMPLEMENTED/NOT_FOUND is a version probe. Anything
      // else — including the same status arriving after the server has already
      // supplied descriptors — is a real failure, and retrying it on another
      // version would throw away the work and misattribute the cause.
      if (!isProbeFailure(e)) throw e;
      lastMissing = e.cause;
    }
  }
  throw new ReflectionUnavailableError(options.address, versions, lastMissing);
}

function runSession(
  options: ReflectionSessionOptions,
  op: ReflectionOp,
  version: ReflectionVersion,
): Promise<ReflectionOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const host = options.host ?? "";

  return loadGrpc().then(({ grpc }) => {
    const md = buildMetadata(
      grpc as unknown as {
        Metadata: new () => { add: (k: string, v: never) => void };
      },
      options.metadata,
    );

    let client: InstanceType<typeof grpc.Client>;
    try {
      client = new grpc.Client(
        options.address,
        options.credentials,
        options.channelOptions as never,
      );
    } catch (e) {
      throw new ReflectionTransportError(
        options.address,
        undefined,
        `the channel could not be created: ${messageOf(e)}. Expected host:port`,
      );
    }

    let call: CallHandle;
    try {
      call = client.makeBidiStreamRequest(
        REFLECTION_PATHS[version],
        (v: Buffer) => v,
        (b: Buffer) => b,
        md as never,
        { deadline: new Date(Date.now() + timeoutMs) } as never,
      ) as unknown as CallHandle;
    } catch (e) {
      try {
        client.close();
      } catch {
        /* nothing to close */
      }
      throw new ReflectionTransportError(
        options.address,
        statusCodeOf(e),
        messageOf(e),
      );
    }

    return new Promise<ReflectionOutcome>((resolve, reject) => {
      const descriptors = new Map<string, Buffer>();
      const notes: string[] = [];
      /** key -> request, for pairing replies. Insertion order is FIFO. */
      const pending = new Map<RequestKey, PendingRequest>();
      const asked = new Set<RequestKey>();
      let services: string[] | undefined;
      let wantsServices = op.kind !== "symbols";
      let totalBytes = 0;
      let settled = false;
      let pairingWarned = false;
      /**
       * Set as soon as one reply is decoded, whatever it contained. From this
       * point the server has proved it speaks this version of the reflection
       * protocol, so no later failure may be reinterpreted as "wrong version".
       */
      let serverAnswered = false;

      const describePending = (): string | undefined => {
        if (pending.size === 0) return undefined;
        const keys = [...pending.keys()].slice(0, 5).join(", ");
        return `still awaiting ${pending.size} reply(ies): ${keys}${
          pending.size > 5 ? ", …" : ""
        }`;
      };

      const guard = setTimeout(() => {
        fail(
          new ReflectionProtocolError(
            `reflection session at ${options.address} did not complete within ` +
              `${timeoutMs}ms`,
            describePending(),
          ),
        );
      }, timeoutMs + 250);
      // Intentionally slightly later than the call deadline, so a server that
      // respects the deadline produces the real gRPC status rather than this
      // generic message.
      guard.unref?.();

      const teardown = (): void => {
        clearTimeout(guard);
        try {
          call.cancel();
        } catch {
          /* already closed */
        }
        try {
          client.close();
        } catch {
          /* already closed */
        }
      };

      function fail(err: unknown): void {
        if (settled) return;
        settled = true;
        teardown();
        reject(err);
      }

      /**
       * Fails in a way withVersionFallback may retry on the other version.
       *
       * Refuses to do so once the server has answered: at that point the status
       * describes something that went wrong mid-conversation, and the honest
       * report is the transport error, not "no reflection service here".
       */
      function failVersion(cause: unknown): void {
        if (serverAnswered) {
          fail(
            new ReflectionProtocolError(
              `the reflection stream at ${options.address} failed after the ` +
                `server had already answered, so ${version} is served here; ` +
                `${descriptors.size} file(s) were discarded`,
              messageOf(cause),
            ),
          );
          return;
        }
        fail({ versionMissing: true, cause } satisfies VersionProbeFailure);
      }

      function succeed(): void {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        try {
          call.end();
        } catch {
          /* already closed */
        }
        try {
          client.close();
        } catch {
          /* already closed */
        }
        resolve({
          services: op.kind === "symbols" ? undefined : (services ?? []),
          descriptors,
          version,
          notes,
        });
      }

      const ask = (key: RequestKey, primary: boolean): void => {
        if (settled || asked.has(key)) return;
        // Counts everything requested rather than everything received: the cap
        // exists to bound the walk, and a graph that fans out to a million
        // imports must be stopped while asking, not after answering.
        if (asked.size >= maxFiles) {
          fail(
            new ReflectionProtocolError(
              `reflection closure exceeded maxFiles=${maxFiles}`,
              `while requesting ${subjectOf(key)}`,
            ),
          );
          return;
        }
        asked.add(key);
        pending.set(key, { key, primary });
        try {
          call.write(encodeRequest(key, host));
        } catch (e) {
          fail(
            new ReflectionTransportError(
              options.address,
              statusCodeOf(e),
              `writing the request for ${subjectOf(key)} failed: ${messageOf(e)}`,
            ),
          );
        }
      };

      /**
       * Resolves which request a reply answers. `original_request` is echoed by
       * every known server implementation; when it is missing we fall back to
       * FIFO order and say so, because from that point on pairing is a guess.
       */
      const settleRequest = (
        echoed: RequestKey | undefined,
      ): PendingRequest | undefined => {
        if (echoed !== undefined && pending.has(echoed)) {
          const req = pending.get(echoed)!;
          pending.delete(echoed);
          return req;
        }
        if (!pairingWarned) {
          pairingWarned = true;
          notes.push(
            echoed === undefined
              ? "server omitted original_request; replies were paired by arrival order."
              : `server echoed an unrequested original_request (${echoed}); ` +
                  `replies were paired by arrival order.`,
          );
        }
        const first = pending.keys().next();
        if (first.done) return undefined;
        const req = pending.get(first.value)!;
        pending.delete(first.value);
        return req;
      };

      const acceptFiles = (raw: Buffer[]): void => {
        for (const bytes of raw) {
          if (settled) return;
          totalBytes += bytes.length;
          if (totalBytes > maxBytes) {
            fail(
              new ReflectionProtocolError(
                `reflection payload exceeded maxBytes=${maxBytes}`,
                `after ${descriptors.size} file(s)`,
              ),
            );
            return;
          }

          let meta: FileMeta;
          try {
            meta = peekFileMeta(bytes);
          } catch (e) {
            fail(
              new ReflectionProtocolError(
                "server returned a FileDescriptorProto that could not be parsed",
                messageOf(e),
              ),
            );
            return;
          }

          if (!meta.name) {
            notes.push(
              "server returned a FileDescriptorProto with no name; it was skipped.",
            );
            continue;
          }
          if (descriptors.has(meta.name)) continue;
          descriptors.set(meta.name, bytes);

          for (const dep of meta.dependencies) {
            if (!descriptors.has(dep)) ask(`file:${dep}`, false);
            if (settled) return;
          }
        }
      };

      call.on("data", (chunk) => {
        if (settled) return;

        let reply: Reply;
        try {
          reply = decodeReply(chunk as Buffer);
        } catch (e) {
          // A reply arrived and was unintelligible. The server is speaking
          // something on this path, so this is not a version mismatch.
          serverAnswered = true;
          fail(
            new ReflectionProtocolError(
              "malformed ServerReflectionResponse",
              messageOf(e),
            ),
          );
          return;
        }
        serverAnswered = true;

        const request = settleRequest(reply.answers);

        switch (reply.body.kind) {
          case "error": {
            const { code, message } = reply.body;
            const detail = `code ${code}: ${message || "(no message)"}`;
            if (!request || request.primary) {
              fail(
                new ReflectionProtocolError(
                  `reflection request for ${
                    request ? subjectOf(request.key) : "(unknown)"
                  } failed`,
                  detail,
                ),
              );
              return;
            }
            // A missing dependency will very likely make the set unloadable,
            // but naming the file beats reporting "reflection failed".
            notes.push(
              `server could not supply ${subjectOf(request.key)} — ${detail}. ` +
                `The descriptor set may be incomplete.`,
            );
            break;
          }

          case "files":
            if (reply.body.descriptors.length === 0 && request?.primary) {
              notes.push(
                `server returned an empty file set for ${subjectOf(request.key)}.`,
              );
            }
            acceptFiles(reply.body.descriptors);
            if (settled) return;
            break;

          case "services": {
            services = reply.body.services;
            wantsServices = false;
            if (op.kind === "list_then_symbols") {
              const targets = services.filter(
                (n) => !n.startsWith("grpc.reflection."),
              );
              for (const symbol of targets) {
                ask(`sym:${symbol}`, true);
                if (settled) return;
              }
            }
            break;
          }

          case "other":
            notes.push(
              `ignored an unexpected reflection response variant ` +
                `(field ${reply.body.field}) for ${
                  request ? subjectOf(request.key) : "(unknown request)"
                }.`,
            );
            break;
        }

        if (pending.size === 0 && !wantsServices) succeed();
      });

      call.on("error", (err) => {
        if (settled) return;
        const code = statusCodeOf(err);
        if (code === GRPC_UNIMPLEMENTED || code === GRPC_NOT_FOUND) {
          // Some implementations answer the v1 path with NOT_FOUND rather than
          // UNIMPLEMENTED; both mean "this version is not served here", but
          // only before the server has answered anything.
          failVersion(err);
          return;
        }
        fail(
          new ReflectionTransportError(options.address, code, messageOf(err)),
        );
      });

      call.on("status", (s) => {
        if (settled) return;
        const st = s as { code: number; details?: string };
        if (st.code !== 0) {
          const detail = `${st.code} ${st.details ?? ""}`.trim();
          if (st.code === GRPC_UNIMPLEMENTED || st.code === GRPC_NOT_FOUND) {
            failVersion(
              Object.assign(new Error(`reflection stream ended: ${detail}`), {
                code: st.code,
                details: st.details,
              }),
            );
            return;
          }
          fail(
            new ReflectionTransportError(
              options.address,
              st.code,
              st.details || "the stream ended with a non-OK status",
            ),
          );
          return;
        }
        // A clean close with questions still outstanding: the server decided it
        // was done answering and we are not. Previously this left the promise
        // pending forever, bounded only by an optional deadline.
        if (pending.size > 0 || wantsServices) {
          fail(
            new ReflectionProtocolError(
              `server closed the reflection stream before answering everything`,
              describePending() ??
                "the service list was requested but never returned",
            ),
          );
          return;
        }
        succeed();
      });

      call.on("end", () => {
        if (settled) return;
        if (pending.size === 0 && !wantsServices) succeed();
        // Otherwise the status handler reports it; "end" alone carries no
        // information about why the server stopped.
      });

      if (op.kind === "symbols") {
        for (const symbol of op.symbols) {
          ask(`sym:${symbol}`, true);
          if (settled) return;
        }
      } else {
        ask("list", true);
      }
    });
  });
}

/* ================================================================== *
 * FileDescriptorSet assembly
 * ================================================================== */

/**
 * Orders files so that every file follows the files it imports.
 *
 * Map iteration order reflects the order the server happened to answer in,
 * which is not stable across runs. A topological order makes the output
 * byte-for-byte reproducible and is what descriptor consumers expect.
 *
 * The order is returned rather than only applied, because the caller has to
 * report the same sequence as its file list: two differently-sorted views of
 * one set let a consumer pair `files[i]` with the wrong descriptor.
 */
function orderFiles(descriptors: Map<string, Buffer>): {
  ordered: string[];
  cycles: string[];
} {
  const deps = new Map<string, string[]>();
  for (const [name, bytes] of descriptors) {
    let meta: FileMeta;
    try {
      meta = peekFileMeta(bytes);
    } catch {
      // Unparseable here is not fatal: the bytes still go into the set, and the
      // descriptor decoder downstream will report what is wrong with them.
      deps.set(name, []);
      continue;
    }
    deps.set(
      name,
      meta.dependencies.filter((d) => descriptors.has(d)),
    );
  }

  const ordered: string[] = [];
  const cycles: string[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (name: string): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      // A cycle is illegal in proto and cannot be resolved by ordering. Emitting
      // the file once and moving on beats looping, but it is a real finding
      // about the server's descriptors and must not be swallowed.
      if (!cycles.includes(name)) cycles.push(name);
      return;
    }
    state.set(name, "visiting");
    for (const dep of deps.get(name) ?? []) visit(dep);
    state.set(name, "done");
    ordered.push(name);
  };

  // Sorted entry points, so the traversal itself is deterministic too.
  for (const name of [...descriptors.keys()].sort()) visit(name);

  return { ordered, cycles };
}

/**
 * Serialises files in dependency order.
 *
 * FileDescriptorSet { repeated FileDescriptorProto file = 1; }
 */
export function serializeDescriptorSet(
  descriptors: Map<string, Buffer>,
): Buffer {
  const { ordered } = orderFiles(descriptors);
  return Buffer.concat(
    ordered.map((name) => lengthDelimited(1, descriptors.get(name)!)),
  );
}

/* ================================================================== *
 * Public API
 * ================================================================== */

export interface ListServicesResult {
  /** Service names, excluding the reflection service itself. */
  services: string[];
  version: ReflectionVersion;
  notes: string[];
}

/**
 * Service names exposed by the server.
 *
 * An empty array is a legitimate answer: it means reflection works and the
 * server registered nothing. That is a different fact from "the server has
 * no reflection service", which throws ReflectionUnavailableError, and callers
 * must not collapse the two into one message.
 */
export async function listServicesDetailed(
  options: ReflectionSessionOptions,
): Promise<ListServicesResult> {
  validateSessionOptions(options);
  const outcome = await withVersionFallback(options, { kind: "list" });
  const services = (outcome.services ?? [])
    .filter((n) => !n.startsWith("grpc.reflection."))
    .sort();
  return { services, version: outcome.version, notes: outcome.notes };
}

/** Convenience wrapper for callers that only want the names. */
export async function listServices(
  options: ReflectionSessionOptions,
): Promise<string[]> {
  return (await listServicesDetailed(options)).services;
}

export interface DescriptorSetResult {
  /** Serialised FileDescriptorSet, in dependency order. */
  descriptorSet: Buffer;
  /**
   * Filenames included, in the same order as the descriptors inside
   * `descriptorSet`.
   *
   * The correspondence is positional and load-bearing: `files[i]` names the
   * i-th FileDescriptorProto in the set. Sorting this list independently — which
   * it used to be — silently broke that pairing for anyone who relied on it.
   */
  files: string[];
  version: ReflectionVersion;
  notes: string[];
}

function assemble(
  outcome: ReflectionOutcome,
  what: string,
): DescriptorSetResult {
  if (outcome.descriptors.size === 0) {
    throw new ReflectionProtocolError(
      `reflection returned no file descriptors for ${what}`,
      outcome.notes.join(" ") || undefined,
    );
  }

  const { ordered, cycles } = orderFiles(outcome.descriptors);
  const notes = [...outcome.notes];
  if (cycles.length > 0) {
    notes.push(
      `${cycles.length} file(s) take part in an import cycle, which protoc ` +
        `cannot produce: ${cycles.slice(0, 5).join(", ")}` +
        (cycles.length > 5 ? ", …" : "") +
        `. They were emitted once each; the descriptor set may not load.`,
    );
  }

  return {
    descriptorSet: Buffer.concat(
      ordered.map((name) => lengthDelimited(1, outcome.descriptors.get(name)!)),
    ),
    files: ordered,
    version: outcome.version,
    notes,
  };
}

/** Transitive descriptor closure for the given symbols, merged and de-duplicated. */
export async function fetchDescriptorSet(
  options: ReflectionSessionOptions & { symbols: string[] },
): Promise<DescriptorSetResult> {
  validateSessionOptions(options);
  if (!Array.isArray(options.symbols) || options.symbols.length === 0) {
    throw new TypeError(
      "fetchDescriptorSet requires a non-empty array of symbol names.",
    );
  }
  const bad = options.symbols.findIndex(
    (s) => typeof s !== "string" || s === "",
  );
  if (bad !== -1) {
    throw new TypeError(
      `symbols[${bad}] is not a non-empty string (got ` +
        `${typeof options.symbols[bad]}).`,
    );
  }

  const outcome = await withVersionFallback(options, {
    kind: "symbols",
    symbols: options.symbols,
  });
  return assemble(outcome, options.symbols.join(", "));
}

export interface FullDescriptorSetResult extends DescriptorSetResult {
  services: string[];
}

/**
 * Lists services and fetches their descriptor closure over a single stream.
 *
 * Doing both on one call is not just an optimisation: two separate sessions can
 * observe two different server states, so the service list could name a service
 * whose descriptors the second session never asked for.
 */
export async function fetchFullDescriptorSet(
  options: ReflectionSessionOptions,
): Promise<FullDescriptorSetResult> {
  validateSessionOptions(options);
  const outcome = await withVersionFallback(options, {
    kind: "list_then_symbols",
  });

  const services = (outcome.services ?? [])
    .filter((n) => !n.startsWith("grpc.reflection."))
    .sort();

  if (services.length === 0) {
    // Reflection worked; there is simply nothing behind it. Returning an empty
    // set rather than throwing keeps this distinguishable from every failure
    // mode above, which is the whole reason the caller can produce a useful
    // message instead of "reflection failed".
    return {
      services,
      descriptorSet: Buffer.alloc(0),
      files: [],
      version: outcome.version,
      notes: [
        ...outcome.notes,
        `reflection is available at ${options.address} but the server ` +
          `advertises no services other than reflection itself.`,
      ],
    };
  }

  return { services, ...assemble(outcome, services.join(", ")) };
}
