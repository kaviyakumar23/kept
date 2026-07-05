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

/**
 * W2 (invariant #4) — fail-CLOSED resolver of the acting workspace for a Slack payload.
 * A signature-verified block-action / view submission always carries `team.id` (org
 * installs fall back to the user's `team_id`); if NEITHER resolves we refuse to derive a
 * tenant rather than proceed unchecked, so the cross-tenant guard can never degrade to the
 * internal no-check path on a malformed payload. Throws when no team resolves.
 */
export function requireTeam(body: any): string {
  const t = body?.team?.id ?? body?.user?.team_id;
  if (!t) throw new Error("no acting workspace on payload");
  return t;
}

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
    // Fail CLOSED on an unattributable delivery: a message with no team can't be scoped
    // to a tenant, so we drop it rather than mint a synthetic ledger (invariant #4).
    if (message.subtype || !message.text || !message.team) return; // ignore edits/bot/system/team-less
    await orch.ingestMessage({
      team: message.team,
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
  /**
   * Fail-CLOSED resolution of the acting workspace for a handler: returns the team id, or
   * DMs the user and returns null when no team resolves — so a team-less payload never
   * reaches the orchestrator on the internal (unchecked) path.
   */
  const resolveTeam = async (client: any, body: any): Promise<string | null> => {
    try {
      return requireTeam(body);
    } catch {
      await dmUser(client, body.user.id, ":warning: Couldn't determine your workspace — action blocked.");
      return null;
    }
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
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.confirmCommitment(obligationOf(action), body.user.id, undefined, team);
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (await handledCrossTenant(client, body, err)) return;
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.action(new RegExp(`^${ACTIONS.dismiss}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.dismiss(obligationOf(action), body.user.id, team);
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.verify}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.verify(obligationOf(action), body.user.id, team);
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.approveSend}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.approveSend(obligationOf(action), body.user.id, team);
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });

  // --- modal openers (tenant-scoped reads: block opening another workspace's card) ---
  app.action(new RegExp(`^${ACTIONS.edit}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      const o = await orch.obligation(obligationOf(action), team);
      if (o) await client.views.open({ trigger_id: body.trigger_id, view: editObligationModal(o) });
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.editDraft}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    const id = obligationOf(action);
    try {
      const o = await orch.obligation(id, team);
      if (o) await client.views.open({ trigger_id: body.trigger_id, view: editDraftModal(o, (await orch.closureDraftText(id, team)) ?? "") });
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.history}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      const audit = await orch.auditFor(obligationOf(action), team);
      if (audit) await client.views.open({ trigger_id: body.trigger_id, view: auditModal(audit.obligation, audit.events) });
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.notYet}:`), async ({ ack }: any) => {
    await ack();
  });

  // --- modal submissions ---
  app.view(CALLBACKS.editObligation, async ({ ack, body, view, client }: any) => {
    const v = view.state.values;
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.confirmCommitment(view.private_metadata, body.user.id, {
        outcome: v[FIELDS.outcome.block]?.[FIELDS.outcome.action]?.value || undefined,
        due: v[FIELDS.due.block]?.[FIELDS.due.action]?.value || null,
        owner: v[FIELDS.owner.block]?.[FIELDS.owner.action]?.value || undefined,
      }, team);
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (await handledCrossTenant(client, body, err)) return;
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.view(CALLBACKS.editDraft, async ({ ack, body, view }: any) => {
    const text = view.state.values[FIELDS.draft.block]?.[FIELDS.draft.action]?.value ?? "";
    let team: string;
    try {
      team = requireTeam(body);
    } catch {
      // Team-less submission → fail closed with an inline error rather than an unchecked send.
      await ack({ response_action: "errors", errors: { [FIELDS.draft.block]: "Couldn't determine your workspace — action blocked." } });
      return;
    }
    const res = await orch.approveSendWithText(view.private_metadata, body.user.id, text, team);
    if (res.kind === "rejected") {
      // Keep the modal open with an inline error — the edited reply still leaks.
      await ack({ response_action: "errors", errors: { [FIELDS.draft.block]: "Remove internal references (ticket keys, PRs, deploys, etc.) before sending." } });
    } else {
      await ack();
    }
  });

  // /kept <customer>            → the two-sided ledger (scoped to the invoking workspace)
  // /kept trust <customer>       → mint (or reuse) the customer's audience-safe trust page URL
  // /kept untrust <customer>     → revoke that customer's trust link (old URLs then 404)
  app.command("/kept", async ({ ack, respond, command }: any) => {
    await ack();
    const text = (command.text || "").trim();
    const team = command.team_id;

    const mint = /^trust\s+(.+)$/i.exec(text);
    if (mint) {
      const customer = mint[1].trim();
      try {
        const link = await orch.mintTrustLink(team, customer);
        const base = process.env.KEPT_PUBLIC_URL?.replace(/\/+$/, "");
        const url = base ? `${base}/trust/${link.token}` : `/trust/${link.token}  (set KEPT_PUBLIC_URL for the full link)`;
        await respond({
          response_type: "ephemeral",
          text: `:link: *Trust page for ${customer}* — a private, audience-safe view of what you owe them.\n<${url}>\nRevoke anytime with \`/kept untrust ${customer}\`.`,
        });
      } catch (err) {
        await respond({ response_type: "ephemeral", text: `:warning: Couldn't mint a trust link (${err instanceof Error ? err.message : "error"}).` });
      }
      return;
    }

    const drop = /^(?:untrust|revoke)\s+(.+)$/i.exec(text);
    if (drop) {
      const customer = drop[1].trim();
      const n = await orch.revokeTrustLink(team, customer);
      await respond({
        response_type: "ephemeral",
        text: n > 0 ? `:lock: Revoked ${n} trust link${n === 1 ? "" : "s"} for *${customer}*. Existing URLs now return 404.` : `No active trust link for *${customer}*.`,
      });
      return;
    }

    const customer = text || "Acme";
    const obligations = await orch.ledgerFor(team, customer);
    await respond({ blocks: ledgerView(customer, obligations) as any });
  });

  return { app, orch };
}
