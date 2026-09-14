// Tests for the unified client surface: prepare() decides the renderer and
// stream taxonomy BEFORE anything is sent, send() runs the full write-back
// pipeline, and writeback() merges the response back into the document.
import { describe, expect, it } from "vitest";
import { createClient, createDebugger } from "../src/index.js";

function specWith(operations: Record<string, any>) {
  return {
    openapi: "3.2.0",
    info: { title: "client-tests", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:4100" }],
    paths: Object.fromEntries(
      Object.entries(operations).map(([path, operation]) => [path, { post: operation }]),
    ),
  };
}

describe("createClient().prepare", () => {
  it("returns the expected surface", () => {
    const client = createClient();
    for (const key of ["prepare", "send", "sendMany", "connect", "discover", "writeback", "dispose", "probeStreamingResponse"]) {
      expect(typeof (client as any)[key]).toBe("function");
    }
  });

  it("infers plain JSON as response mode with no stream", () => {
    const prepared = createClient().prepare({
      spec: specWith({
        "/json": { operationId: "getJson", responses: { "200": { description: "ok", content: { "application/json": {} } } } },
      }),
      target: { path: "/json", method: "post" },
    });
    expect(prepared.protocol).toBe("http");
    expect(prepared.display.mode).toBe("response");
    expect(prepared.stream).toEqual({ kind: "none", expected: false });
  });

  it("infers SSE from the declared content type without any extension", () => {
    const prepared = createClient().prepare({
      spec: specWith({
        "/sse": { operationId: "getSse", responses: { "200": { description: "ok", content: { "text/event-stream": {} } } } },
      }),
      target: { path: "/sse", method: "post" },
    });
    expect(prepared.protocol).toBe("http");
    expect(prepared.display.mode).toBe("event-list");
    expect(prepared.stream).toEqual({ kind: "sse", expected: true });
  });

  it("maps websocket to duplex-session", () => {
    const prepared = createClient().prepare({
      spec: specWith({
        "/socket": { operationId: "ws", "x-protocol": "websocket", "x-ws": { url: "ws://127.0.0.1:4200" }, responses: { "200": { description: "duplex" } } },
      }),
      target: { path: "/socket", method: "post" },
    });
    expect(prepared.protocol).toBe("websocket");
    expect(prepared.display.mode).toBe("duplex-session");
    expect(prepared.stream.kind).toBe("websocket");
  });

  it("maps mcp http and mcp stdio to duplex-session with distinct stream kinds", () => {
    const httpPrepared = createClient().prepare({
      spec: specWith({
        "/mcp": { operationId: "mcpCall", "x-protocol": "mcp", "x-mcp": { endpoint: "http://127.0.0.1:4400", method: "tools/call" }, responses: { "200": { description: "ok" } } },
      }),
      target: { path: "/mcp", method: "post" },
    });
    expect(httpPrepared.display.mode).toBe("duplex-session");
    expect(httpPrepared.stream.kind).toBe("mcp-http-stream");
    expect(httpPrepared.openapi.extensions["x-session"]).toBe(true);

    const stdioPrepared = createClient().prepare({
      spec: specWith({
        "/mcp": { operationId: "mcpCall", "x-protocol": "mcp", "x-transport": "stdio", "x-mcp": { method: "tools/call" }, responses: { "200": { description: "ok" } } },
      }),
      target: { path: "/mcp", method: "post" },
    });
    expect(stdioPrepared.stream.kind).toBe("mcp-stdio");
  });

  it("maps all four gRPC modes onto stream kinds and renderers", () => {
    const modes = [
      ["unary", "grpc-unary", "response"],
      ["server_streaming", "grpc-server-stream", "event-list"],
      ["client_streaming", "grpc-client-stream", "duplex-session"],
      ["bidi_streaming", "grpc-bidi", "duplex-session"],
    ];
    void modes;
    for (const [mode, kind, display] of modes) {
      const prepared = createClient().prepare({
        spec: specWith({
          "/grpc": { operationId: "grpcCall", "x-protocol": "grpc", "x-grpc": { address: "127.0.0.1:4500", service: "echo.Echo", method: "M", kind: mode }, responses: { "200": { description: "ok" } } },
        }),
        target: { path: "/grpc", method: "post" },
      });
      expect(prepared.stream.kind, mode).toBe(kind);
      expect(prepared.display.mode, mode).toBe(display);
    }
  });

  it("exposes the seven OpenAPI extension keys", () => {
    const prepared = createClient().prepare({
      spec: specWith({
        "/sse": { operationId: "getSse", responses: { "200": { description: "ok", content: { "text/event-stream": {} } } } },
      }),
      target: { path: "/sse", method: "post" },
    });
    for (const key of ["x-protocol", "x-transport", "x-session", "x-discovery", "x-message-schema", "x-response-stream", "x-writeback"]) {
      expect(prepared.openapi.extensions, key).toHaveProperty(key);
    }
  });
});

describe("compatibility", () => {
  it("createDebugger stays available with its scripted surface", () => {
    const debuggerClient = createDebugger();
    expect(typeof debuggerClient.send).toBe("function");
    expect(typeof debuggerClient.sendMany).toBe("function");
    expect(typeof debuggerClient.toCollection).toBe("function");
    expect(typeof debuggerClient.registry).toBe("object");
  });
});
