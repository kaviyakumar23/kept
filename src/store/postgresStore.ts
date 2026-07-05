import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EventStore, AppendOpts, PurgeSummary } from "./eventStore.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";
import { ConcurrencyError } from "./errors.js";

const { Pool } = pg;

/** W1 — the team lives on the head REQUEST_DETECTED event; later events inherit it via lookup. */
function payloadTeam(event: ObligationEvent): string | null {
  return event.type === "REQUEST_DETECTED" ? event.team : null;
}

/**
 * Production event store on Postgres. Same contract as InMemoryEventStore:
 * append-only, idempotent (unique idempotency_key), zero-copy enforced. The
 * obligation projection is derived in code, not stored — so a logic change is a
 * replay, not a migration.
 */
export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
  }

  /** Create the schema if needed (idempotent). */
  async init(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "schema.sql"), "utf8");
    await this.pool.query(sql);
  }

  async append(events: ObligationEvent[], opts?: AppendOpts): Promise<ObligationEvent[]> {
    if (events.length === 0) return [];
    const client = await this.pool.connect();
    const persisted: ObligationEvent[] = [];
    try {
      await client.query("BEGIN");
      // Optimistic concurrency: a per-obligation advisory xact-lock serializes appends
      // for this obligation, so the count check + insert are race-safe (held to COMMIT).
      if (opts?.expectedVersion !== undefined) {
        const id = events[0].obligation_id;
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
        const cnt = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM obligation_events WHERE obligation_id = $1",
          [id],
        );
        const current = cnt.rows[0]?.n ?? 0;
        if (current !== opts.expectedVersion) {
          throw new ConcurrencyError(opts.expectedVersion, current, id); // catch → ROLLBACK
        }
      }
      for (const event of events) {
        assertNoRawContent(event);
        // W1 — every row carries team_id (NOT NULL). The head REQUEST_DETECTED supplies
        // it; a later event inherits the team from its obligation's head row (visible
        // within this transaction even if inserted in the same batch).
        let teamId = payloadTeam(event);
        if (teamId === null) {
          const look = await client.query<{ team_id: string }>(
            "SELECT team_id FROM obligation_events WHERE obligation_id = $1 ORDER BY seq ASC LIMIT 1",
            [event.obligation_id],
          );
          teamId = look.rows[0]?.team_id ?? null;
        }
        if (teamId === null) {
          throw new Error(`cannot determine team_id for ${event.type} on ${event.obligation_id} (no REQUEST_DETECTED head)`);
        }
        const res = await client.query(
          `INSERT INTO obligation_events (obligation_id, team_id, event_type, idempotency_key, payload)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING seq`,
          [event.obligation_id, teamId, event.type, event.idempotency_key, JSON.stringify(event)],
        );
        if ((res.rowCount ?? 0) > 0) persisted.push(event);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return persisted;
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1 FROM obligation_events WHERE idempotency_key = $1 LIMIT 1",
      [key],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getEvents(obligationId: ObligationId): Promise<ObligationEvent[]> {
    const res = await this.pool.query<{ payload: ObligationEvent }>(
      "SELECT payload FROM obligation_events WHERE obligation_id = $1 ORDER BY seq ASC",
      [obligationId],
    );
    return res.rows.map((r) => r.payload);
  }

  async getAllObligationIds(teamId: string): Promise<ObligationId[]> {
    // W1 — tenant partition: only this workspace's obligations.
    const res = await this.pool.query<{ obligation_id: string }>(
      "SELECT DISTINCT obligation_id FROM obligation_events WHERE team_id = $1",
      [teamId],
    );
    return res.rows.map((r) => r.obligation_id);
  }

  async purgeTeam(teamId: string): Promise<PurgeSummary> {
    // Invariant #4 + Marketplace data-deletion: delete EVERY tenant-scoped row for
    // `teamId` across the colocated tables in ONE transaction (all-or-nothing). Every
    // predicate is `team_id = $1` (reminders inherit the team via their obligation), so
    // another workspace's data can never be touched. Idempotent — an unknown team is a
    // no-op (all counts 0). `slack_installations` is handled separately by the OAuth
    // `deleteInstallation` (it holds the bot token, keyed by installation id, not team_id).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const obl = await client.query<{ n: number }>(
        "SELECT count(DISTINCT obligation_id)::int AS n FROM obligation_events WHERE team_id = $1",
        [teamId],
      );
      const remRes = await client.query(
        `DELETE FROM reminders
          WHERE obligation_id IN (SELECT obligation_id FROM obligation_events WHERE team_id = $1)`,
        [teamId],
      );
      const trustRes = await client.query("DELETE FROM trust_links WHERE team_id = $1", [teamId]);
      const roadRes = await client.query("DELETE FROM roadmap WHERE team_id = $1", [teamId]);
      // Delete the event log LAST — the reminders sub-select above resolves against it.
      await client.query("DELETE FROM obligation_events WHERE team_id = $1", [teamId]);
      await client.query("COMMIT");
      return {
        obligations: obl.rows[0]?.n ?? 0,
        trustLinks: trustRes.rowCount ?? 0,
        reminders: remRes.rowCount ?? 0,
        roadmap: roadRes.rowCount ?? 0,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
