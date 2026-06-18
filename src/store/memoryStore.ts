import type { EventStore } from "./eventStore.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";

/**
 * In-memory event store — hermetic, deterministic, used by the test suite and the
 * eval/demo runner. Same semantics as PostgresEventStore (append-only, idempotent,
 * zero-copy enforced) without requiring a running database.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byObligation = new Map<ObligationId, ObligationEvent[]>();
  private readonly keys = new Set<string>();

  async append(events: ObligationEvent[]): Promise<ObligationEvent[]> {
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

  async getAllObligationIds(): Promise<ObligationId[]> {
    return [...this.byObligation.keys()];
  }
}
