import pg from "pg";
import type { RoadmapSource, RoadmapEntry } from "../policy/roadmap.js";

/**
 * Postgres-backed roadmap source. Reads the approved per-(customer, subject) target
 * dates from a `roadmap` table (see src/store/schema.sql), so the contradiction
 * check runs against a real, updatable system of record rather than a config array.
 */
export class PostgresRoadmapSource implements RoadmapSource {
  private readonly pool: pg.Pool;
  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString });
  }

  async list(teamId?: string): Promise<RoadmapEntry[]> {
    // W1 / invariant #4 — tenant-scoped read: when the acting workspace is supplied,
    // return ONLY that team's targets (defense-in-depth — roadmap holds target dates,
    // no message content). A missing teamId (single-tenant / legacy caller) reads all.
    const res = teamId
      ? await this.pool.query<{ customer: string; subject_canonical: string; target_date: string }>(
          "SELECT customer, subject_canonical, to_char(target_date, 'YYYY-MM-DD') AS target_date FROM roadmap WHERE team_id = $1",
          [teamId],
        )
      : await this.pool.query<{ customer: string; subject_canonical: string; target_date: string }>(
          "SELECT customer, subject_canonical, to_char(target_date, 'YYYY-MM-DD') AS target_date FROM roadmap",
        );
    return res.rows.map((r) => ({ customer: r.customer, subject_canonical: r.subject_canonical, targetDate: r.target_date }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
