import pg from "pg";
import { randomBytes } from "node:crypto";

const { Pool } = pg;

/**
 * W6 — the customer trust page's capability store.
 *
 * A trust link is an opaque, unguessable, revocable per-(team, customer) capability:
 * the token IS the authorization (there is no login). `GET /trust/:token` resolves it
 * to exactly one (team, customer) and renders THAT account's audience-safe view.
 *
 * Tenant isolation (invariant #4) is enforced here by construction: the resolved
 * `team_id` is the ONLY team the route may read (via the team-scoped `listObligations`),
 * so a token minted by team A for customer Acme can never surface team B's ledger — nor
 * team A's other customers, since the customer name is pinned on the link too.
 *
 * This is NOT an obligation event log: it stores no message content, only a random
 * token + its scope, so it is intentionally not subject to the zero-copy guard.
 */
export interface TrustLink {
  team_id: string;
  customer: string;
  token: string;
  created_at: string;
  revoked_at: string | null;
}

export interface TrustLinkStore {
  /**
   * Mint (or return the existing active) capability for (team, customer). Idempotent
   * per (team, customer): repeat mints return the SAME active token until it is revoked,
   * so `/kept trust <customer>` yields a stable URL. `customer` matches case-insensitively.
   */
  mint(teamId: string, customer: string, now?: number): Promise<TrustLink>;
  /** Resolve an ACTIVE token to its (team, customer). Unknown OR revoked → null (no existence leak). */
  resolve(token: string): Promise<TrustLink | null>;
  /**
   * Revoke every active link for (team, customer) — scoped to `teamId`, so one workspace
   * can never revoke another's capability. Returns the number of links revoked.
   */
  revoke(teamId: string, customer: string, now?: number): Promise<number>;
}

/** 32 bytes of CSPRNG entropy, URL-safe — unguessable and safe as a path segment. */
export function newTrustToken(): string {
  return randomBytes(32).toString("base64url");
}

const iso = (now?: number): string => new Date(now ?? Date.now()).toISOString();
const sameCustomer = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase();

/** In-memory store for tests, the demo, and the local/offline path. */
export class InMemoryTrustLinkStore implements TrustLinkStore {
  private readonly byToken = new Map<string, TrustLink>();

  async mint(teamId: string, customer: string, now?: number): Promise<TrustLink> {
    for (const link of this.byToken.values()) {
      if (link.revoked_at === null && link.team_id === teamId && sameCustomer(link.customer, customer)) {
        return { ...link }; // idempotent: reuse the active capability for this (team, customer)
      }
    }
    const link: TrustLink = { team_id: teamId, customer, token: newTrustToken(), created_at: iso(now), revoked_at: null };
    this.byToken.set(link.token, link);
    return { ...link };
  }

  async resolve(token: string): Promise<TrustLink | null> {
    const link = this.byToken.get(token);
    return link && link.revoked_at === null ? { ...link } : null;
  }

  async revoke(teamId: string, customer: string, now?: number): Promise<number> {
    let n = 0;
    for (const link of this.byToken.values()) {
      if (link.revoked_at === null && link.team_id === teamId && sameCustomer(link.customer, customer)) {
        link.revoked_at = iso(now);
        n++;
      }
    }
    return n;
  }

  /**
   * Invariant #4 — uninstall data-deletion: hard-delete EVERY link (active or revoked)
   * for a team. Team-scoped, so one workspace's uninstall never drops another's tokens.
   * Cascaded from `InMemoryEventStore.purgeTeam`. Returns the count deleted.
   */
  async purgeTeam(teamId: string): Promise<number> {
    let n = 0;
    for (const [token, link] of this.byToken) {
      if (link.team_id === teamId) {
        this.byToken.delete(token);
        n++;
      }
    }
    return n;
  }
}

function normalize(row: {
  token: string;
  team_id: string;
  customer: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}): TrustLink {
  const toIso = (v: Date | string | null): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : String(v);
  return {
    token: row.token,
    team_id: row.team_id,
    customer: row.customer,
    created_at: toIso(row.created_at)!,
    revoked_at: toIso(row.revoked_at),
  };
}

/** Production store on Postgres (reuses the RDS Pool + `trust_links` in schema.sql). */
export class PostgresTrustLinkStore implements TrustLinkStore {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
  }

  /** Create the `trust_links` table if needed (idempotent). */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS trust_links (
        token       TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL,
        customer    TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_trust_links_active
        ON trust_links (team_id, upper(customer)) WHERE revoked_at IS NULL;
    `);
  }

  async mint(teamId: string, customer: string): Promise<TrustLink> {
    const existing = await this.pool.query(
      `SELECT token, team_id, customer, created_at, revoked_at FROM trust_links
       WHERE team_id = $1 AND upper(customer) = upper($2) AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [teamId, customer],
    );
    if (existing.rowCount && existing.rows[0]) return normalize(existing.rows[0]);
    const res = await this.pool.query(
      `INSERT INTO trust_links (token, team_id, customer) VALUES ($1, $2, $3)
       RETURNING token, team_id, customer, created_at, revoked_at`,
      [newTrustToken(), teamId, customer],
    );
    return normalize(res.rows[0]);
  }

  async resolve(token: string): Promise<TrustLink | null> {
    const res = await this.pool.query(
      `SELECT token, team_id, customer, created_at, revoked_at FROM trust_links
       WHERE token = $1 AND revoked_at IS NULL`,
      [token],
    );
    return res.rowCount ? normalize(res.rows[0]) : null;
  }

  async revoke(teamId: string, customer: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE trust_links SET revoked_at = now()
       WHERE team_id = $1 AND upper(customer) = upper($2) AND revoked_at IS NULL`,
      [teamId, customer],
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
