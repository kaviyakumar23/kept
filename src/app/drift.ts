import type { Obligation } from "../domain/obligation.js";
import type { ObligationEvent } from "../domain/events.js";
import type { ObligationState } from "../domain/state.js";
import type { ObligationSignal } from "../domain/signals.js";
import { project } from "../domain/projection.js";
import { TERMINAL_STATES } from "../domain/state.js";

/**
 * W5 — promise-drift radar (pure, deterministic, offline).
 *
 * Quantifies how a commitment's *certainty* decays over time. The engine already
 * does temporal reasoning for supersession; this read-model turns that same ordered
 * event log into a single number: how much a promise has SOFTENED (its language
 * downgraded, its date slipped, its scope moved) and gone SILENT (overdue without an
 * update). Everything here is a deterministic function of (projection|events, now) —
 * no I/O, and NOTHING is persisted (zero-copy: the reasons are ephemeral strings,
 * never appended to the log).
 *
 * Two entry points share one scorer:
 *   • driftForObligation(o, now)   — over the projection (what the App Home band and
 *     the "what's slipping?" Assistant intent use; cheap, no event fetch).
 *   • driftFromEvents(events, now) — the full temporal read: it walks the ordered log
 *     so it can see the phrasing/certainty TRAJECTORY (CONFIRMED→TENTATIVE→…) and count
 *     each date slip. Used where the event log is in hand (tests, a drill-in).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a live commitment can sit without any event before it reads as "gone quiet". */
const STALE_DAYS = 7;
/** Overdue days beyond which the overdue penalty saturates. */
const OVERDUE_SPAN_DAYS = 7;

/** Certainty carried by each phrasing bucket (the classifier's typed signal). */
const CERTAINTY: Record<ObligationSignal, number> = {
  CONFIRMED_COMMITMENT: 1,
  TENTATIVE_COMMITMENT: 0.6,
  CUSTOMER_REQUEST: 0.3,
  INTERNAL_ACKNOWLEDGEMENT: 0.3,
  SCOPE_CHANGE: 0.5,
  FULFILLMENT_SIGNAL: 1,
  CUSTOMER_CONFIRMATION: 1,
  CANCELLATION: 0,
  NON_ACTIONABLE: 0,
};

export type DriftBucket = "FIRM" | "SOFTENING" | "SLIPPING" | "STALLED";

export interface DriftReading {
  obligationId: string;
  customer: string;
  outcome: string;
  owner: string | null;
  state: ObligationState;
  /** Drift score in [0,1] — 0 = firm/on-track, 1 = fully drifted (softened + overdue + silent). */
  score: number;
  bucket: DriftBucket;
  /** Certainty has decayed from its commitment peak (a downgrade, a slip, a scope change, a dispute, or overdue-silence). */
  softening: boolean;
  /** Past due with no update since — the "promise that quietly died" case. */
  overdueWithoutUpdate: boolean;
  daysSinceUpdate: number;
  daysOverdue: number;
  /** Number of times the due date was pushed LATER. */
  slips: number;
  /** Only live commitments (post-candidate, non-terminal) can drift. */
  live: boolean;
  /** Human-readable, EPHEMERAL — surfaced on the card / Assistant, never persisted. */
  reasons: string[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const daysBetween = (a: number, b: number): number => Math.max(0, Math.floor((a - b) / DAY_MS));

interface DriftInputs {
  o: Obligation;
  now: number;
  /** Peak certainty reached over the obligation's life. */
  peakCertainty: number;
  /** Latest certainty (after decays). */
  latestCertainty: number;
  slips: number;
}

/** The single deterministic scorer both entry points funnel through. */
function scoreDrift(inp: DriftInputs): DriftReading {
  const { o, now } = inp;
  const live = !TERMINAL_STATES.has(o.state) && o.state !== "CANDIDATE";

  const dueTime = o.due ? Date.parse(o.due) : null;
  const overdue = o.flags.is_overdue;
  const atRisk = o.flags.is_at_risk;
  const disputed = o.flags.is_disputed;
  const scopeChanged = o.flags.has_scope_change;
  const daysOverdue = overdue && dueTime !== null && !Number.isNaN(dueTime) ? daysBetween(now, dueTime) : 0;
  const daysSinceUpdate = daysBetween(now, Date.parse(o.updated_at) || now);

  const base: DriftReading = {
    obligationId: o.id,
    customer: o.customer,
    outcome: o.outcome,
    owner: o.owner,
    state: o.state,
    score: 0,
    bucket: "FIRM",
    softening: false,
    overdueWithoutUpdate: false,
    daysSinceUpdate,
    daysOverdue,
    slips: inp.slips,
    live,
    reasons: [],
  };

  // A candidate isn't yet a commitment; a terminal obligation is resolved — neither drifts.
  if (!live) return base;

  const softenMag = clamp01(inp.peakCertainty - inp.latestCertainty);
  // Overdue AND nothing has happened since the deadline passed → the promise went silent.
  const overdueWithoutUpdate = overdue && daysSinceUpdate >= 1;

  const score = clamp01(
    0.3 * softenMag +
      0.18 * (Math.min(inp.slips, 2) / 2) +
      0.12 * (scopeChanged ? 1 : 0) +
      0.18 * (disputed ? 1 : 0) +
      0.3 * (overdue ? 1 : 0) +
      0.12 * (atRisk && !overdue ? 1 : 0) +
      0.2 * (overdueWithoutUpdate ? 1 : 0) +
      0.1 * Math.min(daysSinceUpdate / STALE_DAYS, 1) +
      0.1 * (overdue ? Math.min(daysOverdue / OVERDUE_SPAN_DAYS, 1) : 0),
  );

  const bucket: DriftBucket = score >= 0.65 ? "STALLED" : score >= 0.4 ? "SLIPPING" : score >= 0.2 ? "SOFTENING" : "FIRM";
  const softening = softenMag > 0.01 || scopeChanged || disputed || inp.slips > 0 || overdueWithoutUpdate;

  const reasons: string[] = [];
  if (overdueWithoutUpdate) reasons.push(`overdue ${daysOverdue}d, no update in ${daysSinceUpdate}d`);
  else if (overdue) reasons.push(`overdue ${daysOverdue}d`);
  if (inp.slips > 0) reasons.push(`${inp.slips} date slip${inp.slips > 1 ? "s" : ""}`);
  if (scopeChanged) reasons.push("scope changed");
  if (disputed) reasons.push("customer reopened — disputed");
  if (atRisk && !overdue) reasons.push("due soon, not yet done");
  if (softenMag > 0.2 && reasons.length === 0) reasons.push("commitment language softened");
  if (!overdue && !atRisk && daysSinceUpdate >= STALE_DAYS) reasons.push(`quiet ${daysSinceUpdate}d`);

  return { ...base, score, bucket, softening, overdueWithoutUpdate, reasons };
}

/**
 * Drift over the ordered event log — the full temporal read. It replays the log to
 * recover the certainty TRAJECTORY: each confirmation raises certainty; each later
 * due-date move, scope change, or reopen decays it (CONFIRMED_COMMITMENT → softer).
 */
export function driftFromEvents(events: ObligationEvent[], now: number = Date.now()): DriftReading {
  const o = project(events, { now });

  let cur = 0;
  let peak = 0;
  let slips = 0;
  for (const e of events) {
    switch (e.type) {
      case "REQUEST_DETECTED":
        // Prefer the recorded classifier confidence when present; else the phrasing bucket.
        cur = typeof e.confidence === "number" ? e.confidence : CERTAINTY[e.signal] ?? 0;
        break;
      case "COMMITMENT_CONFIRMED":
        cur = Math.max(cur, 1); // a human locked it in — certainty peak
        break;
      case "DUE_DATE_CHANGED": {
        const from = e.from ? Date.parse(e.from) : NaN;
        const to = e.to ? Date.parse(e.to) : NaN;
        if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) {
          cur *= 0.7; // the date slipped later — the promise softened
          slips += 1;
        }
        break;
      }
      case "SCOPE_CHANGED":
        cur *= 0.75;
        break;
      case "REOPENED":
        cur *= 0.6; // customer disputes the close — certainty collapses
        break;
      case "CUSTOMER_CONFIRMED":
        cur = 1; // resolved on the customer's side
        break;
      default:
        continue;
    }
    peak = Math.max(peak, cur);
  }

  return scoreDrift({ o, now, peakCertainty: peak, latestCertainty: cur, slips });
}

/**
 * Drift over a projection — the cheap path the ledger surfaces use. The projection
 * loses the per-slip trajectory, so slips read as 0, but the derived flags
 * (has_scope_change, is_disputed, is_overdue/at_risk) still expose the softening and
 * silence, and the initial phrasing bucket + confirmed-state give the certainty peak.
 */
export function driftForObligation(o: Obligation, now: number = Date.now()): DriftReading {
  const confirmed = o.state !== "CANDIDATE" && !TERMINAL_STATES.has(o.state);
  const peak = confirmed ? Math.max(CERTAINTY[o.signal] ?? 0, 1) : CERTAINTY[o.signal] ?? 0;
  let latest = peak;
  if (o.flags.has_scope_change) latest *= 0.75;
  if (o.flags.is_disputed) latest *= 0.6;
  return scoreDrift({ o, now, peakCertainty: peak, latestCertainty: latest, slips: 0 });
}

export interface DriftRadar {
  /** Drifting live commitments (bucket ≠ FIRM), worst first. */
  readings: DriftReading[];
  counts: { drifting: number; softening: number; slipping: number; stalled: number };
}

/**
 * Aggregate drift across a (tenant-scoped) ledger — powers the App Home band and the
 * "what's slipping?" Assistant answer. Pure: (obligations, now) → radar. The caller
 * passes an already team-scoped list (invariant #4), so no cross-tenant read here.
 */
export function driftRadar(obligations: Obligation[], now: number = Date.now()): DriftRadar {
  const readings = obligations
    .map((o) => driftForObligation(o, now))
    .filter((r) => r.live && r.bucket !== "FIRM")
    .sort((a, b) => b.score - a.score);
  return {
    readings,
    counts: {
      drifting: readings.length,
      softening: readings.filter((r) => r.bucket === "SOFTENING").length,
      slipping: readings.filter((r) => r.bucket === "SLIPPING").length,
      stalled: readings.filter((r) => r.bucket === "STALLED").length,
    },
  };
}
