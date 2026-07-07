import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchDarklyProofAdapter } from "../src/integrations/launchDarkly.js";
import { StatuspageProofAdapter } from "../src/integrations/statuspage.js";
import { JiraProofAdapter } from "../src/integrations/jira.js";
import { LinearProofAdapter } from "../src/integrations/linear.js";
import { ProofCollector } from "../src/integrations/proofCollector.js";
import { createSimulatedProofServer, type McpQueryClient, type McpStructured } from "../src/integrations/mcp.js";
import { buildProofCollector } from "../src/integrations/proofSources.js";
import { loadConfig } from "../src/config.js";
import type { Obligation } from "../src/domain/obligation.js";

/**
 * W4 — REAL Proof-of-Done adapters. Each unit test feeds a CANNED HTTP/MCP response (no real
 * network) and asserts the derived structured fact; each also asserts the missing-creds path
 * returns undefined (so the collector proposes nothing and the simulated server answers upstream).
 */

/** A fetch stub that records the URL/headers it was called with and returns a canned JSON body. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: (opts?.headers ?? {}) as Record<string, string> });
    return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("LaunchDarklyProofAdapter (real feature-flag state)", () => {
  it("parses environments.<env>.on into { enabled, environment } and hits the flag endpoint", async () => {
    const { impl, calls } = stubFetch({ environments: { production: { on: true } } });
    const ld = new LaunchDarklyProofAdapter({ apiToken: "api-xyz", projectKey: "default", fetchImpl: impl });
    expect(ld.configured()).toBe(true);
    const sc = await ld.query("get_flag_state", { flag_key: "sso_login", environment: "production" });
    expect(sc).toEqual({ enabled: true, environment: "production" });
    expect(calls[0].url).toContain("/api/v2/flags/default/sso_login");
    expect(calls[0].url).toContain("env=production");
    expect(calls[0].headers.authorization).toBe("api-xyz"); // raw token, no Bearer
  });

  it("reports enabled:false when the flag is OFF (drives the blocking-negative)", async () => {
    const { impl } = stubFetch({ environments: { production: { on: false } } });
    const ld = new LaunchDarklyProofAdapter({ apiToken: "t", projectKey: "p", fetchImpl: impl });
    expect(await ld.query("get_flag_state", { flag_key: "f" })).toEqual({ enabled: false, environment: "production" });
  });

  it("missing creds → undefined (no fetch); wrong tool → undefined; non-ok → undefined", async () => {
    const { impl, calls } = stubFetch({}, { ok: false, status: 401 });
    expect(await new LaunchDarklyProofAdapter({ fetchImpl: impl }).query("get_flag_state", { flag_key: "f" })).toBeUndefined();
    expect(new LaunchDarklyProofAdapter({}).configured()).toBe(false);
    expect(await new LaunchDarklyProofAdapter({ apiToken: "t", projectKey: "p", fetchImpl: impl }).query("other", {})).toBeUndefined();
    expect(await new LaunchDarklyProofAdapter({ apiToken: "t", projectKey: "p", fetchImpl: impl }).query("get_flag_state", { flag_key: "f" })).toBeUndefined();
    expect(calls.length).toBe(1); // only the non-ok case reached fetch (missing-creds + wrong-tool short-circuit)
  });
});

describe("StatuspageProofAdapter (real component status)", () => {
  it("parses status into { component_status } via the component endpoint with OAuth auth", async () => {
    const { impl, calls } = stubFetch({ status: "degraded_performance" });
    const sp = new StatuspageProofAdapter({ apiKey: "sp-key", pageId: "page1", fetchImpl: impl });
    expect(sp.configured()).toBe(true);
    expect(await sp.query("get_status_page", { component: "comp7" })).toEqual({ component_status: "degraded_performance" });
    expect(calls[0].url).toContain("/v1/pages/page1/components/comp7");
    expect(calls[0].headers.authorization).toBe("OAuth sp-key");
  });

  it("missing creds → undefined; wrong tool → undefined", async () => {
    const { impl } = stubFetch({ status: "operational" });
    expect(await new StatuspageProofAdapter({ fetchImpl: impl }).query("get_status_page", { component: "c" })).toBeUndefined();
    expect(await new StatuspageProofAdapter({ apiKey: "k", pageId: "p", fetchImpl: impl }).query("get_flag_state", {})).toBeUndefined();
  });
});

describe("JiraProofAdapter (real issue status)", () => {
  it("REST: parses fields.status, normalizing a done category to 'Done' even with a custom name", async () => {
    const { impl, calls } = stubFetch({ fields: { status: { name: "Shipped", statusCategory: { key: "done" } } } });
    const jira = new JiraProofAdapter({ baseUrl: "https://acme.atlassian.net", email: "a@b.co", apiToken: "tok", fetchImpl: impl });
    expect(jira.configured()).toBe(true);
    expect(await jira.query("get_issue_status", { key: "ACME-12" })).toEqual({ status: "Done", category: "done" });
    expect(calls[0].url).toContain("/rest/api/3/issue/ACME-12?fields=status");
    expect(calls[0].headers.authorization).toMatch(/^Basic /);
  });

  it("REST: a non-done category keeps the display name", async () => {
    const { impl } = stubFetch({ fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } });
    const jira = new JiraProofAdapter({ baseUrl: "https://x", email: "e", apiToken: "t", fetchImpl: impl });
    expect(await jira.query("get_issue_status", { key: "X-1" })).toEqual({ status: "In Progress", category: "indeterminate" });
  });

  it("MCP: delegates to the injected read client and extracts a nested status", async () => {
    const mcp: McpQueryClient = {
      query: async (): Promise<McpStructured> => ({ status: { name: "Done", statusCategory: { key: "done" } } }),
      close: async () => undefined,
    };
    const jira = new JiraProofAdapter({ mcp });
    expect(jira.configured()).toBe(true);
    expect(await jira.query("get_issue_status", { key: "ACME-9" })).toEqual({ status: "Done" });
  });

  it("no path configured → undefined; wrong tool → undefined", async () => {
    expect(new JiraProofAdapter({}).configured()).toBe(false);
    expect(await new JiraProofAdapter({}).query("get_issue_status", { key: "A-1" })).toBeUndefined();
    expect(await new JiraProofAdapter({ baseUrl: "x", email: "e", apiToken: "t" }).query("get_flag_state", {})).toBeUndefined();
  });
});

describe("LinearProofAdapter (real issue status)", () => {
  it("GraphQL: normalizes a completed state type to 'Done'", async () => {
    const { impl, calls } = stubFetch({ data: { issue: { state: { name: "Merged", type: "completed" } } } });
    const linear = new LinearProofAdapter({ apiKey: "lin_key", fetchImpl: impl });
    expect(linear.configured()).toBe(true);
    expect(await linear.query("get_issue_status", { key: "ENG-3" })).toEqual({ status: "Done", state_type: "completed" });
    expect(calls[0].url).toContain("api.linear.app/graphql");
    expect(calls[0].headers.authorization).toBe("lin_key");
  });

  it("GraphQL: a started state keeps the display name", async () => {
    const { impl } = stubFetch({ data: { issue: { state: { name: "In Progress", type: "started" } } } });
    const linear = new LinearProofAdapter({ apiKey: "k", fetchImpl: impl });
    expect(await linear.query("get_issue_status", { key: "ENG-4" })).toEqual({ status: "In Progress", state_type: "started" });
  });

  it("MCP: delegates to the injected read client and extracts a nested state", async () => {
    const mcp: McpQueryClient = {
      query: async (): Promise<McpStructured> => ({ state: { name: "Done", type: "completed" } }),
      close: async () => undefined,
    };
    const linear = new LinearProofAdapter({ mcp });
    expect(await linear.query("get_issue_status", { key: "ENG-5" })).toEqual({ status: "Done" });
  });

  it("no path configured → undefined", async () => {
    expect(new LinearProofAdapter({}).configured()).toBe(false);
    expect(await new LinearProofAdapter({}).query("get_issue_status", { key: "E-1" })).toBeUndefined();
  });
});

describe("ProofCollector — work target → ticket_status evidence (via get_issue_status)", () => {
  it("reads a linked issue's status over the simulated proof server and proposes ticket_status", async () => {
    const proof = await createSimulatedProofServer({ flags: {}, statuses: {}, issues: { "ENG-7": { status: "Done" } } });
    const collector = new ProofCollector({
      proof,
      targetsFor: () => ({ work: { system: "linear", key: "ENG-7" } }),
      now: () => Date.parse("2026-06-18T10:00:00Z"),
    });
    const ev = await collector.collect({ subject_canonical: "X" } as unknown as Obligation);
    expect(ev).toHaveLength(1);
    expect(ev[0].source).toBe("linear");
    expect(ev[0].kind).toBe("ticket_status");
    expect(ev[0].data.status).toBe("Done");
    expect(ev[0].ref).toBe("ENG-7@2026-06-18T10:00:00.000Z"); // check instant encoded → zero-copy dedupe safe
    await proof.close();
  });
});

describe("buildProofCollector — real-vs-simulated selection", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = [
    "GITHUB_TOKEN", "LAUNCHDARKLY_API_TOKEN", "LAUNCHDARKLY_PROJECT_KEY", "STATUSPAGE_API_KEY", "STATUSPAGE_PAGE_ID",
    "ATLASSIAN_MCP_TOKEN", "ATLASSIAN_MCP_URL", "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN",
    "LINEAR_MCP_TOKEN", "LINEAR_MCP_URL", "LINEAR_API_KEY", "KEPT_PROOF_TARGETS_FILE",
  ];
  beforeEach(() => {
    for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  });

  it("returns null when nothing is configured (production runs with no proof step)", async () => {
    expect(await buildProofCollector(loadConfig())).toBeNull();
  });

  it("goes live for LaunchDarkly when its creds are present", async () => {
    process.env.LAUNCHDARKLY_API_TOKEN = "api-x";
    process.env.LAUNCHDARKLY_PROJECT_KEY = "default";
    const built = await buildProofCollector(loadConfig());
    expect(built).not.toBeNull();
    expect(built!.liveSources).toContain("launchdarkly");
    await (built!.collector as unknown as { d: { proof: McpQueryClient } }).d.proof.close();
  });

  it("wires a collector when only a targets file is present (flag/status/ci mapping), no creds needed", async () => {
    const file = join(tmpdir(), `kept-targets-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ SSO_LOGIN_BUG: { flag: { key: "sso_login" } } }));
    process.env.KEPT_PROOF_TARGETS_FILE = file;
    try {
      const built = await buildProofCollector(loadConfig());
      expect(built).not.toBeNull();
      expect(built!.liveSources).toHaveLength(0); // no real source live, but the targets map drives simulated reads
      await (built!.collector as unknown as { d: { proof: McpQueryClient } }).d.proof.close();
    } finally {
      rmSync(file, { force: true });
    }
  });
});
