import type { EventStore, AppendOpts } from "./eventStore.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";
import { ConcurrencyError } from "./errors.js";

/**
 * In-memory event store — hermetic, deterministic, used by the test suite and the
 * eval/demo runner. Same semantics as PostgresEventStore (append-only, idempotent,
 * zero-copy enforced) without requiring a running database.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byObligation = new Map<ObligationId, ObligationEvent[]>();
  private readonly keys = new Set<string>();

  async append(events: ObligationEvent[], opts?: AppendOpts): Promise<ObligationEvent[]> {
    if (events.length === 0) return [];
    // Optimistic concurrency: compare-and-append (synchronous → atomic on the JS loop).
    if (opts?.expectedVersion !== undefined) {
      const id = events[0].obligation_id;
      const current = (this.byObligation.get(id) ?? []).length;
      if (current !== opts.expectedVersion) throw new ConcurrencyError(opts.expectedVersion, current, id);
    }
    const persisted: ObligationEvent[] = [];
    for (const event of events) {
      assertNoRawContent(event); // safety net (also enforced in decide)
      if (this.keys.has(event.idempotency_key)) continue; // idempotent skip
      this.keys.add(event.idempotency_key);
      const log = this.byObligation.get(event.obligation_id) ?? [];
      log.push(event);
      this.byObligation.set(event.obligation_id, log);
      persisted.push(event);
    }
    return persisted;
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    return this.keys.has(key);
  }

  async getEvents(obligationId: ObligationId): Promise<ObligationEvent[]> {
    return [...(this.byObligation.get(obligationId) ?? [])];
  }

  async getAllObligationIds(teamId: string): Promise<ObligationId[]> {
    // W1 — scope by the team captured on the head REQUEST_DETECTED event.
    const out: ObligationId[] = [];
    for (const [id, events] of this.byObligation) {
      const head = events[0];
      if (head?.type === "REQUEST_DETECTED" && head.team === teamId) out.push(id);
    }
    return out;
  }
}
