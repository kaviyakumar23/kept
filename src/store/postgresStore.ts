import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { EventStore } from "./eventStore.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";

const { Pool } = pg;

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

  async append(events: ObligationEvent[]): Promise<ObligationEvent[]> {
    if (events.length === 0) return [];
    const client = await this.pool.connect();
    const persisted: ObligationEvent[] = [];
    try {
      await client.query("BEGIN");
      for (const event of events) {
        assertNoRawContent(event);
        const res = await client.query(
          `INSERT INTO obligation_events (obligation_id, event_type, idempotency_key, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING seq`,
          [event.obligation_id, event.type, event.idempotency_key, JSON.stringify(event)],
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

  async getAllObligationIds(): Promise<ObligationId[]> {
    const res = await this.pool.query<{ obligation_id: string }>(
      "SELECT DISTINCT obligation_id FROM obligation_events",
    );
    return res.rows.map((r) => r.obligation_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
