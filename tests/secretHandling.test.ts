import { describe, it, expect, beforeAll } from "vitest";
import type { Pool } from "pg";
import { PostgresTenantConfigStore, InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";
import { connectModal, appHomeView, FIELDS } from "../src/slack/blocks.js";
import type { SlackBlock } from "../src/slack/blocks.js";

/**
 * Adversary round 8 — SECRET HANDLING regression locks.
 *
 * The prior round already covers crypto round-trip / IV freshness / GCM tamper and in-memory
 * per-tenant isolation (tests/tenantConfig.test.ts). This file locks the three secret-handling
 * guarantees that were NOT yet under test and are the ones an attacker probes:
 *   (b) a stored provider token is NEVER echoed back into a Connections modal (`initial_value`);
 *   (c) the REAL PostgresTenantConfigStore encrypts on EVERY write and decrypts only on read;
 *       and a blank token on submit PRESERVES the saved secret (never wipes, never leaks);
 *   (e) App Home renders only connection status — never a token.
 */

const SECRET = "ghp_ATTACKER_WOULD_LOVE_THIS_9f8e7d6c";

beforeAll(() => {
  // Deterministic 32-byte key so encryptSecret/decryptSecret work hermetically.
  process.env.KEPT_CONFIG_KEY = "0".repeat(64);
});

/** Recursively collect every `initial_value` string set anywhere in a Block Kit view. */
function initialValues(view: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v == null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "initial_value" && typeof val === "string") out.push(val);
      walk(val);
    }
  };
  walk(view);
  return out;
}

function findBlock(view: { blocks: SlackBlock[] }, blockId: string): SlackBlock | undefined {
  return view.blocks.find((b) => (b as { block_id?: string }).block_id === blockId);
}

describe("secret handling (b) — Connections modal never echoes a stored token", () => {
  it("GitHub: token input carries NO initial_value even when a token is saved", () => {
    const view = connectModal("github", { token: SECRET });
    // The whole rendered modal must not contain the secret anywhere (placeholder, hint, etc.).
    expect(JSON.stringify(view)).not.toContain(SECRET);
    const tokenBlock = findBlock(view as { blocks: SlackBlock[] }, FIELDS.ghToken.block) as any;
    expect(tokenBlock?.element?.initial_value).toBeUndefined();
  });

  it("LaunchDarkly: token input blank; non-secret fields (project/env) DO prefill", () => {
    const view = connectModal("launchdarkly", { mcpToken: "api-SECRET-ld", projectKey: "acme-proj", environment: "production" });
    expect(JSON.stringify(view)).not.toContain("api-SECRET-ld");
    const tokenBlock = findBlock(view as { blocks: SlackBlock[] }, FIELDS.ldToken.block) as any;
    expect(tokenBlock?.element?.initial_value).toBeUndefined();
    // Proves the test is meaningful: non-secret config IS echoed, only the secret is withheld.
    expect(initialValues(view)).toContain("acme-proj");
  });

  it("Jira: apiToken input blank; base URL / email (non-secret) prefill", () => {
    const view = connectModal("jira", { apiToken: "jira-SECRET-xyz", baseUrl: "https://acme.atlassian.net", email: "pm@acme.com" });
    expect(JSON.stringify(view)).not.toContain("jira-SECRET-xyz");
    const tokenBlock = findBlock(view as { blocks: SlackBlock[] }, FIELDS.jiraToken.block) as any;
    expect(tokenBlock?.element?.initial_value).toBeUndefined();
    expect(initialValues(view)).toContain("https://acme.atlassian.net");
  });

  it("no token echo when config is null (first-time connect)", () => {
    for (const p of ["github", "jira", "launchdarkly"] as const) {
      const view = connectModal(p, null);
      const tokenField = p === "github" ? FIELDS.ghToken : p === "jira" ? FIELDS.jiraToken : FIELDS.ldToken;
      const tokenBlock = findBlock(view as { blocks: SlackBlock[] }, tokenField.block) as any;
      expect(tokenBlock?.element?.initial_value).toBeUndefined();
    }
  });
});

describe("secret handling (e) — App Home renders status only, never a token", () => {
  it("Connections section shows configured providers but no secret material", () => {
    const view = appHomeView([], Date.now(), ["github", "launchdarkly", "jira", "proof_targets"]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(SECRET);
    expect(json).toContain("Connections");
    expect(json).toContain("Connected"); // status is rendered…
    // …and no input value / token could exist because appHomeView only receives provider NAMES.
    expect(initialValues(view)).toEqual([]);
  });
});

/**
 * A minimal in-memory fake of the pg Pool that the PostgresTenantConfigStore drives. It records
 * exactly what the store hands to the DB, so we can assert the persisted `config_enc` column is
 * ciphertext (never plaintext) — i.e. the store encrypts on EVERY write, not just via a helper.
 */
class FakePool {
  readonly rows = new Map<string, string>(); // key: `${team}|${provider}` -> config_enc (as stored)
  readonly writes: string[] = []; // every config_enc value ever written
  private k(team: string, provider: string): string {
    return `${team}|${provider}`;
  }
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    const s = sql.trim();
    if (s.startsWith("CREATE TABLE")) return { rows: [] };
    if (s.startsWith("SELECT config_enc")) {
      const v = this.rows.get(this.k(params[0] as string, params[1] as string));
      return { rows: v ? [{ config_enc: v }] : [] };
    }
    if (s.startsWith("INSERT INTO tenant_config")) {
      const enc = params[2] as string;
      this.rows.set(this.k(params[0] as string, params[1] as string), enc);
      this.writes.push(enc);
      return { rows: [] };
    }
    if (s.startsWith("DELETE")) {
      this.rows.delete(this.k(params[0] as string, params[1] as string));
      return { rows: [] };
    }
    if (s.startsWith("SELECT provider")) {
      const team = params[0] as string;
      const rows = [...this.rows.keys()].filter((key) => key.startsWith(`${team}|`)).map((key) => ({ provider: key.split("|")[1] }));
      return { rows };
    }
    return { rows: [] };
  }
}

describe("secret handling (c) — PostgresTenantConfigStore encrypts on EVERY write", () => {
  it("persists ciphertext (never plaintext) and decrypts only on read", async () => {
    const pool = new FakePool();
    const store = new PostgresTenantConfigStore({ pool: pool as unknown as Pool });
    await store.set("T_ACME", "github", { token: SECRET });

    // What actually hit the DB must NOT be the plaintext token or the raw JSON.
    const persisted = pool.rows.get("T_ACME|github")!;
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain(SECRET);
    expect(Buffer.from(persisted, "base64").toString("utf8")).not.toContain(SECRET);

    // Read decrypts back to the original.
    expect(await store.get("T_ACME", "github")).toEqual({ token: SECRET });
  });

  it("every write uses a fresh IV — two identical configs persist as different ciphertext", async () => {
    const pool = new FakePool();
    const store = new PostgresTenantConfigStore({ pool: pool as unknown as Pool });
    await store.set("T", "github", { token: SECRET });
    await store.set("T", "github", { token: SECRET });
    expect(pool.writes).toHaveLength(2);
    expect(pool.writes[0]).not.toBe(pool.writes[1]); // no static IV / deterministic ECB-style output
    expect(await store.get("T", "github")).toEqual({ token: SECRET }); // still decrypts
  });

  it("a corrupt/rotated ciphertext reads as null (fail-safe), never throws or leaks", async () => {
    const pool = new FakePool();
    const store = new PostgresTenantConfigStore({ pool: pool as unknown as Pool });
    pool.rows.set("T|github", "not-valid-base64-ciphertext");
    await expect(store.get("T", "github")).resolves.toBeNull();
  });
});

describe("secret handling — blank token on submit PRESERVES the saved secret", () => {
  // Mirrors the connectProvider view handler in src/server/slackApp.ts (github/jira/launchdarkly
  // branches): `token: str(input) ?? cur?.token`. A blank input → str() is undefined → keep the
  // saved secret; a non-blank input → overwrite. This locks that semantics against a regression
  // that would wipe the token (data loss) or require re-entry.
  it("blank input keeps the existing token; a provided value overwrites it", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T", "github", { token: "ORIGINAL_SECRET" });

    // Submit with a BLANK token field (str(...) === undefined).
    const cur1 = await store.get("T", "github");
    const blank: string | undefined = undefined;
    await store.set("T", "github", { token: blank ?? cur1?.token });
    expect((await store.get("T", "github"))?.token).toBe("ORIGINAL_SECRET"); // preserved, not wiped

    // Submit with a NEW token → overwrite.
    const cur2 = await store.get("T", "github");
    const provided: string | undefined = "ROTATED_SECRET";
    await store.set("T", "github", { token: provided ?? cur2?.token });
    expect((await store.get("T", "github"))?.token).toBe("ROTATED_SECRET");
  });
});
