import type { ObligationId, UserId } from "./ids.js";
import type { Actor, EventSource, WorkSystem, DetectedRefs } from "./events.js";
import type { Direction, ObligationSignal } from "./signals.js";
import type { Evidence } from "./evidence.js";

/**
 * The architectural keystone (critique §"One architectural improvement"):
 *
 *   The LLM never writes an event such as CUSTOMER_NOTIFIED. It proposes a
 *   Command. The deterministic domain engine validates whether that command is
 *   permitted (guards + evidence + approval) and only then emits events.
 *
 *   "The model interprets language; code controls state and actions."
 */
export type Command =
  | { kind: "DETECT_REQUEST"; team: string; direction: Direction; signal: ObligationSignal; customer: string; subject_canonical: string; outcome: string; due: string | null; owner: UserId | null; conditions: string[]; refs?: DetectedRefs; slack?: { channel: string; thread_ts: string; permalink?: string } }
  | { kind: "CONFIRM_COMMITMENT"; outcome: string; due: string | null; owner: UserId } // Gate 1
  | { kind: "DISMISS" }
  | { kind: "FLAG_CLARIFICATION" }
  | { kind: "CLEAR_CLARIFICATION" }
  | { kind: "LINK_WORK_ITEM"; work_system: WorkSystem; work_ref: string }
  | { kind: "START_WORK" }
  | { kind: "CHANGE_DUE_DATE"; to: string | null } // consequential → approval
  | { kind: "RECORD_SCOPE_CHANGE"; note: string }
  | { kind: "RECORD_FULFILLMENT_SIGNAL"; evidence: Evidence }
  | { kind: "VERIFY_FULFILLMENT"; rationale: string; evidenceIds?: string[] } // Gate 2
  | { kind: "REJECT_FULFILLMENT"; reason: string }
  // The sanitized customer-facing draft text is carried so the engine can reject a
  // leaky draft at the command boundary (D1 enforced by construction). draftText is
  // validated but NOT persisted (zero-copy); only draftRef lands in the event.
  | { kind: "NOTIFY_CUSTOMER"; draftText: string; draftRef: string | null }
  | { kind: "RECORD_CUSTOMER_CONFIRMATION" }
  | { kind: "REOPEN"; reason: string }
  | { kind: "CANCEL"; reason: string };

export type CommandKind = Command["kind"];

/** Envelope context the proposer supplies; decide() reads the target + provenance from here. */
export interface CommandContext {
  /** Target obligation. For DETECT_REQUEST this is a freshly minted id. */
  obligationId: ObligationId;
  actor: Actor;
  source: EventSource;
  idempotencyKey: string;
  at: string; // ISO timestamp
  /** Present only when a human approved a Gate transition. */
  approvedBy?: UserId | null;
  /** Reference "now" for projection-derived guards/flags. */
  now?: number;
}
