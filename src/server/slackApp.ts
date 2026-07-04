import { App, type CustomRoute } from "@slack/bolt";
import type { InstallationStore } from "@slack/oauth";
import { WebClient } from "@slack/web-api";
import { KeptOrchestrator, CrossTenantWriteError } from "../app/orchestrator.js";
import type { Notifier } from "../slack/notifier.js";
import type { LlmProvider } from "../llm/provider.js";
import { SlackNotifier, type ClientForTeam } from "./slackNotifier.js";
import type { SlackClientLike } from "./slackNotifier.js";
import { buildKeptAssistant } from "./assistant.js";
import {
  ACTIONS,
  CALLBACKS,
  FIELDS,
  parseActionId,
  ledgerView,
  appHomeView,
  auditModal,
  editObligationModal,
  editDraftModal,
} from "../slack/blocks.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** W2 — OAuth HTTP mode configuration (multi-workspace install + per-tenant tokens). */
export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  scopes: string[];
  installationStore: InstallationStore;
}

export interface SlackAppDeps {
  signingSecret: string;
  /** Single-token / Socket Mode path (demo, dev). Ignored when `oauth` is set. */
  botToken?: string;
  appToken?: string; // for Socket Mode
  /**
   * W2 — when set, boot in OAuth HTTP mode: no static token, Bolt auto-authorizes each
   * event to the right workspace via `installationStore.fetchInstallation`, and out-of-band
   * sends resolve the per-tenant bot token.
   */
  oauth?: SlackOAuthConfig;
  /** Extra HTTP routes (webhooks, /healthz, /trust/:token) — served in OAuth HTTP mode. */
  customRoutes?: CustomRoute[];
  /** Build the orchestrator given the live notifier (which wraps the Slack client(s)). */
  makeOrchestrator: (notifier: Notifier) => KeptOrchestrator;
  /** LLM provider for the Assistant's NL query router (the engine still runs the read). */
  llm: LlmProvider;
}

/**
 * Thin Bolt transport: maps Slack events/actions/commands onto the orchestrator.
 * All real logic (gates, sanitization, reconciliation) lives in the engine +
 * orchestrator; this layer only translates the wire.
 */
export function buildSlackApp(deps: SlackAppDeps): { app: App; orch: KeptOrchestrator } {
  const app = deps.oauth
    ? new App({
        signingSecret: deps.signingSecret,
        clientId: deps.oauth.clientId,
        clientSecret: deps.oauth.clientSecret,
        stateSecret: deps.oauth.stateSecret,
        scopes: deps.oauth.scopes,
        installationStore: deps.oauth.installationStore,
        customRoutes: deps.customRoutes,
      })
    : new App({
        token: deps.botToken,
        signingSecret: deps.signingSecret,
        socketMode: Boolean(deps.appToken),
        appToken: deps.appToken,
      });

  // W2 — in OAuth mode, out-of-band sends (reminders, webhook-driven closures) have no
  // event context, so resolve the workspace's bot token from the install. In single-token
  // mode `app.client` carries the static token and `clientForTeam` stays undefined.
  const clientForTeam: ClientForTeam | undefined = deps.oauth
    ? async (teamId: string): Promise<SlackClientLike> => {
        const install = await deps.oauth!.installationStore.fetchInstallation({
          teamId,
          enterpriseId: undefined,
          isEnterpriseInstall: false,
        });
        const token = install.bot?.token;
        if (!token) throw new Error(`no bot token stored for team ${teamId}`);
        return new WebClient(token) as unknown as SlackClientLike;
      }
    : undefined;

  const notifier = new SlackNotifier(app.client as unknown as SlackClientLike, clientForTeam);
  const orch = deps.makeOrchestrator(notifier);

  // Slack AI Assistant pane — conversational ledger queries (lights "Slack AI capabilities").
  app.assistant(buildKeptAssistant({ orch, llm: deps.llm }));

  // A new message in a (shared) channel → detect + Gate-1 card.
  app.message(async ({ message, context }: any) => {
    if (message.subtype || !message.text) return; // ignore edits/bot/system messages
    await orch.ingestMessage({
      team: message.team ?? "T",
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      ts: message.ts,
      userId: message.user,
      // W3 — the Real-Time Search action_token rides on the event context/payload.
      actionToken: message.action_token ?? context?.actionToken,
      text: message.text,
    });
  });

  const obligationOf = (action: any): string => parseActionId(action.action_id).obligationId;
  /** The acting workspace for a block-action/view payload (org installs fall back to the user's team). */
  const teamOf = (body: any): string => body?.team?.id ?? body?.user?.team_id;
  const republishHome = async (client: any, userId: string, teamId: string) => {
    try {
      // W1 — App Home shows ONLY the acting workspace's obligations.
      await client.views.publish({ user_id: userId, view: appHomeView(await orch.allObligations(teamId)) });
    } catch {
      /* App Home publish is best-effort */
    }
  };
  /** Best-effort private notice to the acting user when an action fails after ack(). */
  const dmUser = async (client: any, userId: string, text: string) => {
    try {
      await client.chat.postMessage({ channel: userId, text });
    } catch {
      /* notice is best-effort */
    }
  };
  /**
   * W2 (invariant #4) — if a listener error is a blocked cross-tenant write, DM the
   * user and report it handled. The orchestrator enforces `body.team.id` == the target
   * obligation's team on confirm/verify/dismiss/approveSend before any side effect.
   */
  const handledCrossTenant = async (client: any, body: any, err: unknown): Promise<boolean> => {
    if (err instanceof CrossTenantWriteError) {
      await dmUser(client, body.user.id, ":lock: That obligation belongs to another workspace — action blocked.");
      return true;
    }
    return false;
  };

  // Global safety net so a listener exception never goes unsurfaced.
  app.error(async (error: any) => {
    console.error("[kept] slack listener error:", error);
  });

  // App Home — the live obligation-ledger dashboard (scoped to the opener's workspace).
  app.event("app_home_opened", async ({ event, body, client }: any) => {
    if (event.tab && event.tab !== "home") return;
    await client.views.publish({ user_id: event.user, view: appHomeView(await orch.allObligations(body.team_id)) });
  });

  // --- gate actions (each enforces acting team == obligation team) ---
  app.action(new RegExp(`^${ACTIONS.confirm}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    try {
      await orch.confirmCommitment(obligationOf(action), body.user.id, undefined, teamOf(body));
      await republishHome(client, body.user.id, teamOf(body));
    } catch (err) {
      if (await handledCrossTenant(client, body, err)) return;
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.action(new RegExp(`^${ACTIONS.dismiss}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    try {
      await orch.dismiss(obligationOf(action), body.user.id, teamOf(body));
      await republishHome(client, body.user.id, teamOf(body));
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.verify}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    try {
      await orch.verify(obligationOf(action), body.user.id, teamOf(body));
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.approveSend}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    try {
      await orch.approveSend(obligationOf(action), body.user.id, teamOf(body));
      await republishHome(client, body.user.id, teamOf(body));
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });

  // --- modal openers ---
  app.action(new RegExp(`^${ACTIONS.edit}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const o = await orch.obligation(obligationOf(action));
    if (o) await client.views.open({ trigger_id: body.trigger_id, view: editObligationModal(o) });
  });
  app.action(new RegExp(`^${ACTIONS.editDraft}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const id = obligationOf(action);
    const o = await orch.obligation(id);
    if (o) await client.views.open({ trigger_id: body.trigger_id, view: editDraftModal(o, (await orch.closureDraftText(id)) ?? "") });
  });
  app.action(new RegExp(`^${ACTIONS.history}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const audit = await orch.auditFor(obligationOf(action));
    if (audit) await client.views.open({ trigger_id: body.trigger_id, view: auditModal(audit.obligation, audit.events) });
  });
  app.action(new RegExp(`^${ACTIONS.notYet}:`), async ({ ack }: any) => {
    await ack();
  });

  // --- modal submissions ---
  app.view(CALLBACKS.editObligation, async ({ ack, body, view, client }: any) => {
    const v = view.state.values;
    await ack();
    try {
      await orch.confirmCommitment(view.private_metadata, body.user.id, {
        outcome: v[FIELDS.outcome.block]?.[FIELDS.outcome.action]?.value || undefined,
        due: v[FIELDS.due.block]?.[FIELDS.due.action]?.value || null,
        owner: v[FIELDS.owner.block]?.[FIELDS.owner.action]?.value || undefined,
      }, teamOf(body));
      await republishHome(client, body.user.id, teamOf(body));
    } catch (err) {
      if (await handledCrossTenant(client, body, err)) return;
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.view(CALLBACKS.editDraft, async ({ ack, body, view }: any) => {
    const text = view.state.values[FIELDS.draft.block]?.[FIELDS.draft.action]?.value ?? "";
    const res = await orch.approveSendWithText(view.private_metadata, body.user.id, text, teamOf(body));
    if (res.kind === "rejected") {
      // Keep the modal open with an inline error — the edited reply still leaks.
      await ack({ response_action: "errors", errors: { [FIELDS.draft.block]: "Remove internal references (ticket keys, PRs, deploys, etc.) before sending." } });
    } else {
      await ack();
    }
  });

  // /kept <customer> → the two-sided ledger (scoped to the invoking workspace).
  app.command("/kept", async ({ ack, respond, command }: any) => {
    await ack();
    const customer = (command.text || "").trim() || "Acme";
    const obligations = await orch.ledgerFor(command.team_id, customer);
    await respond({ blocks: ledgerView(customer, obligations) as any });
  });

  return { app, orch };
}
