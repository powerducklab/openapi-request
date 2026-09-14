import WebSocket, {
  type ClientOptions,
  type Data,
  type RawData,
} from "ws";
import type {
  CreateWsManualSessionOptions,
  WebSocketSessionEvent,
  WsManualSession,
  WsSendOptions,
} from "../../core/types";
import type { SessionEventDTO, SessionSubscription } from "../../core/session";
import { createEventHub } from "../../core/session";
import { messageOf, sleep, tryParseJson } from "../../core/utils";

function normalizeBinaryData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (typeof data === "string") {
    return Buffer.from(data, "base64");
  }

  throw new TypeError(
    "Binary WebSocket data must be a Buffer, Uint8Array, ArrayBuffer, or base64 string",
  );
}

export function createWsManualSession(
  options: CreateWsManualSessionOptions,
): WsManualSession {
  let state: WsManualSession["state"] = "idle";

  function setState(next: WsManualSession["state"]): void {
    state = next;
    hub.setState(next);
  }
  const hub = createEventHub(
    "websocket",
    "websocket",
    `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    typeof options.maxEvents === "number" && options.maxEvents >= 0
      ? Math.floor(options.maxEvents)
      : 1000,
  );
  const openTimeoutMs =
    typeof options.openTimeoutMs === "number" && options.openTimeoutMs > 0
      ? Math.floor(options.openTimeoutMs)
      : 15_000;

  let socket: WebSocket | null = null;

  let closeResolve: () => void = () => {};
  let closePromise: Promise<void> = createClosePromise();

  function createClosePromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
  }

  function resetClosePromise(): void {
    closePromise = createClosePromise();
  }

  function record(event: WebSocketSessionEvent): void {
    const {
      direction,
      receivedAt,
      event: kind,
      data,
      parsed,
      code,
      reason,
      wasClean,
      protocol,
      extensions,
      statusCode,
      statusMessage,
      headers,
      error,
    } = event as any;

    const meta: Record<string, unknown> = {};
    if (parsed !== undefined) meta.parsed = parsed;
    if (code !== undefined) meta.code = code;
    if (reason !== undefined) meta.reason = reason;
    if (wasClean !== undefined) meta.wasClean = wasClean;
    if (protocol !== undefined) meta.protocol = protocol;
    if (extensions !== undefined) meta.extensions = extensions;
    if (statusCode !== undefined) meta.statusCode = statusCode;
    if (statusMessage !== undefined) meta.statusMessage = statusMessage;
    if (headers !== undefined) meta.headers = headers;

    hub.emit({
      direction,
      kind,
      at: receivedAt,
      state: hub.state,
      data,
      meta: Object.keys(meta).length ? meta : undefined,
      error,
    });
  }

  function assertSocketOpen(): WebSocket {
    if (!socket || state !== "open" || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket session is not open");
    }

    return socket;
  }

  function recordError(error: unknown): void {
    const message = messageOf(error);

    record({
      direction: "meta",
      receivedAt: Date.now(),
      event: "error",
      data: message,
      error: message,
    });
  }

  return {
    get protocol(): "websocket" {
      return "websocket";
    },

    get state(): WsManualSession["state"] {
      return state;
    },

    get events(): readonly SessionEventDTO[] {
      return hub.events;
    },

    onEvent(
      listener: (event: SessionEventDTO) => void,
    ): SessionSubscription {
      return hub.onEvent(listener);
    },

    async open(): Promise<void> {
      if (state !== "idle" && state !== "closed" && state !== "error") {
        throw new Error(`WebSocket session cannot open from state "${state}"`);
      }

      if (options.signal?.aborted) {
        setState("closed");
        throw new Error("WebSocket open aborted");
      }

      if (!options.url?.trim()) {
        throw new Error("WebSocket URL is required");
      }

      resetClosePromise();
      setState("connecting");

      await new Promise<void>((resolve, reject) => {
        const clientOptions: ClientOptions = {
          headers: options.headers,
        };

        if (options.rejectUnauthorized !== undefined) {
          clientOptions.rejectUnauthorized = options.rejectUnauthorized;
        }

        const protocols = options.subprotocols?.filter(Boolean) ?? [];

        const ws =
          protocols.length > 0
            ? new WebSocket(options.url, protocols, clientOptions)
            : new WebSocket(options.url, clientOptions);

        socket = ws;

        let openSettled = false;
        let unexpectedResponseReceived = false;
        let openTimeout: ReturnType<typeof setTimeout> | undefined;
        let detachAbort: (() => void) | undefined;

        const cleanupOpenGuards = (): void => {
          if (openTimeout) {
            clearTimeout(openTimeout);
            openTimeout = undefined;
          }
          detachAbort?.();
          detachAbort = undefined;
        };

        const rejectOpen = (error: Error): void => {
          if (openSettled) {
            return;
          }

          openSettled = true;
          cleanupOpenGuards();
          reject(error);
        };

        const resolveOpen = (): void => {
          if (openSettled) {
            return;
          }

          openSettled = true;
          cleanupOpenGuards();
          resolve();
        };

        openTimeout = setTimeout(() => {
          const error = new Error(
            `WebSocket handshake timed out after ${openTimeoutMs}ms`,
          );
          setState("error");
          recordError(error);
          rejectOpen(error);
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }, openTimeoutMs);

        if (typeof (openTimeout as any)?.unref === "function") {
          (openTimeout as any).unref();
        }

        if (options.signal) {
          const onAbort = () => {
            const error = new Error("WebSocket open aborted");
            setState("closed");
            recordError(error);
            rejectOpen(error);
            try {
              ws.terminate();
            } catch {
              // ignore
            }
            closeResolve();
          };

          if (options.signal.aborted) {
            onAbort();
            return;
          }

          options.signal.addEventListener("abort", onAbort, { once: true });
          detachAbort = () =>
            options.signal?.removeEventListener("abort", onAbort);
        }

        ws.once("upgrade", (response) => {
          record({
            direction: "meta",
            receivedAt: Date.now(),
            event: "upgrade",
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
          });
        });

        ws.once("unexpected-response", (_request, response) => {
          unexpectedResponseReceived = true;

          record({
            direction: "meta",
            receivedAt: Date.now(),
            event: "unexpected-response",
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
          });

          response.resume();

          const statusText = [response.statusCode, response.statusMessage]
            .filter(
              (value): value is number | string =>
                value !== undefined && value !== "",
            )
            .join(" ");

          const error = new Error(
            `WebSocket handshake failed${statusText ? `: ${statusText}` : ""}`,
          );

          setState("error");
          recordError(error);
          rejectOpen(error);

          if (
            ws.readyState === WebSocket.CONNECTING ||
            ws.readyState === WebSocket.OPEN
          ) {
            ws.terminate();
          }
        });

        ws.once("open", () => {
          setState("open");

          record({
            direction: "meta",
            receivedAt: Date.now(),
            event: "open",
            statusCode: 101,
            statusMessage: "Switching Protocols",
            protocol: ws.protocol || undefined,
            extensions: ws.extensions || undefined,
          });

          resolveOpen();
        });

        ws.on("message", (data: RawData, isBinary: boolean) => {
          if (isBinary) {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : Buffer.from(data);

            record({
              direction: "in",
              receivedAt: Date.now(),
              event: "binary",
              data: buffer.toString("base64"),
            });

            return;
          }

          const text = Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : data instanceof ArrayBuffer
                ? Buffer.from(data).toString("utf8")
                : Buffer.from(data).toString("utf8");

          record({
            direction: "in",
            receivedAt: Date.now(),
            event: "text",
            data: text,
            parsed: tryParseJson(text),
          });
        });

        ws.on("error", (error) => {
          setState("error");
          recordError(error);
          rejectOpen(error);
        });

        ws.once("close", (code, reasonBuffer) => {
          const reason = reasonBuffer.toString("utf8");
          const wasClean = code === 1000;

          // A failed connection fires 'error' then 'close'. Do not let the
          // close handler override the more specific "error" state.
          if (state !== "error") {
            setState("closed");
          }

          record({
            direction: "meta",
            receivedAt: Date.now(),
            event: "close",
            code,
            reason,
            wasClean,
          });

          closeResolve();

          if (!openSettled && !unexpectedResponseReceived) {
            rejectOpen(
              new Error(
                `WebSocket closed before opening: ${code}${
                  reason ? ` ${reason}` : ""
                }`,
              ),
            );
          }
        });
      });
    },

    async send(data: unknown, sendOptions: WsSendOptions = {}): Promise<void> {
      if (options.signal?.aborted) {
        throw new Error("WebSocket send aborted");
      }

      const ws = assertSocketOpen();

      if (sendOptions.delayMs !== undefined && sendOptions.delayMs > 0) {
        await sleep(sendOptions.delayMs, options.signal);
      }

      if (options.signal?.aborted) {
        throw new Error("WebSocket send aborted");
      }

      assertSocketOpen();

      let outboundData: Data;
      let eventType: "text" | "binary";
      let displayData: string;
      let parsed: unknown;

      if (
        sendOptions.binary ||
        Buffer.isBuffer(data) ||
        data instanceof Uint8Array ||
        data instanceof ArrayBuffer
      ) {
        const buffer = normalizeBinaryData(data);

        outboundData = buffer;
        eventType = "binary";
        displayData = buffer.toString("base64");
      } else if (typeof data === "string") {
        outboundData = data;
        eventType = "text";
        displayData = data;
        parsed = tryParseJson(data);
      } else {
        const serialized = JSON.stringify(data);

        if (serialized === undefined) {
          throw new TypeError("WebSocket payload cannot be serialized");
        }

        outboundData = serialized;
        eventType = "text";
        displayData = serialized;
        parsed = data;
      }

      await new Promise<void>((resolve, reject) => {
        ws.send(
          outboundData,
          {
            binary: eventType === "binary",
          },
          (error?: Error) => {
            if (error) {
              recordError(error);
              reject(error);
              return;
            }

            record({
              direction: "out",
              receivedAt: Date.now(),
              event: eventType,
              data: displayData,
              parsed,
            });

            resolve();
          },
        );
      });
    },

    async close(
      closeOptions: {
        code?: number;
        reason?: string;
      } = {},
    ): Promise<void> {
      if (!socket) {
        setState("closed");
        closeResolve();
        return;
      }

      if (state === "closed") {
        closeResolve();
        return;
      }

      if (state === "closing") {
        await closePromise;
        return;
      }

      setState("closing");

      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
        await closePromise;
        return;
      }

      if (socket.readyState === WebSocket.OPEN) {
        socket.close(
          closeOptions.code ?? 1000,
          closeOptions.reason ?? "Closed",
        );
        await closePromise;
        return;
      }

      if (socket.readyState === WebSocket.CLOSING) {
        await closePromise;
        return;
      }

      setState("closed");
      closeResolve();
    },

    async waitForClose(): Promise<void> {
      await closePromise;
    },
  };
}

export const wsManualSession = createWsManualSession;
