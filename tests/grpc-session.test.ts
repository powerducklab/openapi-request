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

it("half-closes a bidi request without dropping the final inbound reply", async () => {
  const session = makeSession("Chat");
  await session.open();
  try {
    await session.send({from:"client",text:"last-message"});
    await session.finishSending();
    expect(session.events.some(e=>e.direction === "in" && JSON.stringify(e.data).includes("last-message"))).toBe(true);
    await expect(session.send({text:"late"})).rejects.toThrow(/finished/);
  } finally { await session.close(); }
}, 15000);

describe("gRPC four-mode interaction contract", () => {
  it("unary: one request yields one response and the call ends by itself", async () => {
    const session = makeSession("Say");
    await session.open();
    await session.send({ text: "once" });
    expect(session.state).toBe("closed");

    const inbound = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(inbound.length).toBe(1);
    await expect(session.send({ text: "again" })).rejects.toThrow(/not open/);
  }, 15_000);

  it("server streaming: accepts exactly one outbound request", async () => {
    const session = makeSession("Countdown");
    await session.open();
    // Long-lived stream so the first send is still in flight.
    const first = session.send({ from: 100, interval_ms: 40 }).catch(() => {});
    // The client must not be able to fire a second request.
    await expect(
      session.send({ from: 100, interval_ms: 40 }),
    ).rejects.toThrow(/one send|not open|finished/);
    await session.close().catch(() => {});
    await first;
  }, 15_000);

  it("server streaming: pushes multiple messages and can be cancelled early", async () => {
    const session = makeSession("Countdown");
    await session.open();
    const inFlight = session.send({ from: 100, interval_ms: 20 }).catch(() => {});

    // Wait until at least two ticks have been streamed in.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const count = session.events.filter(
          (e) => e.kind === "data" && e.direction === "in",
        ).length;
        if (count >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 15);
    });

    const atCancel = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    ).length;
    await session.close().catch(() => {});
    await inFlight;
    expect(["closed", "error"]).toContain(session.state);

    // After cancellation no further ticks may be appended.
    await new Promise((r) => setTimeout(r, 120));
    const afterCancel = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    ).length;
    expect(afterCancel).toBe(atCancel);
  }, 15_000);

  it("client streaming: repeated sends then finishSending() returns one aggregated result", async () => {
    const session = makeSession("Sum");
    await session.open();
    expect(session.kind).toBe("client_streaming");

    await session.send({ value: 5 });
    await session.send({ value: 15 });
    await session.send({ value: 25 });
    await session.finishSending();

    expect(session.state).toBe("closed");
    const replies = session.events.filter(
      (e) => e.kind === "data" && e.direction === "in",
    );
    expect(replies.length).toBe(1);
    expect((replies[0].data as any).total).toBe(45);
    expect((replies[0].data as any).count).toBe(3);
    await expect(session.send({ value: 1 })).rejects.toThrow(/not open|finished/);
  }, 15_000);

  it("bidi: interleaves many outbound messages with inbound pushes until finish", async () => {
    const session = makeSession("Chat");
    await session.open();
    try {
      for (const word of ["a", "b", "c"]) {
        await session.send({ from: "client", text: word });
        await new Promise((r) => setTimeout(r, 60));
      }
      const echoes = session.events.filter(
        (e) => e.kind === "data" && e.direction === "in",
      );
      // welcome + one echo per outbound message.
      expect(echoes.length).toBeGreaterThanOrEqual(4);
      await session.finishSending();
      expect(session.state).toBe("closed");
    } finally {
      await session.close().catch(() => {});
    }
  }, 15_000);

  it("streaming methods ignore the unary deadlineMs and stay open", async () => {
    const session = createGrpcManualSession({
      address,
      reflection: true,
      service: "demo.echo.Echo",
      method: "Chat",
      // A unary-sized deadline would otherwise kill the interactive stream.
      deadlineMs: 200,
    });
    await session.open();
    try {
      await new Promise((r) => setTimeout(r, 600));
      expect(session.state).toBe("open");
      await session.send({ from: "client", text: "still-alive" });
      await new Promise((r) => setTimeout(r, 150));
      expect(session.state).toBe("open");
      expect(
        session.events.some(
          (e) =>
            e.direction === "in" &&
            JSON.stringify(e.data).includes("still-alive"),
        ),
      ).toBe(true);
    } finally {
      await session.close().catch(() => {});
    }
  }, 15_000);

  it("honors an explicit streamDeadlineMs for a streaming method", async () => {
    const session = createGrpcManualSession({
      address,
      reflection: true,
      service: "demo.echo.Echo",
      method: "Chat",
      streamDeadlineMs: 250,
    });
    await session.open();
    // grpc-js arms the client deadline once the call transmits; send one frame.
    await session
      .send({ from: "client", text: "tick" })
      .catch(() => {});
    // Poll until the deadline terminates the stream (fail after 4 s).
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (session.state === "error") {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 4000) {
          clearInterval(timer);
          reject(new Error("stream deadline was not enforced"));
        }
      }, 20);
    });
    expect(session.state).toBe("error");
    const deadlineStatus = session.events.find(
      (e) => e.kind === "status" && e.meta?.code === 4,
    );
    expect(deadlineStatus?.meta?.statusName).toBe("DEADLINE_EXCEEDED");
    await session.close().catch(() => {});
  }, 15_000);
});
