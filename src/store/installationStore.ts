import pg from "pg";
import type { Installation, InstallationQuery, InstallationStore } from "@slack/oauth";

const { Pool } = pg;

/**
 * W2 — the InstallationStore backs multi-workspace OAuth. Bolt calls
 * `storeInstallation` after each install (persist the workspace's bot token) and
 * `fetchInstallation` on every inbound event (resolve the token to authorize the
 * request to the right tenant). Keyed by `team.id` for a workspace install, or by
 * `enterprise.id` for an org install.
 *
 * NOTE ON ZERO-COPY (invariant #2): the zero-copy guard covers the OBLIGATION event
 * log — it must never hold raw message bodies. Installations are a SEPARATE table
 * that legitimately holds OAuth secrets (the bot token). They are not obligation
 * events and are intentionally not passed through `assertNoRawContent`.
 */
export interface KeptInstallationStore extends InstallationStore {
  /**
   * Enumerate the installed workspace team ids. Not part of the `@slack/oauth`
   * interface — used for webhook payload → tenant routing (a webhook arrives with no
   * Slack auth, so its team is resolved by trying each installed tenant's ledger).
   */
  listTeamIds(): Promise<string[]>;
}

/** The storage key: enterprise id for an org install, else the workspace team id. */
function keyFromInstallation(installation: Installation<"v1" | "v2", boolean>): string {
  if (installation.isEnterpriseInstall && installation.enterprise?.id) return installation.enterprise.id;
  if (installation.team?.id) return installation.team.id;
  if (installation.enterprise?.id) return installation.enterprise.id;
  throw new Error("installation has neither team.id nor enterprise.id");
}

function keyFromQuery(query: InstallationQuery<boolean>): string {
  if (query.isEnterpriseInstall && query.enterpriseId) return query.enterpriseId;
  if (query.teamId) return query.teamId;
  if (query.enterpriseId) return query.enterpriseId;
  throw new Error("installation query has neither teamId nor enterpriseId");
}

/**
 * Production InstallationStore on Postgres (reuses the RDS Pool + schema.sql). The
 * `slack_installations` table stores the full normalized installation JSON so
 * `fetchInstallation` can return everything Slack gave us at install time.
 */
export class PostgresInstallationStore implements KeptInstallationStore {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
  }

  /** Create the `slack_installations` table if needed (idempotent). */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slack_installations (
        id            TEXT PRIMARY KEY,
        team_id       TEXT,
        enterprise_id TEXT,
        installation  JSONB NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_slack_installations_team ON slack_installations (team_id);
    `);
  }

  async storeInstallation<AuthVersion extends "v1" | "v2">(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    const id = keyFromInstallation(installation);
    const teamId = installation.team?.id ?? null;
    const enterpriseId = installation.enterprise?.id ?? null;
    await this.pool.query(
      `INSERT INTO slack_installations (id, team_id, enterprise_id, installation, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET team_id = EXCLUDED.team_id,
             enterprise_id = EXCLUDED.enterprise_id,
             installation = EXCLUDED.installation,
             updated_at = now()`,
      [id, teamId, enterpriseId, JSON.stringify(installation)],
    );
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<"v1" | "v2", boolean>> {
    const id = keyFromQuery(query);
    const res = await this.pool.query<{ installation: Installation<"v1" | "v2", boolean> }>(
      "SELECT installation FROM slack_installations WHERE id = $1",
      [id],
    );
    if (res.rowCount === 0) throw new Error(`no installation found for ${id}`);
    return res.rows[0].installation; // JSONB → parsed object
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const id = keyFromQuery(query);
    await this.pool.query("DELETE FROM slack_installations WHERE id = $1", [id]);
  }

  async listTeamIds(): Promise<string[]> {
    const res = await this.pool.query<{ team_id: string }>(
      "SELECT team_id FROM slack_installations WHERE team_id IS NOT NULL",
    );
    return res.rows.map((r) => r.team_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * In-memory InstallationStore for tests and the local/offline path. Same key rules
 * as the Postgres store (team id, or enterprise id for org installs).
 */
export class InMemoryInstallationStore implements KeptInstallationStore {
  private readonly byKey = new Map<string, Installation<"v1" | "v2", boolean>>();
  private readonly teamIds = new Set<string>();

  async storeInstallation<AuthVersion extends "v1" | "v2">(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    this.byKey.set(keyFromInstallation(installation), installation);
    if (installation.team?.id) this.teamIds.add(installation.team.id);
  }

  async fetchInstallation(query: InstallationQuery<boolean>): Promise<Installation<"v1" | "v2", boolean>> {
    const found = this.byKey.get(keyFromQuery(query));
    if (!found) throw new Error(`no installation found for ${keyFromQuery(query)}`);
    return found;
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    const key = keyFromQuery(query);
    this.byKey.delete(key);
    this.teamIds.delete(key);
  }

  async listTeamIds(): Promise<string[]> {
    return [...this.teamIds];
  }
}
