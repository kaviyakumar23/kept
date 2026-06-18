import { InMemoryEventStore } from "../store/memoryStore.js";
import { ObligationService } from "../engine/obligationService.js";
import { InMemoryScheduler } from "../scheduler/inMemoryScheduler.js";
import type { ReminderJob } from "../scheduler/scheduler.js";
import { userActor, type EventSource } from "../domain/events.js";
import type { CommandContext } from "../domain/commands.js";
import type { Evidence } from "../domain/evidence.js";
import type { ObligationId } from "../domain/ids.js";
import type { ObligationSignal } from "../domain/signals.js";
import type { StructuredRequest } from "../llm/provider.js";

/** Fixed reference clock (matches the demo's "today") for fully deterministic runs. */
export const NOW = Date.parse("2026-06-16T12:00:00Z");
export const ISO_NOW = new Date(NOW).toISOString();

export const AM = userActor("U_ACCOUNT_MANAGER");

export const slackSource = (ref: string): EventSource => ({ system: "slack", ref, accessible_to_user: true });
export const systemSource: EventSource = { system: "system", ref: null, accessible_to_user: true };

export interface CtxOpts {
  approvedBy?: string | null;
  actor?: CommandContext["actor"];
  source?: EventSource;
  at?: string;
  now?: number;
}

export function ctx(obligationId: ObligationId, idempotencyKey: string, opts: CtxOpts = {}): CommandContext {
  return {
    obligationId,
    actor: opts.actor ?? AM,
    source: opts.source ?? systemSource,
    idempotencyKey,
    at: opts.at ?? ISO_NOW,
    approvedBy: opts.approvedBy ?? null,
    now: opts.now ?? NOW,
  };
}

// --- Evidence builders (structured, zero-copy) -----------------------------
export const ticketDone = (id: string, ref: string): Evidence => ({
  id, source: "linear", kind: "ticket_status", ref, at: ISO_NOW, accessible_to_user: true,
  data: { status: "Done" }, proves: "linked ticket marked Done (internal status)",
});
export const prMerged = (id: string, ref: string): Evidence => ({
  id, source: "github", kind: "pr_merged", ref, at: ISO_NOW, accessible_to_user: true,
  data: { merged: true }, proves: "code change merged",
});
export const prodDeploy = (id: string, ref: string): Evidence => ({
  id, source: "deploy", kind: "deploy", ref, at: ISO_NOW, accessible_to_user: true,
  data: { environment: "production", customer_scoped: true }, proves: "released to the customer's environment",
});
export const stagingDeploy = (id: string, ref: string): Evidence => ({
  id, source: "deploy", kind: "deploy", ref, at: ISO_NOW, accessible_to_user: true,
  data: { environment: "staging", customer_scoped: false }, proves: "released to staging",
});
export const customerConfirmed = (id: string, ref: string): Evidence => ({
  id, source: "customer", kind: "customer_reply", ref, at: ISO_NOW, accessible_to_user: true,
  data: { confirmed: true }, proves: "customer confirmed it works",
});

export interface Env {
  store: InMemoryEventStore;
  service: ObligationService;
  scheduler: InMemoryScheduler;
  fired: ReminderJob[];
}

export function buildEnv(now: number = NOW): Env {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => now);
  const fired: ReminderJob[] = [];
  const scheduler = new InMemoryScheduler((job) => {
    fired.push(job);
  });
  return { store, service, scheduler, fired };
}

// --- Classification corpus (gold-labeled) ----------------------------------
export interface LabeledMessage {
  id: string;
  text: string;
  gold: ObligationSignal;
}

export const CLASSIFICATION_CORPUS: LabeledMessage[] = [
  { id: "c1", text: "Can you get the SSO bug fixed by Friday?", gold: "CUSTOMER_REQUEST" },
  { id: "c2", text: "Could you please add SAML support for our login?", gold: "CUSTOMER_REQUEST" },
  { id: "c3", text: "Any chance you can prioritize the export feature this sprint?", gold: "CUSTOMER_REQUEST" },
  { id: "c4", text: "I'll check with eng and get back to you.", gold: "INTERNAL_ACKNOWLEDGEMENT" },
  { id: "c5", text: "Let me look into that and circle back.", gold: "INTERNAL_ACKNOWLEDGEMENT" },
  { id: "c6", text: "We should be able to get that done by Friday.", gold: "TENTATIVE_COMMITMENT" },
  { id: "c7", text: "We'll probably have a fix out next week.", gold: "TENTATIVE_COMMITMENT" },
  { id: "c8", text: "Yes, we'll have the SSO fix shipped by Friday.", gold: "CONFIRMED_COMMITMENT" },
  { id: "c9", text: "Confirmed — we will deliver the report by EOD Thursday.", gold: "CONFIRMED_COMMITMENT" },
  { id: "c10", text: "Actually let's move the deadline to next Wednesday instead of Friday.", gold: "SCOPE_CHANGE" },
  { id: "c11", text: "The SSO fix has been deployed to production.", gold: "FULFILLMENT_SIGNAL" },
  { id: "c12", text: "Done — merged and released in 2026.06.18.", gold: "FULFILLMENT_SIGNAL" },
  { id: "c13", text: "Logging in works perfectly now, thanks!", gold: "CUSTOMER_CONFIRMATION" },
  { id: "c14", text: "Confirmed on our side, the issue is resolved.", gold: "CUSTOMER_CONFIRMATION" },
  { id: "c15", text: "Never mind, we don't need that export anymore.", gold: "CANCELLATION" },
  { id: "c16", text: "Thanks so much for the great support this week!", gold: "NON_ACTIONABLE" },
  { id: "c17", text: "Happy Friday everyone 🎉", gold: "NON_ACTIONABLE" },
  { id: "c18", text: "Can you send us the updated SOC2 report?", gold: "CUSTOMER_REQUEST" },
  { id: "c19", text: "We aim to have this resolved by Monday but no promises.", gold: "TENTATIVE_COMMITMENT" },
  { id: "c20", text: "It's live now — shipped the patch.", gold: "FULFILLMENT_SIGNAL" },
];

/**
 * Offline heuristic "model" — a deterministic keyword classifier used when no LLM
 * key is configured. It is intentionally imperfect, so the eval reports an honest
 * baseline rather than a rigged 100%. Point the runner at AnthropicProvider for
 * the real model's numbers.
 */
export function heuristicResponder(req: StructuredRequest<unknown>): unknown {
  if (req.schemaName === "classify_obligation_signal") {
    return { ...classifyHeuristic(req.user), rationale: "heuristic" };
  }
  if (req.schemaName === "extract_obligation_fields") {
    return extractHeuristic(req.user);
  }
  throw new Error(`no heuristic for schema ${req.schemaName}`);
}

function classifyHeuristic(text: string): { signal: ObligationSignal; direction: string; confidence: number } {
  const t = text.toLowerCase();
  const dir = "TEAM_OWES_CUSTOMER";
  const sig = (signal: ObligationSignal, confidence = 0.8) => ({ signal, direction: dir, confidence });

  if (/\b(works|working|resolved|fixed now|looks good|confirmed on our side)\b/.test(t) && !/can you|could you/.test(t))
    return sig("CUSTOMER_CONFIRMATION");
  if (/\b(deployed|shipped|released|merged|it's live|patch)\b/.test(t) && !/will|we'll/.test(t))
    return sig("FULFILLMENT_SIGNAL");
  if (/\b(never mind|cancel|don't need|drop it)\b/.test(t)) return sig("CANCELLATION");
  if (/\b(move the deadline|instead of|reschedule|change the date|push (it )?to)\b/.test(t)) return sig("SCOPE_CHANGE");
  if (/\b(we'll|we will|confirmed —|yes, we)\b/.test(t)) return sig("CONFIRMED_COMMITMENT");
  if (/\b(should be able|probably|we aim|no promises|try to)\b/.test(t)) return sig("TENTATIVE_COMMITMENT");
  if (/\b(i'll check|let me look|circle back|get back to you)\b/.test(t)) return sig("INTERNAL_ACKNOWLEDGEMENT");
  if (/\b(can you|could you|any chance|please|send us)\b/.test(t) || /\?$/.test(text.trim()))
    return sig("CUSTOMER_REQUEST");
  return sig("NON_ACTIONABLE", 0.6);
}

function extractHeuristic(text: string): {
  customer: string;
  subject_canonical: string;
  outcome: string;
  due: string | null;
  owner: string | null;
  conditions: string[];
  confidence: number;
} {
  const t = text.toLowerCase();
  const subject = /sso|saml|login/.test(t)
    ? "SSO_LOGIN_BUG"
    : /export/.test(t)
      ? "EXPORT_FEATURE"
      : /soc2|report/.test(t)
        ? "SOC2_REPORT"
        : "GENERAL";
  const due = /friday/.test(t) ? "2026-06-19" : null;
  return {
    customer: "Acme",
    subject_canonical: subject,
    outcome: subject === "SSO_LOGIN_BUG" ? "SSO login fix" : subject.toLowerCase().replace(/_/g, " "),
    due,
    owner: null,
    conditions: [],
    confidence: 0.7,
  };
}
