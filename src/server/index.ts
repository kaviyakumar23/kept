import { loadConfig, isOAuthMode, assertProductionOAuth, SLACK_BOT_SCOPES } from "../config.js";
import { InMemoryEventStore } from "../store/memoryStore.js";
import { PostgresEventStore } from "../store/postgresStore.js";
import type { EventStore } from "../store/eventStore.js";
import { PostgresInstallationStore, InMemoryInstallationStore, type KeptInstallationStore } from "../store/installationStore.js";
import { PostgresTrustLinkStore, InMemoryTrustLinkStore, type TrustLinkStore } from "../store/trustLinkStore.js";
import { ObligationService } from "../engine/obligationService.js";
import { InMemoryScheduler } from "../scheduler/inMemoryScheduler.js";
import { BullmqScheduler } from "../scheduler/bullmqScheduler.js";
import { PostgresScheduler } from "../scheduler/postgresScheduler.js";
import type { Scheduler, ReminderHandler } from "../scheduler/scheduler.js";
import type { Notifier } from "../slack/notifier.js";
import { selectLlm } from "../llm/select.js";
import type { WorkItemAdapter } from "../integrations/linear.js";
import { JiraApiAdapter } from "../integrations/jira.js";
import { McpWorkItemAdapter, createSimulatedMcpWorkItems } from "../integrations/mcp.js";
import { buildProofCollector, makeProofCollectorProvider } from "../integrations/proofSources.js";
import { InMemoryTenantConfigStore, PostgresTenantConfigStore, type TenantConfigStore } from "../store/tenantConfigStore.js";
import { InMemoryUsageStore, PostgresUsageStore, type UsageStore } from "../store/usageStore.js";
import { WebClient } from "@slack/web-api";
import {
  LedgerRtsRetriever,
  CompositeRtsRetriever,
  SlackRtsRetriever,
  SlackAssistantSearchRetriever,
  type SlackSearchClient,
  type AssistantSearchClient,
  type AssistantSearchResult,
  type RtsRetriever,
} from "../slack/rts.js";
import { FileRoadmapSource, type RoadmapSource } from "../policy/roadmap.js";
import { PostgresRoadmapSource } from "../integrations/roadmapPostgres.js";
import { KeptOrchestrator } from "../app/orchestrator.js";
import { reminderMessage } from "../slack/blocks.js";
import { heuristicResponder } from "../eval/scenarios.js";
import { buildSlackApp } from "./slackApp.js";
import { createWebhookServer, keptCustomRoutes } from "./webhookServer.js";

/**
 * Production boot. Hybrid substrate: REAL Slack surface (Events API + Block Kit)
 * with simulated/replayable Linear + deploy webhooks by default. Each external
 * dependency upgrades to its real adapter when its env is configured.
 */
async function main() {
  const cfg = loadConfig();
  const oauth = isOAuthMode(cfg);
  if (!cfg.slack.signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required (see .env.example)");
  }
  if (!oauth && !cfg.slack.botToken) {
    throw new Error("SLACK_BOT_TOKEN is required (or set SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_STATE_SECRET for OAuth HTTP mode)");
  }
  // Invariant #6 / OAuth posture — fail closed if a production process would boot the
  // single-workspace token path (the deployed app must authorize via per-workspace OAuth).
  assertProductionOAuth(cfg);

  const store: EventStore = cfg.databaseUrl
    ? await (async () => {
        const pg = new PostgresEventStore({ connectionString: cfg.databaseUrl });
        await pg.init();
        return pg;
      })()
    : new InMemoryEventStore();

  const service = new ObligationService(store);

  // W6 — trust-page capability store (Postgres if a DB is set, else in-memory). Backs the
  // per-(team, customer) tokens that authorize `GET /trust/:token` and the /kept mint/revoke.
  const trustLinks: TrustLinkStore = cfg.databaseUrl
    ? await (async () => {
        const t = new PostgresTrustLinkStore({ connectionString: cfg.databaseUrl });
        await t.init();
        return t;
      })()
    : new InMemoryTrustLinkStore();

  // Provider precedence: OPENAI_API_KEY → openai, else ANTHROPIC_API_KEY → anthropic,
  // else the deterministic mock (KEPT_LLM_PROVIDER can force a specific one). See selectLlm.
  const { provider: llm, label: llmLabel } = selectLlm(cfg, heuristicResponder);

  // Work items go through MCP by default (the hackathon's "MCP server integration").
  // Precedence: Atlassian/Jira MCP > Jira REST > an in-process SIMULATED MCP server (real
  // client↔server round-trip, no network).
  let workItemsMode: string;
  let workItems: WorkItemAdapter;
  if (process.env.ATLASSIAN_MCP_TOKEN) {
    workItems = McpWorkItemAdapter.atlassian({ token: process.env.ATLASSIAN_MCP_TOKEN, url: process.env.ATLASSIAN_MCP_URL, cloudId: process.env.JIRA_CLOUD_ID, projectKey: process.env.JIRA_PROJECT_KEY, toolName: process.env.KEPT_MCP_TOOL });
    workItemsMode = "mcp:atlassian";
  } else if (process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY) {
    workItems = new JiraApiAdapter({ baseUrl: process.env.JIRA_BASE_URL, email: process.env.JIRA_EMAIL, apiToken: process.env.JIRA_API_TOKEN, projectKey: process.env.JIRA_PROJECT_KEY });
    workItemsMode = "jira-rest";
  } else {
    workItems = await createSimulatedMcpWorkItems();
    workItemsMode = "mcp:simulated";
  }

  // W4 — Proof-of-Done collector. Each source (LaunchDarkly / Jira / GitHub Actions) upgrades to
  // its REAL adapter when configured, else the collector routes to the in-process simulated MCP
  // proof server. Null when nothing is configured (no proof step).
  const builtProof = await buildProofCollector(cfg);
  const proofMode = builtProof ? (builtProof.liveSources.length ? `live(${builtProof.liveSources.join(",")})` : "simulated") : "off";

  // Per-tenant integration config (the Connections UI): each workspace's own proof sources,
  // encrypted at rest and scoped by team_id. The proof collector is resolved PER acting team from
  // it, falling back to the operator env so the single-workspace/demo path is unchanged.
  const tenantConfig: TenantConfigStore = cfg.databaseUrl
    ? await (async (url: string) => { const t = new PostgresTenantConfigStore({ connectionString: url }); await t.init(); return t; })(cfg.databaseUrl)
    : new InMemoryTenantConfigStore();
  const proofCollectorFor = makeProofCollectorProvider(tenantConfig, cfg);

  // "Pilot" free-tier metering: monthly LLM-classification counter per workspace + the cap resolver
  // (a per-tenant plan override wins; else the env default KEPT_PILOT_LLM_LIMIT). Caps AI spend.
  const usage: UsageStore = cfg.databaseUrl
    ? await (async (url: string) => { const u = new PostgresUsageStore({ connectionString: url }); await u.init(); return u; })(cfg.databaseUrl)
    : new InMemoryUsageStore();
  const pilotLimitFor = async (teamId: string): Promise<number> => {
    const plan = await tenantConfig.get(teamId, "plan");
    if (plan && plan.llmLimit === null) return Number.POSITIVE_INFINITY; // paid workspace → unlimited
    if (plan && typeof plan.llmLimit === "number") return plan.llmLimit;
    return cfg.pilotLlmLimit;
  };

  const fallbackOwner = process.env.KEPT_DEFAULT_OWNER ?? "U_ACCOUNT_MANAGER";

  // Roadmap source for the contradiction check: a JSON file, else a Postgres table, else none.
  const roadmapSource: RoadmapSource | undefined = process.env.KEPT_ROADMAP_FILE
    ? new FileRoadmapSource(process.env.KEPT_ROADMAP_FILE)
    : cfg.databaseUrl
      ? new PostgresRoadmapSource({ connectionString: cfg.databaseUrl })
      : undefined;

  // W2 — multi-workspace OAuth needs an InstallationStore (Postgres if a DB is set,
  // else in-memory). Also the source of truth for webhook → tenant routing.
  let installationStore: KeptInstallationStore | undefined;
  if (oauth) {
    if (cfg.databaseUrl) {
      const pgStore = new PostgresInstallationStore({ connectionString: cfg.databaseUrl });
      await pgStore.init();
      installationStore = pgStore;
    } else {
      installationStore = new InMemoryInstallationStore();
    }
  }

  // Reminders/nudges go to the obligation owner — never the customer channel (D3).
  // The notifier is created inside buildSlackApp; the handler reads it via this holder
  // so out-of-band reminders resolve the owning tenant's bot token (W2).
  const notifierRef: { n?: Notifier } = {};
  const reminderHandler: ReminderHandler = async (job) => {
    const o = await service.getObligation(job.obligationId);
    if (!o || ["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state) || !notifierRef.n) return;
    // A nudge is a DM to a real user; a time-triggered reminder has no sender to fall back to, so
    // if the owner isn't a valid Slack user id (e.g. an LLM-guessed name or the U_ACCOUNT_MANAGER
    // placeholder) there's simply no one to DM — skip quietly rather than fail the poll loop.
    const owner = o.owner ?? fallbackOwner;
    if (!/^[UW][A-Z0-9]{2,}$/.test(owner)) return;
    const { text, blocks } = reminderMessage(o, job.kind);
    try {
      await notifierRef.n.sendPrivate(owner, { text, blocks }, o.team);
    } catch {
      /* best-effort nudge — a failed DM must never crash the scheduler poll loop */
    }
  };

  // Scheduler precedence: Redis/BullMQ if configured → Postgres (single-datastore, no
  // Redis; the hosted path) → in-memory. Keep the existing Redis behavior unchanged.
  const pgScheduler = !cfg.redisUrl && cfg.databaseUrl ? new PostgresScheduler({ connectionString: cfg.databaseUrl }, reminderHandler) : null;
  const scheduler: Scheduler = cfg.redisUrl
    ? new BullmqScheduler({ host: new URL(cfg.redisUrl).hostname, port: Number(new URL(cfg.redisUrl).port || 6379) }, reminderHandler)
    : (pgScheduler ?? new InMemoryScheduler(reminderHandler));
  if (pgScheduler) {
    await pgScheduler.init();
    pgScheduler.start();
  }

  // Invariant #4 — uninstall data-deletion: let the in-memory event store's `purgeTeam`
  // cascade to the sibling in-memory stores (trust links, reminders). In the Postgres
  // path this is unnecessary — `PostgresEventStore.purgeTeam` deletes the colocated
  // derived tables in one transaction.
  if (store instanceof InMemoryEventStore) {
    store.attachDerivedStores({
      trustLinks: trustLinks instanceof InMemoryTrustLinkStore ? trustLinks : undefined,
      reminders: scheduler instanceof InMemoryScheduler ? scheduler : undefined,
    });
  }

  // Lazy orchestrator holder so the OAuth customRoutes (built before the orchestrator
  // exists) can reach it at request time.
  const orchHolder: { orch?: KeptOrchestrator } = {};
  const webhookOpts = {
    secret: process.env.KEPT_WEBHOOK_SECRET,
    teamId: process.env.KEPT_TEAM_ID,
    ...(installationStore ? { listTeamIds: () => installationStore!.listTeamIds() } : {}),
  };
  const customRoutes = oauth ? keptCustomRoutes(() => orchHolder.orch!, webhookOpts) : undefined;

  const { app, orch } = buildSlackApp({
    signingSecret: cfg.slack.signingSecret,
    botToken: oauth ? undefined : cfg.slack.botToken,
    appToken: oauth ? undefined : cfg.slack.appToken,
    oauth: oauth
      ? {
          clientId: cfg.slack.clientId!,
          clientSecret: cfg.slack.clientSecret!,
          stateSecret: cfg.slack.stateSecret!,
          scopes: SLACK_BOT_SCOPES,
          installationStore: installationStore!,
        }
      : undefined,
    customRoutes,
    llm,
    // W2 (invariant #4) — full per-tenant purge on uninstall (event log + derived rows),
    // logged so "data is deleted on uninstall" is provable in the operator's logs.
    purgeTenant: async (teamId: string) => {
      const summary = await store.purgeTeam(teamId);
      // Invariant #4 — the uninstall purge must also delete the workspace's stored proof-source
      // SECRETS (LaunchDarkly/Jira/GitHub tokens), not just its ledger.
      const tenantConfigRows = await tenantConfig.purgeTeam(teamId);
      const usageRows = await usage.purgeTeam(teamId);
      console.log(`[kept] purged tenant ${teamId}: ${JSON.stringify({ ...summary, tenantConfig: tenantConfigRows, usage: usageRows })}`);
    },
    // Per-tenant Connections config — the App Home "Connections" UI reads/writes it (scoped by team).
    tenantConfig,
    makeOrchestrator: (notifier) => {
      notifierRef.n = notifier;
      // Ledger-backed RTS (prior commitments + owner) is the ALWAYS-ON fallback — a real,
      // runnable source that works even if the Real-Time Search API needs a paid plan /
      // allowlist. KEPT_RTS=1 layers on Marketplace-legal cross-channel context via
      // assistant.search.context (granular scopes + bot token + action_token). The legacy
      // KEPT_SLACK_USER_SEARCH path (classic search.messages, banned scope) is dev-only.
      const ledgerRts = new LedgerRtsRetriever({ listObligations: (teamId) => service.listObligations(teamId) });
      // Resolve the acting team's BOT-token client for the Real-Time Search API. We route
      // through the generic `apiCall` (not a typed method) so the call works even on SDK
      // versions that don't yet type `assistant.search.context` — and degrades to EMPTY
      // (caught in the retriever) if the API isn't allowlisted for the workspace.
      const assistantSearchClientFor = async (teamId: string): Promise<AssistantSearchClient> => {
        const token = oauth
          ? (await installationStore!.fetchInstallation({ teamId, enterpriseId: undefined, isEnterpriseInstall: false })).bot?.token
          : cfg.slack.botToken;
        if (!token) throw new Error(`no bot token available for team ${teamId}`);
        const wc = new WebClient(token);
        return {
          assistant: {
            search: {
              context: (args) =>
                wc.apiCall("assistant.search.context", args) as Promise<{ results?: { messages?: AssistantSearchResult[] } }>,
            },
          },
        };
      };
      const retrievers: RtsRetriever[] = [ledgerRts];
      if (process.env.KEPT_RTS === "1") {
        retrievers.push(new SlackAssistantSearchRetriever({ clientFor: assistantSearchClientFor }));
      }
      if (process.env.KEPT_SLACK_USER_SEARCH === "1") {
        retrievers.push(new SlackRtsRetriever({ clientFor: (token) => new WebClient(token) as unknown as SlackSearchClient }));
      }
      const rts = retrievers.length === 1 ? retrievers[0] : new CompositeRtsRetriever(retrievers);
      return new KeptOrchestrator({ service, llm, workItems, rts, notifier, scheduler, fallbackOwner, roadmapSource, trustLinks, proofCollectorFor, usage, pilotLimitFor });
    },
  });
  orchHolder.orch = orch;

  const port = Number(process.env.PORT ?? 3000);

  if (oauth) {
    // One listener: /slack/events + /slack/install + /slack/oauth_redirect + customRoutes
    // (/webhooks/*, /healthz, /trust/:token) all on a single PORT.
    await app.start(port);
    console.log(`[kept] OAuth HTTP app on :${port} — install at /slack/install · events /slack/events · webhooks /webhooks/* · trust /trust/:token`);
  } else {
    // Single-token / Socket Mode dev path: a standalone webhook server on its own port.
    const webhookPort = Number(process.env.KEPT_WEBHOOK_PORT ?? 3001);
    const webhooks = createWebhookServer(orch, { secret: process.env.KEPT_WEBHOOK_SECRET, teamId: process.env.KEPT_TEAM_ID });
    webhooks.listen(webhookPort, () => console.log(`[kept] webhook server on :${webhookPort} (/webhooks/{linear,jira,github,deploy})`));
    await app.start(port);
    console.log(`[kept] Slack app on :${port}`);
  }

  const roadmapMode = process.env.KEPT_ROADMAP_FILE ? "file" : cfg.databaseUrl ? "postgres" : "none";
  const rtsMode = [
    "ledger",
    process.env.KEPT_RTS === "1" ? "assistant.search.context" : null,
    process.env.KEPT_SLACK_USER_SEARCH === "1" ? "legacy-user-search" : null,
  ]
    .filter(Boolean)
    .join("+");
  const remindersMode = cfg.redisUrl ? "bullmq" : pgScheduler ? "postgres" : "in-memory";
  console.log(`[kept] mode=${oauth ? "oauth-http" : "single-token"} · store=${cfg.databaseUrl ? "postgres" : "memory"} · llm=${llmLabel} · workItems=${workItemsMode} · reminders=${remindersMode} · roadmap=${roadmapMode} · rts=${rtsMode} · proof=${proofMode}`);
}

main().catch((err) => {
  console.error("[kept] failed to start:", err);
  process.exit(1);
});
