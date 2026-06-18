import type { Command, CommandContext } from "../domain/commands.js";
import type { ObligationEvent, EventEnvelope, EventBody } from "../domain/events.js";
import { newEventId } from "../domain/ids.js";
import { project } from "../domain/projection.js";
import type { Obligation } from "../domain/obligation.js";
import { canApply } from "../domain/stateMachine.js";
import { assertNoRawContent } from "../domain/zeroCopy.js";
import { isConsistentEvidence } from "../domain/evidence.js";
import { detectLeaks } from "../policy/audience.js";
import { hasIdempotencyKey } from "./idempotency.js";
import { assessFulfillment } from "./reconciliation.js";

/**
 * decide() is the deterministic heart of the engine. Given the current event log
 * and a proposed Command, it returns exactly one outcome:
 *   • emit       — the command is valid; here are the events to append
 *   • suppressed — idempotent no-op (the key was already applied)
 *   • rejected   — a guard refused (illegal transition / missing approval / insufficient evidence)
 *
 * It performs NO I/O. Pure (events, command, ctx) → Decision, so it is exhaustively
 * unit-testable and replay-safe.
 */
export type Decision =
  | { outcome: "emit"; events: ObligationEvent[] }
  | { outcome: "suppressed"; reason: string }
  | { outcome: "rejected"; code: string; reason: string };

function bodyFor(command: Command, current: Obligation | null): EventBody {
  switch (command.kind) {
    case "DETECT_REQUEST":
      return {
        type: "REQUEST_DETECTED",
        direction: command.direction,
        signal: command.signal,
        customer: command.customer,
        subject_canonical: command.subject_canonical,
        outcome: command.outcome,
        due: command.due,
        owner: command.owner,
        conditions: command.conditions,
        ...(command.refs ? { refs: command.refs } : {}),
        ...(command.slack ? { slack: command.slack } : {}),
      };
    case "CONFIRM_COMMITMENT":
      return { type: "COMMITMENT_CONFIRMED", outcome: command.outcome, due: command.due, owner: command.owner };
    case "DISMISS":
      return { type: "DISMISSED" };
    case "FLAG_CLARIFICATION":
      return { type: "CLARIFICATION_FLAGGED" };
    case "CLEAR_CLARIFICATION":
      return { type: "CLARIFICATION_CLEARED" };
    case "LINK_WORK_ITEM":
      return { type: "WORK_ITEM_LINKED", work_system: command.work_system, work_ref: command.work_ref };
    case "START_WORK":
      return { type: "WORK_STARTED" };
    case "CHANGE_DUE_DATE":
      return { type: "DUE_DATE_CHANGED", from: current?.due ?? null, to: command.to };
    case "RECORD_SCOPE_CHANGE":
      return { type: "SCOPE_CHANGED", note: command.note };
    case "RECORD_FULFILLMENT_SIGNAL":
      return { type: "FULFILLMENT_SIGNAL_DETECTED", evidence: command.evidence };
    case "VERIFY_FULFILLMENT":
      return { type: "INTERNALLY_VERIFIED", rationale: command.rationale };
    case "REJECT_FULFILLMENT":
      return { type: "VERIFICATION_FAILED", reason: command.reason };
    case "NOTIFY_CUSTOMER":
      return { type: "CUSTOMER_NOTIFIED", draft_ref: command.draftRef };
    case "RECORD_CUSTOMER_CONFIRMATION":
      return { type: "CUSTOMER_CONFIRMED" };
    case "REOPEN":
      return { type: "REOPENED", reason: command.reason };
    case "CANCEL":
      return { type: "CANCELLED", reason: command.reason };
  }
}

export function decide(
  events: ObligationEvent[],
  command: Command,
  ctx: CommandContext,
): Decision {
  // Auditability (G5): every event must carry provenance. Reject a blank or
  // whitespace-only envelope.
  const blank = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";
  if (blank(ctx.actor) || !ctx.source || blank(ctx.source.system) || blank(ctx.at) || blank(ctx.idempotencyKey)) {
    return { outcome: "rejected", code: "INVALID_ENVELOPE", reason: "actor, source.system, at, and idempotencyKey are required (non-blank) for an auditable event" };
  }

  // Idempotency: an already-applied key is a no-op, not an error.
  if (hasIdempotencyKey(events, ctx.idempotencyKey)) {
    return { outcome: "suppressed", reason: `idempotency key already applied: ${ctx.idempotencyKey}` };
  }

  // Command-boundary validation of proposer-supplied data.
  if (command.kind === "RECORD_FULFILLMENT_SIGNAL" && !isConsistentEvidence(command.evidence)) {
    return {
      outcome: "rejected",
      code: "INCONSISTENT_EVIDENCE",
      reason: `evidence source '${command.evidence.source}' may not attest to kind '${command.evidence.kind}'`,
    };
  }
  if (command.kind === "NOTIFY_CUSTOMER") {
    if (!command.draftText.trim()) {
      return { outcome: "rejected", code: "EMPTY_DRAFT", reason: "NOTIFY_CUSTOMER requires the sanitized draft text" };
    }
    const leaks = detectLeaks(command.draftText);
    if (leaks.length > 0) {
      return { outcome: "rejected", code: "LEAK_DETECTED", reason: `customer draft contains internal references: ${leaks.join(", ")}` };
    }
  }

  const current = events.length > 0 ? project(events, { now: ctx.now }) : null;

  const envelope: EventEnvelope = {
    event_id: newEventId(),
    obligation_id: ctx.obligationId,
    at: ctx.at,
    actor: ctx.actor,
    source: ctx.source,
    idempotency_key: ctx.idempotencyKey,
    approved_by: ctx.approvedBy ?? null,
  };

  const event: ObligationEvent = { ...envelope, ...bodyFor(command, current) } as ObligationEvent;

  // Zero-copy: never let raw content into the durable log (correction #3).
  assertNoRawContent(event);

  // Reconciliation gate for verification (Gate 2 evidence requirement).
  const evidenceSufficient =
    event.type === "INTERNALLY_VERIFIED"
      ? assessFulfillment(current?.evidence ?? []).sufficientForVerification
      : undefined;

  const guard = canApply(current, event, { evidenceSufficient });
  if (!guard.ok) {
    return { outcome: "rejected", code: guard.code, reason: guard.message };
  }

  return { outcome: "emit", events: [event] };
}
