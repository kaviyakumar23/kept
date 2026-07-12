import { App, type CustomRoute } from "@slack/bolt";
import type { InstallationStore } from "@slack/oauth";
import { WebClient } from "@slack/web-api";
import { KeptOrchestrator, CrossTenantWriteError } from "../app/orchestrator.js";
import type { Notifier } from "../slack/notifier.js";
import type { LlmProvider } from "../llm/provider.js";
import { SlackNotifier, type ClientForTeam } from "./slackNotifier.js";
import type { SlackClientLike } from "./slackNotifier.js";
import { buildKeptAssistant } from "./assistant.js";
import type { TenantConfigStore } from "../store/tenantConfigStore.js";
import { demoFlagOn, setDemoFlag, resetDemoProof } from "../demo/demoRuntime.js";
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
  verifyPacketModal,
  connectModal,
  addMappingModal,
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
  /** Per-tenant integration config — the App Home "Connections" surface reads/writes it, scoped by team. */
  tenantConfig?: TenantConfigStore;
  /** Judge-demo tenant (team id): App Home shows the Demo Controls panel for this workspace only. */
  demoTeam?: string;
  /** Optional channel (id) where the demo's seeded promise + sanitized closure live. Unset → the loop runs DM-only. */
  demoChannel?: string;
  /**
   * W2 (invariant #4) — full per-tenant data deletion on uninstall. Invoked by the
   * `app_uninstalled` / bot-token-revoked handler AFTER `deleteInstallation`, to purge
   * the team's obligation ledger + derived rows (`EventStore.purgeTeam`). Optional: the
   * single-token / dev path may omit it.
   */
  purgeTenant?: (teamId: string) => Promise<void>;
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
        // Marketplace (invariant #6): the Direct Install URL must HTTP-302 straight to
        // slack.com/oauth/v2/authorize. `directInstall` makes GET /slack/install redirect
        // instead of rendering Bolt's default 200 HTML "Add to Slack" button page.
        installerOptions: { directInstall: true },
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
    // Skip edits/deletes/system subtypes, team-less messages, and Kept's OWN posts. But ALLOW a
    // promise from another app / AI agent (a "bot_message") — #5: an agent that makes a customer
    // promise must be held to it too. The engine routes an agent promise to a HUMAN owner.
    const subtype: string | undefined = message.subtype;
    const isSystemOrEdit = Boolean(subtype && subtype !== "bot_message"); // edits/joins/etc. — never a fresh promise
    const isOwnPost = Boolean(
      (message.user && context?.botUserId && message.user === context.botUserId) ||
      (message.bot_id && context?.botId && message.bot_id === context.botId),
    );
    if (isSystemOrEdit || isOwnPost || !message.text || !message.team) return;
    const agent =
      subtype === "bot_message" || message.bot_id
        ? { name: String(message.username || message.bot_profile?.name || "an AI agent") }
        : undefined;
    // Channel→customer binding (if the workspace pinned this channel to a customer). Anchors the
    // customer identity to the channel instead of re-parsing it from every message.
    const channelCustomers = deps.tenantConfig ? await deps.tenantConfig.get(message.team, "channel_customers") : null;
    const r = await orch.ingestMessage({
      team: message.team,
      channel: message.channel,
      threadTs: message.thread_ts ?? message.ts,
      ts: message.ts,
      userId: message.user,
      // W3 — the Real-Time Search action_token rides on the event context/payload.
      actionToken: message.action_token ?? context?.actionToken,
      text: message.text,
      agent,
      customerBinding: channelCustomers?.[message.channel],
    });
    // Operational visibility (zero-copy: OUTCOME only, never the message text) — makes a
    // missing card diagnosable: card sent (+owner) / deduped / skipped (+why).
    const detail =
      r.kind === "skipped" ? `signal=${r.signal}`
      : r.kind === "confirm_card_sent" ? `owner=${r.owner} obligation=${r.obligationId}`
      : r.kind === "deduped" ? `obligation=${r.obligationId}`
      : r.kind === "customer_reply" ? `state=${r.state} obligation=${r.obligationId}`
      : "";
    console.log(`[kept] ingest team=${message.team} channel=${message.channel} -> ${r.kind} ${detail}`.trimEnd());
  });

  const obligationOf = (action: any): string => parseActionId(action.action_id).obligationId;
  const isDemoTeam = (teamId: string): boolean => Boolean(deps.demoTeam) && teamId === deps.demoTeam;
  /** The single in-flight (non-terminal) demo obligation, if any — the one the panel/buttons act on. */
  const activeDemoObligation = (obligations: any[]): any =>
    obligations.find((o) => !["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state)) ?? null;
  const republishHome = async (client: any, userId: string, teamId: string) => {
    try {
      // W1 (invariant #4) — App Home shows ONLY the acting workspace's obligations AND its own
      // configured connections; both reads are scoped to `teamId`. Undefined store (single-token /
      // dev path) → no Connections section is rendered.
      const configured = deps.tenantConfig ? await deps.tenantConfig.listConfigured(teamId) : undefined;
      const mappings = deps.tenantConfig ? (await deps.tenantConfig.get(teamId, "proof_targets")) ?? undefined : undefined;
      const obligations = await orch.allObligations(teamId);
      // Demo workspace only — surface the judge-operable panel + live flag state.
      const demo = isDemoTeam(teamId) ? { obligation: activeDemoObligation(obligations), flagOn: demoFlagOn() } : undefined;
      await client.views.publish({ user_id: userId, view: appHomeView(obligations, undefined, configured, demo, mappings) });
    } catch {
      /* App Home publish is best-effort */
    }
  };
  /**
   * Seed a fresh OPEN demo promise (owned by the acting judge) when the demo workspace has none
   * in flight. When a demo channel is configured we anchor it with a message there so the sanitized
   * closure can post into that thread; if the bot can't post (not a member / bad id) we fall back to
   * a DM-only loop. Gated to the demo team by its only callers.
   */
  const ensureDemoSeed = async (client: any, userId: string, teamId: string): Promise<void> => {
    if (activeDemoObligation(await orch.allObligations(teamId))) return;
    let channel: string | undefined = deps.demoChannel;
    let threadTs: string | undefined;
    if (channel) {
      try {
        const res = await client.chat.postMessage({ channel, text: ':handshake: *Kept demo* — the team just committed: "We\'ll ship the SSO fix for Acme by Friday." (customer: Acme)' });
        threadTs = res?.ts;
      } catch {
        channel = undefined; // bot isn't in the channel / bad id → run the loop DM-only
      }
    }
    await orch.seedDemo(teamId, userId, channel, threadTs);
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

  // W2 (invariant #4) — data deletion on uninstall. Bolt skips authorization for
  // app_uninstalled / tokens_revoked (the token is already gone), populating context
  // with the acting team, so we can resolve the tenant and purge honestly. This is the
  // Marketplace "data is deleted on uninstall" guarantee: we drop BOTH the stored bot
  // token (deleteInstallation) AND the tenant's ledger + derived rows (purgeTenant).
  if (deps.oauth) {
    const installs = deps.oauth.installationStore;
    // Fail-SAFE + idempotent: log-and-continue on any error; never crash the app, and a
    // re-delivered event just re-runs a no-op purge (unknown team deletes nothing).
    const purgeTenant = async (teamId: string): Promise<void> => {
      try {
        await installs.deleteInstallation?.({ teamId, enterpriseId: undefined, isEnterpriseInstall: false });
      } catch (err) {
        console.error(`[kept] deleteInstallation failed for team ${teamId}:`, err);
      }
      try {
        await deps.purgeTenant?.(teamId);
      } catch (err) {
        console.error(`[kept] purgeTeam failed for team ${teamId}:`, err);
      }
      console.log(`[kept] uninstall processed for team ${teamId} — installation + tenant data purged`);
    };
    app.event("app_uninstalled", async ({ context, body }: any) => {
      const teamId = context.teamId ?? body?.team_id;
      if (teamId) await purgeTenant(teamId);
    });
    app.event("tokens_revoked", async ({ event, context, body }: any) => {
      // Only a BOT-token revoke is an effective uninstall for us. A user-token-only
      // revoke leaves the app installed, so purging the ledger would be data loss.
      if (!event?.tokens?.bot?.length) return;
      const teamId = context.teamId ?? body?.team_id;
      if (teamId) await purgeTenant(teamId);
    });
  }

  // App Home — the live obligation-ledger dashboard + Connections (scoped to the opener's workspace).
  app.event("app_home_opened", async ({ event, body, client }: any) => {
    if (event.tab && event.tab !== "home") return;
    const teamId = body.team_id;
    // Demo workspace — make sure the judge always lands on a fresh OPEN demo promise + Demo Controls.
    if (isDemoTeam(teamId)) await ensureDemoSeed(client, event.user, teamId).catch(() => undefined);
    await republishHome(client, event.user, teamId);
  });

  // --- gate actions (each enforces acting team == obligation team) ---
  app.action(new RegExp(`^${ACTIONS.confirm}:`), async ({ ack, body, action, client, respond }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.confirmCommitment(obligationOf(action), body.user.id, undefined, team);
      await republishHome(client, body.user.id, team);
      // Lock the card so its buttons can't be re-clicked — swap it to a confirmed state.
      await respond({
        replace_original: true,
        text: "Commitment confirmed — now tracked.",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: ":white_check_mark: *Confirmed* — now tracked. Kept will gather proof from Jira, GitHub Actions, and LaunchDarkly before you verify." } }],
      }).catch(() => undefined);
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
  // Gate 2 — open the Proof-of-Done packet as a focused modal (from the Home "👀 Verify" row or the
  // DM nudge). The owner reviews the assembled evidence and signs via the modal's submit
  // (CALLBACKS.verifyPacket); no card is left behind in the DM history. Tenant-scoped read.
  app.action(new RegExp(`^${ACTIONS.verify}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      const packet = await orch.assemblePacket(obligationOf(action), team);
      if (packet) await client.views.open({ trigger_id: body.trigger_id, view: verifyPacketModal(packet.obligation, packet.assessment) });
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.approveSend}:`), async ({ ack, respond, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      const res = await orch.approveSend(obligationOf(action), body.user.id, team);
      await republishHome(client, body.user.id, team);
      // Lock the draft card once it's sent so it can't be re-sent from a stale card.
      if (res.kind === "notified") {
        await respond({
          replace_original: true,
          text: "Closure sent.",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: ":white_check_mark: *Sent* — the sanitized closure is posted in the customer thread. Kept closes the loop when they confirm." } }],
        }).catch(() => undefined);
      } else {
        await respond({ replace_original: false, response_type: "ephemeral", text: `:warning: Not sent — ${res.reason ?? "it was already handled"}.` }).catch(() => undefined);
      }
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });

  // Option A — owner manually attests delivery (teams with no automated proof source). Records a
  // manual_delivery signal → Evidence Packet DM; the App Home refreshes so the promise moves along.
  app.action(new RegExp(`^${ACTIONS.markDelivered}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team) return;
    try {
      await orch.markDelivered(obligationOf(action), body.user.id, team);
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

  // --- Connections surface (App Home) — per-tenant proof-source config (invariant #4/#6) ---
  // The provider rides in the button `value`; every read/write below is scoped to the ACTING
  // team resolved from the signature-verified payload — never a constant or another team's id.
  // TODO(admin-gate): optionally restrict "manage connections" to workspace admins via a
  // `users.info(is_admin)` check — deferred (extra scope + call; not trivially available here).
  app.action(new RegExp(`^${ACTIONS.connect}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    if (!deps.tenantConfig) return; // single-token / dev path: no Connections surface
    const team = await resolveTeam(client, body);
    if (!team) return;
    const provider = action.value;
    if (provider !== "launchdarkly" && provider !== "jira" && provider !== "github") return;
    const config = await deps.tenantConfig.get(team, provider);
    await client.views.open({ trigger_id: body.trigger_id, view: connectModal(provider, config) });
  });

  // Disconnect a provider — team-scoped delete of the stored secret (right-to-deletion without
  // uninstalling). The per-team collector rebuilds on the next read via its config fingerprint.
  app.action(new RegExp(`^${ACTIONS.disconnect}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    if (!deps.tenantConfig) return;
    const team = await resolveTeam(client, body);
    if (!team) return;
    const provider = action.value;
    if (provider !== "launchdarkly" && provider !== "jira" && provider !== "github") return;
    await deps.tenantConfig.remove(team, provider);
    await republishHome(client, body.user.id, team);
  });
  app.action(new RegExp(`^${ACTIONS.addMapping}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    if (!deps.tenantConfig) return;
    const team = await resolveTeam(client, body);
    if (!team) return;
    const config = (await deps.tenantConfig.get(team, "proof_targets")) ?? {};
    // "Add mapping" carries value "proof_targets" (fresh); a row's ✏️ Edit carries the mapping key.
    const val = action?.value;
    const prefillKey = val && val !== "proof_targets" && config[val] ? val : undefined;
    await client.views.open({ trigger_id: body.trigger_id, view: addMappingModal(config, prefillKey) });
  });
  app.action(new RegExp(`^${ACTIONS.removeMapping}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    if (!deps.tenantConfig) return;
    const team = await resolveTeam(client, body);
    if (!team) return;
    const key = action?.value;
    const config = (await deps.tenantConfig.get(team, "proof_targets")) ?? {};
    if (key && key in config) {
      const rest = { ...config }; // remove just this one, keep the rest
      delete rest[key];
      await deps.tenantConfig.set(team, "proof_targets", rest);
    }
    await republishHome(client, body.user.id, team);
  });

  // --- 🎬 Demo Controls (App Home) — judge-operable hero flow, DEMO WORKSPACE ONLY ---
  // Every handler is team-scoped (resolveTeam) AND gated to `deps.demoTeam` (invariant #4): the
  // controls do nothing for any other workspace. None posts to the customer (invariant #3) — the
  // engine assembles proof and the judge (as owner) still signs each gate; "still fails" reopens.
  app.action(new RegExp(`^${ACTIONS.demoShip}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team || !isDemoTeam(team)) return;
    try {
      await orch.markDemoShipped(team, obligationOf(action));
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.demoToggle}:`), async ({ ack, body, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team || !isDemoTeam(team)) return;
    // Flip the controllable production flag the demo tenant's proof collector reads. No live
    // integration is touched — this is exactly what verify()/recordFulfillmentSignal re-read.
    setDemoFlag(!demoFlagOn());
    await republishHome(client, body.user.id, team);
  });
  app.action(new RegExp(`^${ACTIONS.demoFail}:`), async ({ ack, body, action, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team || !isDemoTeam(team)) return;
    try {
      const o = await orch.obligation(obligationOf(action), team); // tenant-scoped (throws on cross-tenant)
      if (o) await orch.reopen(o.id, "customer reports it still fails"); // engine-only; never messages the customer
      await republishHome(client, body.user.id, team);
    } catch (err) {
      if (!(await handledCrossTenant(client, body, err))) throw err;
    }
  });
  app.action(new RegExp(`^${ACTIONS.demoReset}:`), async ({ ack, body, client }: any) => {
    await ack();
    const team = await resolveTeam(client, body);
    if (!team || !isDemoTeam(team)) return;
    // Wipe the demo tenant's ledger (team-scoped), reset the flag OFF, and re-seed a fresh promise.
    await orch.resetDemo(team);
    resetDemoProof();
    await ensureDemoSeed(client, body.user.id, team);
    await republishHome(client, body.user.id, team);
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
  // Gate-2 modal submit — the human signs the verdict. verify() re-gathers proof and refuses if the
  // evidence still doesn't reconcile (e.g. production flag OFF); on refusal we re-render the packet so
  // the owner sees exactly why. Tenant-scoped: verify() enforces acting team == the obligation's team.
  app.view(CALLBACKS.verifyPacket, async ({ ack, body, view, client }: any) => {
    const id = view.private_metadata;
    let team: string;
    try {
      team = requireTeam(body);
    } catch {
      await ack();
      await dmUser(client, body.user.id, ":warning: Couldn't determine your workspace — action blocked.");
      return;
    }
    try {
      const { draftSent } = await orch.verify(id, body.user.id, team);
      if (draftSent) {
        await ack(); // close the modal — the send nudge is now in the owner's DMs
        await republishHome(client, body.user.id, team);
      } else {
        // Blocked — keep the modal open, re-rendered with the (still-failing) evidence packet.
        const packet = await orch.assemblePacket(id, team);
        await ack(packet ? { response_action: "update", view: verifyPacketModal(packet.obligation, packet.assessment) } : {});
      }
    } catch (err) {
      if (err instanceof CrossTenantWriteError) {
        await ack();
        await dmUser(client, body.user.id, ":lock: That obligation belongs to another workspace — action blocked.");
        return;
      }
      await ack();
      await dmUser(client, body.user.id, ":warning: Couldn't verify right now — please try again.");
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

  // --- Connections modal submissions — write the acting team's own provider config ---
  // teamId is resolved from `body` (same fail-CLOSED path as the other view handlers); the
  // provider is stashed in `private_metadata` when the modal is opened. A blank token input
  // KEEPS the saved token (never overwrite a secret with empty). Tokens are never logged/echoed.
  app.view(CALLBACKS.connectProvider, async ({ ack, body, view, client }: any) => {
    const provider = view.private_metadata;
    const v = view.state.values;
    // On a team-less submission, keep the modal open with an inline error rather than write unscoped.
    const errBlock = provider === "jira" ? FIELDS.jiraBaseUrl.block : provider === "github" ? FIELDS.ghToken.block : FIELDS.ldToken.block;
    let team: string;
    try {
      team = requireTeam(body);
    } catch {
      await ack({ response_action: "errors", errors: { [errBlock]: "Couldn't determine your workspace — action blocked." } });
      return;
    }
    await ack();
    if (!deps.tenantConfig) return;
    const tc = deps.tenantConfig;
    const str = (b: { block: string; action: string }): string | undefined => (v[b.block]?.[b.action]?.value ?? "").trim() || undefined;
    if (provider === "launchdarkly") {
      const cur = await tc.get(team, "launchdarkly"); // keep the saved token if the input is blank
      await tc.set(team, "launchdarkly", {
        mcpToken: str(FIELDS.ldToken) ?? cur?.mcpToken,
        projectKey: str(FIELDS.ldProject),
        environment: str(FIELDS.ldEnv),
      });
    } else if (provider === "jira") {
      const cur = await tc.get(team, "jira");
      await tc.set(team, "jira", {
        baseUrl: str(FIELDS.jiraBaseUrl),
        email: str(FIELDS.jiraEmail),
        apiToken: str(FIELDS.jiraToken) ?? cur?.apiToken,
        cloudId: str(FIELDS.jiraCloudId),
      });
    } else if (provider === "github") {
      const cur = await tc.get(team, "github");
      await tc.set(team, "github", { token: str(FIELDS.ghToken) ?? cur?.token });
    } else {
      return; // unknown provider — ignore
    }
    await republishHome(client, body.user.id, team);
  });
  app.view(CALLBACKS.addMapping, async ({ ack, body, view, client }: any) => {
    const v = view.state.values;
    const val = (b: { block: string; action: string }): string => (v[b.block]?.[b.action]?.value ?? "").trim();
    const key = val(FIELDS.mapKey);
    const flag = val(FIELDS.mapFlag);
    const environment = val(FIELDS.mapEnv) || "production";
    let team: string;
    try {
      team = requireTeam(body);
    } catch {
      await ack({ response_action: "errors", errors: { [FIELDS.mapKey.block]: "Couldn't determine your workspace — action blocked." } });
      return;
    }
    if (!key || !flag) {
      await ack({ response_action: "errors", errors: { [!key ? FIELDS.mapKey.block : FIELDS.mapFlag.block]: "Required." } });
      return;
    }
    await ack();
    if (!deps.tenantConfig) return;
    // Load → merge the new entry into the existing proof-target map → save (never clobber prior keys).
    const current = (await deps.tenantConfig.get(team, "proof_targets")) ?? {};
    await deps.tenantConfig.set(team, "proof_targets", { ...current, [key]: { flag: { key: flag, environment } } });
    await republishHome(client, body.user.id, team);
  });

  // /kept <customer>            → the two-sided ledger (scoped to the invoking workspace)
  // /kept trust <customer>       → mint (or reuse) the customer's audience-safe trust page URL
  // /kept untrust <customer>     → revoke that customer's trust link (old URLs then 404)
  app.command("/kept", async ({ ack, respond, command }: any) => {
    await ack();
    const text = (command.text || "").trim();
    const team = command.team_id;

    // `/kept customer <name>` — bind THIS channel to a customer (a shared customer channel = one
    // customer). The binding then anchors every promise here, overriding the LLM's guess.
    const bind = /^customer(?:\s+(.+))?$/i.exec(text);
    if (bind) {
      if (!deps.tenantConfig) {
        await respond({ response_type: "ephemeral", text: ":information_source: Channel→customer binding isn't available on this deployment." });
        return;
      }
      const channel = command.channel_id;
      const arg = (bind[1] || "").trim();
      const current = (await deps.tenantConfig.get(team, "channel_customers")) ?? {};
      if (!arg) {
        const c = current[channel];
        await respond({ response_type: "ephemeral", text: c
          ? `:round_pushpin: This channel is bound to *${c}* — every promise here is tracked for them. Change with \`/kept customer <name>\`, clear with \`/kept customer clear\`.`
          : "This channel has no customer binding. Set one with `/kept customer <name>` so every promise here is tracked for that customer — no guessing from the wording." });
        return;
      }
      if (/^(clear|none|off|remove)$/i.test(arg)) {
        delete current[channel];
        await deps.tenantConfig.set(team, "channel_customers", current);
        await respond({ response_type: "ephemeral", text: ":unlock: Cleared this channel's customer binding — Kept will infer the customer from each message again." });
        return;
      }
      current[channel] = arg;
      await deps.tenantConfig.set(team, "channel_customers", current);
      await respond({ response_type: "ephemeral", text: `:round_pushpin: This channel is now bound to *${arg}*. Every promise here is tracked for ${arg}, regardless of how it's worded.` });
      return;
    }

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
