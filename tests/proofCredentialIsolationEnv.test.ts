import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeProofCollectorProvider } from "../src/integrations/proofSources.js";
import { InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";
import { mkObl } from "./helpers.js";
import type { KeptConfig } from "../src/config.js";

/**
 * ROUND-8 ADVERSARY — operator-env credential isolation (invariant #4, P0).
 *
 * The credential-isolation fix (proofSources.ts:185-186, 222-224 + config.ts:33-37) promises:
 * "ONLY [the operator] team may use the operator-env integration credentials
 * (LaunchDarkly/Jira/GitHub + proof-targets). Every other installed workspace uses strictly its
 * own connected sources — no fallback to the operator's accounts (tenant isolation)."
 *
 * `resolveTenantProof` honors this at the merge layer (unconfigured providers resolve to {} /
 * undefined). BUT the proof ADAPTERS independently read process.env as a fallback:
 *   - githubActions.ts:40   `this.opts.token ?? process.env.GITHUB_TOKEN`
 *   - launchDarkly.ts:56    configured() ?? process.env.LAUNCHDARKLY_API_TOKEN / _PROJECT_KEY
 *   - launchDarkly.ts:75-76 viaRest() same env fallback
 * so a NON-operator, NON-demo tenant that sets ONLY a proof_targets entry (flag + ci) — which any
 * workspace can do through the Connections UI — drives live reads against the OPERATOR's
 * LaunchDarkly project and the OPERATOR's GitHub token. The tenant controls the flag key / owner /
 * repo / run id, so this is both a cross-tenant credential leak AND a forged-proof vector.
 *
 * This test pins the FIX's stated guarantee: with the operator env populated (the real operator
 * deployment), a non-operator tenant's collect() must NEVER emit an outbound request bearing an
 * operator credential. It FAILS today (the adapters leak the env creds) and passes once the
 * adapters stop reading process.env for a per-tenant build.
 */

const OPERATOR_LD_TOKEN = "op-ld-secret-token";
const OPERATOR_LD_PROJECT = "op-secret-project";
const OPERATOR_GH_TOKEN = "op-gh-secret-token";

const OPERATOR_ENV: Record<string, string> = {
  GITHUB_TOKEN: OPERATOR_GH_TOKEN,
  LAUNCHDARKLY_API_TOKEN: OPERATOR_LD_TOKEN,
  LAUNCHDARKLY_PROJECT_KEY: OPERATOR_LD_PROJECT,
};

function cfg(): KeptConfig {
  return {
    operatorTeam: "T_OPERATOR",
    demoTeam: undefined,
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
}

let saved: Record<string, string | undefined> = {};
let calls: { url: string; auth: string }[] = [];

beforeEach(() => {
  saved = {};
  for (const k of Object.keys(OPERATOR_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = OPERATOR_ENV[k];
  }
  calls = [];
  // Every outbound HTTP request is recorded. The simulated proof server is fully in-process
  // (InMemoryTransport), so ANY fetch here is a REAL request to LaunchDarkly / GitHub.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), auth: String(init?.headers?.authorization ?? "") });
      return {
        ok: true,
        json: async () => ({ conclusion: "success", status: "completed", environments: { production: { on: true } } }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  for (const k of Object.keys(OPERATOR_ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("operator-env creds NEVER serve a non-operator tenant's proof reads (invariant #4)", () => {
  it("a non-operator tenant with only a proof_targets flag+ci does NOT read via the operator's LaunchDarkly/GitHub creds", async () => {
    const store = new InMemoryTenantConfigStore();
    // A non-operator, non-demo tenant configures ONLY a proof-target mapping (allowed via the
    // Connections UI). It connects NO LaunchDarkly, NO Jira, NO GitHub of its own.
    await store.set("T_TENANT", "proof_targets", {
      "*": { flag: { key: "leak-flag" }, ci: { owner: "victim-org", repo: "private-repo", runId: 99 } },
    });

    const provider = makeProofCollectorProvider(store, cfg());
    const collector = await provider("T_TENANT");
    expect(collector).not.toBeNull();

    await collector!.collect(
      mkObl("POSSIBLE_FULFILLMENT", { team: "T_TENANT", customer: "Acme", subject_canonical: "S1" }),
    );

    // The FIX's guarantee: no operator credential may authenticate this tenant's reads.
    const auths = calls.map((c) => c.auth);
    const urls = calls.map((c) => c.url);
    expect(auths).not.toContain(OPERATOR_LD_TOKEN); // LaunchDarkly REST uses the raw token
    expect(auths).not.toContain(`Bearer ${OPERATOR_GH_TOKEN}`); // GitHub uses Bearer
    expect(urls.some((u) => u.includes("launchdarkly.com"))).toBe(false);
    expect(urls.some((u) => u.includes("api.github.com"))).toBe(false);
  });
});
