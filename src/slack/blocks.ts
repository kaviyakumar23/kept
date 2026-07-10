import type { Obligation } from "../domain/obligation.js";
import type { ObligationEvent } from "../domain/events.js";
import type { Evidence } from "../domain/evidence.js";
import type { Classification } from "../llm/schemas.js";
import type { FulfillmentAssessment } from "../engine/reconciliation.js";
import type { ClosureDraft } from "../policy/audience.js";
import type { RtsContext } from "./rts.js";
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
  approveSend: "kept_approve_send",
  editDraft: "kept_edit_draft",
  history: "kept_history",
} as const;

/** Modal callback ids + input block/action ids (read back on view_submission). */
export const CALLBACKS = { editObligation: "kept_edit_obligation", editDraft: "kept_edit_draft_modal" } as const;
export const FIELDS = {
  outcome: { block: "b_outcome", action: "i_outcome" },
  due: { block: "b_due", action: "i_due" },
  owner: { block: "b_owner", action: "i_owner" },
  draft: { block: "b_draft", action: "i_draft" },
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
export function confirmCard(o: Obligation, classification: Classification, rts: RtsContext, roadmapWarning?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header("Kept · new obligation detected"),
    section(`*${o.customer}* — ${o.outcome}\n_${SIGNAL_LABEL[classification.signal] ?? classification.signal}_`),
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: dueLabel(o.due) },
        { type: "mrkdwn", text: `*Owner:* ${o.owner && /^[UW][A-Z0-9]{2,}$/.test(o.owner) ? `<@${o.owner}>` : "—"}` },
        { type: "mrkdwn", text: `*Customer:* ${o.customer}` },
        { type: "mrkdwn", text: `*Confidence:* ${(classification.confidence * 100).toFixed(0)}%` },
      ],
    },
  ];
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
function evidencePacketRows(evidence: Evidence[]): string[] {
  const rows: string[] = [];
  const flag = latestEvidence(evidence, "feature_flag");
  if (flag) rows.push(flag.data.enabled === true ? "Feature flag ON ✓" : "Feature flag OFF ✗");
  const ci = latestEvidence(evidence, "ci_run");
  if (ci) rows.push(ci.data.conclusion === "success" ? "CI success ✓" : `CI ${escapeMrkdwn(String(ci.data.conclusion ?? "?"))} ✗`);
  const status = latestEvidence(evidence, "status_page");
  if (status) rows.push(status.data.component_status === "operational" ? "Status operational ✓" : `Status ${escapeMrkdwn(String(status.data.component_status ?? "?"))} ✗`);
  if (evidence.some((e) => e.kind === "ticket_status" && String(e.data.status ?? "").toLowerCase() === "done")) rows.push("Ticket Done ✓");
  if (evidence.some((e) => e.kind === "pr_merged" && e.data.merged === true)) rows.push("Code merged ✓");
  if (evidence.some((e) => e.kind === "deploy" && isProdEnv(e.data.environment))) rows.push("Prod deploy ✓");
  if (evidence.some((e) => e.kind === "customer_reply" && e.data.confirmed === true)) rows.push("Customer confirmed ✓");
  if (rows.length === 0) rows.push("(no corroborating evidence yet)");
  return rows.map((r) => `• ${r}`);
}

/** Gate 2 — the Proof-of-Done evidence packet + verdict. A human signs; the agent assembled it. */
export function possibleFulfillmentCard(o: Obligation, assessment: FulfillmentAssessment): SlackBlock[] {
  return [
    header("Kept · Proof-of-Done evidence packet"),
    section(`*${o.customer}* — ${o.outcome}`),
    section(`*Evidence packet:*\n${evidencePacketRows(o.evidence).join("\n")}`),
    section(
      assessment.available
        ? "*Verdict: available* — proof reconciled ✅"
        : "*Verdict: blocked* — not verifiably available ⛔",
    ),
    context(assessment.rationale),
    {
      type: "actions",
      elements: [
        button("Verify it's available", ACTIONS.verify, o.id, "primary"),
        button("Not yet", ACTIONS.notYet, o.id),
      ],
    },
    context("Ticket-Done alone is never enough — Kept reconciles flag / CI / status / merge / deploy (or a customer confirmation)."),
  ];
}

/** Closure draft approval card — the sanitized, customer-facing text to be posted in-thread. */
export function closureDraftCard(o: Obligation, draft: ClosureDraft): SlackBlock[] {
  return [
    header("Kept · ready to close the loop"),
    section(`*${o.customer}* — ${o.outcome}\nDraft reply for the original thread:`),
    section(`>>> ${draft.text}`),
    context(
      draft.safe.redactedCount > 0
        ? `${draft.safe.redactedCount} internal item(s) redacted (${draft.safe.redactedSources.join(", ") || "internal"}). ${draft.clean ? "Leak-safe ✅" : "⚠️ leak detected"}`
        : draft.clean
          ? "Leak-safe ✅"
          : "⚠️ leak detected",
    ),
    {
      type: "actions",
      elements: [button("Approve & send", ACTIONS.approveSend, o.id, "primary"), button("Edit", ACTIONS.editDraft, o.id)],
    },
  ];
}

const STATE_EMOJI: Record<string, string> = {
  CANDIDATE: "🟡", OPEN: "🔵", IN_PROGRESS: "🔵", POSSIBLE_FULFILLMENT: "🟣",
  VERIFIED: "🟢", CUSTOMER_NOTIFIED: "🟢", CLOSED: "✅", REOPENED: "🔁", DISMISSED: "⚪", CANCELLED: "⚪",
};

/** W5 — drift radar bucket → emoji, worst first. */
const DRIFT_EMOJI: Record<DriftBucket, string> = { STALLED: "🔴", SLIPPING: "🟠", SOFTENING: "〰️", FIRM: "🟢" };

function ledgerLine(o: Obligation): string {
  const flags: string[] = [];
  if (o.flags.is_overdue) flags.push("overdue");
  else if (o.flags.is_at_risk) flags.push("at risk");
  if (o.flags.is_disputed) flags.push("disputed");
  if (o.flags.has_scope_change) flags.push("scope changed");
  const tail = flags.length ? `  _(${flags.join(", ")})_` : "";
  const ref = o.work_item ? `  ·  ${escapeMrkdwn(o.work_item.ref)}` : "";
  return `${STATE_EMOJI[o.state] ?? "•"} *${escapeMrkdwn(o.outcome)}* — ${o.state}${o.due ? `, due ${escapeMrkdwn(o.due)}` : ""}${ref}${tail}`;
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
export function auditHistoryView(o: Obligation, events: ObligationEvent[]): SlackBlock[] {
  const lines = events.map((e) => {
    const approver = e.approved_by ? ` · approved by <@${e.approved_by}>` : "";
    const src = e.source.system !== "system" ? ` · ${e.source.system}` : "";
    return `\`${e.at.slice(0, 19).replace("T", " ")}\`  *${e.type}*${src}${approver}`;
  });
  return [
    header(`Audit history · ${o.outcome}`),
    section(`*${o.customer}* — current state: *${o.state}* (v${o.state_version}, ${o.history_count} events)`),
    divider,
    section(lines.join("\n") || "_no events_"),
  ];
}

/** Internal nudge for an at-risk / overdue obligation (owner only — no public noise). */
export function reminderMessage(o: Obligation, kind: "AT_RISK" | "OVERDUE"): { text: string; blocks: SlackBlock[] } {
  const label = kind === "OVERDUE" ? "⏰ Overdue" : "⚠️ At risk";
  const text = `${label}: ${o.customer} — ${o.outcome}${o.due ? ` (due ${o.due})` : ""}`;
  return { text, blocks: [section(`${label}\n*${escapeMrkdwn(o.customer)}* — ${escapeMrkdwn(o.outcome)}\n${dueLabel(o.due)}  ·  state ${o.state}`)] };
}

// --- App Home (live ledger dashboard) --------------------------------------
/** The App Home tab — every customer's request-and-commitment ledger, with drill-in. */
export function appHomeView(obligations: Obligation[], now: number = Date.now()): SlackView {
  const blocks: SlackBlock[] = [
    header("Kept · the obligation ledger"),
    context("Everything your team committed to — and everything customers asked for."),
  ];
  if (obligations.length === 0) {
    blocks.push(section("_No obligations yet. Kept will surface them as they're made._"));
    return { type: "home", blocks };
  }
  // Insight band (flag/state-derived → deterministic): what needs attention right now.
  const a = analytics(obligations, now);
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Open:* ${a.counts.open}` },
      { type: "mrkdwn", text: `:red_circle: *Overdue:* ${a.overdue.length}` },
      { type: "mrkdwn", text: `:large_yellow_circle: *At risk:* ${a.atRisk.length}` },
      { type: "mrkdwn", text: `:eyes: *Awaiting verify:* ${a.awaitingVerify.length}` },
    ],
  });
  // W5 — promise-drift radar band (certainty-decay derived → deterministic): which
  // commitments are softening / slipping / going silent. Rendered only when something drifts.
  const radar = driftRadar(obligations, now);
  if (radar.counts.drifting > 0) {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `:chart_with_downwards_trend: *Drifting:* ${radar.counts.drifting}` },
        { type: "mrkdwn", text: `:red_circle: *Stalled:* ${radar.counts.stalled}` },
        { type: "mrkdwn", text: `:large_orange_circle: *Slipping:* ${radar.counts.slipping}` },
        { type: "mrkdwn", text: `:wavy_dash: *Softening:* ${radar.counts.softening}` },
      ],
    });
    for (const r of radar.readings.slice(0, 3)) {
      const why = r.reasons.length ? ` — ${escapeMrkdwn(r.reasons.join(", "))}` : "";
      blocks.push(context(`${DRIFT_EMOJI[r.bucket]} *${escapeMrkdwn(r.customer)}* — ${escapeMrkdwn(r.outcome)}: _${r.bucket.toLowerCase()}_${why}`));
    }
  }
  const byCustomer = new Map<string, Obligation[]>();
  for (const o of obligations) {
    const list = byCustomer.get(o.customer) ?? [];
    list.push(o);
    byCustomer.set(o.customer, list);
  }
  for (const [customer, list] of byCustomer) {
    const openCount = list.filter((o) => !["CLOSED", "DISMISSED", "CANCELLED"].includes(o.state)).length;
    blocks.push(divider, section(`*${customer}*  ·  ${openCount} open`));
    for (const o of list) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: ledgerLine(o) },
        accessory: button("History", ACTIONS.history, o.id),
      });
    }
  }
  return { type: "home", blocks };
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

function inputBlock(blockId: string, label: string, actionId: string, initial: string, opts: { multiline?: boolean; optional?: boolean } = {}): SlackBlock {
  const element: Record<string, unknown> = { type: "plain_text_input", action_id: actionId, multiline: opts.multiline ?? false };
  if (initial) element.initial_value = initial;
  return { type: "input", block_id: blockId, optional: opts.optional ?? false, label: { type: "plain_text", text: label }, element };
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
