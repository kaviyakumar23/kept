import pg from "pg";
import type { Scheduler, ReminderJob, ReminderHandler, ReminderKind } from "./scheduler.js";
import type { ObligationId } from "../domain/ids.js";

const { Pool } = pg;

/**
 * W2 — production reminder scheduler on Postgres, so the hosted path is a single
 * datastore (no Redis). A `reminders` table holds pending AT_RISK / OVERDUE jobs; a
 * poll loop claims due jobs atomically and fires them to the internal owner.
 *
 * Multi-instance safe: `runDue` claims jobs with a single
 * `UPDATE ... SET fired_at = now() WHERE fire_at <= now AND fired_at IS NULL RETURNING *`,
 * so two App Runner instances polling concurrently never double-fire the same job.
 * The deterministic id (`${obligationId}:${kind}`) makes re-scheduling replace, not
 * duplicate (and re-arms fired_at so a moved due date fires again).
 */
export class PostgresScheduler implements Scheduler {
  private readonly pool: pg.Pool;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    opts: { connectionString?: string; pool?: pg.Pool; pollMs?: number },
    private readonly handler: ReminderHandler,
  ) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
    this.pollMs = opts.pollMs ?? 15_000;
  }

  /** Create the `reminders` table if needed (idempotent). */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS reminders (
        id            TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL,
        kind          TEXT NOT NULL,
        fire_at       TIMESTAMPTZ NOT NULL,
        fired_at      TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (fire_at) WHERE fired_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_reminders_obligation ON reminders (obligation_id);
    `);
  }

  async schedule(job: ReminderJob): Promise<void> {
    // Upsert by deterministic id: reschedule replaces the fire time AND re-arms the
    // job (clears fired_at) so a moved due date fires again.
    await this.pool.query(
      `INSERT INTO reminders (id, obligation_id, kind, fire_at, fired_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), NULL)
       ON CONFLICT (id) DO UPDATE
         SET obligation_id = EXCLUDED.obligation_id,
             kind = EXCLUDED.kind,
             fire_at = EXCLUDED.fire_at,
             fired_at = NULL`,
      [job.id, job.obligationId, job.kind, job.fireAt],
    );
  }

  async cancelForObligation(obligationId: ObligationId): Promise<void> {
    await this.pool.query("DELETE FROM reminders WHERE obligation_id = $1", [obligationId]);
  }

  /** Begin polling for due jobs. Idempotent (a second call is a no-op). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runDue().catch((err) => console.error("[kept] reminder poll failed:", err));
    }, this.pollMs);
    // Don't hold the event loop open just for the poll timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Fire every due, not-yet-fired job as of `now`. Claims jobs atomically so
   * concurrent pollers can't double-fire. Returns the jobs fired.
   */
  async runDue(now: number = Date.now()): Promise<ReminderJob[]> {
    const res = await this.pool.query<{ id: string; obligation_id: string; kind: string; fire_at_ms: string }>(
      `UPDATE reminders
         SET fired_at = now()
       WHERE fire_at <= to_timestamp($1 / 1000.0) AND fired_at IS NULL
       RETURNING id, obligation_id, kind, (extract(epoch FROM fire_at) * 1000)::bigint AS fire_at_ms`,
      [now],
    );
    const fired: ReminderJob[] = res.rows.map((r) => ({
      id: r.id,
      obligationId: r.obligation_id,
      kind: r.kind as ReminderKind,
      fireAt: Number(r.fire_at_ms),
    }));
    for (const job of fired) {
      try {
        await this.handler(job);
      } catch (err) {
        console.error(`[kept] reminder handler failed for ${job.id}:`, err);
      }
    }
    return fired;
  }

  async close(): Promise<void> {
    this.stop();
    await this.pool.end();
  }
}
