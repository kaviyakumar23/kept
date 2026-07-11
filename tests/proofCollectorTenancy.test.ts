import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeProofCollectorProvider } from "../src/integrations/proofSources.js";
import { InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";
import { mkObl } from "./helpers.js";
import type { KeptConfig } from "../src/config.js";

/**
 * ADVERSARY (invariant #4, P0) — the PER-TENANT proof collector.
 *
 * These lock the isolation the `adversary` round verified on `makeProofCollectorProvider` /
 * `resolveTenantProof` (src/integrations/proofSources.ts): team A's resolved collector must
 * read proof with team A's OWN credentials + targets, never team B's. The ONLY fallback is
 * the shared OPERATOR env (process.env.GITHUB_TOKEN / cfg.proof.*) — an accepted operator
 * default, and NEVER another tenant's secret. If a future change ever merged the operator
 * token INTO a configured tenant, keyed the per-team cache by anything other than team_id, or
 * let one tenant's config bleed into another's collector, one of these breaks.
 */

/** Operator config with NO live proof creds — the operator default is "nothing configured". */
function baseCfg(): KeptConfig {
  return {
    proof: {
      launchDarkly: {
        mcpToken: undefined,
        mcpUrl: "https://mcp.example/none",
        mcpFlagTool: undefined,
        apiToken: undefined,
        projectKey: undefined,
        environment: "production",
        baseUrl: undefined,
      },
      jira: {
        mcpToken: undefined,
        mcpUrl: undefined,
        cloudId: undefined,
        mcpStatusTool: undefined,
        baseUrl: undefined,
        email: undefined,
        apiToken: undefined,
      },
      targetsFile: undefined,
    },
  } as unknown as KeptConfig;
}

// Neutralize any ambient proof creds so the operator default is deterministically empty.
const PROOF_ENV = [
  "GITHUB_TOKEN",
  "LAUNCHDARKLY_API_TOKEN",
  "LAUNCHDARKLY_PROJECT_KEY",
  "LAUNCHDARKLY_MCP_TOKEN",
  "LAUNCHDARKLY_ENVIRONMENT",
  "LAUNCHDARKLY_BASE_URL",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of PROOF_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PROOF_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-tenant proof collector — cross-tenant isolation (invariant #4)", () => {
  it("a team's proof-targets are NEVER visible to another team's collector", async () => {
    const store = new InMemoryTenantConfigStore();
    // Each team configures its OWN flag mapping (keyed on its own customer).
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "a_flag" } } });
    await store.set("T_B", "proof_targets", { Globex: { flag: { key: "b_flag" } } });

    const provider = makeProofCollectorProvider(store, baseCfg());
    const cA = await provider("T_A");
    const cB = await provider("T_B");
    expect(cA).not.toBeNull();
    expect(cB).not.toBeNull();

    const obAcme = mkObl("POSSIBLE_FULFILLMENT", { team: "T_A", customer: "Acme", subject_canonical: "S1" });
    const obGlobex = mkObl("POSSIBLE_FULFILLMENT", { team: "T_B", customer: "Globex", subject_canonical: "S2" });

    // A resolves only ITS OWN target (a_flag), via the simulated fallback proof server.
    expect((await cA!.collect(obAcme)).map((e) => e.ref)).toEqual([expect.stringMatching(/^a_flag@/)]);
    // A has no mapping for Globex, and B's mapping must NOT bleed into A.
    expect(await cA!.collect(obGlobex)).toEqual([]);

    // B resolves only ITS OWN target (b_flag) …
    expect((await cB!.collect(obGlobex)).map((e) => e.ref)).toEqual([expect.stringMatching(/^b_flag@/)]);
    // … and can never see A's Acme mapping.
    expect(await cB!.collect(obAcme)).toEqual([]);
  });

  it("caches per team by config fingerprint; a Connections change rebuilds, a stale collector never learns it", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "a_flag" } } });
    const provider = makeProofCollectorProvider(store, baseCfg());

    const c1 = await provider("T_A");
    const c1again = await provider("T_A");
    expect(c1again).toBe(c1); // unchanged config → same cached instance (fingerprint hit)

    // Team A adds a mapping through the Connections UI.
    await store.set("T_A", "proof_targets", {
      Acme: { flag: { key: "a_flag" } },
      NewCo: { flag: { key: "n_flag" } },
    });
    const c2 = await provider("T_A");
    expect(c2).not.toBe(c1); // fingerprint changed → rebuilt collector

    const obNew = mkObl("POSSIBLE_FULFILLMENT", { team: "T_A", customer: "NewCo", subject_canonical: "S3" });
    expect((await c2!.collect(obNew)).map((e) => e.ref)).toEqual([expect.stringMatching(/^n_flag@/)]);
    // The pre-change instance never gained the new mapping (proves the rebuild wasn't a mutation).
    expect(await c1!.collect(obNew)).toEqual([]);
  });

  it("reads GitHub with the ACTING team's own token; NEVER borrows the operator env or another tenant's token", async () => {
    const seen: string[] = [];
    const fakeFetch = vi.fn(async (_url: unknown, init: { headers?: Record<string, string> }) => {
      seen.push(String(init?.headers?.authorization ?? ""));
      return { ok: true, json: async () => ({ conclusion: "success", status: "completed" }) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fakeFetch);
    process.env.GITHUB_TOKEN = "operator-token"; // the shared operator default

    const store = new InMemoryTenantConfigStore();
    // Team A brings its OWN GitHub token; Team B configures a CI target but NO token. Neither team is
    // the operatorTeam, so B must NOT borrow the operator's GITHUB_TOKEN — its live read is skipped.
    await store.set("T_A", "github", { token: "team-A-token" });
    await store.set("T_A", "proof_targets", { Acme: { ci: { owner: "acme", repo: "web", runId: 42 } } });
    await store.set("T_B", "proof_targets", { Globex: { ci: { owner: "globex", repo: "app", runId: 7 } } });

    const provider = makeProofCollectorProvider(store, baseCfg());

    const cA = await provider("T_A");
    await cA!.collect(mkObl("POSSIBLE_FULFILLMENT", { team: "T_A", customer: "Acme", subject_canonical: "S1" }));
    const cB = await provider("T_B");
    const bEvidence = await cB!.collect(mkObl("POSSIBLE_FULFILLMENT", { team: "T_B", customer: "Globex", subject_canonical: "S2" }));

    // A used ITS OWN token. B has no token and the operator fallback is REMOVED → B makes NO
    // authenticated operator request; it gathers no CI evidence rather than borrowing operator creds.
    expect(seen).toEqual(["Bearer team-A-token"]);
    expect(seen).not.toContain("Bearer operator-token"); // operator creds never leak to another tenant
    expect(seen).not.toContain(""); // the one read that happened was authenticated
    expect(bEvidence).toEqual([]); // no token → no live read for B (uses the manual path instead)
  });

  it("an unconfigured team with NO operator default gets a null collector (no cross-tenant borrow)", async () => {
    const store = new InMemoryTenantConfigStore();
    // Only team A configures anything; the operator env is empty (cleared in beforeEach).
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "a_flag" } } });

    const provider = makeProofCollectorProvider(store, baseCfg());
    expect(await provider("T_A")).not.toBeNull(); // A has a target → a collector
    // Team B configured nothing and there is no operator default → no collector at all,
    // so B can NEVER end up running A's collector or A's targets.
    expect(await provider("T_B")).toBeNull();
  });
});
