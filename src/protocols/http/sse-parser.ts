import type { Json, StreamEvent } from "../../core/types";

/** Payloads that mark end-of-stream and should stay unparsed. */
const SENTINELS = new Set(["[DONE]", "DONE", "[done]", "done"]);

/** Event boundary per the WHATWG event stream grammar. */
const BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/** Only ASCII digits are a valid `retry` value; `Number()` would accept "1e3". */
const ASCII_DIGITS = /^\d+$/;

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENT = 1024 * 1024;

export interface SseParserOptions {
  /**
   * Maximum characters buffered while waiting for an event boundary. A peer that
   * never terminates an event would otherwise grow the buffer without bound.
   * Defaults to 4 Mi characters.
   */
  maxBufferChars?: number;
  /** Maximum characters retained in a single event's `data`. Defaults to 1 Mi. */
  maxEventChars?: number;
  /**
   * Attach the last seen `id` to events that omit one. Defaults to true.
   *
   * The specification uses the last event id only for the `Last-Event-ID`
   * header on reconnect, not as a property of subsequent events. Inheriting it
   * is convenient when debugging, but it makes `id` look universally present to
   * schema inference. Set to false for a spec-faithful stream.
   */
  inheritEventId?: boolean;
}

function positive(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Incremental Server-Sent Events parser following the WHATWG event stream rules.
 * postman-runtime usually hands over complete events, but chunk boundaries are
 * not guaranteed, so buffering is still required.
 *
 * The parser is deliberately defensive about size: the peer controls how much
 * data arrives before a boundary appears, so both the pending buffer and any
 * single event are capped instead of growing until the process runs out of memory.
 */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");
  private lastEventId: string | undefined;
  private bomChecked = false;
  private overflowed = false;
  private sequence = 0;

  private readonly maxBufferChars: number;
  private readonly maxEventChars: number;
  private readonly inheritEventId: boolean;

  /** Number of events or blocks discarded because a size cap was exceeded. */
  public droppedEvents = 0;

  constructor(options: SseParserOptions = {}) {
    this.maxBufferChars = positive(options.maxBufferChars, DEFAULT_MAX_BUFFER);
    this.maxEventChars = positive(options.maxEventChars, DEFAULT_MAX_EVENT);
    this.inheritEventId = options.inheritEventId !== false;
  }

  /** True once a size cap forced data to be discarded. */
  get truncated(): boolean {
    return this.overflowed;
  }

  /** Number of events emitted so far. */
  get count(): number {
    return this.sequence;
  }

  /** Feed a chunk and return every complete event it produced. */
  push(chunk: Buffer | Uint8Array | string): StreamEvent[] {
    if (chunk === null || chunk === undefined) return [];

    if (typeof chunk === "string") {
      this.buffer += chunk;
    } else {
      let view: Uint8Array;
      if (chunk instanceof Uint8Array) {
        view = chunk;
      } else {
        try {
          view = new Uint8Array(chunk as ArrayLike<number>);
        } catch {
          return [];
        }
      }
      try {
        this.buffer += this.decoder.decode(view, { stream: true });
      } catch {
        // A malformed byte sequence must not tear down the whole stream.
        return [];
      }
    }

    // A leading BOM is stripped exactly once, per the specification.
    if (!this.bomChecked && this.buffer.length) {
      this.bomChecked = true;
      if (this.buffer.charCodeAt(0) === 0xfeff)
        this.buffer = this.buffer.slice(1);
    }

    const events = this.drain();

    // Nothing parseable arrived and the buffer is over budget: the peer is
    // streaming an event that will never terminate. Drop what is pending and
    // resynchronize at the next boundary rather than accumulating forever.
    if (this.buffer.length > this.maxBufferChars) {
      this.overflowed = true;
      this.droppedEvents += 1;
      // Keep a short tail so a boundary split across this cut is still found.
      this.buffer = this.buffer.slice(-8);
    }

    return events;
  }

  /** Emit whatever remains once the stream has ended. */
  flush(): StreamEvent[] {
    try {
      this.buffer += this.decoder.decode();
    } catch {
      /* Decoder already flushed. */
    }

    const events = this.drain();
    const remainder = this.buffer;
    this.buffer = "";

    if (remainder.trim()) {
      const event = this.parseBlock(remainder);
      if (event) events.push(event);
    }
    return events;
  }

  reset(): void {
    this.buffer = "";
    this.lastEventId = undefined;
    this.bomChecked = false;
    this.overflowed = false;
    this.sequence = 0;
    this.droppedEvents = 0;
    // Drain any partial multi-byte sequence held by the decoder.
    try {
      this.decoder.decode();
    } catch {
      /* ignore */
    }
  }

  /** Consume every complete block currently in the buffer. */
  private drain(): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (;;) {
      const match = BOUNDARY.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.parseBlock(block);
      if (event) events.push(event);
    }
    return events;
  }

  private parseBlock(block: string): StreamEvent | null {
    const lines = block.split(/\r\n|\n|\r/);
    const dataLines: string[] = [];
    const event: StreamEvent = {
      data: "",
      receivedAt: Date.now(),
      direction: "in",
    };
    let sawField = false;
    let dataChars = 0;
    let dataTruncated = false;

    for (const line of lines) {
      if (line === "") continue;
      if (line.charCodeAt(0) === 0x3a) continue; // Comment or keep-alive heartbeat.

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20) value = value.slice(1);

      switch (field) {
        case "data": {
          sawField = true;
          if (dataTruncated) break;
          const budget = this.maxEventChars - dataChars;
          if (value.length > budget) {
            dataLines.push(value.slice(0, Math.max(0, budget)));
            dataTruncated = true;
            this.overflowed = true;
            this.droppedEvents += 1;
          } else {
            dataLines.push(value);
            dataChars += value.length + 1;
          }
          break;
        }
        case "event":
          event.event = value;
          sawField = true;
          break;
        case "id":
          // The specification requires ignoring ids containing a NULL character.
          if (!value.includes("\u0000")) {
            event.id = value;
            this.lastEventId = value;
          }
          sawField = true;
          break;
        case "retry": {
          // Reject "1e3", "+5", " 5" and similar; only ASCII digits are valid.
          if (ASCII_DIGITS.test(value) && value.length <= 15) {
            const retry = Number(value);
            if (Number.isSafeInteger(retry)) event.retry = retry;
          }
          sawField = true;
          break;
        }
        default:
          break; // Unknown fields are ignored.
      }
    }

    // A block of only comments carries no event, matching the specification.
    if (!sawField) return null;

    event.data = dataLines.join("\n");

    if (
      event.id === undefined &&
      this.inheritEventId &&
      this.lastEventId !== undefined
    ) {
      event.id = this.lastEventId;
    }

    // A truncated payload is no longer valid JSON, so parsing is skipped.
    if (!dataTruncated) {
      const trimmed = event.data.trim();
      if (trimmed && !SENTINELS.has(trimmed) && looksLikeJson(trimmed)) {
        try {
          event.parsed = JSON.parse(event.data) as Json;
        } catch {
          /* Plain-text payload, keep `data` only. */
        }
      }
    }

    this.sequence += 1;
    return event;
  }
}

/**
 * Cheap pre-check before JSON.parse.
 *
 * Without it, a bare token stream emits `data: 42` and `data: true`, which parse
 * into numbers and booleans and pollute the inferred item schema with a type
 * union. Only structured values and quoted strings are treated as JSON.
 */
function looksLikeJson(text: string): boolean {
  const first = text.charCodeAt(0);
  return (
    first === 0x7b || // {
    first === 0x5b || // [
    first === 0x22 //   "
  );
}
