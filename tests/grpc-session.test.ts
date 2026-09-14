// Integration tests for gRPC manual session state transitions.
// The critical regression: a successful unary call must transition the session
// to "closed" and emit a status event, so the UI can disable the Send button.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrpcManualSession } from "../src/protocols/grpc/session.js";
import { startGrpcServer, echoProtoDir } from "./helpers/servers.js";

const server = startGrpcServer();
let address = "";

beforeAll(async () => {
  address = await server.grpcAddress;
}, 20_000);

afterAll(() => {
  server.stop();
});

function makeSession(method: string) {
  return createGrpcManualSession({
    address,
    reflection: true,
    service: "demo.echo.Echo",
    method,
  });
}

describe("gRPC unary session state", () => {
  it("transitions to closed after a successful unary call (Say)", async () => {
    const session = makeSession("Say");
    await session.open();
    expect(session.state).toBe("open");

    const statusEvents: any[] = [];
    session.onEvent((e) => {
      if (e.kind === "status") statusEvents.push(e);
    });

    await session.send({ text: "hello" });

    // The session must be closed after a unary call completes.
    expect(session.state).toBe("closed");

    // A status event with code 0 must have been emitted.
    expect(statusEvents.length).toBeGreaterThan(0);
    const okStatus = statusEvents.find((e) => e.meta?.code === 0);
    expect(okStatus).toBeDefined();
    expect(okStatus.meta?.statusName).toBe("OK");

    // The status event must carry state="closed" (not stale "open").
    expect(okStatus.state).toBe("closed");
  }, 15_000);

  it("transitions to error after a failing unary call (Boom)", async () => {
    const session = makeSession("Boom");
    await session.open();
    expect(session.state).toBe("open");

    await expect(session.send({ text: "fail" })).rejects.toThrow();

    expect(session.state).toBe("error");
  }, 15_000);

  it("rejects a second send on a closed unary session", async () => {
    const session = makeSession("Say");
    await session.open();
    await session.send({ text: "first" });
    expect(session.state).toBe("closed");

    await expect(session.send({ text: "second" })).rejects.toThrow(/not open/);
  }, 15_000);

  it("records inbound data for a successful unary call", async () => {
    const session = makeSession("Say");
    await session.open();
    await session.send({ text: "ping" });

    const dataEvents = session.events.filter((e) => e.kind === "data" && e.direction === "in");
    expect(dataEvents.length).toBeGreaterThan(0);
    expect(dataEvents[0].data).toBeDefined();
  }, 15_000);
});

describe("gRPC server-streaming session state", () => {
  it("transitions to closed after the stream ends naturally", async () => {
    const session = makeSession("Countdown");
    await session.open();
    expect(session.state).toBe("open");

    await session.send({ from: 3, interval_ms: 50 });

    expect(session.state).toBe("closed");

    const dataEvents = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(dataEvents.length).toBeGreaterThanOrEqual(3);
  }, 15_000);
});

describe("gRPC client-streaming session state", () => {
  it("transitions to closed after Sum completes and waitForClose resolves", async () => {
    const session = makeSession("Sum");
    await session.open();
    expect(session.state).toBe("open");
    expect(session.kind).toBe("client_streaming");

    const closePromise = session.waitForClose();

    await session.send({ value: 10 });
    await session.send({ value: 20 });
    await session.send({ value: 30 });
    await session.close(); // Finish -> server sends SumReply

    await closePromise; // must not hang
    expect(session.state).toBe("closed");

    const reply = session.events.find(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(reply).toBeDefined();
    expect((reply?.data as any)?.total).toBe(60);
    expect((reply?.data as any)?.count).toBe(3);
  }, 15_000);

  it("rejects send after close on a client-streaming session", async () => {
    const session = makeSession("Sum");
    await session.open();
    await session.send({ value: 1 });
    await session.close();
    expect(session.state).toBe("closed");
    await expect(session.send({ value: 2 })).rejects.toThrow(/not open/);
  }, 15_000);
});

describe("gRPC bidi-streaming session state", () => {
  it("exchanges messages and closes cleanly", async () => {
    const session = makeSession("Chat");
    await session.open();
    expect(session.state).toBe("open");
    expect(session.kind).toBe("bidi_streaming");

    // Server sends "welcome" immediately.
    await new Promise((r) => setTimeout(r, 200));
    const welcome = session.events.find(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(welcome).toBeDefined();

    await session.send({ from: "client", text: "hello" });
    await new Promise((r) => setTimeout(r, 200));

    const replies = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(replies.length).toBeGreaterThanOrEqual(2);

    await session.close();
    expect(session.state).toBe("closed");
  }, 15_000);

  it("discards inbound messages after close is initiated", async () => {
    const session = makeSession("Chat");
    await session.open();
    await session.send({ from: "client", text: "before-close" });
    await new Promise((r) => setTimeout(r, 100));

    const countBeforeClose = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    ).length;

    await session.close();
    expect(session.state).toBe("closed");

    // No new inbound data events should appear after close.
    await new Promise((r) => setTimeout(r, 200));
    const countAfterClose = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    ).length;
    expect(countAfterClose).toBe(countBeforeClose);
  }, 15_000);
});

describe("gRPC session lifecycle", () => {
  it("rejects open() from a non-idle state", async () => {
    const session = makeSession("Say");
    await session.open();
    await expect(session.open()).rejects.toThrow(/cannot open/);
  }, 10_000);

  it("rejects send() when not open", async () => {
    const session = makeSession("Say");
    await expect(session.send({ text: "x" })).rejects.toThrow(/not open/);
  });

  it("close() on an idle session is a no-op that sets closed", async () => {
    const session = makeSession("Say");
    await session.close();
    expect(session.state).toBe("closed");
  });

  it("exposes the method kind after open", async () => {
    const session = makeSession("Say");
    await session.open();
    expect(session.kind).toBe("unary");
    expect(session.source).toBe("reflection");
  }, 10_000);

  it("waitForClose resolves after a unary call", async () => {
    const session = makeSession("Say");
    await session.open();
    const closePromise = session.waitForClose();
    await session.send({ text: "x" });
    await closePromise; // should resolve without hanging
    expect(session.state).toBe("closed");
  }, 10_000);
});
