// Unit tests for the unified event hub: listener safety, ring buffer, state.
import { describe, expect, it } from "vitest";
import { createEventHub } from "../src/core/session.js";

describe("createEventHub", () => {
  it("delivers events to all listeners", () => {
    const hub = createEventHub("test", "test", "s1", 100);
    const received: string[] = [];
    hub.onEvent((e) => received.push(`a:${e.kind}`));
    hub.onEvent((e) => received.push(`b:${e.kind}`));
    hub.emit({ direction: "in", kind: "msg", at: 1 });
    expect(received).toEqual(["a:msg", "b:msg"]);
  });

  it("a throwing listener does not prevent other listeners from receiving events", () => {
    const hub = createEventHub("test", "test", "s2", 100);
    const received: string[] = [];
    hub.onEvent(() => {
      throw new Error("boom");
    });
    hub.onEvent((e) => received.push(e.kind));
    hub.emit({ direction: "in", kind: "survived", at: 1 });
    expect(received).toEqual(["survived"]);
  });

  it("unsubscribe stops delivery", () => {
    const hub = createEventHub("test", "test", "s3", 100);
    let count = 0;
    const sub = hub.onEvent(() => {
      count += 1;
    });
    hub.emit({ direction: "in", kind: "1", at: 1 });
    sub.unsubscribe();
    hub.emit({ direction: "in", kind: "2", at: 1 });
    expect(count).toBe(1);
  });

  it("enforces the ring buffer cap (maxEvents)", () => {
    const hub = createEventHub("test", "test", "s4", 5);
    for (let i = 0; i < 10; i++) {
      hub.emit({ direction: "in", kind: `e${i}`, at: i });
    }
    expect(hub.events).toHaveLength(5);
    expect(hub.events[0].kind).toBe("e5");
    expect(hub.events[4].kind).toBe("e9");
  });

  it("maxEvents=0 means unbounded", () => {
    const hub = createEventHub("test", "test", "s5", 0);
    for (let i = 0; i < 50; i++) {
      hub.emit({ direction: "in", kind: `e${i}`, at: i });
    }
    expect(hub.events).toHaveLength(50);
  });

  it("setState updates the state", () => {
    const hub = createEventHub("test", "test", "s6", 10);
    expect(hub.state).toBe("idle");
    hub.setState("open");
    expect(hub.state).toBe("open");
  });

  it("events carry the protocol, transport and sessionId", () => {
    const hub = createEventHub("grpc", "grpc", "session-xyz", 10);
    hub.emit({ direction: "in", kind: "data", at: 123, data: { x: 1 } });
    const e = hub.events[0];
    expect(e.protocol).toBe("grpc");
    expect(e.transport).toBe("grpc");
    expect(e.sessionId).toBe("session-xyz");
    expect(e.direction).toBe("in");
    expect(e.kind).toBe("data");
    expect(e.at).toBe(123);
  });

  it("clones event payloads so listeners cannot mutate library state", () => {
    const hub = createEventHub("test", "test", "s7", 10);
    const payload = { nested: { value: 1 } };
    hub.emit({ direction: "in", kind: "data", at: 1, data: payload });
    const received = hub.events[0].data as any;
    received.nested.value = 999;
    expect(payload.nested.value).toBe(1);
  });

  it("defaults at to Date.now() when not provided", () => {
    const hub = createEventHub("test", "test", "s8", 10);
    const before = Date.now();
    hub.emit({ direction: "in", kind: "data" });
    const after = Date.now();
    expect(hub.events[0].at).toBeGreaterThanOrEqual(before);
    expect(hub.events[0].at).toBeLessThanOrEqual(after);
  });
});
