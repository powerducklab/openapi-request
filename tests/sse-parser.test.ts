// Unit tests for the incremental SSE parser. No network required.
import { describe, expect, it } from "vitest";
import { SseParser } from "../src/protocols/http/sse-parser.js";

function chunk(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("SseParser", () => {
  it("parses a single complete event", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data: hello\n\n"));
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
    expect(events[0].direction).toBe("in");
    expect(typeof events[0].receivedAt).toBe("number");
  });

  it("parses the event field", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("event: tick\ndata: 1\n\n"));
    expect(events[0].event).toBe("tick");
    expect(events[0].data).toBe("1");
  });

  it("parses the id field", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("id: 42\ndata: x\n\n"));
    expect(events[0].id).toBe("42");
  });

  it("ignores ids containing a NULL character (spec requirement)", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("id: bad\u0000id\ndata: x\n\n"));
    expect(events[0].id).toBeUndefined();
  });

  it("parses the retry field as a positive integer", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("retry: 5000\ndata: x\n\n"));
    expect(events[0].retry).toBe(5000);
  });

  it("rejects non-ASCII-digit retry values like 1e3", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("retry: 1e3\ndata: x\n\n"));
    expect(events[0].retry).toBeUndefined();
  });

  it("joins multiple data lines with a newline", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data: line1\ndata: line2\n\n"));
    expect(events[0].data).toBe("line1\nline2");
  });

  it("strips a single leading space from field values", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data:  spaced\n\n"));
    expect(events[0].data).toBe(" spaced");
  });

  it("ignores comment lines (starting with colon)", () => {
    const parser = new SseParser();
    const events = parser.push(chunk(": this is a comment\ndata: real\n\n"));
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("returns no event for a block of only comments", () => {
    const parser = new SseParser();
    const events = parser.push(chunk(": heartbeat\n\n"));
    expect(events).toHaveLength(0);
  });

  it("parses JSON data into the parsed field", () => {
    const parser = new SseParser();
    const events = parser.push(chunk('data: {"key":"value"}\n\n'));
    expect(events[0].parsed).toEqual({ key: "value" });
  });

  it("does not parse bare numbers as JSON", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data: 42\n\n"));
    expect(events[0].parsed).toBeUndefined();
  });

  it("does not parse sentinel values like [DONE]", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data: [DONE]\n\n"));
    expect(events[0].parsed).toBeUndefined();
    expect(events[0].data).toBe("[DONE]");
  });

  it("handles events split across chunk boundaries", () => {
    const parser = new SseParser();
    const first = parser.push(chunk("data: hel"));
    expect(first).toHaveLength(0);
    const second = parser.push(chunk("lo\n\n"));
    expect(second).toHaveLength(1);
    expect(second[0].data).toBe("hello");
  });

  it("handles \\r\\n line endings", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data: crlf\r\n\r\n"));
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("crlf");
  });

  it("strips a leading BOM exactly once", () => {
    const parser = new SseParser();
    const bom = "\uFEFF";
    const events = parser.push(chunk(`${bom}data: after-bom\n\n`));
    expect(events[0].data).toBe("after-bom");
  });

  it("inherits the last event id when inheritEventId is true (default)", () => {
    const parser = new SseParser();
    parser.push(chunk("id: first\ndata: a\n\n"));
    const events = parser.push(chunk("data: b\n\n"));
    expect(events[0].id).toBe("first");
  });

  it("does not inherit id when inheritEventId is false", () => {
    const parser = new SseParser({ inheritEventId: false });
    parser.push(chunk("id: first\ndata: a\n\n"));
    const events = parser.push(chunk("data: b\n\n"));
    expect(events[0].id).toBeUndefined();
  });

  it("flushes a trailing partial event", () => {
    const parser = new SseParser();
    parser.push(chunk("data: partial"));
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("partial");
  });

  it("returns nothing from flush when the buffer is empty", () => {
    const parser = new SseParser();
    expect(parser.flush()).toHaveLength(0);
  });

  it("resets all internal state", () => {
    const parser = new SseParser();
    parser.push(chunk("id: kept\ndata: a\n\n"));
    parser.reset();
    const events = parser.push(chunk("data: fresh\n\n"));
    expect(events[0].id).toBeUndefined();
    expect(parser.count).toBe(1);
    expect(parser.truncated).toBe(false);
  });

  it("enforces maxEventChars on a single data field", () => {
    const parser = new SseParser({ maxEventChars: 10 });
    const long = "x".repeat(100);
    const events = parser.push(chunk(`data: ${long}\n\n`));
    expect(events[0].data.length).toBeLessThanOrEqual(10);
    expect(parser.truncated).toBe(true);
    expect(parser.droppedEvents).toBeGreaterThan(0);
  });

  it("enforces maxBufferChars when no boundary arrives", () => {
    const parser = new SseParser({ maxBufferChars: 50 });
    const huge = "data: " + "y".repeat(200);
    parser.push(chunk(huge));
    expect(parser.truncated).toBe(true);
    // The buffer should have been trimmed to a short tail.
    const events = parser.flush();
    // Whatever survived is at most the tail + boundary.
    for (const e of events) {
      expect(e.data.length).toBeLessThanOrEqual(200);
    }
  });

  it("accepts Uint8Array input", () => {
    const parser = new SseParser();
    const events = parser.push(new TextEncoder().encode("data: u8\n\n"));
    expect(events[0].data).toBe("u8");
  });

  it("accepts string input", () => {
    const parser = new SseParser();
    const events = parser.push("data: str\n\n");
    expect(events[0].data).toBe("str");
  });

  it("returns [] for null/undefined input", () => {
    const parser = new SseParser();
    expect(parser.push(null as any)).toEqual([]);
    expect(parser.push(undefined as any)).toEqual([]);
  });

  it("counts emitted events", () => {
    const parser = new SseParser();
    parser.push(chunk("data: 1\n\ndata: 2\n\ndata: 3\n\n"));
    expect(parser.count).toBe(3);
  });

  it("treats a field with no colon as the field name with empty value", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("data\n\n"));
    expect(events[0].data).toBe("");
  });

  it("ignores unknown fields", () => {
    const parser = new SseParser();
    const events = parser.push(chunk("custom: value\ndata: ok\n\n"));
    expect(events[0].data).toBe("ok");
  });
});
