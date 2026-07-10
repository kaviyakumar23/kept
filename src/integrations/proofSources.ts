import { readFileSync } from "node:fs";
import type { KeptConfig } from "../config.js";
import type { Obligation } from "../domain/obligation.js";
import { McpProofClient, createSimulatedProofServer, type McpQueryClient, type McpStructured } from "./mcp.js";
import { GitHubActionsProofAdapter } from "./githubActions.js";
import { LaunchDarklyProofAdapter } from "./launchDarkly.js";
import { JiraProofAdapter } from "./jira.js";
import { ProofCollector, type ProofTarget } from "./proofCollector.js";

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
export function buildProofCollector(cfg: KeptConfig, opts: { now?: () => number } = {}): Promise<BuiltProofCollector | null> {
  return build(cfg, opts);
}

async function build(cfg: KeptConfig, opts: { now?: () => number }): Promise<BuiltProofCollector | null> {
  const p = cfg.proof;
  const targets = loadTargetsFile(p.targetsFile);

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
  if (process.env.GITHUB_TOKEN) liveSources.push("github");
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
  const ci = new GitHubActionsProofAdapter();

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
