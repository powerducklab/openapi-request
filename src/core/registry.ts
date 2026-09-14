import type { ProtocolAdapter, AdapterContext } from "./protocol";
import { err } from "./errors";

interface RegistryEntry {
  adapter: ProtocolAdapter<any>;
  /** Stable insertion order, preserved across re-registration of the same name. */
  seq: number;
}

export class AdapterRegistry {
  private readonly entries: RegistryEntry[] = [];
  private nextSeq = 0;

  register(adapter: ProtocolAdapter<any>): this {
    if (!adapter || typeof adapter !== "object") {
      throw err("BAD_ADAPTER", "Adapter must be an object");
    }
    if (typeof adapter.name !== "string" || !adapter.name.trim()) {
      throw err("BAD_ADAPTER", "Adapter must expose a non-empty `name`");
    }
    for (const method of ["supports", "plan", "execute"] as const) {
      if (typeof adapter[method] !== "function") {
        throw err(
          "BAD_ADAPTER",
          `Adapter "${adapter.name}" must implement ${method}()`,
        );
      }
    }

    // Re-registering the same name replaces the implementation but keeps the
    // original priority slot, so tie-breaking stays deterministic.
    const index = this.entries.findIndex(
      (e) => e.adapter.name === adapter.name,
    );
    if (index >= 0) {
      this.entries[index] = { adapter, seq: this.entries[index].seq };
    } else {
      this.entries.push({ adapter, seq: this.nextSeq++ });
    }
    return this;
  }

  unregister(name: string): boolean {
    const index = this.entries.findIndex((e) => e.adapter.name === name);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    return true;
  }

  get(name: string): ProtocolAdapter<any> | undefined {
    return this.entries.find((e) => e.adapter.name === name)?.adapter;
  }

  list(): string[] {
    return this.entries.map((e) => e.adapter.name);
  }

  /** Ranked candidates, best first. Useful for diagnostics. */
  rank(ctx: AdapterContext): Array<{ name: string; score: number }> {
    return this.entries
      .map((entry) => ({ entry, score: this.scoreOf(entry.adapter, ctx) }))
      .filter((r) => r.score > 0)
      .sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.entry.seq - b.entry.seq,
      )
      .map((r) => ({ name: r.entry.adapter.name, score: r.score }));
  }

  resolve(ctx: AdapterContext): ProtocolAdapter<any> {
    if (!ctx || !ctx.located) {
      throw err(
        "BAD_ADAPTER_CONTEXT",
        "resolve() requires a located operation",
      );
    }

    let best: RegistryEntry | undefined;
    let bestScore = 0;

    for (const entry of this.entries) {
      const score = this.scoreOf(entry.adapter, ctx);
      if (score <= 0) continue;
      // Strictly greater keeps the earliest-registered adapter on ties.
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }

    if (!best) {
      const method = String(ctx.located.method ?? "").toUpperCase();
      const path = String(ctx.located.path ?? "");
      throw err(
        "NO_ADAPTER",
        `No protocol adapter matched operation "${method} ${path}"`,
        { registered: this.list() },
      );
    }
    return best.adapter;
  }

  /** Coerce a score into a usable finite number; any fault means "unsupported". */
  private scoreOf(adapter: ProtocolAdapter<any>, ctx: AdapterContext): number {
    let raw: unknown;
    try {
      raw = adapter.supports(ctx);
    } catch {
      return 0; // A throwing adapter simply opts out.
    }
    const score = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(score) || score <= 0) return 0;
    return score;
  }
}
