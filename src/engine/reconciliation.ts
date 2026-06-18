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
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const customerConfirmations = customerReplies.filter((e) => e.data.confirmed === true);

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

  // Code merged AND deployed to the customer's environment → available.
  if (prMerged.length > 0 && customerDeploys.length > 0) {
    return {
      available: true,
      confidence: 0.8,
      sufficientForVerification: true,
      customerConfirmed: false,
      rationale:
        "Code merged and deployed to the customer's environment — available to the customer (ticket-Done alone would not have been enough).",
      contributing: [...prMerged, ...customerDeploys],
    };
  }

  // Everything below is evidence of progress, but NOT of availability.
  const reasons: string[] = [];
  if (ticketDone.length > 0) reasons.push("ticket marked Done");
  if (prMerged.length > 0) reasons.push("PR merged");
  if (deploys.length > 0 && customerDeploys.length === 0) reasons.push("deploy to a non-customer environment");
  if (reasons.length === 0) reasons.push("no fulfillment evidence yet");

  return {
    available: false,
    confidence: prMerged.length > 0 ? 0.5 : 0.3,
    sufficientForVerification: false,
    customerConfirmed: false,
    rationale: `Not yet verifiable as available: ${reasons.join(", ")}. Need a merge plus a deploy reaching the customer (or the customer's confirmation).`,
    contributing: [...ticketDone, ...prMerged, ...deploys],
  };
}
