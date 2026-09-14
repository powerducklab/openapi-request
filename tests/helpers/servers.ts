// Shared fixture servers for the test suite. Each returns a handle with
// `url` / `port` / `stop()`. Servers bind 127.0.0.1:0 (ephemeral port) so
// parallel test files never collide. Readiness is detected from the server's
// own "listening" line on stdout, which works for HTTP, WS, MCP and gRPC.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const example = (...parts: string[]) => path.join(here, "..", "..", "examples", ...parts);

function startServer(file: string, env: Record<string, string> = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [file], {
    cwd: path.join(here, ".."),
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settle: { resolved: boolean; resolve: (port: number) => void; reject: (error: Error) => void } = {
    resolved: false,
    resolve: () => {},
    reject: () => {},
  };
  const ready = new Promise<number>((resolve, reject) => {
    settle = { resolved: false, resolve, reject };
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes("listening") && !settle.resolved) {
      settle.resolved = true;
      settle.resolve(port);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    // Many example servers log readiness via console.error (stderr), so check
    // both streams for the "listening" marker.
    if (stderr.includes("listening") && !settle.resolved) {
      settle.resolved = true;
      settle.resolve(port);
    }
  });
  child.on("exit", (code) => {
    if (!settle.resolved) {
      settle.resolved = true;
      settle.reject(new Error(`server ${file} exited early (code ${code}): ${stderr}`));
    }
  });
  // Safety net: never let a broken spawn hang the suite forever.
  setTimeout(() => {
    if (!settle.resolved) {
      settle.resolved = true;
      settle.reject(new Error(`server ${file} did not report listening; stderr: ${stderr}`));
    }
  }, 15_000).unref?.();

  return {
    port: ready,
    url: `http://127.0.0.1:${port}`,
    stop: () => child.kill("SIGTERM"),
    stderr: () => stderr,
  };
}

export function startHttpServer() {
  return startServer(example("http", "server.mjs"));
}

export function startWsServer() {
  const handle = startServer(example("ws", "server.mjs"));
  return {
    ...handle,
    wsUrl: handle.port.then((port) => `ws://127.0.0.1:${port}`),
  };
}

export function startGraphQLServer() {
  return startServer(example("graphql", "server.mjs"));
}

export function startMcpHttpServer() {
  return startServer(example("mcp", "server.mjs"), { MCP_TRANSPORT: "http" });
}

export function startGrpcServer() {
  const handle = startServer(example("grpc", "server.mjs"));
  return {
    ...handle,
    grpcAddress: handle.port.then((port) => `127.0.0.1:${port}`),
  };
}

export const stdioServerPath = example("mcp", "stdio-server.mjs");
export const echoProtoPath = example("grpc", "proto", "echo", "echo.proto");
export const echoProtoDir = example("grpc", "proto");
