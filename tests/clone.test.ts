// Tests for toCloneable: every value that can appear in a SessionEventDTO is
// normalized into plain JSON-safe data, including cycles and typed values.
import { describe, expect, it } from "vitest";
import { toCloneable } from "../src/index.js";

describe("toCloneable", () => {
  it("passes through plain JSON data", () => {
    expect(toCloneable({ a: 1, b: ["x", null, true] })).toEqual({ a: 1, b: ["x", null, true] });
  });

  it("converts Date to ISO strings", () => {
    const at = new Date("2026-09-08T00:00:00.000Z");
    expect(toCloneable({ at })).toEqual({ at: "2026-09-08T00:00:00.000Z" });
  });

  it("converts URL to its string form", () => {
    expect(toCloneable(new URL("https://example.com/a?b=1"))).toBe("https://example.com/a?b=1");
  });

  it("converts Error to a plain shape with name/message/stack", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at fixture";
    const clone = toCloneable(error);
    expect(clone).toMatchObject({ name: "Error", message: "boom", stack: "Error: boom\n    at fixture" });
  });

  it("converts Buffer/Uint8Array to { type, data }", () => {
    const buffer = Buffer.from([1, 2, 3]);
    expect(toCloneable(buffer)).toEqual({ type: "Buffer", data: [1, 2, 3] });
  });

  it("handles circular references without recursing forever", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const clone = toCloneable(node) as { name: string; self: unknown };
    expect(clone.name).toBe("root");
    // The cycle is preserved as a reference (structured-clone safe), which is
    // exactly why it must not be JSON.stringify-ed.
    expect(clone.self).toBe(clone);
  });

  it("stringifies functions, symbols and bigints instead of dropping them", () => {
    const clone = toCloneable({ fn: () => 1, sym: Symbol("s"), big: 9007199254740993n }) as Record<string, string>;
    expect(typeof clone.fn).toBe("string");
    expect(clone.sym).toContain("s");
    expect(clone.big).toBe("9007199254740993");
  });

  it("maps undefined to null", () => {
    expect(toCloneable(undefined)).toBeNull();
  });
});
