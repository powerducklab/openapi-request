// Integration tests for WebSocket manual session lifecycle and messaging.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWsManualSession } from "../src/protocols/ws/session.js";
import { startWsServer } from "./helpers/servers.js";

const server = startWsServer();
let wsUrl = "";

beforeAll(async () => {
  wsUrl = await server.wsUrl;
}, 20_000);

afterAll(() => {
  server.stop();
});

describe("WebSocket manual session", () => {
  it("connects and records an open event", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();
    expect(session.state).toBe("open");

    const openEvents = session.events.filter((e) => e.kind === "open");
    expect(openEvents.length).toBeGreaterThan(0);
    expect(openEvents[0].state).toBe("open");

    await session.close();
  }, 10_000);

  it("sends and receives text messages", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();

    const received: string[] = [];
    session.onEvent((e) => {
      if (e.kind === "text" && e.direction === "in") {
        received.push(e.data as string);
      }
    });

    await session.send({ type: "echo", text: "hello" });

    // Give the server a moment to reply.
    await new Promise((r) => setTimeout(r, 500));

    expect(received.length).toBeGreaterThan(0);
    await session.close();
  }, 10_000);

  it("transitions to closed after close()", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();
    await session.close({ code: 1000, reason: "test done" });
    expect(session.state).toBe("closed");

    const closeEvents = session.events.filter((e) => e.kind === "close");
    expect(closeEvents.length).toBeGreaterThan(0);
  }, 10_000);

  it("rejects send when not open", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await expect(session.send("x")).rejects.toThrow(/not open/);
  });

  it("rejects open from a non-idle state", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();
    await expect(session.open()).rejects.toThrow(/cannot open/);
    await session.close();
  }, 10_000);

  it("records an upgrade event with status 101", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();

    const upgradeEvents = session.events.filter((e) => e.kind === "upgrade");
    expect(upgradeEvents.length).toBeGreaterThan(0);
    expect(upgradeEvents[0].meta?.statusCode).toBe(101);

    await session.close();
  }, 10_000);

  it("waitForClose resolves after close()", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();
    const waitPromise = session.waitForClose();
    await session.close();
    await waitPromise;
    expect(session.state).toBe("closed");
  }, 10_000);

  it("close() is idempotent", async () => {
    const session = createWsManualSession({ url: wsUrl });
    await session.open();
    await session.close();
    await session.close(); // should not throw
    expect(session.state).toBe("closed");
  }, 10_000);

  it("rejects connection to an invalid URL", async () => {
    const session = createWsManualSession({ url: "ws://127.0.0.1:1" });
    await expect(session.open()).rejects.toThrow();
    expect(session.state).toBe("error");
  }, 10_000);

  it("supports subprotocols", async () => {
    const session = createWsManualSession({
      url: wsUrl,
      subprotocols: ["chat"],
    });
    await session.open();
    expect(session.state).toBe("open");
    await session.close();
  }, 10_000);
});
