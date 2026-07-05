import type { EventStore, AppendOpts, PurgeSummary } from "./eventStore.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";
import { ConcurrencyError } from "./errors.js";

/**
 * Sibling in-memory stores that hold a tenant's DERIVED rows (trust links, reminders).
 * In Postgres these are colocated tables the event store's own pool can delete in one
 * transaction; in memory they are separate objects, so `purgeTeam` cascades to them via
 * these narrow (structurally-typed) hooks to keep uninstall data-deletion at parity.
 */
export interface MemoryDerivedStores {
  /** Delete every trust link for a team. Returns the count deleted. */
  trustLinks?: { purgeTeam(teamId: string): Promise<number> };
  /** Delete every reminder for these obligation ids. Returns the count deleted. */
  reminders?: { purgeObligations(obligationIds: readonly ObligationId[]): Promise<number> };
}

/**
 * In-memory event store — hermetic, deterministic, used by the test suite and the
 * eval/demo runner. Same semantics as PostgresEventStore (append-only, idempotent,
 * zero-copy enforced) without requiring a running database.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byObligation = new Map<ObligationId, ObligationEvent[]>();
  private readonly keys = new Set<string>();
  private derived: MemoryDerivedStores;

  constructor(derived: MemoryDerivedStores = {}) {
    this.derived = derived;
  }

  /**
   * Attach the sibling in-memory stores (trust links, reminders) after construction so
   * uninstall `purgeTeam` cascades to them. Needed because the scheduler/trust store are
   * built after the event store in the boot graph (they depend on it). No-op in Postgres.
   */
  attachDerivedStores(derived: MemoryDerivedStores): void {
    this.derived = derived;
  }

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

  async purgeTeam(teamId: string): Promise<PurgeSummary> {
    // Invariant #4 — strictly team-scoped: getAllObligationIds already filters by team,
    // so only this tenant's obligations (and their derived rows) are touched.
    const ids = await this.getAllObligationIds(teamId);
    for (const id of ids) {
      const events = this.byObligation.get(id);
      if (events) for (const e of events) this.keys.delete(e.idempotency_key);
      this.byObligation.delete(id);
    }
    const trustLinks = this.derived.trustLinks ? await this.derived.trustLinks.purgeTeam(teamId) : 0;
    const reminders = this.derived.reminders ? await this.derived.reminders.purgeObligations(ids) : 0;
    return { obligations: ids.length, trustLinks, reminders, roadmap: 0 };
  }
}
