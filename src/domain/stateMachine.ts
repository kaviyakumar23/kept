import type { ObligationState } from "./state.js";
import { ACTIVE_STATES } from "./state.js";
import type { EventType, ObligationEvent } from "./events.js";
import type { Obligation } from "./obligation.js";

/**
 * C7 — the lifecycle as an explicit, guarded transition module (not free-form LLM steps).
 *
 * Every event type declares the states it may apply from, the state it moves to,
 * and whether it requires human approval and/or corroborating evidence. The two
 * mandatory human gates fall out of these flags:
 *   • Gate 1: COMMITMENT_CONFIRMED  (CANDIDATE → OPEN), requiresApproval
 *   • Gate 2: INTERNALLY_VERIFIED   (POSSIBLE_FULFILLMENT → VERIFIED), requiresApproval + requiresEvidence
 *             CUSTOMER_NOTIFIED     (VERIFIED → CUSTOMER_NOTIFIED), requiresApproval
 */
export interface TransitionSpec {
  from: ObligationState[] | "ANY_ACTIVE" | "CREATE";
  to: ObligationState | "SAME";
  requiresApproval: boolean;
  requiresEvidence: boolean;
  changesState: boolean;
}

const T = (s: TransitionSpec): TransitionSpec => s;

export const TRANSITIONS: Record<EventType, TransitionSpec> = {
  REQUEST_DETECTED: T({ from: "CREATE", to: "CANDIDATE", requiresApproval: false, requiresEvidence: false, changesState: true }),
  COMMITMENT_CONFIRMED: T({ from: ["CANDIDATE"], to: "OPEN", requiresApproval: true, requiresEvidence: false, changesState: true }),
  DISMISSED: T({ from: ["CANDIDATE"], to: "DISMISSED", requiresApproval: true, requiresEvidence: false, changesState: true }),
  CLARIFICATION_FLAGGED: T({ from: ["CANDIDATE"], to: "SAME", requiresApproval: false, requiresEvidence: false, changesState: false }),
  CLARIFICATION_CLEARED: T({ from: ["CANDIDATE"], to: "SAME", requiresApproval: false, requiresEvidence: false, changesState: false }),
  WORK_ITEM_LINKED: T({ from: ["OPEN", "IN_PROGRESS", "REOPENED"], to: "SAME", requiresApproval: true, requiresEvidence: false, changesState: false }),
  WORK_STARTED: T({ from: ["OPEN", "REOPENED"], to: "IN_PROGRESS", requiresApproval: false, requiresEvidence: false, changesState: true }),
  DUE_DATE_CHANGED: T({ from: "ANY_ACTIVE", to: "SAME", requiresApproval: true, requiresEvidence: false, changesState: false }),
  SCOPE_CHANGED: T({ from: "ANY_ACTIVE", to: "SAME", requiresApproval: false, requiresEvidence: false, changesState: false }),
  // Allowed from POSSIBLE_FULFILLMENT too, so multiple evidence signals (PR merge, then
  // deploy) can accumulate toward sufficiency without leaving the state.
  FULFILLMENT_SIGNAL_DETECTED: T({ from: ["OPEN", "IN_PROGRESS", "POSSIBLE_FULFILLMENT"], to: "POSSIBLE_FULFILLMENT", requiresApproval: false, requiresEvidence: true, changesState: true }),
  INTERNALLY_VERIFIED: T({ from: ["POSSIBLE_FULFILLMENT"], to: "VERIFIED", requiresApproval: true, requiresEvidence: true, changesState: true }),
  VERIFICATION_FAILED: T({ from: ["POSSIBLE_FULFILLMENT"], to: "IN_PROGRESS", requiresApproval: false, requiresEvidence: false, changesState: true }),
  CUSTOMER_NOTIFIED: T({ from: ["VERIFIED"], to: "CUSTOMER_NOTIFIED", requiresApproval: true, requiresEvidence: false, changesState: true }),
  CUSTOMER_CONFIRMED: T({ from: ["CUSTOMER_NOTIFIED"], to: "CLOSED", requiresApproval: false, requiresEvidence: false, changesState: true }),
  REOPENED: T({ from: ["CUSTOMER_NOTIFIED", "CLOSED", "VERIFIED"], to: "REOPENED", requiresApproval: false, requiresEvidence: false, changesState: true }),
  CANCELLED: T({ from: "ANY_ACTIVE", to: "CANCELLED", requiresApproval: true, requiresEvidence: false, changesState: true }),
};

function sourceAllows(spec: TransitionSpec, state: ObligationState): boolean {
  if (spec.from === "CREATE") return false; // creation is handled separately
  if (spec.from === "ANY_ACTIVE") return ACTIVE_STATES.has(state);
  return spec.from.includes(state);
}

export type GuardResult =
  | { ok: true; to: ObligationState }
  | {
      ok: false;
      code: "ILLEGAL_TRANSITION" | "APPROVAL_REQUIRED" | "EVIDENCE_REQUIRED" | "INSUFFICIENT_EVIDENCE";
      message: string;
    };

export interface GuardContext {
  /** Result of multi-source reconciliation — required by INTERNALLY_VERIFIED. */
  evidenceSufficient?: boolean;
}

/**
 * The single authority on whether an event may be applied. The LLM proposes;
 * THIS decides. No transition happens without passing here.
 */
export function canApply(
  current: Obligation | null,
  event: ObligationEvent,
  ctx: GuardContext = {},
): GuardResult {
  const spec = TRANSITIONS[event.type];

  // Creation
  if (spec.from === "CREATE") {
    if (current !== null) {
      return { ok: false, code: "ILLEGAL_TRANSITION", message: `${event.type} cannot apply to an existing obligation` };
    }
    return { ok: true, to: "CANDIDATE" };
  }

  if (current === null) {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: `${event.type} requires an existing obligation` };
  }

  if (!sourceAllows(spec, current.state)) {
    return { ok: false, code: "ILLEGAL_TRANSITION", message: `${event.type} not allowed from state ${current.state}` };
  }

  if (spec.requiresApproval && !event.approved_by) {
    return { ok: false, code: "APPROVAL_REQUIRED", message: `${event.type} requires human approval (approved_by)` };
  }

  if (spec.requiresEvidence) {
    if (event.type === "FULFILLMENT_SIGNAL_DETECTED") {
      if (!("evidence" in event) || !event.evidence) {
        return { ok: false, code: "EVIDENCE_REQUIRED", message: "FULFILLMENT_SIGNAL_DETECTED requires evidence" };
      }
    }
    if (event.type === "INTERNALLY_VERIFIED" && ctx.evidenceSufficient !== true) {
      return {
        ok: false,
        code: "INSUFFICIENT_EVIDENCE",
        message: "INTERNALLY_VERIFIED requires reconciled evidence proving availability (ticket-Done alone is not enough)",
      };
    }
  }

  return { ok: true, to: spec.to === "SAME" ? current.state : spec.to };
}
