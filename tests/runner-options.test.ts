// Unit tests for HTTP runtime option composition and validation.
import { describe, expect, it } from "vitest";
import { buildRunOptions } from "../src/protocols/http/runner-options.js";

const baseSpec = {
  openapi: "3.2.0",
  info: { title: "t", version: "1" },
  servers: [{ url: "http://127.0.0.1:4100" }],
  paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "ok" } } } } },
};

function opts(overrides: Record<string, unknown> = {}) {
  return { spec: baseSpec, target: { path: "/x", method: "get" }, ...overrides } as any;
}

describe("buildRunOptions", () => {
  it("sets sensible defaults for a non-streaming request", () => {
    const result = buildRunOptions(opts(), { baseUrl: "http://127.0.0.1:4100", streaming: false });
    expect(result.timeout?.request).toBe(30_000);
    expect(result.timeout?.script).toBe(15_000);
    expect(result.iterationCount).toBe(1);
    expect(result.requester?.strictSSL).toBe(true);
    expect(result.requester?.followRedirects).toBe(true);
    expect(result.requester?.maxRedirects).toBe(10);
    expect(result.requester?.protocolVersion).toBe("http1");
    // encoding: null is critical for incremental SSE streaming.
    expect(result.requester?.encoding).toBeNull();
  });

  it("relaxes the global timeout for streaming requests", () => {
    const result = buildRunOptions(
      opts({ maxStreamMs: 60_000 }),
      { baseUrl: "http://127.0.0.1:4100", streaming: true },
    );
    expect(result.timeout?.global).toBeGreaterThan(60_000);
  });

  it("honours a caller-supplied timeout", () => {
    const result = buildRunOptions(opts({ timeout: 5000 }), {
      baseUrl: "http://127.0.0.1:4100",
      streaming: false,
    });
    expect(result.timeout?.request).toBe(5000);
  });

  it("caps absurd timeout values at 24 hours", () => {
    const result = buildRunOptions(opts({ timeout: 999_999_999 }), {
      baseUrl: "http://127.0.0.1:4100",
      streaming: false,
    });
    expect(result.timeout?.request).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("rejects maxResponseSize: 0 with BAD_RUN_OPTIONS", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { requester: { maxResponseSize: 0 } } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/maxResponseSize/);
  });

  it("rejects negative maxResponseSize", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { requester: { maxResponseSize: -5 } } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/maxResponseSize/);
  });

  it("accepts a positive maxResponseSize", () => {
    const result = buildRunOptions(
      opts({ runner: { requester: { maxResponseSize: 1024 } } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.requester?.maxResponseSize).toBe(1024);
  });

  it("rejects invalid protocolVersion", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { requester: { protocolVersion: "http3" } } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/protocolVersion/);
  });

  it("accepts protocolVersion http2", () => {
    const result = buildRunOptions(
      opts({ runner: { requester: { protocolVersion: "http2" } } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.requester?.protocolVersion).toBe("http2");
  });

  it("rejects negative maxRedirects", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { requester: { maxRedirects: -1 } } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/maxRedirects/);
  });

  it("rejects non-integer maxRedirects", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { requester: { maxRedirects: 1.5 } } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/maxRedirects/);
  });

  it("rejects iterationCount below 1", () => {
    expect(() =>
      buildRunOptions(
        opts({ runner: { iterationCount: 0 } }),
        { baseUrl: "http://x", streaming: false },
      ),
    ).toThrow(/iterationCount/);
  });

  it("merges caller-supplied runner options over defaults", () => {
    const result = buildRunOptions(
      opts({ runner: { requester: { strictSSL: false, followRedirects: false } } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.requester?.strictSSL).toBe(false);
    expect(result.requester?.followRedirects).toBe(false);
    // Untouched defaults remain.
    expect(result.requester?.maxRedirects).toBe(10);
  });

  it("builds a VariableScope from plain variables", () => {
    const result = buildRunOptions(
      opts({ variables: { token: "abc" } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.environment).toBeDefined();
  });

  it("does not overwrite a caller-supplied environment", () => {
    const customEnv = { values: [] };
    const result = buildRunOptions(
      opts({ runner: { environment: customEnv } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.environment).toBe(customEnv);
  });

  it("sets iterationCount from data length when not explicitly provided", () => {
    const result = buildRunOptions(
      opts({ runner: { data: [{ a: 1 }, { a: 2 }, { a: 3 }] } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.iterationCount).toBe(3);
  });

  it("keeps explicit iterationCount even when data is supplied", () => {
    const result = buildRunOptions(
      opts({ runner: { data: [{ a: 1 }], iterationCount: 5 } }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.iterationCount).toBe(5);
  });

  it("treats timeout 0 as unlimited (request and global consistent)", () => {
    const result = buildRunOptions(
      opts({ timeout: 0 }),
      { baseUrl: "http://x", streaming: false },
    );
    expect(result.timeout?.request).toBe(0);
    expect(result.timeout?.global).toBe(0);
  });

  it("throws when options are missing", () => {
    expect(() => buildRunOptions(null as any, { baseUrl: "x", streaming: false })).toThrow();
  });
});
