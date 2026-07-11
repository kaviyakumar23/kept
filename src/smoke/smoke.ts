/**
 * Live smoke test — "is everything actually working?"
 *
 * A personal, on-demand check (NOT a CI gate; the 263 hermetic tests already cover the engine).
 * It exercises the things that break BETWEEN deploys against the REAL config: the app's HTTP
 * surface, the LLM classifier, and each live proof source (LaunchDarkly / Jira / GitHub Actions),
 * printing a green/red report per step. Run where the secrets live:
 *
 *   flyctl ssh console -C "npm run smoke"          # on Fly (all secrets + DB in env)
 *   SMOKE_URL=https://<host> npm run smoke         # locally with env injected
 *
 * Optional overrides (skip a probe by leaving it unset):
 *   SMOKE_URL         health/endpoint base (default: skip HTTP checks)
 *   SMOKE_FLAG_KEY    LaunchDarkly flag to read (default: sso-login-fix)
 *   SMOKE_JIRA_KEY    Jira issue to read (e.g. KD-2)
 *   SMOKE_GH          GitHub CI run "owner/repo/runId"
 */
import { loadConfig, type KeptConfig } from "../config.js";
import { selectLlm } from "../llm/select.js";
import { classifyMessage } from "../llm/classify.js";
import { buildProofCollector } from "../integrations/proofSources.js";
import { LaunchDarklyProofAdapter } from "../integrations/launchDarkly.js";
import { JiraProofAdapter } from "../integrations/jira.js";
import { GitHubActionsProofAdapter } from "../integrations/githubActions.js";
import { McpProofClient } from "../integrations/mcp.js";
import { DEMO_FLAG_KEY } from "../demo/demoRuntime.js";

// --- tiny green/red reporter ------------------------------------------------
type Status = "pass" | "fail" | "skip";
const results: { status: Status; label: string; detail: string }[] = [];
const record = (status: Status, label: string, detail = "") => {
  results.push({ status, label, detail });
  const icon = status === "pass" ? "\x1b[32m✓\x1b[0m" : status === "fail" ? "\x1b[31m✗\x1b[0m" : "\x1b[90m–\x1b[0m";
  console.log(`  ${icon} ${label}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
};
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Run a probe; any throw is a fail (never crashes the run). Return the value for chaining. */
async function probe<T>(label: string, fn: () => Promise<T>, describe: (v: T) => string = () => ""): Promise<T | undefined> {
  try {
    const v = await fn();
    record("pass", label, describe(v));
    return v;
  } catch (e) {
    record("fail", label, e instanceof Error ? e.message : String(e));
    return undefined;
  }
}

// --- the checks -------------------------------------------------------------
async function httpChecks(base: string): Promise<void> {
  section("App surface");
  await probe(
    "GET /healthz → 200",
    async () => {
      const r = await fetch(`${base}/healthz`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.status;
    },
    (s) => `HTTP ${s}`,
  );
  // The Slack events endpoint must REJECT an unsigned request (signature verification is on).
  await probe(
    "POST /slack/events unsigned → rejected",
    async () => {
      const r = await fetch(`${base}/slack/events`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status === 200) throw new Error("accepted an unsigned request (signing check off!)");
      return r.status;
    },
    (s) => `HTTP ${s} (signed-only, good)`,
  );
}

async function llmCheck(cfg: KeptConfig): Promise<void> {
  section("LLM classifier");
  const provider = cfg.llmProvider ?? (cfg.openaiApiKey ? "openai" : cfg.anthropicApiKey ? "anthropic" : "mock");
  record(provider === "mock" ? "skip" : "pass", "provider configured", provider);
  if (provider === "mock") {
    record("skip", "classify a sample promise", "no live LLM key set");
    return;
  }
  const llm = selectLlm(cfg, () => ({}));
  await probe(
    "classify: “We'll ship the SSO fix for Acme by Friday.”",
    async () => {
      const c = await classifyMessage(llm.provider, { messageText: "We'll ship the SSO fix for Acme by Friday." });
      const isCommitment = c.signal === "TENTATIVE_COMMITMENT" || c.signal === "CONFIRMED_COMMITMENT";
      if (!isCommitment) throw new Error(`classified as ${c.signal} (expected a commitment)`);
      return c;
    },
    (c) => `${c.signal} · ${(c.confidence * 100).toFixed(0)}%`,
  );
}

/** Faithfully reconstruct the LaunchDarkly adapter the collector would use (MCP-preferred, else REST). */
function ldAdapter(cfg: KeptConfig): LaunchDarklyProofAdapter {
  const ld = cfg.proof.launchDarkly;
  return new LaunchDarklyProofAdapter(
    ld.mcpToken && ld.mcpUrl
      ? { mcp: McpProofClient.hosted({ token: ld.mcpToken, url: ld.mcpUrl, label: "mcp(launchdarkly-proof)" }), mcpFlagTool: ld.mcpFlagTool, projectKey: ld.projectKey, environment: ld.environment }
      : { apiToken: ld.apiToken, projectKey: ld.projectKey, environment: ld.environment, baseUrl: ld.baseUrl },
  );
}
function jiraAdapter(cfg: KeptConfig): JiraProofAdapter {
  const j = cfg.proof.jira;
  return new JiraProofAdapter(
    j.mcpToken && j.mcpUrl
      ? { mcp: McpProofClient.hosted({ token: j.mcpToken, url: j.mcpUrl, label: "mcp(atlassian-proof)" }), mcpStatusTool: j.mcpStatusTool, cloudId: j.cloudId }
      : { baseUrl: j.baseUrl, email: j.email, apiToken: j.apiToken },
  );
}

async function proofChecks(cfg: KeptConfig): Promise<void> {
  section("Proof sources (real integrations)");
  const built = await buildProofCollector(cfg);
  record(built ? "pass" : "skip", "proof collector wired", built ? `live: ${built.liveSources.join(", ") || "none (simulated fallback)"}` : "nothing configured");

  // LaunchDarkly — read the production flag state directly (the money integration).
  const ld = ldAdapter(cfg);
  if (ld.configured()) {
    const flagKey = process.env.SMOKE_FLAG_KEY || DEMO_FLAG_KEY;
    await probe(
      `LaunchDarkly · get_flag_state(${flagKey}, production)`,
      async () => {
        const r = await ld.query("get_flag_state", { flag_key: flagKey, environment: "production" });
        if (!r || typeof r.enabled !== "boolean") throw new Error("no boolean 'enabled' returned");
        return r;
      },
      (r) => `flag is ${r.enabled ? "ON ✅" : "OFF ⛔"} in production`,
    );
  } else {
    record("skip", "LaunchDarkly flag read", "not configured (KEPT_LD_* unset)");
  }

  // Jira — read a linked issue's status (needs a real key to probe).
  const jira = jiraAdapter(cfg);
  const jiraKey = process.env.SMOKE_JIRA_KEY;
  if (jira.configured() && jiraKey) {
    await probe(
      `Jira · get_issue_status(${jiraKey})`,
      async () => {
        const r = await jira.query("get_issue_status", { key: jiraKey, system: "jira" });
        if (!r || !r.status) throw new Error("no status returned");
        return r;
      },
      (r) => `status: ${String(r.status)}`,
    );
  } else {
    record("skip", "Jira issue read", jira.configured() ? "set SMOKE_JIRA_KEY=KD-2 to probe" : "not configured");
  }

  // GitHub Actions — the always-live CI source. Needs a real run "owner/repo/runId".
  const ghToken = process.env.GITHUB_TOKEN;
  const gh = new GitHubActionsProofAdapter({ token: ghToken });
  const ghRef = process.env.SMOKE_GH; // owner/repo/runId
  if (ghToken && ghRef) {
    const [owner, repo, runId] = ghRef.split("/");
    await probe(
      `GitHub Actions · get_workflow_run(${ghRef})`,
      async () => {
        const r = await gh.query("get_workflow_run", { owner, repo, run_id: runId });
        if (!r || !r.conclusion) throw new Error("no conclusion returned");
        return r;
      },
      (r) => `conclusion: ${String(r.conclusion)}`,
    );
  } else {
    record("skip", "GitHub Actions run read", ghToken ? "set SMOKE_GH=owner/repo/runId to probe" : "no GITHUB_TOKEN");
  }
}

async function main(): Promise<void> {
  console.log("\n\x1b[1m🔎 Kept live smoke test\x1b[0m — verifying the deployed app + real integrations\n");
  const cfg = loadConfig();
  const base = process.env.SMOKE_URL?.replace(/\/$/, "");
  if (base) await httpChecks(base);
  else record("skip", "App surface (HTTP)", "set SMOKE_URL=https://<host> to probe");

  await llmCheck(cfg);
  await proofChecks(cfg);

  // Summary
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  console.log(`\n\x1b[1mSummary:\x1b[0m \x1b[32m${pass} passed\x1b[0m · \x1b[31m${fail} failed\x1b[0m · \x1b[90m${skip} skipped\x1b[0m\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke run crashed:", e);
  process.exit(1);
});
