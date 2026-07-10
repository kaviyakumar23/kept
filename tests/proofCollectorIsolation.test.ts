import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";
import { makeProofCollectorProvider } from "../src/integrations/proofSources.js";
import type { KeptConfig } from "../src/config.js";

/**
 * Round-8 adversary — per-tenant SECRET-credential isolation of the proof-collector provider
 * (invariant #4, P0). Complements tests/tenantConfigIsolation.test.ts (which locks proof_target
 * mapping isolation + per-team cache keying) by covering the OTHER axis: a workspace's stored
 * provider *secrets* (a LaunchDarkly token, a GitHub PAT) must never make ANOTHER workspace's
 * collector go live. `resolveTenantProof` reads `store.get(teamId, provider)` for the acting team
 * only, falling back to operator env; a regression that read a sibling team's row (or a global
 * scan) would let team A's webhook-driven Proof-of-Done borrow team B's credentials — a
 * cross-tenant secret leak into another tenant's flag/CI reads.
 *
 * With ZERO operator proof creds in cfg + env, the ONLY thing that can flip a team's collector to
 * non-null is that team's OWN stored secret. Team A inheriting team B's token would flip A from
 * null → non-null and fail these tests.
 */
const CFG = {
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

// Operator-fallback env that `configured()` / resolveTenantProof consult. Clear it so the ONLY
// proof signal is the per-tenant store (a CI machine's tokens would otherwise mask a bleed).
const ENV_KEYS = ["GITHUB_TOKEN", "LAUNCHDARKLY_API_TOKEN", "LAUNCHDARKLY_PROJECT_KEY"] as const;
const saved: Record<string, string | undefined> = {};

describe("proof-collector provider — one workspace's SECRETS never activate another's collector (invariant #4)", () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("team A does NOT borrow team B's LaunchDarkly MCP token", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_B", "launchdarkly", { mcpToken: "B-only-secret", projectKey: "beta" });

    const provider = makeProofCollectorProvider(store, CFG);
    expect(await provider("T_B")).not.toBeNull(); // B's own LD creds → live collector
    expect(await provider("T_A")).toBeNull(); // A must not see B's LD creds → nothing configured
  });

  it("team A does NOT borrow team B's GitHub token", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_B", "github", { token: "ghp_B_only" });

    const provider = makeProofCollectorProvider(store, CFG);
    expect(await provider("T_B")).not.toBeNull(); // B's GitHub token makes its CI source live
    expect(await provider("T_A")).toBeNull(); // A has no token and must not inherit B's
  });
});
