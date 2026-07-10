import type { Obligation } from "../domain/obligation.js";
import type { ObligationState } from "../domain/state.js";

/**
 * Pure read-model analytics over the obligation projections — the "intelligent
 * insights" surfaced by the App Home band and the Slack AI Assistant. It does NOT
 * re-derive risk thresholds: overdue / at-risk come straight from the engine-computed
 * `flags` (config `riskWindowMs`), so the dashboard and the engine never disagree.
 * Everything here is a deterministic function of (projections, now) — no I/O.
 */

const TERMINAL: ReadonlyArray<ObligationState> = ["CLOSED", "DISMISSED", "CANCELLED"];
export const PROMISE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Open = still owed (not closed/dismissed/cancelled). */
export const isOpen = (o: Obligation): boolean => !TERMINAL.includes(o.state);

export interface OwnerStat {
  owner: string;
  open: number;
  overdue: number;
  awaitingVerify: number;
}
export interface CustomerStat {
  customer: string;
  open: number;
  overdue: number;
}
export interface AgingBucket {
  label: string;
  count: number;
}

export interface LedgerAnalytics {
  counts: { total: number; open: number; byState: Partial<Record<ObligationState, number>> };
  /** Open and past due (engine flag). */
  overdue: Obligation[];
  /** Open, at-risk, not yet overdue (engine flag). */
  atRisk: Obligation[];
  /** In POSSIBLE_FULFILLMENT — evidence in, a human still needs to verify (Gate 2). */
  awaitingVerify: Obligation[];
  disputed: Obligation[];
  /** Open with a due date within the next PROMISE_WINDOW_DAYS. */
  promisedThisWeek: Obligation[];
  byOwner: OwnerStat[];
  byCustomer: CustomerStat[];
  aging: { oldestOpenDays: number; buckets: AgingBucket[] };
  /**
   * The differentiator, quantified: how many promises Kept blocked from a FALSE close because a
   * proof source reported not-actually-done (flag OFF in prod / CI failing / status degraded).
   * Every one is a broken promise a ticket-only tool would have shipped to the customer as "Done".
   */
  blockedCatches: number;
}

const daysBetween = (a: number, b: number): number => Math.max(0, Math.floor((a - b) / DAY_MS));

/** Compute the full insight set. `now` is epoch ms. */
export function analytics(obligations: Obligation[], now: number): LedgerAnalytics {
  const open = obligations.filter(isOpen);

  const byState: Partial<Record<ObligationState, number>> = {};
  for (const o of obligations) byState[o.state] = (byState[o.state] ?? 0) + 1;

  const overdue = open.filter((o) => o.flags.is_overdue);
  const atRisk = open.filter((o) => o.flags.is_at_risk && !o.flags.is_overdue);
  const awaitingVerify = open.filter((o) => o.state === "POSSIBLE_FULFILLMENT");
  const disputed = obligations.filter((o) => o.flags.is_disputed);

  const weekEnd = now + PROMISE_WINDOW_DAYS * DAY_MS;
  const promisedThisWeek = open.filter((o) => {
    if (!o.due) return false;
    const t = Date.parse(o.due);
    return !Number.isNaN(t) && t >= now && t <= weekEnd;
  });

  const ownerMap = new Map<string, OwnerStat>();
  for (const o of open) {
    const owner = o.owner ?? "unassigned";
    const s = ownerMap.get(owner) ?? { owner, open: 0, overdue: 0, awaitingVerify: 0 };
    s.open++;
    if (o.flags.is_overdue) s.overdue++;
    if (o.state === "POSSIBLE_FULFILLMENT") s.awaitingVerify++;
    ownerMap.set(owner, s);
  }
  const byOwner = [...ownerMap.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);

  const custMap = new Map<string, CustomerStat>();
  for (const o of open) {
    const s = custMap.get(o.customer) ?? { customer: o.customer, open: 0, overdue: 0 };
    s.open++;
    if (o.flags.is_overdue) s.overdue++;
    custMap.set(o.customer, s);
  }
  const byCustomer = [...custMap.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);

  const ages = open.map((o) => daysBetween(now, Date.parse(o.created_at) || now));
  const buckets: AgingBucket[] = [
    { label: "≤1d", count: ages.filter((d) => d <= 1).length },
    { label: "2–7d", count: ages.filter((d) => d > 1 && d <= 7).length },
    { label: "8–30d", count: ages.filter((d) => d > 7 && d <= 30).length },
    { label: ">30d", count: ages.filter((d) => d > 30).length },
  ];

  // A promise Kept caught: any proof source in its history reported not-actually-done, so the close
  // was blocked before it could reach the customer (cumulative — counts ones later fixed + closed too).
  const blockedCatches = obligations.filter((o) =>
    o.evidence.some(
      (e) =>
        (e.kind === "feature_flag" && e.data.enabled === false) ||
        (e.kind === "ci_run" && e.data.conclusion !== undefined && e.data.conclusion !== "success") ||
        (e.kind === "status_page" && e.data.component_status !== undefined && e.data.component_status !== "operational"),
    ),
  ).length;

  return {
    counts: { total: obligations.length, open: open.length, byState },
    overdue,
    atRisk,
    awaitingVerify,
    disputed,
    promisedThisWeek,
    byOwner,
    byCustomer,
    // reduce (not Math.max(...spread)) — a 125k+ open ledger would blow the arg limit.
    aging: { oldestOpenDays: ages.reduce((m, d) => (d > m ? d : m), 0), buckets },
    blockedCatches,
  };
}

/** Obligations a specific owner still needs to verify — powers "anything waiting on me?". */
export function awaitingVerifyFor(a: LedgerAnalytics, owner: string): Obligation[] {
  return a.awaitingVerify.filter((o) => (o.owner ?? "unassigned") === owner);
}
