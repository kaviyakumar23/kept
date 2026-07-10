import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";
import { makeProofCollectorProvider } from "../src/integrations/proofSources.js";

/**
 * Adversary round 8 — cross-tenant reads of the per-tenant integration config surface
 * (invariant #4, P0). These lock in the ISOLATION of the proof-collector provider, which
 * resolves each workspace's own Connections config (LaunchDarkly / Jira / GitHub / proof
 * targets) and caches a collector per team. A regression that re-keys the cache by config
 * hash (instead of team id) or drops the per-team resolve would let workspace B inherit
 * workspace A's collector — and thus A's tokens / proof targets. These tests fail if that
 * ever happens.
 *
 * Store-level (team_id, provider) isolation is covered in tenantConfig.test.ts; this file
 * targets the collector PROVIDER that sits on top of it.
 */
function baseCfg(): any {
  return {
    proof: {
      launchDarkly: {
        mcpToken: undefined,
        mcpUrl: "https://mcp.launchdarkly.com/mcp/launchdarkly",
        mcpFlagTool: undefined,
        apiToken: undefined,
        projectKey: undefined,
        environment: "production",
        baseUrl: undefined,
      },
      jira: { mcpToken: undefined, mcpUrl: undefined, cloudId: undefined, mcpStatusTool: undefined, baseUrl: undefined, email: undefined, apiToken: undefined },
      targetsFile: undefined,
    },
  };
}

describe("proof-collector provider — cross-tenant isolation (invariant #4)", () => {
  let savedGithub: string | undefined;
  beforeAll(() => {
    savedGithub = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN; // no operator fallback for these tests
    process.env.KEPT_CONFIG_KEY = "0".repeat(64);
  });
  afterAll(() => {
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGithub;
  });

  it("workspace B does NOT inherit workspace A's proof targets", async () => {
    const store = new InMemoryTenantConfigStore();
    // A maps a customer to a LaunchDarkly flag; B configures nothing at all.
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "acme-ga", environment: "production" } } });
    const provider = makeProofCollectorProvider(store, baseCfg());

    const collA = await provider("T_A");
    const collB = await provider("T_B");

    // A has a real target → a collector is built. B has no config and no operator env →
    // null. If B ever got a non-null collector here it would be reading A's targets.
    expect(collA).not.toBeNull();
    expect(collB).toBeNull();
  });

  it("caches a collector PER team id (B is never served A's collector instance)", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "a" } } });
    await store.set("T_B", "proof_targets", { Beta: { flag: { key: "b" } } });
    const provider = makeProofCollectorProvider(store, baseCfg());

    const a1 = await provider("T_A");
    const b1 = await provider("T_B");
    const a2 = await provider("T_A");

    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    expect(a2).toBe(a1); // stable per-team cache
    expect(b1).not.toBe(a1); // B never handed A's instance
  });

  it("two teams with IDENTICAL resolved config still get separate cache entries (no hash-keyed sharing)", async () => {
    const store = new InMemoryTenantConfigStore();
    // Identical target maps → identical resolved-config hash. The cache must still be keyed
    // by team id, so A and B get distinct collector instances (a hash-keyed cache would
    // hand B the same object A built — a latent cross-tenant coupling).
    await store.set("T_A", "proof_targets", { Same: { flag: { key: "same" } } });
    await store.set("T_B", "proof_targets", { Same: { flag: { key: "same" } } });
    const provider = makeProofCollectorProvider(store, baseCfg());

    const a = await provider("T_A");
    const b = await provider("T_B");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
  });

  it("a Connections change for A rebuilds A's collector without touching B", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "old" } } });
    await store.set("T_B", "proof_targets", { Beta: { flag: { key: "b" } } });
    const provider = makeProofCollectorProvider(store, baseCfg());

    const a1 = await provider("T_A");
    const b1 = await provider("T_B");
    await store.set("T_A", "proof_targets", { Acme: { flag: { key: "new" } } });
    const a2 = await provider("T_A");
    const b2 = await provider("T_B");

    expect(a2).not.toBe(a1); // A rebuilt on its own config change
    expect(b2).toBe(b1); // B untouched (still cached)
  });
});
