// Error-path and boundary tests. Uses inline node:http servers to simulate
// failures that the fixture servers do not cover: oversized responses,
// WebSocket handshake rejection, MCP timeouts, and abort signals.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createClient } from "../src/index.js";
import { startHttpServer, startWsServer } from "./helpers/servers.js";

function startInlineServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const server = http.createServer(handler);
  const port = 30000 + Math.floor(Math.random() * 20000);
  return new Promise<{ port: number; url: string; stop: () => void }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        stop: () => server.close(),
      });
    });
  });
}

const fixtureHttp = startHttpServer();
const fixtureWs = startWsServer();

beforeAll(async () => {
  await Promise.all([fixtureHttp.port, fixtureWs.port]);
});

afterAll(() => {
  fixtureHttp.stop();
  fixtureWs.stop();
});

describe("HTTP maxResponseSize", () => {
  it("truncates a response body that exceeds maxResponseSize", async () => {
    const server = await startInlineServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Write 1 MB of 'a' characters.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let i = 0; i < 16; i++) res.write(chunk);
      res.end();
    });

    try {
      const client = createClient();
      const spec = {
        openapi: "3.2.0",
        info: { title: "size", version: "1.0.0" },
        servers: [{ url: server.url }],
        paths: {
          "/big": {
            get: {
              operationId: "big",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      };
      const result = await client.send({
        spec,
        target: { path: "/big", method: "get" },
        runner: { requester: { maxResponseSize: 100 * 1024 } },
      });
      // The run should complete without throwing. When maxResponseSize is
      // hit the socket is destroyed, so status may be 0; the key assertion
      // is that sizeBytes stays within the cap (plus one in-flight chunk).
      expect(result.response.sizeBytes).toBeLessThanOrEqual(100 * 1024 + 64 * 1024);
    } finally {
      server.stop();
    }
  });

  it("rejects maxResponseSize of 0 as invalid", async () => {
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: {
        "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } },
      },
    };
    await expect(
      client.send({
        spec,
        target: { path: "/x", method: "get" },
        runner: { requester: { maxResponseSize: 0 } },
      }),
    ).rejects.toThrow(/maxResponseSize|BAD_RUN_OPTIONS|must be greater/);
  });
});

describe("HTTP abort signal", () => {
  it("cancels an in-flight SSE stream via AbortSignal", async () => {
    const port = await fixtureHttp.port;
    const client = createClient();
    const controller = new AbortController();
    const spec = {
      openapi: "3.2.0",
      info: { title: "sse", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        "/sse": {
          get: {
            operationId: "sse",
            responses: { "200": { description: "ok", content: { "text/event-stream": {} } } },
          },
        },
      },
    };

    let eventCount = 0;
    const sendPromise = client.send({
      spec,
      target: { path: "/sse", method: "get" },
      signal: controller.signal,
      onEvent: () => {
        eventCount += 1;
        if (eventCount >= 2) controller.abort();
      },
    });

    const result = await sendPromise;
    // After abort, the result should reflect a stopped stream.
    expect(result.response.stopReason).toBeDefined();
    expect(eventCount).toBeGreaterThanOrEqual(2);
  });
});

describe("WebSocket handshake failure", () => {
  it("reports error state when the server refuses the upgrade", async () => {
    // An HTTP server that never upgrades -> WS handshake fails.
    const server = await startInlineServer((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("no websocket here");
    });

    try {
      const session = createClient().connect({
        kind: "websocket",
        url: `ws://127.0.0.1:${server.port}`,
      });
      await expect(session.open()).rejects.toThrow();
      expect(session.state).toBe("error");
    } finally {
      server.stop();
    }
  });

  it("reports error state for an unreachable WebSocket endpoint", async () => {
    const session = createClient().connect({
      kind: "websocket",
      url: "ws://127.0.0.1:1/nonexistent",
    });
    await expect(session.open()).rejects.toThrow();
    expect(session.state).toBe("error");
  });

  it("send() rejects when not open", async () => {
    const session = createClient().connect({
      kind: "websocket",
      url: "ws://127.0.0.1:1/nonexistent",
    });
    await expect(session.send({ hello: "world" })).rejects.toThrow(/not open|not connected/i);
  });
});

describe("MCP error paths", () => {
  it("rejects an invalid MCP endpoint URL", () => {
    const client = createClient();
    expect(() =>
      client.connect({ kind: "mcp", transport: "streamable-http", endpoint: "ftp://bad" }),
    ).toThrow(/endpoint|http/);
  });

  it("rejects stdio transport without a command", () => {
    const client = createClient();
    expect(() => client.connect({ kind: "mcp", transport: "stdio" })).toThrow(
      /command/,
    );
  });

  it("times out when the MCP server does not respond", async () => {
    // A server that accepts the connection but never responds -> initialize timeout.
    const server = await startInlineServer((_req, res) => {
      // Never write, never end.
    });

    try {
      const session = createClient().connect({
        kind: "mcp",
        transport: "streamable-http",
        endpoint: `http://127.0.0.1:${server.port}/mcp`,
        timeoutMs: 1500,
      });
      await expect(session.open()).rejects.toThrow(/MCP_TIMEOUT|timed out/);
    } finally {
      server.stop();
    }
  });

  it("returns MCP_RPC_ERROR when the server returns a JSON-RPC error", async () => {
    const server = await startInlineServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
      });
    });

    try {
      const session = createClient().connect({
        kind: "mcp",
        transport: "streamable-http",
        endpoint: `http://127.0.0.1:${server.port}/mcp`,
        timeoutMs: 5000,
      });
      // open() will fail because the server returns an error for initialize.
      await expect(session.open()).rejects.toThrow(/MCP_RPC_ERROR|Method not found/);
    } finally {
      server.stop();
    }
  });
});

describe("HTTP non-200 responses", () => {
  it("surfaces a 404 response without throwing", async () => {
    const port = await fixtureHttp.port;
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      paths: {
        "/missing": {
          get: { operationId: "missing", responses: { "404": { description: "not found" } } },
        },
      },
    };
    const result = await client.send({
      spec,
      target: { path: "/missing", method: "get" },
    });
    expect(result.response.status).toBe(404);
    expect(result.error).toBeUndefined();
  });

  it("surfaces a 500 response without throwing", async () => {
    const server = await startInlineServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
    try {
      const client = createClient();
      const spec = {
        openapi: "3.2.0",
        info: { title: "t", version: "1" },
        servers: [{ url: server.url }],
        paths: {
          "/err": { get: { operationId: "err", responses: { "500": { description: "err" } } } },
        },
      };
      const result = await client.send({ spec, target: { path: "/err", method: "get" } });
      expect(result.response.status).toBe(500);
      expect(result.error).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});

describe("Input validation", () => {
  it("rejects a spec without paths", async () => {
    const client = createClient();
    const spec = { openapi: "3.2.0", info: { title: "t", version: "1" }, paths: {} };
    await expect(
      client.send({ spec, target: { path: "/x", method: "get" } }),
    ).rejects.toThrow();
  });

  it("rejects an invalid protocolVersion", async () => {
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } } },
    };
    await expect(
      client.send({
        spec,
        target: { path: "/x", method: "get" },
        runner: { requester: { protocolVersion: "ftp" as any } },
      }),
    ).rejects.toThrow(/protocolVersion|BAD_RUN_OPTIONS/);
  });

  it("rejects a negative maxRedirects", async () => {
    const client = createClient();
    const spec = {
      openapi: "3.2.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } } },
    };
    await expect(
      client.send({
        spec,
        target: { path: "/x", method: "get" },
        runner: { requester: { maxRedirects: -1 } },
      }),
    ).rejects.toThrow(/maxRedirects|BAD_RUN_OPTIONS/);
  });
});
