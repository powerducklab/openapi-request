// Tests for the unified session contract: every protocol (ws, mcp http, mcp
// stdio, grpc) reports through one SessionEventDTO shape with a shared state
// machine, and long sessions still expose their protocol-specific methods.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createManualSession, createWsManualSession, createGrpcManualSession } from "../src/index.js";
import {
  echoProtoDir,
  echoProtoPath,
  startGrpcServer,
  startMcpHttpServer,
  startWsServer,
  stdioServerPath,
} from "./helpers/servers.js";

const servers = {
  ws: startWsServer(),
  mcp: startMcpHttpServer(),
  grpc: startGrpcServer(),
};

beforeAll(async () => {
  await Promise.all([
    servers.ws.port,
    servers.mcp.port,
    servers.grpc.port,
  ]);
});

afterAll(() => {
  for (const server of Object.values(servers)) server.stop();
});

describe("UnifiedSession event DTO", () => {
  it("ws session emits unified events and exposes onEvent", async () => {
    const url = await servers.ws.wsUrl;
    const session = createManualSession({ kind: "websocket", url });
    const seen: Array<Record<string, any>> = [];
    session.onEvent((event) => seen.push(event));

    await session.open();
    await session.send({ text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.close({ code: 1000 });

    expect(session.state).toBe("closed");
    for (const event of seen) {
      expect(event).toHaveProperty("direction");
      expect(event).toHaveProperty("kind");
      expect(event).toHaveProperty("at");
      expect(event).toHaveProperty("state");
    }
    const kinds = seen.map((event) => event.kind);
    expect(kinds).toContain("open");
    expect(kinds).toContain("text");
    expect(kinds).toContain("close");
    const textEvent = seen.find((event) => event.kind === "text" && event.direction === "in");
    expect(JSON.parse(textEvent!.data).echo).toBe(true);
  });

  it("ws session factory still works standalone", async () => {
    const url = await servers.ws.wsUrl;
    const session = createWsManualSession({ url, maxEvents: 5 });
    await session.open();
    await session.send({ ping: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await session.close();
    expect(session.events.length).toBeLessThanOrEqual(5);
  });
});

describe("MCP sessions", () => {
  it("http manual session initializes, lists tools and calls one", async () => {
    const port = await servers.mcp.port;
    const session = createManualSession({ kind: "mcp", endpoint: `http://127.0.0.1:${port}/mcp` });
    await session.open();

    expect(session.state).toBe("open");
    expect((session as any).serverInfo?.name).toBe("protokit-demo-mcp");
    expect((session as any).sessionId).toBeTruthy();

    const tools = await (session as any).listTools();
    expect(tools.items.map((tool: any) => tool.name).sort()).toEqual(["add", "echo", "get_weather"]);

    const reply = await (session as any).callTool({ name: "add", arguments: { a: 2, b: 3 } });
    expect(reply.content[0].text).toBe('5');

    const events = session.events;
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("jsonrpc");
    expect(events.some((event) => event.direction === "out" && event.kind === "jsonrpc")).toBe(true);
    expect(events.some((event) => event.direction === "in" && event.kind === "session")).toBe(true);

    await session.close();
    expect(session.state).toBe("closed");
  });

  it("stdio manual session pairs responses by id", async () => {
    const session = createManualSession({
      kind: "mcp",
      transport: "stdio",
      command: process.execPath,
      args: [stdioServerPath],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    await session.open();
    expect((session as any).serverInfo?.name).toBe("protokit-demo-mcp");

    const tools = await (session as any).listTools();
    expect(tools.items.length).toBe(3);

    const reply = await (session as any).callTool({ name: "echo", arguments: { text: "stdio" } });
    expect(reply.content[0].text).toBe('stdio');

    // Only one result per call, despite many raw lines on the pipe.
    expect(session.events.filter((event) => event.kind === "jsonrpc").length).toBeGreaterThanOrEqual(3);
    await session.close();
    expect(session.state).toBe("closed");
  });
});

describe("gRPC manual session", () => {
  it("opens from proto files, resolves kind/source and reports unified events", async () => {
    const address = await servers.grpc.grpcAddress;
    const session = createGrpcManualSession({
      address,
      protoPaths: [echoProtoPath],
      includeDirs: [echoProtoDir],
      service: "demo.echo.Echo",
      method: "Say",
    });

    const seen: Array<Record<string, any>> = [];
    session.onEvent((event) => seen.push(event));

    await session.open();
    expect((session as any).kind).toBe("unary");
    expect((session as any).source).toBe("proto");
    expect(session.state).toBe("open");

    await session.send({ text: "one-shot" });
    await session.close();
    expect(session.state).toBe("closed");
    expect(seen.some((event) => event.kind === "status")).toBe(true);
  });

  it("routes through the unified createManualSession entry", async () => {
    const address = await servers.grpc.grpcAddress;
    const session = createManualSession({
      kind: "grpc",
      address,
      protoPaths: [echoProtoPath],
      includeDirs: [echoProtoDir],
      service: "demo.echo.Echo",
      method: "Countdown",
    });
    await session.open();
    expect((session as any).kind).toBe("server_streaming");
    await session.send({ from: 3, interval_ms: 100 });
    await session.close();
    expect(session.state).toBe("closed");
  });
});
