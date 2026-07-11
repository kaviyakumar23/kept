import { readFileSync } from "node:fs";
import type { KeptConfig } from "../config.js";
import type { Obligation } from "../domain/obligation.js";
import { McpProofClient, createSimulatedProofServer, type McpQueryClient, type McpStructured } from "./mcp.js";
import { GitHubActionsProofAdapter } from "./githubActions.js";
import { LaunchDarklyProofAdapter } from "./launchDarkly.js";
import { JiraProofAdapter } from "./jira.js";
import { ProofCollector, type ProofTarget } from "./proofCollector.js";
import { createHash } from "node:crypto";
import type { TenantConfigStore } from "../store/tenantConfigStore.js";
import { getDemoCollector } from "../demo/demoRuntime.js";

/**
 * W4 — production wiring for the Proof-of-Done sources.
 *
 * Selection mirrors the work-item precedence in server/index.ts and the GitHub-live
 * philosophy (invariant #7): each source uses its REAL adapter when its credentials are
 * configured, otherwise the read is routed to the in-process SIMULATED MCP proof server.
 * So a fully-unconfigured deploy still runs (simulated), and each source upgrades to live
 * independently as its credentials are added. CODE (not the model) picks every tool + arg
 * (invariant #1); the adapters only PROPOSE structured facts to the collector.
 */

/** Routes a proof read to the real adapter for that tool (when configured), else a fallback client. */
interface ProofRoute {
  match: (name: string, args: Record<string, unknown>) => boolean;
  client: McpQueryClient;
}

class RoutingProofClient implements McpQueryClient {
  constructor(
    private readonly routes: ProofRoute[],
    private readonly fallback: McpQueryClient,
  ) {}

  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    const route = this.routes.find((r) => r.match(name, args));
    return (route?.client ?? this.fallback).query(name, args);
  }

  async close(): Promise<void> {
    for (const r of this.routes) await r.client.close().catch(() => undefined);
    await this.fallback.close().catch(() => undefined);
  }
}

/** Optional per-subject proof targets (flag/ci), loaded from KEPT_PROOF_TARGETS_FILE. */
type TargetsMap = Record<
  string,
  {
    flag?: { key: string; environment?: string };
    ci?: { owner: string; repo: string; runId: number | string };
  }
>;

function loadTargetsFile(path: string | undefined): TargetsMap {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TargetsMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // a missing/invalid file just means no flag/status/ci targets — never fatal
  }
}

export interface BuiltProofCollector {
  collector: ProofCollector;
  /** Which real sources are live (for the boot log). Simulated ones are omitted. */
  liveSources: string[];
}

/**
 * Build the production ProofCollector, or return null when NOTHING is configured (no real
 * proof source and no targets file) — in which case production runs exactly as before, with
 * no proof collection. When at least one source is live (or a targets file is present), the
 * collector runs, using real adapters where configured and the simulated server elsewhere.
 */
/** A fully-resolved proof configuration (global env, or a tenant's own) that {@link build} turns into a collector. */
export interface ResolvedProofConfig {
  launchDarkly: Partial<KeptConfig["proof"]["launchDarkly"]>;
  jira: Partial<KeptConfig["proof"]["jira"]>;
  targetsFile?: string;
  /** Inline proof targets (per-tenant Connections config); merged OVER any targetsFile entries. */
  targets?: TargetsMap;
  /** GitHub token for the live CI source (a tenant's own, or the global GITHUB_TOKEN). */
  githubToken?: string;
}

/** Build the global-env collector (operator config / single-token / demo path). */
export function buildProofCollector(cfg: KeptConfig, opts: { now?: () => number } = {}): Promise<BuiltProofCollector | null> {
  return build({ ...cfg.proof, githubToken: process.env.GITHUB_TOKEN }, opts);
}

async function build(p: ResolvedProofConfig, opts: { now?: () => number }): Promise<BuiltProofCollector | null> {
  const targets = { ...loadTargetsFile(p.targetsFile), ...(p.targets ?? {}) };

  // Real adapters (constructed only when their creds are present so `configured()` is true).
  // MCP-preferred (matches the Jira precedence): when a LaunchDarkly MCP token+url are set the
  // adapter reads flag state over the hosted LaunchDarkly MCP server, else via the REST API.
  const ld = new LaunchDarklyProofAdapter(
    p.launchDarkly.mcpToken && p.launchDarkly.mcpUrl
      ? {
          mcp: McpProofClient.hosted({ token: p.launchDarkly.mcpToken, url: p.launchDarkly.mcpUrl, label: "mcp(launchdarkly-proof)" }),
          mcpFlagTool: p.launchDarkly.mcpFlagTool,
          projectKey: p.launchDarkly.projectKey,
          environment: p.launchDarkly.environment,
        }
      : {
          apiToken: p.launchDarkly.apiToken,
          projectKey: p.launchDarkly.projectKey,
          environment: p.launchDarkly.environment,
          baseUrl: p.launchDarkly.baseUrl,
        },
  );
  const jira = new JiraProofAdapter({
    ...(p.jira.mcpToken && p.jira.mcpUrl
      ? { mcp: McpProofClient.hosted({ token: p.jira.mcpToken, url: p.jira.mcpUrl, label: "mcp(atlassian-proof)" }), mcpStatusTool: p.jira.mcpStatusTool, cloudId: p.jira.cloudId }
      : { baseUrl: p.jira.baseUrl, email: p.jira.email, apiToken: p.jira.apiToken }),
  });

  const ldLive = ld.configured();
  const jiraLive = jira.configured();

  const liveSources: string[] = [];
  if (p.githubToken) liveSources.push("github");
  if (ldLive) liveSources.push("launchdarkly");
  if (jiraLive) liveSources.push("jira");

  const haveTargets = Object.keys(targets).length > 0;
  // Nothing to do: no real source and no per-subject targets → don't wire a collector at all.
  if (liveSources.length === 0 && !haveTargets) return null;

  // The simulated proof server backs every tool the real adapters don't cover here.
  const fallback = await createSimulatedProofServer();

  const routes: ProofRoute[] = [];
  if (ldLive) routes.push({ match: (n) => n === "get_flag_state", client: ld });
  if (jiraLive) routes.push({ match: (n, a) => n === "get_issue_status" && a.system === "jira", client: jira });

  const proof = new RoutingProofClient(routes, fallback);
  const ci = new GitHubActionsProofAdapter({ token: p.githubToken });

  const collector = new ProofCollector({
    proof,
    ci,
    now: opts.now,
    // CODE decides which proof to read for an obligation: the linked work item's live status
    // (only when the Jira proof source is configured), plus any per-subject flag/ci targets
    // from the optional targets file.
    targetsFor: (o: Obligation): ProofTarget | null => {
      const t: ProofTarget = {};
      const wi = o.work_item;
      if (wi && wi.system === "jira" && jiraLive) t.work = { system: "jira", key: wi.ref };
      // Resolve a per-subject target, falling back to a per-customer entry and then a "*" catch-all.
      // The subject_canonical is LLM-generated (non-deterministic), so customer/"*" keys let a
      // configured proof target survive re-created obligations without knowing the exact subject.
      const mapped = targets[o.subject_canonical] ?? targets[o.customer] ?? targets["*"];
      if (mapped?.flag) t.flag = mapped.flag;
      if (mapped?.ci) t.ci = mapped.ci;
      return Object.keys(t).length > 0 ? t : null;
    },
  });

  return { collector, liveSources };
}

/**
 * Per-tenant proof collector provider (invariant #4). Resolves EACH workspace's own Connections
 * config (LaunchDarkly / Jira / GitHub / proof-targets) from `tenant_config`, falling back to the
 * global operator env only where the tenant hasn't configured that provider, and builds + caches a
 * collector per team (keyed by a config fingerprint so a Connections change rebuilds on next read).
 * Returns null when neither the tenant nor the operator has any real source or targets.
 */
export function makeProofCollectorProvider(
  store: TenantConfigStore,
  cfg: KeptConfig,
  opts: { now?: () => number } = {},
): (teamId: string) => Promise<ProofCollector | null> {
  const cache = new Map<string, { hash: string; collector: ProofCollector | null }>();
  return async (teamId: string): Promise<ProofCollector | null> => {
    // Judge-demo tenant reads the CONTROLLABLE demo proof source (Demo Controls own its state),
    // never live integrations — so the judge can toggle the flag and the demo can't die on a
    // lapsed trial. All other tenants resolve their own Connections config below.
    if (cfg.demoTeam && teamId === cfg.demoTeam) return getDemoCollector(opts.now ?? (() => Date.now()));
    // The operator's OWN workspace is the only team allowed to use the operator-env credentials
    // (LaunchDarkly/Jira/GitHub + proof-targets file). Every other tenant is strictly isolated below.
    if (cfg.operatorTeam && teamId === cfg.operatorTeam) {
      const hit = cache.get(teamId);
      if (hit && hit.hash === "operator") return hit.collector;
      const built = await buildProofCollector(cfg, opts);
      const collector = built?.collector ?? null;
      cache.set(teamId, { hash: "operator", collector });
      return collector;
    }
    const resolved = await resolveTenantProof(store, teamId, cfg);
    const hash = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
    const hit = cache.get(teamId);
    if (hit && hit.hash === hash) return hit.collector;
    const built = await build(resolved, opts);
    const collector = built?.collector ?? null;
    cache.set(teamId, { hash, collector });
    return collector;
  };
}

const LD_DEFAULTS = { mcpUrl: "https://mcp.launchdarkly.com/mcp/launchdarkly", environment: "production" };

/**
 * Merge a workspace's stored proof config over the operator env fallback. A tenant that has
 * configured a provider uses ITS OWN credentials in isolation (never borrows the operator's token
 * for the same provider); providers it hasn't configured fall back to the operator env.
 */
async function resolveTenantProof(store: TenantConfigStore, teamId: string, cfg: KeptConfig): Promise<ResolvedProofConfig> {
  const [ld, jira, gh, tgt] = await Promise.all([
    store.get(teamId, "launchdarkly"),
    store.get(teamId, "jira"),
    store.get(teamId, "github"),
    store.get(teamId, "proof_targets"),
  ]);
  const ldConfigured = !!(ld && (ld.mcpToken || (ld.apiToken && ld.projectKey)));
  const jiraConfigured = !!(jira && (jira.mcpToken || (jira.apiToken && jira.email && jira.baseUrl)));
  // STRICT per-tenant isolation: a workspace reads ONLY the sources it connected itself. No fallback
  // to the operator's LaunchDarkly/Jira/GitHub or proof-targets file (that's operator-team only, handled
  // above). Unconfigured providers stay empty → no live source → no collector → uses the manual path.
  return {
    launchDarkly: ldConfigured ? { ...LD_DEFAULTS, ...ld } : {},
    jira: jiraConfigured ? { ...jira } : {},
    githubToken: gh?.token,
    targetsFile: undefined,
    targets: tgt ?? undefined,
  };
}
