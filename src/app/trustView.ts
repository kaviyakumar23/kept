import type { Obligation } from "../domain/obligation.js";
import { sanitizeForAudience, detectLeaks } from "../policy/audience.js";

/**
 * W6 — the customer trust page's DATA model (pure over the obligations).
 *
 * This is the audience gate for a NEW surface, reusing the SAME D1 policy in
 * `src/policy/audience.ts` (invariant #5) — it does not reimplement leak detection.
 * Safety is by construction on two axes:
 *   1. The only free-text this surface emits is the commitment label, and it is gated
 *      with `detectLeaks` — the exact predicate `sanitizeForAudience` applies to every
 *      shareable fact. A label that trips it becomes a generic "Commitment #N".
 *   2. Everything else is a non-text projection — a status bucket (enum), dates, and
 *      counts — so there is no ticket/PR/release ref, internal source, evidence internal,
 *      or reconciliation detail to leak. `sanitizeForAudience` is still run per obligation
 *      to prove the guarantee and to surface how many internal facts were withheld.
 *
 * Tenant/customer scoping is the caller's responsibility: `buildTrustView` only ever sees
 * the obligations it is handed (the orchestrator supplies a team-scoped `listObligations`
 * result), and it filters those to the one pinned customer.
 */
export type TrustBucket = "kept" | "in_progress" | "verifying" | "at_risk";

/** Display order — lead with what we delivered (the retention beat), end with risk. */
export const TRUST_BUCKETS: readonly TrustBucket[] = ["kept", "in_progress", "verifying", "at_risk"];

export interface TrustItem {
  /** Audience-safe label: the outcome if it passes the D1 gate, else a generic "Commitment #N". */
  label: string;
  bucket: TrustBucket;
  /** Due date (YYYY-MM-DD) or null — a date only, never a ref. */
  due: string | null;
  /** The date the commitment was kept (verified / closed), for the "kept on <date>" line. */
  keptOn: string | null;
}

export interface TrustView {
  customer: string;
  /** ISO timestamp the page was generated (drives the footer). */
  generatedAt: string;
  counts: Record<TrustBucket, number>;
  items: TrustItem[];
  /** How many internal-only evidence facts the D1 sanitizer withheld from this page (transparency). */
  redactedInternalCount: number;
}

/** Only commitments the team owes the customer, past Gate 1, and not dropped, are shown. */
const HIDDEN_STATES = new Set(["CANDIDATE", "DISMISSED", "CANCELLED"]);
/** States we present to the customer as "kept" (delivered — verified, communicated, or closed). */
const KEPT_STATES = new Set(["VERIFIED", "CUSTOMER_NOTIFIED", "CLOSED"]);

function bucketOf(o: Obligation): TrustBucket {
  if (KEPT_STATES.has(o.state)) return "kept";
  if (o.state === "POSSIBLE_FULFILLMENT") return "verifying";
  // Active work (OPEN / IN_PROGRESS / REOPENED): risk flags take display precedence.
  if (o.flags.is_overdue || o.flags.is_at_risk) return "at_risk";
  return "in_progress";
}

function isDisplayable(o: Obligation, customer: string): boolean {
  return (
    o.direction === "TEAM_OWES_CUSTOMER" &&
    !HIDDEN_STATES.has(o.state) &&
    o.customer.toUpperCase() === customer.toUpperCase()
  );
}

/**
 * Build the audience-safe trust view for one customer from a set of obligations.
 * The obligations MUST already be tenant-scoped by the caller (the orchestrator passes
 * a team-scoped `listObligations` result); this function pins them to `customer`.
 */
export function buildTrustView(obligations: Obligation[], customer: string, now: number): TrustView {
  const shown = obligations.filter((o) => isDisplayable(o, customer));

  // Stable, human-meaningful order: kept most-recent-first, active by soonest due.
  shown.sort((a, b) => {
    const ba = bucketOf(a);
    const bb = bucketOf(b);
    if (ba !== bb) return TRUST_BUCKETS.indexOf(ba) - TRUST_BUCKETS.indexOf(bb);
    if (ba === "kept") return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    return (a.due ?? "9999-12-31").localeCompare(b.due ?? "9999-12-31");
  });

  const counts: Record<TrustBucket, number> = { kept: 0, in_progress: 0, verifying: 0, at_risk: 0 };
  let redactedInternalCount = 0;
  const items: TrustItem[] = shown.map((o, i) => {
    // Reuse the D1 gate (invariant #5): run this obligation's evidence through the SAME
    // sanitizer the shared customer channel uses. Nothing evidence-derived is rendered —
    // we only tally what it withheld, as a transparency signal to the customer.
    const safe = sanitizeForAudience(o.evidence, "SHARED_CUSTOMER_CHANNEL");
    redactedInternalCount += safe.redactedCount;

    const bucket = bucketOf(o);
    counts[bucket]++;
    // The label is the ONLY free-text on the page; gate it with the same leak detector.
    const label = detectLeaks(o.outcome).length === 0 ? o.outcome : `Commitment #${i + 1}`;
    return {
      label,
      bucket,
      due: o.due,
      keptOn: bucket === "kept" ? o.updated_at : null,
    };
  });

  return {
    customer,
    generatedAt: new Date(now).toISOString(),
    counts,
    items,
    redactedInternalCount,
  };
}
