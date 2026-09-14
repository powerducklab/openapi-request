import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { err } from "../../core/errors";
import { messageOf, sleep } from "../../core/utils";

export interface McpStdioOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Undefined values explicitly remove inherited environment variables. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface StdioRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpStdioConnection {
  readonly pid: number | undefined;
  request<T = unknown>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T>;
  notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const FORCE_KILL_AFTER_MS = 1_500;
const CLOSE_WAIT_MS = 2_000;

type RequestId = string | number;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createMcpStdioConnection(
  options: McpStdioOptions,
): McpStdioConnection {
  if (
    !options ||
    typeof options.command !== "string" ||
    !options.command.trim()
  ) {
    throw err(
      "BAD_MCP_STDIO_COMMAND",
      "MCP stdio requires a non-empty command.",
    );
  }

  const timeoutMs = normalizePositive(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxBufferBytes = normalizePositive(
    options.maxBufferBytes,
    DEFAULT_MAX_BUFFER_BYTES,
    "maxBufferBytes",
  );
  const env = buildEnvironment(options.env);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
  } catch (cause) {
    throw err(
      "MCP_STDIO_SPAWN_FAILED",
      `Could not start MCP stdio process: ${messageOf(cause)}`,
      undefined,
      { cause },
    );
  }

  let closed = false;
  let nextId = 0;
  let stdoutBuffer = "";
  let stderr = "";
  const pending = new Map<RequestId, PendingRequest>();

  const cleanupPending = (
    id: RequestId,
    pendingRequest: PendingRequest,
  ): void => {
    if (pending.get(id) === pendingRequest) pending.delete(id);
    if (pendingRequest.timer) clearTimeout(pendingRequest.timer);
    if (pendingRequest.signal && pendingRequest.onAbort) {
      pendingRequest.signal.removeEventListener(
        "abort",
        pendingRequest.onAbort,
      );
    }
  };

  const rejectAll = (reason: unknown): void => {
    for (const [id, pendingRequest] of pending) {
      cleanupPending(id, pendingRequest);
      pendingRequest.reject(reason);
    }
  };

  const failProtocol = (message: string): void => {
    if (closed) return;
    const failure = err("MCP_STDIO_PROTOCOL_ERROR", message);
    rejectAll(failure);
    void close();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (closed) return;
    stdoutBuffer += chunk;

    if (Buffer.byteLength(stdoutBuffer, "utf8") > maxBufferBytes) {
      failProtocol(
        `MCP stdio stdout buffer exceeded ${maxBufferBytes} bytes without a complete JSON-RPC line.`,
      );
      return;
    }

    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;

      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      if (Buffer.byteLength(line, "utf8") > maxBufferBytes) {
        failProtocol(
          `MCP stdio JSON-RPC message exceeded ${maxBufferBytes} bytes.`,
        );
        return;
      }

      let message: StdioRpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        failProtocol(
          `MCP stdio emitted invalid JSON-RPC: ${line.slice(0, 512)}`,
        );
        return;
      }

      if (!isRpcMessage(message)) {
        failProtocol("MCP stdio emitted an invalid JSON-RPC envelope.");
        return;
      }

      if (message.id === undefined) continue; // server notification/request; not a response to us

      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) continue; // late response after timeout/abort, or unknown id

      cleanupPending(message.id, pendingRequest);

      if (message.error !== undefined) {
        pendingRequest.reject(
          err(
            "MCP_RPC_ERROR",
            `${message.error.code}: ${message.error.message}`,
            message.error,
          ),
        );
      } else if (Object.prototype.hasOwnProperty.call(message, "result")) {
        pendingRequest.resolve(message.result);
      } else {
        pendingRequest.reject(
          err(
            "MCP_STDIO_PROTOCOL_ERROR",
            "MCP stdio response contained neither result nor error.",
          ),
        );
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
  });

  child.once("error", (cause) => {
    if (closed) return;
    closed = true;
    rejectAll(
      err(
        "MCP_STDIO_SPAWN_FAILED",
        `Could not start MCP stdio process: ${messageOf(cause)}`,
        undefined,
        { cause },
      ),
    );
  });

  child.once("exit", (code, signal) => {
    if (closed) return;
    closed = true;
    const diagnostic = stderr.trim()
      ? ` stderr: ${stderr.trim().slice(-2048)}`
      : "";
    rejectAll(
      err(
        "MCP_STDIO_EXITED",
        `MCP stdio process exited (code=${code}, signal=${signal ?? "none"}).${diagnostic}`,
      ),
    );
  });

  function write(message: StdioRpcMessage): Promise<void> {
    if (closed || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(
        err("MCP_STDIO_CLOSED", "MCP stdio process is closed."),
      );
    }

    let payload: string;
    try {
      payload = JSON.stringify(message) + "\n";
    } catch (cause) {
      return Promise.reject(
        err(
          "MCP_STDIO_SERIALIZE_FAILED",
          `Could not serialize MCP JSON-RPC message: ${messageOf(cause)}`,
          undefined,
          { cause },
        ),
      );
    }

    return new Promise((resolve, reject) => {
      child.stdin.write(payload, "utf8", (cause) => {
        if (cause) reject(cause);
        else resolve();
      });
    });
  }

  function request<T>(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(
        err("MCP_ABORTED", "MCP request was aborted before send."),
      );
    }
    if (closed)
      return Promise.reject(
        err("MCP_STDIO_CLOSED", "MCP stdio process is closed."),
      );

    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const pendingRequest: PendingRequest = { resolve, reject };

      pendingRequest.timer = setTimeout(() => {
        cleanupPending(id, pendingRequest);
        reject(err("MCP_TIMEOUT", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequest.timer.unref?.();

      if (signal) {
        pendingRequest.signal = signal;
        pendingRequest.onAbort = () => {
          cleanupPending(id, pendingRequest);
          reject(err("MCP_ABORTED", `${method} was aborted.`));
        };
        signal.addEventListener("abort", pendingRequest.onAbort, {
          once: true,
        });
      }

      pending.set(id, pendingRequest);

      void write({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }).catch((cause) => {
        cleanupPending(id, pendingRequest);
        reject(cause);
      });
    });
  }

  async function notify(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted)
      throw err("MCP_ABORTED", "MCP notification was aborted before send.");
    await write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    rejectAll(err("MCP_STDIO_CLOSED", "MCP stdio process was closed."));

    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode !== null || child.killed) return;

    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort only.
        }
      }
    }, FORCE_KILL_AFTER_MS);
    forceKillTimer.unref?.();

    try {
      await Promise.race([
        once(child, "exit").then(() => undefined),
        sleep(CLOSE_WAIT_MS),
      ]);
    } finally {
      clearTimeout(forceKillTimer);
    }
  }

  return {
    get pid() {
      return child.pid;
    },
    request,
    notify,
    close,
  };
}

function buildEnvironment(
  overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!overrides) return env;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function normalizePositive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw err(
      "BAD_MCP_STDIO_CONFIG",
      `MCP stdio ${name} must be a positive finite number.`,
    );
  }
  return result;
}

function isRpcMessage(value: unknown): value is StdioRpcMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}
