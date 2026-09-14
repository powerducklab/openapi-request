import WebSocket from "ws";
import type {
  SendOptions,
  ExecResult,
  StreamEvent,
  StopReason,
  Json,
} from "../../core/types";
import type { ExecuteContext } from "../../core/protocol";
import { createLatch, safeClearTimeout } from "../../core/utils";
import { toErrorInfo } from "../../core/errors";
import type { ResolvedWsConfig } from "./config";

/** WebSocket close codes that indicate a clean, expected shutdown. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

type Phase = "connecting" | "open" | "closing" | "finalized";

type ErrorShape = { message: string; code?: string; name?: string };

/**
 * Open a WebSocket session, send the configured messages, and collect inbound
 * frames until a sampling limit or a close event is reached.
 *
 * Lifecycle: connecting -> open -> closing -> finalized. Every exit path runs
 * through `finalize()`, which is idempotent, so a close frame racing the close
 * watchdog cannot produce two results.
 */
export function runWebSocket(
  config: ResolvedWsConfig,
  options: SendOptions,
  ctx?: ExecuteContext,
): Promise<ExecResult> {
  const latch = createLatch<ExecResult>();

  const startedAt = Date.now();
  let phase: Phase = "connecting";
  let openedAt: number | undefined;
  let inboundCount = 0;
  let sequence = 0;
  let bytes = 0;
  let truncated = false;
  let stopReason: StopReason | undefined;
  let droppedEvents = 0;
  let sawBinary = false;
  let sawText = false;
  let closeCodeSeen: number | undefined;

  const events: StreamEvent[] = [];
  const handshakeHeaders: Record<string, string> = {};
  let handshakeStatus = 0;
  let negotiatedProtocol: string | undefined;
  let failure: ErrorShape | undefined;

  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  const sendTimers: Array<ReturnType<typeof setTimeout>> = [];
  let detachSignal: (() => void) | null = null;

  // Keep-alive liveness: a peer whose TCP connection is up but whose
  // application layer is dead still answers nothing.
  let awaitingPong = false;

  const unref = <T>(timer: T): T => {
    if (timer && typeof (timer as any).unref === "function") {
      (timer as any).unref();
    }
    return timer;
  };

  const clearAllTimers = () => {
    sessionTimer = safeClearTimeout(sessionTimer);
    idleTimer = safeClearTimeout(idleTimer);
    closeTimer = safeClearTimeout(closeTimer);
    if (keepAliveTimer) {
      try {
        clearInterval(keepAliveTimer);
      } catch {
        /* ignore */
      }
      keepAliveTimer = null;
    }
    for (const timer of sendTimers.splice(0)) safeClearTimeout(timer);
  };

  const buildResult = (error?: ErrorShape): ExecResult => {
    const endedAt = Date.now();
    const succeeded = !error && handshakeStatus > 0 && handshakeStatus < 400;

    const responseHeaders: Record<string, string> = { ...handshakeHeaders };
    // The negotiated subprotocol is the single most useful piece of handshake
    // feedback, so make sure it is present even if the peer omitted the header.
    if (
      negotiatedProtocol &&
      !hasHeader(responseHeaders, "sec-websocket-protocol")
    ) {
      responseHeaders["sec-websocket-protocol"] = negotiatedProtocol;
    }

    return {
      protocol: "websocket",
      request: {
        method: "GET",
        url: config.url,
        headers: {
          ...config.headers,
          Upgrade: "websocket",
          Connection: "Upgrade",
          ...(config.subprotocols.length
            ? { "Sec-WebSocket-Protocol": config.subprotocols.join(", ") }
            : {}),
        },
        body: config.send.length
          ? config.send.map((entry) =>
              typeof entry === "string"
                ? entry
                : `<binary ${entry.byteLength} bytes>`,
            )
          : undefined,
      },
      response: {
        status: handshakeStatus || (error ? 0 : 101),
        statusText: error
          ? "WebSocket error"
          : succeeded
            ? "Switching Protocols"
            : "Connection closed",
        headers: responseHeaders,
        // Reported from what actually arrived rather than assumed, since this
        // value feeds the OpenAPI write-back step.
        contentType:
          sawBinary && !sawText
            ? "application/octet-stream"
            : "application/json",
        events,
        timings: {
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          firstByteMs: openedAt ? openedAt - startedAt : undefined,
        },
        sizeBytes: bytes,
        ...(truncated ? { truncated: true } : {}),
        ...(stopReason ? { stopReason } : {}),
        ...(droppedEvents ? { droppedEvents } : {}),
      },
      ...(error ? { error } : {}),
    };
  };

  const finalize = (error?: ErrorShape) => {
    if (phase === "finalized") return;
    phase = "finalized";
    clearAllTimers();
    detachSignal?.();
    detachSignal = null;
    latch.resolve(buildResult(error ?? failure));
  };

  /** Begin a clean shutdown, with a bounded wait for the peer's close frame. */
  const stop = (reason: StopReason, detail: string) => {
    if (phase === "closing" || phase === "finalized") return;
    phase = "closing";
    stopReason = reason;
    truncated = true;

    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(
          config.closeCode,
          // The reason field is capped at 123 bytes by the protocol.
          truncateUtf8(
            Buffer.from(`${config.closeReason}: ${detail}`, "utf8"),
            123,
          ),
        );
      } else {
        socket?.terminate?.();
      }
    } catch {
      /* ignore */
    }

    // A peer that never completes the closing handshake must not keep us open.
    closeTimer = unref(
      setTimeout(() => {
        try {
          socket?.terminate?.();
        } catch {
          /* ignore */
        }
        finalize();
      }, config.closeTimeoutMs),
    );
  };

  let socket: WebSocket;
  try {
    socket = new WebSocket(config.url, config.subprotocols, {
      headers: config.headers,
      handshakeTimeout: Math.max(1_000, Math.min(config.maxSessionMs, 30_000)),
      rejectUnauthorized: config.rejectUnauthorized,
      // Frames above this are a protocol error that closes the session with
      // 1009, so it must stay comfortably above the retention limit.
      maxPayload: Math.max(1024 * 1024, config.maxPayloadBytes * 4),
      ...config.clientOptions,
    });
  } catch (e) {
    phase = "finalized";
    return Promise.resolve(buildResult(toErrorInfo(e)));
  }

  // External cancellation.
  if (ctx?.signal ?? options.signal) {
    const signal = (ctx?.signal ?? options.signal)!;
    if (signal.aborted) {
      stop("aborted", "signal already aborted");
    } else {
      const onAbort = () => stop("aborted", "caller aborted the session");
      signal.addEventListener("abort", onAbort, { once: true });
      detachSignal = () => signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Restart the idle window. Only data frames count: a control ping is exactly
   * what a peer sends when it has no data, so treating it as activity would
   * make `idleTimeoutMs` unreachable against any server with a heartbeat.
   */
  const bumpIdleTimer = () => {
    if (!config.idleTimeoutMs) return;
    idleTimer = safeClearTimeout(idleTimer);
    idleTimer = unref(
      setTimeout(
        () =>
          stop("idleTimeout", `no data frame within ${config.idleTimeoutMs}ms`),
        config.idleTimeoutMs,
      ),
    );
  };

  const record = (event: StreamEvent) => {
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      /* User callbacks must not break the session. */
    }
  };

  const absorbHandshakeHeaders = (response: any) => {
    for (const [key, value] of Object.entries(response?.headers ?? {})) {
      handshakeHeaders[key] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    }
  };

  socket.on("upgrade", (response: any) => {
    handshakeStatus = response?.statusCode ?? 101;
    absorbHandshakeHeaders(response);
  });

  socket.on("unexpected-response", (_request: any, response: any) => {
    handshakeStatus = response?.statusCode ?? 0;
    absorbHandshakeHeaders(response);
    failure = {
      message: `Handshake rejected with HTTP ${handshakeStatus}`,
      code: "WS_HANDSHAKE_FAILED",
    };
    try {
      response?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      socket.terminate();
    } catch {
      /* ignore */
    }
    finalize(failure);
  });

  socket.on("open", () => {
    if (phase !== "connecting") return;
    phase = "open";
    openedAt = Date.now();
    negotiatedProtocol = socket.protocol || undefined;
    if (!handshakeStatus) handshakeStatus = 101;

    try {
      options.onOpen?.({
        url: config.url,
        protocol: negotiatedProtocol,
        headers: handshakeHeaders,
      });
    } catch {
      /* ignore */
    }

    // Outbound messages, optionally spaced out to mimic a real client.
    config.send.forEach((payload, index) => {
      const dispatch = () => {
        if (phase !== "open" || socket.readyState !== WebSocket.OPEN) return;
        socket.send(payload, (sendError?: Error) => {
          if (sendError) {
            failure = failure ?? toErrorInfo(sendError);
            return;
          }
          sequence += 1;
          record({
            id: String(sequence),
            event: typeof payload === "string" ? "text" : "binary",
            data:
              typeof payload === "string"
                ? payload
                : `<binary ${payload.byteLength} bytes>`,
            parsed: typeof payload === "string" ? tryParse(payload) : undefined,
            receivedAt: Date.now(),
            direction: "out",
          });
        });
      };
      const delay = config.sendDelayMs * index;
      if (delay <= 0) {
        dispatch();
      } else {
        sendTimers.push(unref(setTimeout(dispatch, delay)));
      }
    });

    if (config.keepAlive) {
      const { intervalMs, payload } = config.keepAlive;
      keepAliveTimer = unref(
        setInterval(() => {
          if (phase !== "open" || socket.readyState !== WebSocket.OPEN) return;
          // The previous ping was never answered: the peer is unresponsive even
          // though the socket is still nominally open.
          if (awaitingPong) {
            stop(
              "idleTimeout",
              `keep-alive ping unanswered for ${intervalMs}ms`,
            );
            return;
          }
          try {
            socket.ping(payload);
            awaitingPong = true;
          } catch {
            /* ignore */
          }
        }, intervalMs),
      );
    }

    bumpIdleTimer();
  });

  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    if (phase !== "open") return;

    const buffer = toBuffer(raw);
    bytes += buffer.length;
    sequence += 1;
    inboundCount += 1;
    if (isBinary) sawBinary = true;
    else sawText = true;

    const oversized = buffer.length > config.maxPayloadBytes;
    if (oversized) {
      // The frame arrived intact but is not retained in full.
      truncated = true;
      droppedEvents += 1;
    }

    const text = isBinary
      ? `<binary ${buffer.length} bytes>`
      : oversized
        ? `${truncateUtf8(buffer, config.maxPayloadBytes)}...`
        : buffer.toString("utf8");

    record({
      id: String(sequence),
      event: isBinary ? "binary" : "text",
      data: text,
      parsed: !isBinary && !oversized ? tryParse(text) : undefined,
      receivedAt: Date.now(),
      direction: "in",
    });

    bumpIdleTimer();

    if (inboundCount >= config.maxMessages) {
      stop("maxEvents", `maxMessages (${config.maxMessages}) reached`);
    }
  });

  socket.on("ping", (payload: Buffer) => {
    if (phase === "finalized") return;
    sequence += 1;
    record({
      id: String(sequence),
      event: "ping",
      data: payload?.length ? payload.toString("utf8") : "",
      receivedAt: Date.now(),
      direction: "in",
    });
    // Deliberately does not reset the idle timer; see bumpIdleTimer.
  });

  socket.on("pong", () => {
    awaitingPong = false;
  });

  socket.on("error", (socketError: Error) => {
    // A socket we tore down on purpose reports ECONNRESET or ERR_STREAM_
    // PREMATURE_CLOSE; that is a completed sample, not a failure.
    if (phase === "closing" || phase === "finalized") return;
    failure = failure ?? toErrorInfo(socketError);
    if (socket.readyState === WebSocket.CLOSED) finalize(failure);
  });

  socket.on("close", (code: number, reasonBuffer: Buffer) => {
    closeCodeSeen = code;
    const reason = reasonBuffer?.length ? reasonBuffer.toString("utf8") : "";
    const deliberate = phase === "closing" || !!stopReason;
    if (!failure && !deliberate && !NORMAL_CLOSE_CODES.has(code)) {
      failure = {
        message: `Connection closed with code ${code}${reason ? `: ${reason}` : ""}`,
        code: String(code),
      };
    }
    // 1009 means the peer's frame exceeded maxPayload; surface it either way
    // because data was lost regardless of who initiated the close.
    if (code === 1009) {
      truncated = true;
      droppedEvents += 1;
    }
    finalize(failure);
  });

  sessionTimer = unref(
    setTimeout(
      () =>
        stop("maxSessionMs", `maxSessionMs (${config.maxSessionMs}ms) reached`),
      config.maxSessionMs,
    ),
  );

  return latch.promise;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

/**
 * Decode at most `limit` bytes, backing off to the last complete UTF-8
 * sequence so a truncated frame does not end in a replacement character.
 */
function truncateUtf8(buffer: Buffer, limit: number): string {
  if (buffer.length <= limit) return buffer.toString("utf8");
  let end = limit;
  // Continuation bytes match 10xxxxxx; rewind past a split sequence.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  if (end === 0) end = limit;
  return buffer.subarray(0, end).toString("utf8");
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  try {
    return Buffer.from(raw as ArrayBuffer);
  } catch {
    return Buffer.alloc(0);
  }
}

function tryParse(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{"\-\d]|^(true|false|null)$/.test(trimmed))
    return undefined;
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    return undefined;
  }
}
