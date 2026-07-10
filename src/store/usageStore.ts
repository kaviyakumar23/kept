import { Pool } from "pg";

/**
 * Per-tenant usage metering (the "pilot" free-tier guardrail). Kept's dominant variable cost is
 * the LLM classification it runs on every ingested Slack message; this meter caps those calls per
 * workspace per month so a busy/abusive tenant can't run up an unbounded AI bill on the free tier.
 * Counters are keyed by (team_id, period) — read/incremented ONLY for the acting workspace
 * (invariant #4). Not obligation events; holds no message content, so it's outside the zero-copy guard.
 */
export interface UsageStore {
  /** Atomically increment the team's counter for the period, returning the NEW total. */
  bump(teamId: string, period: string): Promise<number>;
  /** Current count for the period without incrementing. */
  get(teamId: string, period: string): Promise<number>;
  /** Delete all of a team's counters (invariant #4 — uninstall data deletion). Returns rows removed. */
  purgeTeam(teamId: string): Promise<number>;
}

/** YYYY-MM bucket from an epoch-ms instant (resets on the 1st). */
export function usagePeriod(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export class InMemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, number>();
  private key(teamId: string, period: string): string {
    return `${teamId} ${period}`;
  }
  async bump(teamId: string, period: string): Promise<number> {
    const n = (this.counts.get(this.key(teamId, period)) ?? 0) + 1;
    this.counts.set(this.key(teamId, period), n);
    return n;
  }
  async get(teamId: string, period: string): Promise<number> {
    return this.counts.get(this.key(teamId, period)) ?? 0;
  }
  async purgeTeam(teamId: string): Promise<number> {
    let n = 0;
    for (const k of [...this.counts.keys()]) if (k.startsWith(`${teamId} `)) { this.counts.delete(k); n++; }
    return n;
  }
}

export class PostgresUsageStore implements UsageStore {
  private readonly pool: Pool;
  constructor(opts: { connectionString: string } | { pool: Pool }) {
    this.pool = "pool" in opts ? opts.pool : new Pool({ connectionString: opts.connectionString });
  }
  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS usage_counters (
         team_id    TEXT NOT NULL,
         period     TEXT NOT NULL,
         count      INTEGER NOT NULL DEFAULT 0,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (team_id, period)
       )`,
    );
  }
  async bump(teamId: string, period: string): Promise<number> {
    const r = await this.pool.query<{ count: number }>(
      `INSERT INTO usage_counters (team_id, period, count, updated_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (team_id, period) DO UPDATE SET count = usage_counters.count + 1, updated_at = now()
       RETURNING count`,
      [teamId, period],
    );
    return r.rows[0]?.count ?? 1;
  }
  async get(teamId: string, period: string): Promise<number> {
    const r = await this.pool.query<{ count: number }>(
      `SELECT count FROM usage_counters WHERE team_id = $1 AND period = $2`,
      [teamId, period],
    );
    return r.rows[0]?.count ?? 0;
  }
  async purgeTeam(teamId: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM usage_counters WHERE team_id = $1`, [teamId]);
    return r.rowCount ?? 0;
  }
}
