import { loadConfig } from "../config.js";
import { InMemoryEventStore } from "../store/memoryStore.js";
import { PostgresEventStore } from "../store/postgresStore.js";
import type { EventStore } from "../store/eventStore.js";
import { ObligationService } from "../engine/obligationService.js";
import { InMemoryScheduler } from "../scheduler/inMemoryScheduler.js";
import { BullmqScheduler } from "../scheduler/bullmqScheduler.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { MockLlmProvider } from "../llm/mock.js";
import type { LlmProvider } from "../llm/provider.js";
import { LinearApiAdapter, type WorkItemAdapter } from "../integrations/linear.js";
import { JiraApiAdapter } from "../integrations/jira.js";
import { McpWorkItemAdapter, createSimulatedMcpWorkItems } from "../integrations/mcp.js";
import { WebClient } from "@slack/web-api";
import { LedgerRtsRetriever, CompositeRtsRetriever, SlackRtsRetriever, type SlackSearchClient } from "../slack/rts.js";
import { FileRoadmapSource, type RoadmapSource } from "../policy/roadmap.js";
import { PostgresRoadmapSource } from "../integrations/roadmapPostgres.js";
import { KeptOrchestrator } from "../app/orchestrator.js";
import { reminderMessage } from "../slack/blocks.js";
import { heuristicResponder } from "../eval/scenarios.js";
import { buildSlackApp } from "./slackApp.js";
import { createWebhookServer } from "./webhookServer.js";

/**
 * Production boot. Hybrid substrate: REAL Slack surface (Events API + Block Kit)
 * with simulated/replayable Linear + deploy webhooks by default. Each external
 * dependency upgrades to its real adapter when its env is configured.
 */
async function main() {
  const cfg = loadConfig();
  if (!cfg.slack.botToken || !cfg.slack.signingSecret) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required (see .env.example)");
  }

  const store: EventStore = cfg.databaseUrl
    ? await (async () => {
        const pg = new PostgresEventStore({ connectionString: cfg.databaseUrl });
        await pg.init();
        return pg;
      })()
    : new InMemoryEventStore();

  const service = new ObligationService(store);

  const llm: LlmProvider = cfg.anthropicApiKey
    ? new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel })
    : new MockLlmProvider(heuristicResponder);

  // Work items go through MCP by default (the hackathon's "MCP server integration").
  // Precedence: Linear MCP > Atlassian/Jira MCP > legacy direct-API adapters >
  // an in-process SIMULATED MCP server (real client↔server round-trip, no network).
  let workItemsMode: string;
  let workItems: WorkItemAdapter;
  if (process.env.LINEAR_MCP_TOKEN) {
    workItems = McpWorkItemAdapter.linear({ token: process.env.LINEAR_MCP_TOKEN, url: process.env.LINEAR_MCP_URL, teamId: process.env.LINEAR_TEAM_ID, toolName: process.env.KEPT_MCP_TOOL });
    workItemsMode = "mcp:linear";
  } else if (process.env.ATLASSIAN_MCP_TOKEN) {
    workItems = McpWorkItemAdapter.atlassian({ token: process.env.ATLASSIAN_MCP_TOKEN, url: process.env.ATLASSIAN_MCP_URL, cloudId: process.env.JIRA_CLOUD_ID, projectKey: process.env.JIRA_PROJECT_KEY, toolName: process.env.KEPT_MCP_TOOL });
    workItemsMode = "mcp:atlassian";
  } else if (process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN && process.env.JIRA_PROJECT_KEY) {
    workItems = new JiraApiAdapter({ baseUrl: process.env.JIRA_BASE_URL, email: process.env.JIRA_EMAIL, apiToken: process.env.JIRA_API_TOKEN, projectKey: process.env.JIRA_PROJECT_KEY });
    workItemsMode = "jira-rest";
  } else if (process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_ID) {
    workItems = new LinearApiAdapter({ apiKey: process.env.LINEAR_API_KEY, teamId: process.env.LINEAR_TEAM_ID });
    workItemsMode = "linear-graphql";
  } else {
    workItems = await createSimulatedMcpWorkItems();
    workItemsMode = "mcp:simulated";
  }

  const fallbackOwner = process.env.KEPT_DEFAULT_OWNER ?? "U_ACCOUNT_MANAGER";

  // Roadmap source for the contradiction check: a JSON file, else a Postgres table, else none.
  const roadmapSource: RoadmapSource | undefined = process.env.KEPT_ROADMAP_FILE
    ? new FileRoadmapSource(process.env.KEPT_ROADMAP_FILE)
    : cfg.databaseUrl
      ? new PostgresRoadmapSource({ connectionString: cfg.databaseUrl })
      : undefined;

  const { app, orch } = buildSlackApp({
    botToken: cfg.slack.botToken,
    signingSecret: cfg.slack.signingSecret,
    appToken: cfg.slack.appToken,
    llm,
    makeOrchestrator: (notifier) => {
      // Reminders/nudges go to the obligation owner — never the customer channel (D3).
      const scheduler: Scheduler = cfg.redisUrl
        ? new BullmqScheduler({ host: new URL(cfg.redisUrl).hostname, port: Number(new URL(cfg.redisUrl).port || 6379) }, async (job) => {
            const o = await service.getObligation(job.obligationId);
            if (o && !["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state)) {
              const { text, blocks } = reminderMessage(o, job.kind);
              await notifier.sendPrivate(o.owner ?? fallbackOwner, { text, blocks });
            }
          })
        : new InMemoryScheduler(async (job) => {
            const o = await service.getObligation(job.obligationId);
            if (o) {
              const { text, blocks } = reminderMessage(o, job.kind);
              await notifier.sendPrivate(o.owner ?? fallbackOwner, { text, blocks });
            }
          });

      // Ledger-backed RTS (prior commitments + owner); optionally add cross-channel
      // Slack search with per-user tokens for permission-safe context.
      const ledgerRts = new LedgerRtsRetriever({ listObligations: () => service.listObligations() });
      const rts =
        process.env.KEPT_SLACK_USER_SEARCH === "1"
          ? new CompositeRtsRetriever([
              ledgerRts,
              new SlackRtsRetriever({ clientFor: (token) => new WebClient(token) as unknown as SlackSearchClient }),
            ])
          : ledgerRts;
      return new KeptOrchestrator({ service, llm, workItems, rts, notifier, scheduler, fallbackOwner, roadmapSource });
    },
  });

  const webhookPort = Number(process.env.KEPT_WEBHOOK_PORT ?? 3001);
  const webhooks = createWebhookServer(orch, { secret: process.env.KEPT_WEBHOOK_SECRET });
  webhooks.listen(webhookPort, () => console.log(`[kept] webhook server on :${webhookPort} (/webhooks/{linear,jira,github,deploy})`));

  const slackPort = Number(process.env.PORT ?? 3000);
  await app.start(slackPort);
  console.log(`[kept] Slack app on :${slackPort}`);
  const roadmapMode = process.env.KEPT_ROADMAP_FILE ? "file" : cfg.databaseUrl ? "postgres" : "none";
  const rtsMode = process.env.KEPT_SLACK_USER_SEARCH === "1" ? "ledger+slack-search" : "ledger";
  console.log(`[kept] store=${cfg.databaseUrl ? "postgres" : "memory"} · llm=${llm.name} · workItems=${workItemsMode} · reminders=${cfg.redisUrl ? "bullmq" : "in-memory"} · roadmap=${roadmapMode} · rts=${rtsMode}`);
}

main().catch((err) => {
  console.error("[kept] failed to start:", err);
  process.exit(1);
});
