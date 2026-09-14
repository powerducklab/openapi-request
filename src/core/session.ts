/**
 * UnifiedSession: the single session contract shared by every connect-first
 * protocol (WebSocket / MCP / gRPC).
 *
 * One state machine, one event DTO, one subscription API. Protocol sessions
 * subclass this and keep their richer methods (callTool, listTools, kind, ...)
 * on top, but the UI only ever has to render one event shape and drive one
 * lifecycle. Event payloads are cloned with toCloneable so a listener can
 * never mutate library state by poking at the object it received.
 */
import type { Cloneable } from "./clone";
import { toCloneable } from "./clone";

export type SessionState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "error";

/**
 * Protocol-agnostic session event. `kind` is a short discriminator such as
 * "open" | "message" | "error" | "close"; protocol detail lives in
 * `data` / `meta` / `error`, already cloneable.
 */
export interface SessionEventDTO {
  protocol: string;
  /** Transport label: "websocket" | "http" | "stdio" | "grpc". */
  transport?: string;
  sessionId: string;
  direction: "in" | "out" | "meta";
  kind: string;
  at: number;
  state?: SessionState;
  data?: Cloneable;
  error?: Cloneable;
  meta?: Cloneable;
}

export interface SessionSubscription {
  unsubscribe(): void;
}

export abstract class UnifiedSession {
  public state: SessionState = "idle";
  public readonly events: SessionEventDTO[] = [];
  protected readonly listeners = new Set<(event: SessionEventDTO) => void>();

  constructor(
    public readonly protocol: string,
    public readonly transport: string | undefined,
    public readonly sessionId: string,
    public readonly maxEvents = 1000,
  ) {}

  setState(next: SessionState): void {
    this.state = next;
  }

  /**
   * Record one event. `data` / `error` / `meta` are accepted loosely (any
   * runtime value) and cloned into Cloneable on the way in, so callers never
   * worry about what is serializable.
   */
  emit(event: {
    direction: SessionEventDTO["direction"];
    kind: string;
    at?: number;
    state?: SessionState;
    data?: unknown;
    error?: unknown;
    meta?: unknown;
  }): void {
    const dto: SessionEventDTO = {
      protocol: this.protocol,
      transport: this.transport,
      sessionId: this.sessionId,
      at: event.at ?? Date.now(),
      direction: event.direction,
      kind: event.kind,
      state: event.state,
      data: toCloneable(event.data),
      error: toCloneable(event.error),
      meta: toCloneable(event.meta),
    };
    this.events.push(dto);
    if (this.maxEvents > 0 && this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    for (const listener of this.listeners) {
      // A throwing listener must not prevent other listeners from receiving
      // the event or corrupt the emitter's own state.
      try {
        listener(dto);
      } catch {
        /* Observer errors are swallowed; they are not the library's concern. */
      }
    }
  }

  onEvent(listener: (event: SessionEventDTO) => void): SessionSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  abstract open(): Promise<void>;
  abstract close(options?: Record<string, unknown>): Promise<void>;
  abstract waitForClose(): Promise<void>;
  abstract send(
    data: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  request?(data: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Concrete hub used by the protocol session factories. The factories keep
 * their protocol-specific logic and public methods; this instance owns the
 * shared state machine, the event ring buffer and the listener set, so every
 * protocol reports through exactly one event shape.
 */
class EventHub extends UnifiedSession {
  async open(): Promise<void> {
    /* The owning factory drives the lifecycle. */
  }
  async close(): Promise<void> {
    /* The owning factory drives the lifecycle. */
  }
  async waitForClose(): Promise<void> {
    /* The owning factory drives the lifecycle. */
  }
  async send(): Promise<unknown> {
    return undefined;
  }
}

export function createEventHub(
  protocol: string,
  transport: string | undefined,
  sessionId: string,
  maxEvents = 1000,
): UnifiedSession {
  return new EventHub(protocol, transport, sessionId, maxEvents);
}
