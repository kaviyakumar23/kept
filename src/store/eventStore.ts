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

/**
 * Per-table row counts deleted by `purgeTeam` — surfaced to the uninstall audit log so
 * "data is deleted on uninstall" is provable, not just asserted.
 */
export interface PurgeSummary {
  /** Distinct obligations whose entire event log was deleted. */
  obligations: number;
  /** Trust-link capability tokens deleted (customer trust page). */
  trustLinks: number;
  /** Pending reminder jobs deleted. */
  reminders: number;
  /** Roadmap target-date rows deleted (0 on the memory/demo path — roadmap is static there). */
  roadmap: number;
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

  /**
   * W1 — tenant-scoped choke point. Returns ONLY the obligations owned by `teamId`
   * (the team captured on each REQUEST_DETECTED). There is no unscoped variant: a
   * caller MUST supply the acting workspace, so a cross-tenant read is a type error.
   */
  getAllObligationIds(teamId: string): Promise<ObligationId[]>;

  /**
   * Invariant #4 + Marketplace data-deletion: irreversibly delete ALL data for one
   * tenant — its obligation event log AND every derived row (trust links, reminders,
   * roadmap). STRICTLY team-scoped: purging team A leaves team B's data completely
   * intact. Idempotent and fail-safe: purging an unknown team deletes nothing. Wired
   * to the Slack `app_uninstalled` / bot-token-revoked event so an uninstall honestly
   * purges the tenant (not just the stored bot token). Returns per-table counts.
   */
  purgeTeam(teamId: string): Promise<PurgeSummary>;
}
