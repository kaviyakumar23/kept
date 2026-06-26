import { App } from "@slack/bolt";
import { KeptOrchestrator } from "../app/orchestrator.js";
import type { Notifier } from "../slack/notifier.js";
import type { LlmProvider } from "../llm/provider.js";
import { SlackNotifier } from "./slackNotifier.js";
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

export interface SlackAppDeps {
  botToken: string;
  signingSecret: string;
  appToken?: string; // for Socket Mode
  /** Build the orchestrator given the live notifier (which wraps app.client). */
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
  const app = new App({
    token: deps.botToken,
    signingSecret: deps.signingSecret,
    socketMode: Boolean(deps.appToken),
    appToken: deps.appToken,
  });

  const notifier = new SlackNotifier(app.client as any);
  const orch = deps.makeOrchestrator(notifier);

  // Slack AI Assistant pane — conversational ledger queries (lights "Slack AI capabilities").
  app.assistant(buildKeptAssistant({ orch, llm: deps.llm }));

  // A new message in a (shared) channel → detect + Gate-1 card.
  app.message(async ({ message }: any) => {
    if (message.subtype || !message.text) return; // ignore edits/bot/system messages
    await orch.ingestMessage({
      team: message.team ?? "T",
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      ts: message.ts,
      userId: message.user,
      text: message.text,
    });
  });

  const obligationOf = (action: any): string => parseActionId(action.action_id).obligationId;
  const republishHome = async (client: any, userId: string) => {
    try {
      await client.views.publish({ user_id: userId, view: appHomeView(await orch.allObligations()) });
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

  // Global safety net so a listener exception never goes unsurfaced.
  app.error(async (error: any) => {
    console.error("[kept] slack listener error:", error);
  });

  // App Home — the live obligation-ledger dashboard.
  app.event("app_home_opened", async ({ event, client }: any) => {
    if (event.tab && event.tab !== "home") return;
    await client.views.publish({ user_id: event.user, view: appHomeView(await orch.allObligations()) });
  });

  // --- gate actions ---
  app.action(new RegExp(`^${ACTIONS.confirm}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    try {
      await orch.confirmCommitment(obligationOf(action), body.user.id);
      await republishHome(client, body.user.id);
    } catch (err) {
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.action(new RegExp(`^${ACTIONS.dismiss}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    await orch.dismiss(obligationOf(action), body.user.id);
    await republishHome(client, body.user.id);
  });
  app.action(new RegExp(`^${ACTIONS.verify}:`), async ({ ack, body, action }: any) => {
    await ack();
    await orch.verify(obligationOf(action), body.user.id);
  });
  app.action(new RegExp(`^${ACTIONS.approveSend}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    await orch.approveSend(obligationOf(action), body.user.id);
    await republishHome(client, body.user.id);
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
      });
      await republishHome(client, body.user.id);
    } catch (err) {
      await dmUser(client, body.user.id, `:warning: Couldn't create the work item (${err instanceof Error ? err.message : "error"}). The commitment is confirmed — click *Confirm* again to retry once the system recovers.`);
    }
  });
  app.view(CALLBACKS.editDraft, async ({ ack, body, view }: any) => {
    const text = view.state.values[FIELDS.draft.block]?.[FIELDS.draft.action]?.value ?? "";
    const res = await orch.approveSendWithText(view.private_metadata, body.user.id, text);
    if (res.kind === "rejected") {
      // Keep the modal open with an inline error — the edited reply still leaks.
      await ack({ response_action: "errors", errors: { [FIELDS.draft.block]: "Remove internal references (ticket keys, PRs, deploys, etc.) before sending." } });
    } else {
      await ack();
    }
  });

  // /kept <customer> → the two-sided ledger.
  app.command("/kept", async ({ ack, respond, command }: any) => {
    await ack();
    const customer = (command.text || "").trim() || "Acme";
    const obligations = await orch.ledgerFor(customer);
    await respond({ blocks: ledgerView(customer, obligations) as any });
  });

  return { app, orch };
}
