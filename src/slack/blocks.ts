import type { Obligation } from "../domain/obligation.js";
import type { ObligationState } from "../domain/state.js";
import type { ObligationEvent } from "../domain/events.js";
import type { Evidence } from "../domain/evidence.js";
import type { Classification } from "../llm/schemas.js";
import type { FulfillmentAssessment } from "../engine/reconciliation.js";
import type { ClosureDraft } from "../policy/audience.js";
import type { RtsContext } from "./rts.js";
import type {
  GithubTenantConfig,
  IntegrationProvider,
  JiraTenantConfig,
  LaunchDarklyTenantConfig,
  ProofTargetsConfig,
} from "../store/tenantConfigStore.js";
import { analytics } from "../app/analytics.js";
import { driftRadar, type DriftBucket } from "../app/drift.js";

/** A Block Kit block / surface — valid Slack JSON. Kept dependency-light (plain objects). */
export type SlackBlock = Record<string, unknown>;
export type SlackView = Record<string, unknown>;

// --- action id routing -----------------------------------------------------
export const ACTIONS = {
  confirm: "kept_confirm",
  edit: "kept_edit",
  dismiss: "kept_dismiss",
  verify: "kept_verify",
  notYet: "kept_not_yet",
  // Option A — owner manually attests delivery (for teams with no automated proof source).
  markDelivered: "kept_mark_delivered",
  approveSend: "kept_approve_send",
  editDraft: "kept_edit_draft",
  history: "kept_history",
  // App Home "Connections" surface — the provider rides in the action_id suffix + `value`.
  connect: "kept_connect",
  disconnect: "kept_disconnect",
  addMapping: "kept_add_mapping",
  removeMapping: "kept_remove_mapping",
  // App Home "🎬 Demo Controls" (demo workspace only) — the in-flight demo obligation id rides
  // in the action_id suffix + `value`, exactly like the per-obligation gate buttons.
  demoShip: "kept_demo_ship",
  demoToggle: "kept_demo_toggle",
  demoFail: "kept_demo_fail",
  demoReset: "kept_demo_reset",
} as const;

/** Modal callback ids + input block/action ids (read back on view_submission). */
export const CALLBACKS = {
  editObligation: "kept_edit_obligation",
  editDraft: "kept_edit_draft_modal",
  connectProvider: "kept_connect_provider",
  addMapping: "kept_add_mapping_modal",
  verifyPacket: "kept_verify_packet_modal",
} as const;
export const FIELDS = {
  outcome: { block: "b_outcome", action: "i_outcome" },
  due: { block: "b_due", action: "i_due" },
  owner: { block: "b_owner", action: "i_owner" },
  draft: { block: "b_draft", action: "i_draft" },
  // Connections modals (one input per field; token fields never carry an initial value).
  ldToken: { block: "b_ld_token", action: "i_ld_token" },
  ldProject: { block: "b_ld_project", action: "i_ld_project" },
  ldEnv: { block: "b_ld_env", action: "i_ld_env" },
  jiraBaseUrl: { block: "b_jira_base", action: "i_jira_base" },
  jiraEmail: { block: "b_jira_email", action: "i_jira_email" },
  jiraToken: { block: "b_jira_token", action: "i_jira_token" },
  jiraCloudId: { block: "b_jira_cloud", action: "i_jira_cloud" },
  ghToken: { block: "b_gh_token", action: "i_gh_token" },
  mapKey: { block: "b_map_key", action: "i_map_key" },
  mapFlag: { block: "b_map_flag", action: "i_map_flag" },
  mapEnv: { block: "b_map_env", action: "i_map_env" },
} as const;

export const actionId = (action: string, obligationId: string): string => `${action}:${obligationId}`;
export function parseActionId(id: string): { action: string; obligationId: string } {
  const i = id.indexOf(":");
  return i < 0 ? { action: id, obligationId: "" } : { action: id.slice(0, i), obligationId: id.slice(i + 1) };
}

// --- helpers ---------------------------------------------------------------
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): SlackBlock => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const divider: SlackBlock = { type: "divider" };
const button = (text: string, action: string, obligationId: string, style?: "primary" | "danger"): SlackBlock => ({
  type: "button",
  text: { type: "plain_text", text, emoji: true },
  action_id: actionId(action, obligationId),
  value: obligationId,
  ...(style ? { style } : {}),
});

/** Neutralize Slack mrkdwn control chars so an LLM/adapter-supplied value can't inject a mention/link. */
const escapeMrkdwn = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dueLabel = (due: string | null): string => (due ? `*Due:* ${escapeMrkdwn(due)}` : "*Due:* —");
const SIGNAL_LABEL: Record<string, string> = {
  CUSTOMER_REQUEST: "Customer request — not yet a commitment",
  TENTATIVE_COMMITMENT: "Tentative commitment",
  CONFIRMED_COMMITMENT: "Confirmed commitment",
};

/** Gate 1 — private confirm card to the account owner (Confirm · Edit · Not a request). */
export function confirmCard(o: Obligation, classification: Classification, rts: RtsContext, roadmapWarning?: string, agentName?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header("Kept · confirm this promise"),
    section(`*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}`),
    context(`_${SIGNAL_LABEL[classification.signal] ?? classification.signal}_  ·  ${(classification.confidence * 100).toFixed(0)}% confidence`),
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: dueLabel(o.due) },
        { type: "mrkdwn", text: `*Owner:* ${o.owner && /^[UW][A-Z0-9]{2,}$/.test(o.owner) ? `<@${o.owner}>` : "—"}` },
        { type: "mrkdwn", text: `*Customer:* ${escapeMrkdwn(o.customer)}` },
        { type: "mrkdwn", text: `*Source:* Slack thread` },
      ],
    },
  ];
  // #5 — an AI agent made this promise in the customer channel. Kept still holds it: routed to a
  // human owner (above), badged here, human-signed at Gate 1.
  if (agentName) {
    blocks.push(context(`🤖 *Promised by ${escapeMrkdwn(agentName)}* — an AI agent made this commitment; a human owner verifies it.`));
  }
  if (rts.priorCommitments.length > 0) {
    blocks.push(
      context(
        `Prior to ${o.customer}: ` +
          rts.priorCommitments.map((p) => `${p.outcome} (${p.state}${p.due ? `, due ${p.due}` : ""})`).join(" · "),
      ),
    );
  }
  if (rts.notes.length > 0) {
    blocks.push(context(`Related context (RTS): ${rts.notes.join(" · ")}`));
  }
  if (roadmapWarning) {
    blocks.push(section(`:warning: *Roadmap conflict* — ${roadmapWarning}`));
  }
  blocks.push({
    type: "actions",
    elements: [
      button("Confirm", ACTIONS.confirm, o.id, "primary"),
      button("Edit", ACTIONS.edit, o.id),
      button("Not a request", ACTIONS.dismiss, o.id, "danger"),
    ],
  });
  blocks.push(context("Private to you · Kept won't post anything to the customer without your approval."));
  return blocks;
}

/** Latest observation of a proof kind (evidence encodes the check instant in `ref`/`at`). */
const latestEvidence = (evidence: Evidence[], kind: Evidence["kind"]): Evidence | undefined =>
  evidence.filter((e) => e.kind === kind).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();

const isProdEnv = (v: unknown): boolean => {
  const s = String(v ?? "").toLowerCase();
  return s === "production" || s === "prod";
};

/**
 * The Proof-of-Done evidence packet: one row per gathered signal (✓ passed / ✗ failed),
 * so a reviewer sees at a glance WHY the close is or isn't allowed — e.g. "Ticket Done ✓"
 * next to "Feature flag OFF ✗" is the whole differentiator.
 */
// Provenance tags — so the reader knows HOW Kept knows each fact: a source Kept actively
// queried ("read live") vs. an event a pipeline pushed to Kept's webhook ("reported").
const LIVE = "  _· read live_";
const REPORTED = "  _· reported_";
function evidencePacketRows(evidence: Evidence[]): string[] {
  const rows: string[] = [];
  const flag = latestEvidence(evidence, "feature_flag");
  if (flag) rows.push((flag.data.enabled === true ? "🚩 Production flag *ON*  ✓" : "🚩 Production flag *OFF*  ✗") + LIVE);
  const ci = latestEvidence(evidence, "ci_run");
  if (ci) rows.push((ci.data.conclusion === "success" ? "🔧 CI *passed*  ✓" : `🔧 CI *${escapeMrkdwn(String(ci.data.conclusion ?? "?"))}*  ✗`) + LIVE);
  const status = latestEvidence(evidence, "status_page");
  if (status) rows.push((status.data.component_status === "operational" ? "🟢 Status *operational*  ✓" : `🟠 Status *${escapeMrkdwn(String(status.data.component_status ?? "?"))}*  ✗`) + LIVE);
  const ticket = latestEvidence(evidence, "ticket_status");
  if (ticket && String(ticket.data.status ?? "").toLowerCase() === "done") {
    // ticket_status has two provenances: a collector MCP read encodes the instant in `ref`
    // (`KEY@<iso>`) → read live; a webhook push carries a bare `KEY` → reported. Label honestly.
    const readLive = /@\d{4}-\d\d-\d\d/.test(ticket.ref);
    rows.push("🎫 Ticket *Done*  ✓" + (readLive ? LIVE : REPORTED));
  }
  if (evidence.some((e) => e.kind === "pr_merged" && e.data.merged === true)) rows.push("🔀 Code *merged*  ✓" + REPORTED);
  if (evidence.some((e) => e.kind === "deploy" && isProdEnv(e.data.environment))) rows.push("🚀 *Prod deploy*  ✓" + REPORTED);
  if (evidence.some((e) => e.kind === "customer_reply" && e.data.confirmed === true)) rows.push("💬 *Customer confirmed*  ✓" + REPORTED);
  if (evidence.some((e) => e.kind === "manual_delivery")) rows.push("✍️ *Marked delivered by the owner*  ✓  _· attested_");
  if (rows.length === 0) rows.push("_no corroborating evidence yet_");
  return rows.map((r) => `•  ${r}`);
}

const PACKET_LEGEND =
  "_read live_ = Kept queried the source just now · _reported_ = your pipeline pushed it · _attested_ = a human marked it delivered. A closed ticket is never enough on its own.";

/** The shared Proof-of-Done body — evidence rows + verdict + rationale. Reused by the DM card and
 *  the Home verify modal, so a promise reads identically wherever the owner opens it. No buttons. */
function evidencePacketBlocks(o: Obligation, assessment: FulfillmentAssessment): SlackBlock[] {
  return [
    section(`*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}`),
    section(`*What Kept gathered*\n${evidencePacketRows(o.evidence).join("\n")}`),
    divider,
    section(
      assessment.available
        ? "✅ *Ready to close* — every signal reconciles."
        : "⛔ *Not ready to close* — the evidence doesn't agree yet.",
    ),
    context(assessment.rationale),
  ];
}

/** Gate 2 — the Proof-of-Done evidence packet + verdict. A human signs; the agent assembled it. */
export function possibleFulfillmentCard(o: Obligation, assessment: FulfillmentAssessment): SlackBlock[] {
  return [
    header("Kept · Proof-of-Done"),
    ...evidencePacketBlocks(o, assessment),
    {
      type: "actions",
      elements: [
        button("Verify it's available", ACTIONS.verify, o.id, "primary"),
        button("Not yet", ACTIONS.notYet, o.id),
      ],
    },
    context(PACKET_LEGEND),
  ];
}

/** Gate 2 as a focused modal — opened from the Home row or the DM nudge. The evidence is shown; the
 *  modal's *submit* IS the human signature. On a blocked verdict the engine still refuses on submit
 *  and the handler re-renders this modal with the (still-failing) packet. private_metadata = id. */
export function verifyPacketModal(o: Obligation, assessment: FulfillmentAssessment): SlackView {
  return {
    type: "modal",
    callback_id: CALLBACKS.verifyPacket,
    private_metadata: o.id,
    title: { type: "plain_text", text: "Proof-of-Done" },
    submit: { type: "plain_text", text: "Verify it's available" },
    close: { type: "plain_text", text: "Not yet" },
    blocks: [...evidencePacketBlocks(o, assessment), context(PACKET_LEGEND)],
  };
}

/** Thin owner DM — "something's ready to verify", one button that opens the packet modal. Replaces
 *  the full packet card in the DM so the app's message history stays a scannable nudge list, not a
 *  wall of stacked cards. The evidence lives in the modal, one click away. */
export function verifyNudge(o: Obligation): SlackBlock[] {
  return [
    section(`*${escapeMrkdwn(o.customer)} — ${escapeMrkdwn(o.outcome)}* is ready for your review.`),
    context("Kept gathered the delivery evidence. Open it to see what reconciles — and sign only if it does."),
    { type: "actions", elements: [button("Review & verify", ACTIONS.verify, o.id, "primary")] },
  ];
}

/** Thin owner DM — "verified, ready to send", one button that opens the closure-draft modal. */
export function sendNudge(o: Obligation): SlackBlock[] {
  return [
    section(`*${escapeMrkdwn(o.customer)} — ${escapeMrkdwn(o.outcome)}* is verified and ready to close.`),
    context("Review the sanitized reply, then send it to the customer thread when you're happy."),
    { type: "actions", elements: [button("Review & send", ACTIONS.editDraft, o.id, "primary")] },
  ];
}

/** Closure draft approval card — the sanitized, customer-facing text to be posted in-thread. */
export function closureDraftCard(o: Obligation, draft: ClosureDraft): SlackBlock[] {
  const n = draft.safe.redactedCount;
  const safety =
    !draft.clean
      ? "⚠️ Review before sending — an internal detail may leak."
      : n > 0
        ? `🛡️ Safe to send — Kept kept ${n} internal detail${n === 1 ? "" : "s"} out of the customer's reply.`
        : "🛡️ Safe to send — nothing internal is in this reply.";
  return [
    header("Kept · close the loop"),
    section(`*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}`),
    context("Draft reply for the original customer thread. Nothing is sent until you approve."),
    section(`>>> ${draft.text}`),
    context(safety),
    {
      type: "actions",
      elements: [button("Approve & send", ACTIONS.approveSend, o.id, "primary"), button("Edit", ACTIONS.editDraft, o.id)],
    },
  ];
}

/**
 * Shared status vocabulary — engine state → human-readable {emoji, label}. Used on EVERY
 * surface (App Home rows, cards, receipts, reminders) so a user never sees a raw enum name
 * like POSSIBLE_FULFILLMENT. One source of truth for how a promise's status reads.
 */
const STATUS: Record<ObligationState, { emoji: string; label: string }> = {
  CANDIDATE: { emoji: "🟡", label: "Awaiting confirmation" },
  OPEN: { emoji: "🔵", label: "Tracking" },
  IN_PROGRESS: { emoji: "🔵", label: "In progress" },
  POSSIBLE_FULFILLMENT: { emoji: "👀", label: "Awaiting your verify" },
  VERIFIED: { emoji: "☑️", label: "Verified — ready to close" },
  CUSTOMER_NOTIFIED: { emoji: "📣", label: "Closing with customer" },
  CLOSED: { emoji: "✅", label: "Kept" },
  REOPENED: { emoji: "↩️", label: "Reopened" },
  DISMISSED: { emoji: "⚪", label: "Dismissed" },
  CANCELLED: { emoji: "⚪", label: "Cancelled" },
};
const statusOf = (state: ObligationState): { emoji: string; label: string } => STATUS[state] ?? { emoji: "•", label: state };
const statusChip = (state: ObligationState): string => {
  const s = statusOf(state);
  return `${s.emoji} ${s.label}`;
};

/** W5 — drift radar bucket → emoji, worst first. */
const DRIFT_EMOJI: Record<DriftBucket, string> = { STALLED: "🔴", SLIPPING: "🟠", SOFTENING: "〰️", FIRM: "🟢" };

/** One tidy row per obligation — status chip + outcome + the facts a reviewer scans for. */
function ledgerLine(o: Obligation): string {
  const s = statusOf(o.state);
  const flags: string[] = [];
  if (o.flags.is_overdue) flags.push("overdue");
  else if (o.flags.is_at_risk) flags.push("at risk");
  if (o.flags.is_disputed) flags.push("disputed");
  if (o.flags.has_scope_change) flags.push("scope changed");
  const tail = flags.length ? `  _(${flags.join(", ")})_` : "";
  const ref = o.work_item ? `  ·  ${escapeMrkdwn(o.work_item.ref)}` : "";
  const due = o.due ? `  ·  due ${escapeMrkdwn(o.due)}` : "";
  return `${s.emoji}  *${escapeMrkdwn(o.outcome)}*  —  ${s.label}${due}${ref}${tail}`;
}

/** The "what we owe Acme" view — request-and-commitment ledger for one customer. */
export function ledgerView(customer: string, obligations: Obligation[]): SlackBlock[] {
  const open = obligations.filter((o) => !["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state));
  const closed = obligations.filter((o) => o.state === "CLOSED");
  const blocks: SlackBlock[] = [header(`What we owe ${customer}`)];
  if (open.length === 0) blocks.push(section("_No open obligations._"));
  else {
    const MAX = 25; // keep one section under Slack's 3000-char limit
    const shown = open.slice(0, MAX);
    const more = open.length - shown.length;
    blocks.push(section(shown.map(ledgerLine).join("\n") + (more > 0 ? `\n_…and ${more} more._` : "")));
  }
  if (closed.length > 0) {
    blocks.push(divider, context(`Recently closed: ${closed.map((o) => escapeMrkdwn(o.outcome)).join(" · ")}`));
  }
  return blocks;
}

/** Full audit-history panel for one obligation — every transition, explainable. */
/** One human-readable "receipt" line per event — plain language + the key detail, not the raw type. */
function receiptLine(e: ObligationEvent): string {
  switch (e.type) {
    case "REQUEST_DETECTED": return "📥 *Promise captured* in Slack";
    case "COMMITMENT_CONFIRMED": return "✅ *Confirmed* — Gate 1 (human signed)";
    case "DISMISSED": return "🚫 *Dismissed* — not a request";
    case "CLARIFICATION_FLAGGED": return "❓ *Needs clarification*";
    case "CLARIFICATION_CLEARED": return "❔ *Clarified*";
    case "WORK_ITEM_LINKED": return `🔗 *Work item linked* — ${escapeMrkdwn(e.work_system)}:${escapeMrkdwn(e.work_ref)}`;
    case "WORK_STARTED": return "🛠️ *Work started*";
    case "DUE_DATE_CHANGED": return `📅 *Due changed* — ${escapeMrkdwn(e.from ?? "—")} → ${escapeMrkdwn(e.to ?? "—")}`;
    case "SCOPE_CHANGED": return `✏️ *Scope changed* — ${escapeMrkdwn(e.note)}`;
    case "FULFILLMENT_SIGNAL_DETECTED": return fulfillmentReceipt(e.evidence);
    case "INTERNALLY_VERIFIED": return "☑️ *Verified* — Gate 2 (proof reconciled, human signed)";
    case "VERIFICATION_FAILED": return `⛔ *Close blocked* — ${escapeMrkdwn(e.reason)}`;
    case "CUSTOMER_NOTIFIED": return "📣 *Sanitized closure posted* to the customer thread";
    case "CUSTOMER_CONFIRMED": return "🎉 *Customer confirmed* — loop closed";
    case "REOPENED": return `↩️ *Reopened* — ${escapeMrkdwn(e.reason)}`;
    case "CANCELLED": return `🗑️ *Cancelled* — ${escapeMrkdwn(e.reason)}`;
    default: return `*${(e as { type: string }).type}*`;
  }
}

/** The proof-evidence detail for a fulfillment signal (this is where "flag OFF ✗" lands). */
function fulfillmentReceipt(ev: Evidence): string {
  switch (ev.kind) {
    case "feature_flag": return ev.data.enabled === true ? "🟢 *Production flag ON* — feature reachable" : "🔴 *Production flag OFF* — not actually shipped (close blocked)";
    case "ci_run": return ev.data.conclusion === "success" ? "🟢 *CI passed*" : `🔴 *CI ${escapeMrkdwn(String(ev.data.conclusion ?? "?"))}*`;
    case "status_page": return ev.data.component_status === "operational" ? "🟢 *Status operational*" : `🔴 *Status ${escapeMrkdwn(String(ev.data.component_status ?? "?"))}*`;
    case "ticket_status": return `🎫 *Ticket ${escapeMrkdwn(String(ev.data.status ?? "updated"))}*`;
    case "pr_merged": return ev.data.merged === true ? "🔀 *PR merged*" : "🔀 *PR update*";
    case "deploy": return `🚀 *Deployed* — ${escapeMrkdwn(String(ev.data.environment ?? "?"))}`;
    default: return `📎 *${escapeMrkdwn(ev.kind)}*`;
  }
}

/** "Show receipts" — the append-only event log rendered as a human-readable timeline. Proves the
 *  event-sourcing claim without a word of explanation: every state change, signed, in order. */
export function auditHistoryView(o: Obligation, events: ObligationEvent[]): SlackBlock[] {
  const lines = events.map((e) => {
    const ts = `\`${e.at.slice(0, 16).replace("T", " ")}\``;
    const who = e.approved_by ? ` · <@${e.approved_by}>` : "";
    return `${ts}  ${receiptLine(e)}${who}`;
  });
  return [
    header("Receipts — the full ledger"),
    section(`*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}\nStatus: *${statusChip(o.state)}*  ·  ${o.history_count} events, append-only & human-signed at both gates`),
    divider,
    section(lines.join("\n") || "_no events_"),
    context("Event-sourced: this is the actual immutable log Kept decides from — nothing here is reconstructed after the fact."),
  ];
}

/** Internal nudge for an at-risk / overdue obligation (owner only — no public noise). */
export function reminderMessage(o: Obligation, kind: "AT_RISK" | "OVERDUE"): { text: string; blocks: SlackBlock[] } {
  const label = kind === "OVERDUE" ? "⏰ Overdue" : "⚠️ At risk";
  const text = `${label}: ${o.customer} — ${o.outcome}${o.due ? ` (due ${o.due})` : ""}`;
  return {
    text,
    blocks: [
      section(`*${label}*\n*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}`),
      context(`${dueLabel(o.due)}  ·  ${statusChip(o.state)}`),
    ],
  };
}

// --- App Home (live ledger dashboard) --------------------------------------
/** Provider display metadata for the App Home "Connections" rows. */
const CONNECT_PROVIDERS: { provider: Extract<IntegrationProvider, "launchdarkly" | "jira" | "github">; label: string }[] = [
  { provider: "launchdarkly", label: "LaunchDarkly" },
  { provider: "jira", label: "Jira" },
  { provider: "github", label: "GitHub" },
];

/**
 * The "🔌 Connections" surface — each workspace connects ITS OWN proof sources. `configured`
 * is the acting team's `tenantConfig.listConfigured(teamId)` result (tenant-scoped, invariant #4).
 * Undefined = no tenant-config store wired (single-token / dev path) → the section is omitted.
 */
function connectionsBlocks(configured?: IntegrationProvider[], mappings?: ProofTargetsConfig): SlackBlock[] {
  if (!configured) return [];
  const on = new Set(configured);
  const blocks: SlackBlock[] = [
    divider,
    header("Connections"),
    context("Connect this workspace's own proof sources. Kept reads them only for your team."),
  ];
  for (const { provider, label } of CONNECT_PROVIDERS) {
    const connected = on.has(provider);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${label}* — ${connected ? "Connected ✓" : "Not connected"}` },
      ...(connected ? {} : { accessory: button("Connect", ACTIONS.connect, provider, "primary") }),
    });
    if (connected) {
      blocks.push({
        type: "actions",
        elements: [button("Manage", ACTIONS.connect, provider), button("Disconnect", ACTIONS.disconnect, provider, "danger")],
      });
    }
  }
  // Proof-target mappings — one row per (customer/subject → flag), each editable + removable.
  blocks.push(divider, section("*Proof-target mappings* — which flag proves each customer's work"));
  const keys = Object.keys(mappings ?? {});
  if (keys.length === 0) {
    blocks.push(context("None yet — map a customer to a LaunchDarkly flag so Kept can verify their promises."));
  } else {
    for (const key of keys) {
      const m = mappings![key];
      const target = m.flag
        ? `\`${escapeMrkdwn(m.flag.key)}\`${m.flag.environment ? `  ·  ${escapeMrkdwn(m.flag.environment)}` : ""}`
        : m.ci
          ? `CI \`${escapeMrkdwn(m.ci.owner)}/${escapeMrkdwn(m.ci.repo)}\``
          : "—";
      blocks.push(
        { type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(key)}*  →  ${target}` } },
        { type: "actions", elements: [
          button("Edit", ACTIONS.addMapping, key),
          button("Remove", ACTIONS.removeMapping, key, "danger"),
        ] },
      );
    }
  }
  blocks.push({ type: "actions", elements: [button("Add mapping", ACTIONS.addMapping, "proof_targets", "primary")] });
  return blocks;
}

/**
 * The judge-operable "🎬 Demo Controls" panel — rendered ONLY on the demo workspace's App Home
 * (invariant #4 — the Slack layer passes `demo` only when the acting team === deps.demoTeam).
 * It shows the live demo state (the in-flight promise + the controllable production flag) and the
 * four buttons that drive the whole hero loop from Slack. Mirrors `connectionsBlocks`.
 */
export function demoControlsBlocks(obligation: Obligation | null, flagOn: boolean): SlackBlock[] {
  const id = obligation?.id ?? "";
  const promise = obligation
    ? `*${escapeMrkdwn(obligation.customer)}* — ${escapeMrkdwn(obligation.outcome)}  ·  ${statusChip(obligation.state)}`
    : "_none yet — click Reset demo to seed a fresh one_";
  return [
    divider,
    header("Demo Controls"),
    context("Judge-operable hero flow. Drive the whole loop from these buttons — the engine will personally block you until the production flag is ON."),
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Demo promise:* ${promise}` },
        { type: "mrkdwn", text: `*Production feature flag:* ${flagOn ? "ON ✅" : "OFF ⛔"}` },
      ],
    },
    context("Start here → 1) *Mark work shipped* → Kept DMs a nudge; open it (or the promise on Home) for the evidence packet, flag OFF ⛔. 2) *Verify it's available* → the engine refuses. 3) *Toggle production flag* ON → *Verify* again → it passes → *Review & send* the sanitized closure."),
    {
      type: "actions",
      elements: [
        button("Mark work shipped", ACTIONS.demoShip, id, "primary"),
        button(flagOn ? "Toggle production flag (ON→OFF)" : "Toggle production flag (OFF→ON)", ACTIONS.demoToggle, id),
        button("Customer replies: still fails", ACTIONS.demoFail, id),
        button("Reset demo", ACTIONS.demoReset, id, "danger"),
      ],
    },
  ];
}

/** The one action a promise is waiting on, by state — so every Home row can be acted on in place
 *  (the cockpit). Verify/Send open focused modals; Confirm/Mark-delivered act directly. Terminal
 *  and awaiting-customer rows have no pending owner action (null → just Receipts). */
function primaryActionFor(o: Obligation): { label: string; action: string } | null {
  // Slack app-design: button labels are clean, specific text — no emoji on controls.
  switch (o.state) {
    case "CANDIDATE": return { label: "Confirm", action: ACTIONS.confirm };
    case "OPEN":
    case "IN_PROGRESS":
    case "REOPENED": return { label: "Mark delivered", action: ACTIONS.markDelivered };
    case "POSSIBLE_FULFILLMENT": return { label: "Verify", action: ACTIONS.verify };
    case "VERIFIED": return { label: "Send", action: ACTIONS.editDraft };
    default: return null; // CUSTOMER_NOTIFIED / CLOSED / DISMISSED / CANCELLED
  }
}

/** App Home row for one obligation — the status line plus its next action, so the whole lifecycle
 *  is driveable from the Home tab (no hunting through DMs). Rows with a pending action render as a
 *  section + [action · 🧾 Receipts]; settled rows collapse to one line with Receipts as accessory. */
function obligationBlocks(o: Obligation): SlackBlock[] {
  const primary = primaryActionFor(o);
  const receipts = button("Receipts", ACTIONS.history, o.id);
  if (!primary) {
    return [{ type: "section", text: { type: "mrkdwn", text: ledgerLine(o) }, accessory: receipts }];
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: ledgerLine(o) } },
    { type: "actions", elements: [button(primary.label, primary.action, o.id, "primary"), receipts] },
  ];
}
/** Stable de-dupe by id (an obligation can be both overdue and awaiting-verify). */
function dedupeById(list: Obligation[]): Obligation[] {
  const seen = new Set<string>();
  const out: Obligation[] = [];
  for (const o of list) if (!seen.has(o.id)) { seen.add(o.id); out.push(o); }
  return out;
}
const OPEN_STATE = (o: Obligation): boolean => !["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state);
const TERMINAL_STATE = (o: Obligation): boolean => ["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state);
/** Sort key so the promises needing a human float to the top of each customer's list. */
const ACTION_RANK: Partial<Record<ObligationState, number>> = {
  POSSIBLE_FULFILLMENT: 0, VERIFIED: 1, CANDIDATE: 2, REOPENED: 3, OPEN: 4, IN_PROGRESS: 4, CUSTOMER_NOTIFIED: 6,
};
const actionRank = (o: Obligation): number => (ACTION_RANK[o.state] ?? 5) - (o.flags.is_overdue ? 0.5 : 0);

/** The App Home tab — every customer's request-and-commitment ledger, with drill-in. */
export function appHomeView(
  obligations: Obligation[],
  now: number = Date.now(),
  configured?: IntegrationProvider[],
  demo?: { obligation: Obligation | null; flagOn: boolean },
  mappings?: ProofTargetsConfig,
): SlackView {
  const blocks: SlackBlock[] = [
    header("Kept"),
    context("Customer promises made in Slack — checked against live delivery evidence, closed only when you sign."),
  ];
  // Demo workspace only — the judge-operable panel goes at the top so it's the first thing seen.
  if (demo) blocks.push(...demoControlsBlocks(demo.obligation, demo.flagOn));
  if (obligations.length === 0) {
    blocks.push(
      divider,
      section("*No promises tracked yet.*\nWhen your team commits to a customer in a shared channel — _“we’ll ship the SSO fix by Friday”_ — Kept surfaces it right here for you to confirm."),
    );
    blocks.push(...connectionsBlocks(configured, mappings), homeFooter());
    return { type: "home", blocks };
  }
  const a = analytics(obligations, now);
  // At-a-glance counts — one compact strip (replaces the 2×2 emoji-number tile grid).
  blocks.push(
    divider,
    section(`🔵 *${a.counts.open}* open      🔴 *${a.overdue.length}* overdue      🟡 *${a.atRisk.length}* at risk      👀 *${a.awaitingVerify.length}* to verify`),
  );
  // ⚡ Needs you now — a one-line pointer to what's waiting on the owner. The actual action buttons
  // live on each ledger row below (sorted so these float to the top), so this doesn't re-render them.
  const needsNow = dedupeById([...a.awaitingVerify, ...a.overdue]);
  if (needsNow.length > 0) {
    const items = needsNow.slice(0, 4).map((o) => `${statusOf(o.state).emoji} ${escapeMrkdwn(o.customer)} — ${escapeMrkdwn(o.outcome)}`);
    blocks.push(context(`*Needs you now:*  ${items.join("     ·     ")}${needsNow.length > 4 ? `   +${needsNow.length - 4} more` : ""}`));
  }
  // The differentiator, quantified. Every one is a broken promise a ticket-only tool would have
  // shipped to the customer as "Done". Shown once Kept has actually caught one.
  if (a.blockedCatches > 0) {
    blocks.push(section(`*${a.blockedCatches} close${a.blockedCatches === 1 ? "" : "s"} blocked before reaching a customer* — promises that read “Done” but weren’t actually shipped (flag off · CI red · status degraded).`));
  }
  // W5 — promise-drift radar band (certainty-decay derived → deterministic): which
  // commitments are softening / slipping / going silent. Rendered only when something drifts.
  const radar = driftRadar(obligations, now);
  if (radar.counts.drifting > 0) {
    blocks.push(divider, section(`*Drift radar*  ·  ${radar.counts.drifting} drifting`));
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Stalled*\n🔴 ${radar.counts.stalled}` },
        { type: "mrkdwn", text: `*Slipping*\n🟠 ${radar.counts.slipping}` },
        { type: "mrkdwn", text: `*Softening*\n〰️ ${radar.counts.softening}` },
      ],
    });
    for (const r of radar.readings.slice(0, 3)) {
      const why = r.reasons.length ? ` — ${escapeMrkdwn(r.reasons.join(", "))}` : "";
      blocks.push(context(`${DRIFT_EMOJI[r.bucket]} *${escapeMrkdwn(r.customer)}* — ${escapeMrkdwn(r.outcome)}: _${r.bucket.toLowerCase()}_${why}`));
    }
  }
  // The ledger — grouped by customer, actionable promises first, settled ones collapsed to a line.
  blocks.push(divider, section("*The ledger*  ·  every promise carries its next step — act right here."));
  const byCustomer = new Map<string, Obligation[]>();
  for (const o of obligations) {
    const list = byCustomer.get(o.customer) ?? [];
    list.push(o);
    byCustomer.set(o.customer, list);
  }
  for (const [customer, list] of byCustomer) {
    const active = list.filter((o) => !TERMINAL_STATE(o)).sort((x, y) => actionRank(x) - actionRank(y));
    const kept = list.filter((o) => o.state === "CLOSED");
    const dropped = list.filter((o) => o.state === "DISMISSED" || o.state === "CANCELLED");
    blocks.push(section(`*${escapeMrkdwn(customer)}*  ·  ${active.length} open`));
    for (const o of active) blocks.push(...obligationBlocks(o));
    if (kept.length > 0) blocks.push(context(`✅ *Kept:* ${kept.slice(0, 6).map((o) => escapeMrkdwn(o.outcome)).join("   ·   ")}${kept.length > 6 ? `   +${kept.length - 6} more` : ""}`));
    if (dropped.length > 0) blocks.push(context(`⚪ *Closed:* ${dropped.slice(0, 6).map((o) => escapeMrkdwn(o.outcome)).join("   ·   ")}`));
  }
  blocks.push(...connectionsBlocks(configured, mappings), homeFooter());
  return { type: "home", blocks };
}

/** App Home footer — surfaces help/support, pricing, and the notification control (Slack Home-tab
 *  + notification-preference guidelines). */
function homeFooter(): SlackBlock {
  return context("Kept is free.   Reminders: `/kept notify`   ·   Need a hand?  <https://kept-iota.vercel.app/docs|Docs>  ·  <https://kept-iota.vercel.app/support|Support>");
}

// --- modals ----------------------------------------------------------------
function modal(callbackId: string, title: string, blocks: SlackBlock[], submit: string, privateMetadata: string): SlackView {
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: privateMetadata,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: submit },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function inputBlock(
  blockId: string,
  label: string,
  actionId: string,
  initial: string,
  opts: { multiline?: boolean; optional?: boolean; placeholder?: string; hint?: string } = {},
): SlackBlock {
  const element: Record<string, unknown> = { type: "plain_text_input", action_id: actionId, multiline: opts.multiline ?? false };
  if (initial) element.initial_value = initial;
  if (opts.placeholder) element.placeholder = { type: "plain_text", text: opts.placeholder };
  const block: Record<string, unknown> = { type: "input", block_id: blockId, optional: opts.optional ?? false, label: { type: "plain_text", text: label }, element };
  if (opts.hint) block.hint = { type: "plain_text", text: opts.hint };
  return block;
}

/** Read-only audit history rendered as a modal (opened from the home "History" button). */
export function auditModal(o: Obligation, events: ObligationEvent[]): SlackView {
  return {
    type: "modal",
    callback_id: "kept_audit",
    title: { type: "plain_text", text: "Audit history" },
    close: { type: "plain_text", text: "Close" },
    blocks: auditHistoryView(o, events),
  };
}

/** Gate-1 "Edit" → edit the extracted fields, then confirm. private_metadata = obligation id. */
export function editObligationModal(o: Obligation): SlackView {
  return modal(
    CALLBACKS.editObligation,
    "Edit & confirm",
    [
      inputBlock(FIELDS.outcome.block, "Outcome", FIELDS.outcome.action, o.outcome),
      inputBlock(FIELDS.due.block, "Due (YYYY-MM-DD)", FIELDS.due.action, o.due ?? "", { optional: true }),
      inputBlock(FIELDS.owner.block, "Owner (Slack user id)", FIELDS.owner.action, o.owner ?? "", { optional: true }),
    ],
    "Confirm",
    o.id,
  );
}

/** Closure "Edit" → edit the customer-facing reply before sending (re-leak-checked on submit). */
export function editDraftModal(o: Obligation, draftText: string): SlackView {
  return modal(
    CALLBACKS.editDraft,
    "Edit reply",
    [
      section(`Reply to *${o.customer}* in the original thread:`),
      inputBlock(FIELDS.draft.block, "Message", FIELDS.draft.action, draftText, { multiline: true }),
    ],
    "Approve & send",
    o.id,
  );
}

// --- Connections modals ----------------------------------------------------
// Non-secret fields prefill from the stored config; token fields NEVER carry an initial
// value (a saved secret must never be echoed back into a modal). private_metadata = provider,
// so the view_submission handler knows which config to build (team is resolved from `body`).
const KEEP_TOKEN_HINT = "Leave blank to keep the saved token.";

/** "Connect"/"Manage" per proof source. `config` is the acting team's stored config (or null). */
export function connectModal(
  provider: "launchdarkly" | "jira" | "github",
  config: LaunchDarklyTenantConfig | JiraTenantConfig | GithubTenantConfig | null,
): SlackView {
  if (provider === "launchdarkly") {
    const c = (config ?? {}) as LaunchDarklyTenantConfig;
    return modal(
      CALLBACKS.connectProvider,
      "Connect LaunchDarkly",
      [
        inputBlock(FIELDS.ldToken.block, "API access token", FIELDS.ldToken.action, "", {
          optional: true,
          placeholder: c.mcpToken ? "•••••• saved — leave blank to keep" : "api-xxxxxxxx",
          hint: KEEP_TOKEN_HINT,
        }),
        inputBlock(FIELDS.ldProject.block, "Project key", FIELDS.ldProject.action, c.projectKey ?? "", { optional: true }),
        inputBlock(FIELDS.ldEnv.block, "Environment", FIELDS.ldEnv.action, c.environment ?? "production", { optional: true }),
      ],
      "Save",
      provider,
    );
  }
  if (provider === "jira") {
    const c = (config ?? {}) as JiraTenantConfig;
    return modal(
      CALLBACKS.connectProvider,
      "Connect Jira",
      [
        inputBlock(FIELDS.jiraBaseUrl.block, "Base URL", FIELDS.jiraBaseUrl.action, c.baseUrl ?? "", {
          optional: true,
          placeholder: "https://your-org.atlassian.net",
        }),
        inputBlock(FIELDS.jiraEmail.block, "Email", FIELDS.jiraEmail.action, c.email ?? "", { optional: true }),
        inputBlock(FIELDS.jiraToken.block, "API token", FIELDS.jiraToken.action, "", {
          optional: true,
          placeholder: c.apiToken ? "•••••• saved — leave blank to keep" : "",
          hint: KEEP_TOKEN_HINT,
        }),
        inputBlock(FIELDS.jiraCloudId.block, "Cloud ID (optional)", FIELDS.jiraCloudId.action, c.cloudId ?? "", { optional: true }),
      ],
      "Save",
      provider,
    );
  }
  const c = (config ?? {}) as GithubTenantConfig;
  return modal(
    CALLBACKS.connectProvider,
    "Connect GitHub",
    [
      inputBlock(FIELDS.ghToken.block, "Personal access token", FIELDS.ghToken.action, "", {
        optional: true,
        placeholder: c.token ? "•••••• saved — leave blank to keep" : "ghp_xxxxxxxx",
        hint: KEEP_TOKEN_HINT,
      }),
    ],
    "Save",
    provider,
  );
}

/** "Add mapping" → map a customer / subject key to the LaunchDarkly flag that proves it shipped. */
/** Add OR edit a proof-target mapping. `prefillKey` (from the row's ✏️ Edit) pre-fills the fields. */
export function addMappingModal(config: ProofTargetsConfig, prefillKey?: string): SlackView {
  const cfg = config ?? {};
  const existing = Object.keys(cfg);
  const pre = prefillKey ? cfg[prefillKey] : undefined;
  const blocks: SlackBlock[] = [section("Map a *customer or subject key* to the LaunchDarkly flag that proves it shipped.")];
  if (existing.length) blocks.push(context(`Already mapped: ${existing.map(escapeMrkdwn).join(", ")}`));
  blocks.push(
    inputBlock(FIELDS.mapKey.block, "Customer or subject key", FIELDS.mapKey.action, prefillKey ?? "", { placeholder: "Acme  ·  a subject key  ·  or *" }),
    inputBlock(FIELDS.mapFlag.block, "LaunchDarkly flag key", FIELDS.mapFlag.action, pre?.flag?.key ?? ""),
    inputBlock(FIELDS.mapEnv.block, "Environment (default production)", FIELDS.mapEnv.action, pre?.flag?.environment ?? "production", { optional: true }),
  );
  return modal(CALLBACKS.addMapping, prefillKey ? "Edit proof-target" : "Add proof-target", blocks, "Save mapping", "proof_targets");
}
