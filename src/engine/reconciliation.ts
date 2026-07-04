import type { Evidence } from "../domain/evidence.js";
import { isConsistentEvidence } from "../domain/evidence.js";

/**
 * C5 — Multi-source truth reconciliation.
 *
 * The rules that matter:
 *   • PR merged          ≠ fulfilled
 *   • ticket Done        ≠ customer notified, and not enough to verify
 *   • deploy complete    ≠ customer confirmed
 *   • code merged + deployed to the customer's environment → AVAILABLE (Gate 2 may proceed)
 *   • customer confirms success → STRONG closure
 *
 * `sufficientForVerification` is what the INTERNALLY_VERIFIED guard consults: a
 * human may verify only when reconciled evidence actually proves availability.
 * The human still has to approve (approved_by) — evidence opens the gate; it
 * does not walk through it.
 */
export interface FulfillmentAssessment {
  available: boolean;
  confidence: number;
  sufficientForVerification: boolean;
  customerConfirmed: boolean;
  rationale: string;
  contributing: Evidence[];
}

const isProdDeploy = (e: Evidence): boolean => {
  const env = String(e.data.environment ?? "").toLowerCase();
  return env === "production" || env === "prod";
};

// Reaching the customer requires a production deploy. We do NOT honor a bare
// data.customer_scoped:true on a non-prod deploy — that boolean is self-asserted
// and would let a staging release masquerade as customer-facing.
const isCustomerScopedDeploy = (e: Evidence): boolean => isProdDeploy(e);

const byAt = (a: Evidence, b: Evidence): number => Date.parse(a.at) - Date.parse(b.at);
/** The most recent observation of a proof kind (evidence carries the toggle instant in `ref`). */
const latestOfKind = (evidence: Evidence[], kind: Evidence["kind"]): Evidence | undefined => {
  const bucket = evidence.filter((e) => e.kind === kind).sort(byAt);
  return bucket[bucket.length - 1];
};

export function assessFulfillment(allEvidence: Evidence[]): FulfillmentAssessment {
  // Reject forged/mislabeled evidence first: only count evidence whose source is
  // allowed to attest to its claimed kind (a customer_reply from `github` is dropped).
  const evidence = allEvidence.filter(isConsistentEvidence);

  const ticketDone = evidence.filter(
    (e) => e.kind === "ticket_status" && String(e.data.status ?? "").toLowerCase() === "done",
  );
  const prMerged = evidence.filter((e) => e.kind === "pr_merged" && e.data.merged === true);
  const deploys = evidence.filter((e) => e.kind === "deploy");
  const customerDeploys = deploys.filter(isCustomerScopedDeploy);
  const customerReplies = evidence
    .filter((e) => e.kind === "customer_reply")
    .sort(byAt);
  const customerConfirmations = customerReplies.filter((e) => e.data.confirmed === true);

  // W4 — Proof-of-Done: the LATEST observed state of each proof source (each observation
  // encodes its check/toggle instant in `ref`, so OFF→ON→OFF are distinct facts).
  const latestFlag = latestOfKind(evidence, "feature_flag");
  const latestCi = latestOfKind(evidence, "ci_run");
  const latestStatus = latestOfKind(evidence, "status_page");
  // Tri-state per source: true = positive, false = negative, null = not linked / unknown.
  const flagOn = latestFlag ? latestFlag.data.enabled === true : null;
  const ciGreen = latestCi ? latestCi.data.conclusion === "success" : null;
  const statusOk = latestStatus ? latestStatus.data.component_status === "operational" : null;

  // A customer DENIAL is the strongest real-world signal and blocks verification —
  // never tell a customer it works when their latest word was that it doesn't.
  const latestReply = customerReplies[customerReplies.length - 1];
  if (latestReply && latestReply.data.confirmed === false) {
    return {
      available: false,
      confidence: 0.95,
      sufficientForVerification: false,
      customerConfirmed: false,
      rationale: "Customer's latest reply says it still fails — a denial blocks verification.",
      contributing: [latestReply],
    };
  }

  // W4 — BLOCKING NEGATIVE: a feature flag that is OFF in production means the code may
  // be merged and deployed, but the capability is NOT actually reachable by the customer.
  // This is the differentiator: Jira says Done, but the flag gate is OFF → BLOCK the close.
  // Ordered before customer-confirmation and merge+deploy so nothing can assert availability
  // over an OFF flag.
  if (latestFlag && latestFlag.data.enabled === false) {
    return {
      available: false,
      confidence: 0.9,
      sufficientForVerification: false,
      customerConfirmed: false,
      rationale: "feature flag is OFF in production — not actually available",
      contributing: [latestFlag],
    };
  }

  // Strongest positive signal: the customer says it works.
  if (customerConfirmations.length > 0) {
    return {
      available: true,
      confidence: 0.97,
      sufficientForVerification: true,
      customerConfirmed: true,
      rationale: "Customer confirmed the fix works — strongest closure signal.",
      contributing: customerConfirmations,
    };
  }

  // A linked proof source that is NEGATIVE (flag not ON, CI not green, status not
  // operational) means the capability isn't actually reachable — even with a merge +
  // prod deploy. Fall through to "progress" rather than assert availability.
  const proofBlocks = flagOn === false || ciGreen === false || statusOk === false;

  // Code merged AND deployed to the customer's environment → available (unless a proof
  // source blocks). ON / green / operational are corroborating proofs that raise confidence.
  if (prMerged.length > 0 && customerDeploys.length > 0 && !proofBlocks) {
    const proofsPositive = [latestFlag, latestCi, latestStatus].filter(
      (e): e is Evidence => e !== undefined,
    );
    const raisers = [flagOn === true, ciGreen === true, statusOk === true].filter(Boolean).length;
    return {
      available: true,
      confidence: Math.min(0.95, 0.8 + raisers * 0.05),
      sufficientForVerification: true,
      customerConfirmed: false,
      rationale:
        "Code merged and deployed to the customer's environment — available to the customer" +
        (raisers > 0 ? " (proof sources confirm it's live)" : "") +
        " (ticket-Done alone would not have been enough).",
      contributing: [...prMerged, ...customerDeploys, ...proofsPositive],
    };
  }

  // Everything below is evidence of progress, but NOT of availability.
  const reasons: string[] = [];
  if (ticketDone.length > 0) reasons.push("ticket marked Done");
  if (prMerged.length > 0) reasons.push("PR merged");
  if (deploys.length > 0 && customerDeploys.length === 0) reasons.push("deploy to a non-customer environment");
  if (ciGreen === false) reasons.push("CI run did not pass");
  if (statusOk === false) reasons.push("status page component not operational");
  if (reasons.length === 0) reasons.push("no fulfillment evidence yet");

  const proofContrib = [latestFlag, latestCi, latestStatus].filter((e): e is Evidence => e !== undefined);
  return {
    available: false,
    confidence: prMerged.length > 0 ? 0.5 : 0.3,
    sufficientForVerification: false,
    customerConfirmed: false,
    rationale: `Not yet verifiable as available: ${reasons.join(", ")}. Need a merge plus a deploy reaching the customer (or the customer's confirmation).`,
    contributing: [...ticketDone, ...prMerged, ...deploys, ...proofContrib],
  };
}
