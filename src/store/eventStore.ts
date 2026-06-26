import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";

/**
 * The append-only event store. Implementations: InMemoryEventStore (tests + demo)
 * and PostgresEventStore (production). All higher layers depend only on this
 * interface, so the store brand is swappable — judges see the engine, not the DB.
 */
export interface AppendOpts {
  /**
   * Optimistic concurrency: if set, the append succeeds only when the obligation's
   * current event count equals this value; otherwise it throws ConcurrencyError.
   * (All events in one append must belong to the same obligation.)
   */
  expectedVersion?: number;
}

export interface EventStore {
  /**
   * Append events atomically. Events whose idempotency_key already exists are
   * skipped (idempotent). Returns the events that were actually persisted.
   * Implementations MUST enforce the zero-copy guard before persisting, and — when
   * `opts.expectedVersion` is given — the compare-and-append atomically.
   */
  append(events: ObligationEvent[], opts?: AppendOpts): Promise<ObligationEvent[]>;

  hasIdempotencyKey(key: string): Promise<boolean>;

  /** Ordered event log for one obligation. */
  getEvents(obligationId: ObligationId): Promise<ObligationEvent[]>;

  getAllObligationIds(): Promise<ObligationId[]>;
}
