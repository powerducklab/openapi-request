import { loadGrpc } from "./loader.js";
import { buildCredentialsChecked } from "./credentials.js";
import { resolveMethod } from "./descriptor.js";
import { buildCatalog, type Catalog } from "./catalog.js";
import type {
  GrpcEvent,
  GrpcMetadataOutput,
  GrpcResult,
  GrpcSendOptions,
  GrpcStatus,
  GrpcStatusOrigin,
  GrpcTarget,
  GrpcTruncatedReason,
} from "./types.js";

const CODE_NAMES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

const CODE_OK = 0;
const CODE_CANCELLED = 1;
const CODE_UNKNOWN = 2;
const CODE_INVALID_ARGUMENT = 3;

/**
 * How long a completed unary or client-streaming call waits for the status that
 * grpc-js is about to deliver.
 *
 * These two kinds signal completion through their callback, which fires before
 * the "status" event reaches our listener. Finishing on the callback therefore
 * discarded the real status and the trailers, and reported a locally
 * manufactured OK in their place — see the note on `awaitingStatus`.
 *
 * The wait is bounded because a hang is not an acceptable substitute for a lost
 * field: if the status never arrives the call still completes, with the
 * response intact and a warning saying the status was synthesised. The value is
 * generous relative to the in-process hop it covers (the status is already
 * decoded when the callback runs) and is not a network timeout.
 */
const STATUS_GRACE_MS = 200;

function toStatus(code: number, details?: string): GrpcStatus {
  return { code, codeName: CODE_NAMES[code] ?? `CODE_${code}`, details };
}

/**
 * Omit that distributes over a union.
 *
 * The built-in Omit collapses a discriminated union into the intersection of
 * its keys, which would erase payload/metadata/status and make every emit()
 * call site fail. Distributing keeps each branch intact, so a caller still has
 * to supply the full set of fields for the branch it picked.
 */
type EventDraft<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;

/**
 * A descriptor source already built by the caller.
 *
 * Passing one is not merely an optimisation. Under reflection every
 * `buildCatalog` is a fresh dial, so resolving the method again here would
 * compare the runtime and descriptor views of two different server states —
 * exactly the disagreement `resolveMethod` refuses to guess through. A host
 * that already holds a catalog (GrpcAdapter does) must hand it over.
 */
export interface GrpcCallContext {
  catalog: Catalog;
  packageDefinition: Record<string, unknown>;
  /**
   * Whether catalog-wide diagnostics belong in this call's `warnings`.
   *
   * Default false. A catalog note describes the descriptor source — "3 .proto
   * files were merged", "these type references do not resolve" — and is a
   * property of the endpoint, not of one invocation. Repeating it on every call
   * buries the notes that are about the call, which is what turned the warning
   * list into scrollback. Surface them once, from discover()/describeMethod().
   */
  includeSourceNotes?: boolean;
}

/**
 * grpc-js `Metadata.toJSON()` returns every key as an array, which is the only
 * honest shape: HTTP/2 headers can repeat. Binary (`-bin`) values arrive as
 * Buffers and are base64-encoded so the result stays JSON-serialisable.
 */
function metadataToObject(md: unknown): GrpcMetadataOutput {
  const anyMd = md as { toJSON?: () => Record<string, unknown> } | undefined;
  if (typeof anyMd?.toJSON !== "function") return {};

  const out: GrpcMetadataOutput = {};
  for (const [key, raw] of Object.entries(anyMd.toJSON())) {
    const items = Array.isArray(raw) ? raw : [raw];
    out[key] = items.map((v) =>
      Buffer.isBuffer(v) ? v.toString("base64") : String(v),
    );
  }
  return out;
}

interface AnyCall {
  cancel: () => void;
  write?: (v: unknown) => void;
  end?: () => void;
  on: (ev: string, fn: (...args: unknown[]) => void) => void;
}

/** Termination reasons the client caused, as opposed to the server or network. */
const CLIENT_INITIATED: ReadonlySet<GrpcTruncatedReason> = new Set([
  "max_messages",
  "idle_timeout",
  "max_session",
  "aborted",
]);

/* ------------------------------------------------------------------ *
 * Option validation
 *
 * These throw rather than being reported in the result. The division is
 * deliberate and load-bearing: a malformed option is a mistake in the calling
 * program, which a thrown error puts at the right stack frame, whereas a
 * transport failure is an observation about the world and belongs in the
 * result. Letting a bad option reach grpc-js produces neither — it produces an
 * opaque UNKNOWN from inside the library.
 * ------------------------------------------------------------------ */

function assertDurationMs(name: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a finite number of milliseconds >= 0; received ` +
        `${typeof value === "number" ? value : typeof value}.`,
    );
  }
}

function assertCount(name: string, value: unknown): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer; received ` +
        `${typeof value === "number" ? value : typeof value}. ` +
        `A fractional limit can never be reached by a message count.`,
    );
  }
}

function assertMessages(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(
      `options.messages must be an array of request payloads; received ` +
        `${value === null ? "null" : typeof value}. A single message still ` +
        `goes in an array.`,
    );
  }
  return value;
}

/**
 * Builds request metadata, attributing a rejected header to its key.
 *
 * grpc-js validates key syntax and value type inside `add`, and its error names
 * neither, so a single bad header used to surface as an unexplained throw from
 * a line the caller never wrote.
 */
function buildMetadata(
  grpc: { Metadata: new () => { add: (k: string, v: unknown) => void } },
  source: GrpcTarget["metadata"],
): { add: (k: string, v: unknown) => void } {
  const md = new grpc.Metadata();
  for (const [key, value] of Object.entries(source ?? {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== "string" && !Buffer.isBuffer(item)) {
        throw new TypeError(
          `metadata["${key}"] must be a string, a Buffer, or an array of ` +
            `those; received ${item === null ? "null" : typeof item}. ` +
            `Binary values require a key ending in "-bin".`,
        );
      }
      try {
        md.add(key, item);
      } catch (e) {
        throw new TypeError(
          `metadata key "${key}" was rejected by grpc-js: ` +
            `${e instanceof Error ? e.message : String(e)}. Keys must match ` +
            `[0-9a-z_.-]+, and only keys ending in "-bin" may carry Buffers.`,
        );
      }
    }
  }
  return md;
}

/**
 * Invokes one gRPC method. All four streaming kinds converge on a single event
 * log and a single set of termination conditions.
 *
 * Transport-level failures are reported in the result rather than thrown; only
 * option validation and descriptor resolution — both of which happen before any
 * bytes move — throw.
 *
 * Without a `context`, this builds a descriptor source on every call, which
 * means reading the proto tree or dialling reflection each time. Calling it in
 * a loop that way is wasteful and, under reflection, unsound; go through
 * GrpcAdapter, or pass the catalog yourself.
 */
export async function grpcCall(
  target: GrpcTarget,
  options: GrpcSendOptions = {},
  context?: GrpcCallContext,
): Promise<GrpcResult> {
  const startedAt = Date.now();

  const outbound = assertMessages(options.messages);
  assertCount("maxMessages", options.maxMessages);
  assertDurationMs("idleTimeoutMs", options.idleTimeoutMs);
  assertDurationMs("maxSessionMs", options.maxSessionMs);
  assertDurationMs("sendIntervalMs", options.sendIntervalMs);
  assertDurationMs("deadlineMs", target.deadlineMs);
  if (options.signal !== undefined && options.signal !== null) {
    const s = options.signal as Partial<AbortSignal>;
    if (
      typeof s.addEventListener !== "function" ||
      typeof s.aborted !== "boolean"
    ) {
      throw new TypeError(
        "options.signal must be an AbortSignal (pass controller.signal, not " +
          "the controller).",
      );
    }
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new TypeError(
      `options.onEvent must be a function; received ${typeof options.onEvent}.`,
    );
  }

  const loaded = await loadGrpc();
  const { grpc } = loaded;

  // One catalog, one resolution. When the caller supplied a context both views
  // provably come from the same build; when it did not, building it here rather
  // than letting resolveMethod do it internally is what makes the catalog's own
  // notes separable from the method's below.
  const source =
    context ??
    (await (async () => {
      const built = await buildCatalog(target);
      return {
        catalog: built.catalog,
        packageDefinition: built.packageDefinition,
        includeSourceNotes: false,
      } satisfies GrpcCallContext;
    })());

  const method = await resolveMethod(target, {
    catalog: source.catalog,
    packageDefinition: source.packageDefinition,
  });

  // ResolvedMethod.notes carries the catalog's notes through unchanged. Only the
  // ones this method contributed belong to this call.
  const sourceNotes = new Set(source.catalog.notes);
  const warnings = source.includeSourceNotes
    ? [...method.notes]
    : method.notes.filter((n) => !sourceNotes.has(n));

  const events: GrpcEvent[] = [];
  const inbound: unknown[] = [];
  let seq = 0;
  let truncated = false;
  let truncatedReason: GrpcTruncatedReason | undefined;
  let error: string | undefined;
  let status: GrpcStatus | undefined;
  let statusOrigin: GrpcStatusOrigin | undefined;
  let initialMetadata: GrpcMetadataOutput | undefined;
  let trailers: GrpcMetadataOutput | undefined;

  /* ---------------------------------------------------------------- *
   * Option consistency, checked before anything is dialled
   * ---------------------------------------------------------------- */

  if (!method.requestStream && outbound.length > 1) {
    warnings.push(
      `${method.kind} accepts a single request message; ` +
        `${outbound.length - 1} extra message(s) were ignored.`,
    );
  }
  if (!method.requestStream && outbound.length === 0) {
    warnings.push(
      `${method.kind} requires a request message and none was given; ` +
        `an empty message was sent, which on the wire means "all defaults".`,
    );
  }
  if (options.keepWriteOpen && method.kind !== "bidi_streaming") {
    warnings.push(
      `keepWriteOpen only applies to bidi_streaming; ignored for ${method.kind}.`,
    );
  }
  if (options.sendIntervalMs !== undefined && !method.requestStream) {
    warnings.push(
      `sendIntervalMs paces the outbound stream and has no effect on ` +
        `${method.kind}, which sends exactly one message.`,
    );
  }
  if (options.keepWriteOpen && method.kind === "bidi_streaming") {
    const hasClientLimit =
      options.maxSessionMs !== undefined ||
      options.idleTimeoutMs !== undefined ||
      options.maxMessages !== undefined ||
      Boolean(options.signal);

    if (!hasClientLimit && target.deadlineMs === undefined) {
      warnings.push(
        "keepWriteOpen is set with no limit and no deadline; " +
          "the call can only end when the server closes the stream.",
      );
    } else if (!hasClientLimit) {
      // A deadline does bound the call, but it bounds it by failing: with the
      // write side held open the client never half-closes, so unless the server
      // ends the stream on its own the only possible outcome is
      // DEADLINE_EXCEEDED. Worth saying, because "bounded" and "will succeed"
      // are being conflated whenever this configuration is chosen deliberately.
      warnings.push(
        `keepWriteOpen is bounded only by deadlineMs (${target.deadlineMs}ms); ` +
          `since the write side is never half-closed, the call will end in ` +
          `DEADLINE_EXCEEDED unless the server closes the stream first. Set ` +
          `maxMessages, idleTimeoutMs, or maxSessionMs for a clean stop.`,
      );
    }
  }

  const creds = buildCredentialsChecked(target, loaded);
  warnings.push(...creds.warnings);

  // Metadata is built before the channel so a rejected header cannot leak a
  // client that nothing will ever close.
  const md = buildMetadata(
    grpc as unknown as {
      Metadata: new () => { add: (k: string, v: unknown) => void };
    },
    target.metadata,
  );

  let client: InstanceType<typeof grpc.Client>;
  try {
    client = new grpc.Client(
      target.address,
      creds.credentials,
      target.channelOptions as never,
    );
  } catch (e) {
    // An address grpc-js will not even parse is a caller mistake, and there is
    // no call to report it on.
    throw new Error(
      `could not create a channel to "${target.address}": ` +
        `${e instanceof Error ? e.message : String(e)}. Expected host:port.`,
    );
  }

  const callOptions: Record<string, unknown> = {};
  if (target.deadlineMs !== undefined) {
    // A deadline is not truncation: DEADLINE_EXCEEDED is the peer's verdict, so
    // it surfaces as a server-origin status and never as truncatedReason.
    callOptions.deadline = new Date(Date.now() + target.deadlineMs);
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    /**
     * Status and error lock independently.
     *
     * They are separate observations, and grpc-js delivers them through
     * separate paths whose order is not part of its contract: the "status"
     * listener carries the code and details, the unary callback carries the
     * Error. Locking them together let whichever fired first suppress the
     * other, so a failed call could report FAILED_PRECONDITION with no error
     * string, or an error string with no status.
     */
    let statusLocked = false;
    let errorLocked = false;
    /**
     * Set when a unary or client-streaming callback has delivered its response
     * and the call is now waiting for the server's status.
     *
     * These two kinds complete through their callback, and grpc-js invokes it
     * before the "status" event reaches a listener registered on the returned
     * call object. The previous code finished right there, which had three
     * consequences, all of them silent: the status was a locally manufactured
     * `toStatus(0)` while `statusOrigin` still claimed "server"; `details` was
     * undefined where streaming calls reported the server's "OK"; and the
     * trailers were dropped entirely, so trailing metadata was unreachable for
     * every unary call this library ever made. The event log also showed no
     * status entry, asserting that none was received when one was.
     */
    let awaitingStatus = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let sessionTimer: NodeJS.Timeout | undefined;
    let sendTimer: NodeJS.Timeout | undefined;
    let statusGraceTimer: NodeJS.Timeout | undefined;
    let call: AnyCall | undefined;
    let abortListener: (() => void) | undefined;

    /**
     * Events are dropped after the call has settled.
     *
     * Cancelling a call makes grpc-js emit a further error/status pair, and
     * appending those would mean the event log continues past the moment the
     * result claims the session ended.
     */
    const emit = (event: EventDraft<GrpcEvent>): void => {
      if (settled) return;
      const full = { ...event, seq: seq++, at: Date.now() } as GrpcEvent;
      events.push(full);
      if (!options.onEvent) return;
      try {
        options.onEvent(full);
      } catch {
        // A throwing callback must never take down the call; mirrors http/ws.
      }
    };

    const setStatus = (next: GrpcStatus, origin: GrpcStatusOrigin): void => {
      if (statusLocked) return;
      statusLocked = true;
      status = next;
      statusOrigin = origin;
    };

    const setError = (message: string): void => {
      if (errorLocked) return;
      // A client-initiated stop is not a failure to report as `error`; the
      // truncation fields already describe it, and grpc-js's CANCELLED message
      // would read as though the server refused.
      if (truncated) return;
      errorLocked = true;
      error = message;
    };

    const finish = (reason?: GrpcTruncatedReason): void => {
      if (settled) return;

      if (reason) {
        truncated = true;
        truncatedReason = reason;

        // Every client-initiated stop gets a status, synthesised when the
        // server will never send one. Without this, max_messages was the only
        // termination path that produced an undefined status while the other
        // three surfaced a real CANCELLED — one meaning, two shapes.
        //
        // No event is emitted for it: nothing was observed on the wire, and a
        // synthetic entry in the timeline would be indistinguishable from one.
        if (CLIENT_INITIATED.has(reason)) {
          setStatus(
            toStatus(
              CODE_CANCELLED,
              `call stopped by the client (${reason}); ` +
                `the server never reported a status`,
            ),
            "synthesized",
          );
        }
      }

      // The response arrived but the status did not, within the grace window.
      // Reported rather than papered over: an OK here is this library's
      // inference from "the callback succeeded", not something the peer said.
      if (awaitingStatus && !statusLocked) {
        setStatus(toStatus(CODE_OK), "synthesized");
        warnings.push(
          `the response was received but the server's status did not arrive ` +
            `within ${STATUS_GRACE_MS}ms; OK was inferred from the successful ` +
            `response and no trailing metadata is available.`,
        );
      }
      awaitingStatus = false;

      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(sessionTimer);
      clearTimeout(sendTimer);
      clearTimeout(statusGraceTimer);
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
      try {
        call?.cancel();
      } catch {
        /* already closed */
      }
      try {
        client.close();
      } catch {
        /* already closed */
      }
      resolve();
    };

    /**
     * Restarts the idle clock. Called for traffic in BOTH directions.
     *
     * Outbound writes count as activity. They did not before, so a paced
     * client-streaming send — sendIntervalMs above idleTimeoutMs — was killed
     * as idle while it was actively working, and the result blamed the server
     * for a silence the client had scheduled.
     */
    const bumpIdle = (): void => {
      if (settled) return;
      if (options.idleTimeoutMs === undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish("idle_timeout"),
        options.idleTimeoutMs,
      );
    };

    const onInbound = (payload: unknown): void => {
      if (settled) return;
      inbound.push(payload);
      emit({ direction: "inbound", payload });
      bumpIdle();
      if (
        options.maxMessages !== undefined &&
        inbound.length >= options.maxMessages
      ) {
        finish("max_messages");
      }
    };

    /**
     * Holds the call open just long enough for the status grpc-js is about to
     * deliver, for the two kinds whose callback fires first.
     */
    const waitForStatus = (): void => {
      if (settled || statusLocked) {
        finish();
        return;
      }
      awaitingStatus = true;
      // Idle timeouts must not fire during this window: the call is complete
      // and is waiting on an in-process hop, not on the network.
      clearTimeout(idleTimer);
      statusGraceTimer = setTimeout(() => finish(), STATUS_GRACE_MS);
    };

    /**
     * A failure delivered by grpc-js rather than by the peer's trailers.
     *
     * Origin is "client" when there is no code at all — a channel that never
     * connected — and "server" otherwise, since grpc-js populates the code from
     * the received status when there was one.
     */
    const onCallError = (err: unknown): void => {
      const e = err as { code?: number; message?: string; details?: string };
      const observed = toStatus(e.code ?? CODE_UNKNOWN, e.details ?? e.message);
      const origin: Exclude<GrpcStatusOrigin, "synthesized"> =
        e.code === undefined ? "client" : "server";
      setStatus(observed, origin);
      setError(e.message ?? String(err));
      emit({ direction: "status", status: observed, statusOrigin: origin });
      finish();
    };

    /** Reports a failure this library detected, without involving the wire. */
    const failLocally = (
      code: number,
      details: string,
      cause: unknown,
    ): void => {
      const observed = toStatus(code, details);
      setStatus(observed, "client");
      setError(cause instanceof Error ? cause.message : String(cause));
      emit({ direction: "status", status: observed, statusOrigin: "client" });
      finish();
    };

    // maxMessages: 0 means "do not accept any response", which has to be
    // handled before the first message rather than after it.
    if (options.maxMessages === 0) {
      warnings.push(
        "maxMessages is 0, so the call is stopped before any response is read.",
      );
      finish("max_messages");
      return;
    }

    if (options.maxSessionMs !== undefined) {
      sessionTimer = setTimeout(
        () => finish("max_session"),
        options.maxSessionMs,
      );
    }

    if (options.signal) {
      if (options.signal.aborted) {
        finish("aborted");
        return;
      }
      abortListener = () => finish("aborted");
      options.signal.addEventListener("abort", abortListener, { once: true });
    }

    const serialize = (v: unknown): Buffer => method.serialize(v);
    const deserialize = (b: Buffer): unknown => method.deserialize(b);

    /**
     * Serialises eagerly so a malformed request message is reported as a
     * client-side INVALID_ARGUMENT naming the offending index, instead of
     * surfacing as an opaque UNKNOWN from inside the transport. The transport
     * serialises again; one extra encode per message buys an error a user can
     * act on.
     */
    const precheck = (payload: unknown, index: number): boolean => {
      try {
        method.serialize(payload);
        return true;
      } catch (e) {
        failLocally(
          CODE_INVALID_ARGUMENT,
          `request message #${index} does not match ` +
            `${method.inputType ?? "the request type"}`,
          e,
        );
        return false;
      }
    };

    /** Attaches the listeners every call kind shares. */
    const attachCommon = (c: AnyCall): void => {
      c.on("metadata", (initial) => {
        initialMetadata = metadataToObject(initial);
        emit({ direction: "meta", metadata: initialMetadata });
      });
      c.on("status", (s) => {
        const st = s as { code: number; details?: string; metadata?: unknown };
        trailers = metadataToObject(st.metadata);
        // One object for both uses: two toStatus() calls would drift the moment
        // GrpcStatus grows a field.
        const observed = toStatus(st.code, st.details);
        setStatus(observed, "server");
        emit({
          direction: "status",
          status: observed,
          statusOrigin: "server",
          metadata: trailers,
        });
        // Response-streaming calls end here. So do unary and client-streaming
        // calls that already delivered their response and were holding open for
        // exactly this event. What must NOT happen is finishing a unary call
        // whose callback has not run yet: the status can precede it, and that
        // would discard a response already on its way.
        if (method.responseStream || awaitingStatus) finish();
      });
    };

    /** Writes the outbound queue, optionally paced, then half-closes. */
    const startWriting = (c: AnyCall): void => {
      let index = 0;
      const writeNext = (): void => {
        if (settled) return;
        if (index >= outbound.length) {
          const keepOpen =
            options.keepWriteOpen === true && method.kind === "bidi_streaming";
          if (!keepOpen) {
            try {
              c.end?.();
            } catch {
              /* already closed */
            }
          }
          return;
        }
        const at = index;
        const payload = outbound[index++];
        if (!precheck(payload, at)) return;
        try {
          c.write?.(payload);
          emit({ direction: "outbound", payload });
          bumpIdle();
        } catch (e) {
          failLocally(CODE_UNKNOWN, `write of message #${at} failed`, e);
          return;
        }
        if (options.sendIntervalMs) {
          sendTimer = setTimeout(writeNext, options.sendIntervalMs);
        } else {
          writeNext();
        }
      };
      writeNext();
    };

    try {
      if (method.kind === "unary" || method.kind === "server_streaming") {
        const payload = outbound[0] ?? {};
        if (!precheck(payload, 0)) return;
        // Emitted before dialling so the outbound event cannot be ordered after
        // a synchronously delivered response or failure.
        emit({ direction: "outbound", payload });

        if (method.kind === "unary") {
          call = client.makeUnaryRequest(
            method.path,
            serialize,
            deserialize,
            payload,
            md as never,
            callOptions as never,
            (err, value) => {
              if (err) onCallError(err);
              else {
                // No setStatus here: the server's own status is arriving and
                // must win. Manufacturing OK first locked it out.
                onInbound(value);
                waitForStatus();
              }
            },
          ) as unknown as AnyCall;
          attachCommon(call);
          // Unary calls surface failures through the callback, but a channel
          // level error can also reach the emitter; both funnel to one place.
          call.on("error", onCallError);
        } else {
          call = client.makeServerStreamRequest(
            method.path,
            serialize,
            deserialize,
            payload,
            md as never,
            callOptions as never,
          ) as unknown as AnyCall;
          attachCommon(call);
          call.on("data", (p) => onInbound(p));
          call.on("error", onCallError);
          call.on("end", () => {
            // "end" without a status is possible on an abrupt close; the status
            // handler wins when it has already run, since setStatus locks.
            setStatus(toStatus(CODE_OK), "synthesized");
            finish();
          });
        }
      } else if (method.kind === "client_streaming") {
        call = client.makeClientStreamRequest(
          method.path,
          serialize,
          deserialize,
          md as never,
          callOptions as never,
          (err, value) => {
            if (err) onCallError(err);
            else {
              onInbound(value);
              waitForStatus();
            }
          },
        ) as unknown as AnyCall;
        attachCommon(call);
        call.on("error", onCallError);
        startWriting(call);
      } else {
        call = client.makeBidiStreamRequest(
          method.path,
          serialize,
          deserialize,
          md as never,
          callOptions as never,
        ) as unknown as AnyCall;
        attachCommon(call);
        call.on("data", (p) => onInbound(p));
        call.on("error", onCallError);
        call.on("end", () => {
          setStatus(toStatus(CODE_OK), "synthesized");
          finish();
        });
        startWriting(call);
      }
    } catch (e) {
      failLocally(CODE_UNKNOWN, "call setup failed", e);
      return;
    }

    bumpIdle();
  });

  return {
    protocol: "grpc",
    kind: method.kind,
    target,
    events,
    messages: inbound,
    initialMetadata,
    status,
    statusOrigin,
    trailers,
    truncated,
    truncatedReason,
    error,
    warnings,
    durationMs: Date.now() - startedAt,
  };
}
