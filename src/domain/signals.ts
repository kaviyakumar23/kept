/**
 * C1 — Typed signal taxonomy.
 *
 * "Can you do Friday?", "I'll check", "yes, we'll do Friday", and "we should be
 * able to" are NOT equivalent. The classifier emits one of these typed signals;
 * it never collapses to a binary is/isn't-a-request.
 */
export type ObligationSignal =
  | "CUSTOMER_REQUEST" // customer asks; no commitment yet
  | "INTERNAL_ACKNOWLEDGEMENT" // "I'll check with eng" — not a promise
  | "TENTATIVE_COMMITMENT" // "we should be able to do Friday"
  | "CONFIRMED_COMMITMENT" // "yes, we'll have it fixed by Friday"
  | "SCOPE_CHANGE" // changes the date/scope of an existing obligation
  | "FULFILLMENT_SIGNAL" // deploy / Done / release
  | "CUSTOMER_CONFIRMATION" // customer says it works
  | "CANCELLATION"
  | "NON_ACTIONABLE";

export const ALL_SIGNALS: ObligationSignal[] = [
  "CUSTOMER_REQUEST",
  "INTERNAL_ACKNOWLEDGEMENT",
  "TENTATIVE_COMMITMENT",
  "CONFIRMED_COMMITMENT",
  "SCOPE_CHANGE",
  "FULFILLMENT_SIGNAL",
  "CUSTOMER_CONFIRMATION",
  "CANCELLATION",
  "NON_ACTIONABLE",
];

/**
 * Who owes whom. The P0 ledger is a *customer request-and-commitment* ledger
 * (correction #2): what the customer asked for, and what the team committed to.
 * The CUSTOMER_OWES_TEAM direction is modeled but out of P0 scope.
 */
export type Direction = "TEAM_OWES_CUSTOMER" | "CUSTOMER_OWES_TEAM";

/** Signals that, once human-confirmed, create or imply a team→customer obligation. */
export const COMMITMENT_SIGNALS: ReadonlySet<ObligationSignal> = new Set([
  "TENTATIVE_COMMITMENT",
  "CONFIRMED_COMMITMENT",
]);
