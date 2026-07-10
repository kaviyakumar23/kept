import * as dotenv from "dotenv";

dotenv.config();

export interface KeptConfig {
  llmModel: string;
  anthropicApiKey: string | undefined;
  /** OpenAI provider (alternative to Anthropic; see selectLlm precedence). */
  openaiApiKey: string | undefined;
  /** OpenAI model — overridable via OPENAI_MODEL; defaults to a Structured-Outputs model. */
  openaiModel: string;
  /** Optional hard override of provider selection: "openai" | "anthropic" | "mock". */
  llmProvider: "openai" | "anthropic" | "mock" | undefined;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  slack: {
    botToken: string | undefined;
    signingSecret: string | undefined;
    appToken: string | undefined;
    // W2 — OAuth (multi-workspace HTTP mode). When clientId+clientSecret+stateSecret are
    // all set, the app boots in OAuth HTTP mode (no static bot token, no Socket Mode) and
    // resolves each workspace's bot token from the InstallationStore. Otherwise it keeps the
    // existing single-token / Socket Mode path so `npm run demo` and the tests keep working.
    clientId: string | undefined;
    clientSecret: string | undefined;
    stateSecret: string | undefined;
  };
  /** Public HTTPS origin the deployed app is reachable at (for docs/manifest wiring). */
  publicUrl: string | undefined;
  riskWindowMs: number;
  /**
   * W4 — Proof-of-Done sources. Each is REAL when its credentials are present, else the
   * proof-collector routes to the in-process simulated MCP proof server (so the offline
   * demo + hermetic tests are unchanged). GitHub Actions (the always-live source) reads its
   * token straight from GITHUB_TOKEN inside GitHubActionsProofAdapter.
   */
  proof: {
    /** LaunchDarkly feature-flag production state — hosted LaunchDarkly MCP (preferred) or REST. */
    launchDarkly: {
      mcpToken: string | undefined; mcpUrl: string; mcpFlagTool: string | undefined;
      apiToken: string | undefined; projectKey: string | undefined; environment: string; baseUrl: string | undefined;
    };
    /** Jira issue status — hosted Atlassian MCP (preferred) or Jira Cloud REST. */
    jira: {
      mcpToken: string | undefined; mcpUrl: string | undefined; cloudId: string | undefined; mcpStatusTool: string | undefined;
      baseUrl: string | undefined; email: string | undefined; apiToken: string | undefined;
    };
    /** Optional JSON file mapping subject_canonical → { flag, ci } proof targets. */
    targetsFile: string | undefined;
  };
}

function normalizeLlmProvider(raw: string | undefined): KeptConfig["llmProvider"] {
  const v = raw?.trim().toLowerCase();
  return v === "openai" || v === "anthropic" || v === "mock" ? v : undefined;
}

export function loadConfig(): KeptConfig {
  return {
    llmModel: process.env.KEPT_LLM_MODEL ?? "claude-opus-4-8",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
    llmProvider: normalizeLlmProvider(process.env.KEPT_LLM_PROVIDER),
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      appToken: process.env.SLACK_APP_TOKEN,
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_STATE_SECRET,
    },
    publicUrl: process.env.KEPT_PUBLIC_URL,
    riskWindowMs: Number(process.env.KEPT_RISK_WINDOW_MS ?? 24 * 60 * 60 * 1000),
    proof: {
      launchDarkly: {
        // MCP-preferred: LAUNCHDARKLY_MCP_TOKEN is a LaunchDarkly API access token used as the
        // hosted-MCP Bearer; when set, the adapter reads flag state over MCP, else via REST.
        mcpToken: process.env.LAUNCHDARKLY_MCP_TOKEN,
        mcpUrl: process.env.LAUNCHDARKLY_MCP_URL ?? "https://mcp.launchdarkly.com/mcp/launchdarkly",
        mcpFlagTool: process.env.LAUNCHDARKLY_MCP_FLAG_TOOL,
        apiToken: process.env.LAUNCHDARKLY_API_TOKEN,
        projectKey: process.env.LAUNCHDARKLY_PROJECT_KEY,
        environment: process.env.LAUNCHDARKLY_ENVIRONMENT ?? "production",
        baseUrl: process.env.LAUNCHDARKLY_BASE_URL,
      },
      jira: {
        mcpToken: process.env.ATLASSIAN_MCP_TOKEN,
        mcpUrl: process.env.ATLASSIAN_MCP_URL,
        cloudId: process.env.JIRA_CLOUD_ID,
        mcpStatusTool: process.env.JIRA_MCP_STATUS_TOOL,
        baseUrl: process.env.JIRA_BASE_URL,
        email: process.env.JIRA_EMAIL,
        apiToken: process.env.JIRA_API_TOKEN,
      },
      targetsFile: process.env.KEPT_PROOF_TARGETS_FILE,
    },
  };
}

/**
 * W2 — is the OAuth HTTP path fully configured? Requires the three OAuth secrets.
 * When false, the app runs the existing single-token / Socket Mode path.
 */
export function isOAuthMode(cfg: KeptConfig): boolean {
  return Boolean(cfg.slack.clientId && cfg.slack.clientSecret && cfg.slack.stateSecret);
}

/**
 * Invariant #6 / OAuth posture — the DEPLOYED app MUST authorize via per-workspace OAuth; the
 * single-token / Socket Mode path is a LOCAL-DEV convenience only. Throws if a production process
 * would boot without OAuth (e.g. a stray SLACK_BOT_TOKEN and no OAuth trio), so a hard-coded
 * single-workspace token can never silently run in production. Fails closed. Call at boot.
 */
export function assertProductionOAuth(cfg: KeptConfig, nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (!isOAuthMode(cfg) && nodeEnv === "production") {
    throw new Error(
      "Production requires OAuth: set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_STATE_SECRET. The single-workspace SLACK_BOT_TOKEN path is for local development only.",
    );
  }
}

/**
 * The minimal bot scopes Kept requests at install (must match slack-manifest.yaml).
 * Marketplace constraint (invariant #6): granular scopes only — no blanket
 * `search:read` / `read` / `post` / `client`.
 */
export const SLACK_BOT_SCOPES: string[] = [
  "chat:write",
  "im:write",
  "im:history",
  "assistant:write",
  "commands",
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  // W3 — Real-Time Search API (assistant.search.context). GRANULAR search scopes only;
  // never the banned blanket `search:read`. Gated at runtime by KEPT_RTS=1.
  "search:read.public",
  "search:read.files",
  "search:read.users",
];
