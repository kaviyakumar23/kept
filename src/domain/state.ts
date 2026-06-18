/**
 * C7 + correction #4 — the lifecycle is split into three concerns:
 *   • State  — where the obligation currently is (this file)
 *   • Flags  — current conditions, derived from events + time (ObligationFlags)
 *   • Events — what happened (events.ts)
 *
 * AT_RISK / OVERDUE / SCOPE_CHANGED are NOT states (an obligation can be
 * IN_PROGRESS *and* at-risk); they are derived flags. SCOPE_CHANGED is an event.
 */
export type ObligationState =
  | "CANDIDATE" // detected, awaiting Gate 1 (human confirmation)
  | "OPEN" // commitment confirmed, work not yet started
  | "IN_PROGRESS"
  | "POSSIBLE_FULFILLMENT" // evidence suggests done — NOT truth
  | "VERIFIED" // human verified availability (Gate 2)
  | "CUSTOMER_NOTIFIED"
  | "CLOSED"
  // terminal / branching
  | "DISMISSED"
  | "CANCELLED"
  | "REOPENED"; // customer says it still fails; outlives the ticket

/** Conditions derived from the event log + the current time. Never stored as state. */
export interface ObligationFlags {
  needs_clarification: boolean;
  is_overdue: boolean;
  is_at_risk: boolean;
  has_scope_change: boolean;
  is_disputed: boolean;
}

export const TERMINAL_STATES: ReadonlySet<ObligationState> = new Set([
  "CLOSED",
  "DISMISSED",
  "CANCELLED",
]);

/** Post-candidate, non-terminal states — the window in which time-based flags apply. */
export const ACTIVE_STATES: ReadonlySet<ObligationState> = new Set([
  "OPEN",
  "IN_PROGRESS",
  "POSSIBLE_FULFILLMENT",
  "VERIFIED",
  "CUSTOMER_NOTIFIED",
  "REOPENED",
]);

/** States in which the obligation is still actively being worked / chased. */
export const WORKABLE_STATES: ReadonlySet<ObligationState> = new Set([
  "OPEN",
  "IN_PROGRESS",
  "REOPENED",
]);

export const emptyFlags = (): ObligationFlags => ({
  needs_clarification: false,
  is_overdue: false,
  is_at_risk: false,
  has_scope_change: false,
  is_disputed: false,
});
