// Tests for the HTTP streaming detectors: static inference from the OpenAPI
// document and live classification from response headers.
import { describe, expect, it } from "vitest";
import {
  acceptHeaderFor,
  isStreamingContentType,
  isStreamingOperation,
  isSseContentType,
} from "../src/index.js";

describe("detect", () => {
  it("classifies content types", () => {
    expect(isSseContentType("text/event-stream; charset=utf-8")).toBe(true);
    expect(isSseContentType("application/json")).toBe(false);
    expect(isStreamingContentType("application/x-ndjson")).toBe(true);
    expect(isStreamingContentType("application/jsonl")).toBe(true);
    expect(isStreamingContentType("application/json")).toBe(false);
  });

  it("infers streaming from responses content-type", () => {
    const operation = {
      responses: {
        "200": { content: { "text/event-stream": { schema: {} } } },
      },
    };
    expect(isStreamingOperation(operation)).toBe(true);
  });

  it("infers streaming from declared x-protocol", () => {
    expect(isStreamingOperation({ "x-protocol": "sse" })).toBe(true);
    expect(isStreamingOperation({ "x-protocol": "eventsource" })).toBe(true);
    expect(isStreamingOperation({ "x-protocol": "http" })).toBe(false);
  });

  it("acceptHeaderFor ranks stream types first and caps the list", () => {
    const header = acceptHeaderFor({
      responses: {
        "200": {
          content: {
            "application/json": {},
            "text/event-stream": {},
            "application/x-ndjson": {},
          },
        },
        "404": { content: { "text/plain": {} } },
      },
    });
    expect(header!.startsWith("text/event-stream")).toBe(true);
    expect(header).not.toContain("text/plain");
  });
});
