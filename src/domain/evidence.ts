import type { JsonScalar } from "./json.js";

/**
 * C5 — Multi-source truth reconciliation.
 *
 * No single source is treated as truth. Each piece of evidence declares its
 * source and what it actually proves; reconciliation (engine/reconciliation.ts)
 * combines them. Evidence carries only structured data + a reference (permalink /
 * issue / PR / release) — never message bodies (zero-copy, correction #3).
 */
export type EvidenceSource =
  | "slack"
  | "linear"
  | "jira"
  | "github"
  | "deploy"
  | "customer"
  | "crm"
  // W4 — Proof-of-Done sources gathered via MCP. `feature_flag` = LaunchDarkly-style
  // toggle state; `ci` = CI/GitHub-Actions run conclusion; `status_page` = Statuspage
  // component health. All three are internal-only (never surfaced to a customer).
  | "feature_flag"
  | "ci"
  | "status_page";

export type EvidenceKind =
  | "customer_request" // slack: the ask
  | "team_commitment" // slack: the promise
  | "ticket_status" // linear/jira: planned work + internal status
  | "pr_merged" // github: a code change merged
  | "deploy" // deployment system: release to an environment
  | "customer_reply" // customer: real-world confirmation (strongest closure)
  | "account_context" // crm: commercial account context
  // W4 — Proof-of-Done. A `feature_flag` proves whether the capability is actually
  // reachable in production; `ci_run` proves the build/tests passed; `status_page`
  // proves the component is operational.
  //
  // ZERO-COPY / DEDUPE INVARIANT: flag/CI/status evidence MUST encode the check /
  // toggle instant in `ref` (e.g. `billing_v2@2026-06-18T14:00:00Z`). projection.ts
  // dedupes evidence on source+kind+ref, so a STABLE flag ref (e.g. just `billing_v2`)
  // would silently drop a later OFF→ON→OFF toggle — reconciliation would keep only the
  // first-seen state. Encoding the instant makes each observed state a distinct fact,
  // and `assessFulfillment` then honors the latest-by-`at`.
  | "feature_flag"
  | "ci_run"
  | "status_page";

export interface Evidence {
  id: string;
  source: EvidenceSource;
  kind: EvidenceKind;
  /** Permalink / issue key / PR number / release id — a pointer, not content. */
  ref: string;
  at: string; // ISO timestamp
  /** RTS / permission parity: was this accessible to the acting user? */
  accessible_to_user: boolean;
  /** Structured facts only — e.g. { status: "Done" }, { environment: "prod", customer_scoped: true }. */
  data: Record<string, JsonScalar>;
  /** Human-readable note on what this evidence proves (sanitized; safe for audit). */
  proves: string;
}

/** What each source can legitimately attest to (see C5 table). */
export const SOURCE_ROLES: Record<EvidenceSource, string> = {
  slack: "the request and the communication commitment",
  linear: "planned work and internal status",
  jira: "planned work and internal status",
  github: "a code change / merge",
  deploy: "release to an environment",
  customer: "real-world confirmation (strongest closure signal)",
  crm: "commercial account context",
  feature_flag: "whether the capability is actually reachable in production",
  ci: "the build / tests passed for the change",
  status_page: "the component's operational health",
};

/** Sources that must never leak to a shared customer channel (see D1). */
export const INTERNAL_ONLY_SOURCES: ReadonlySet<EvidenceSource> = new Set([
  "linear",
  "jira",
  "github",
  "crm",
  // Proof-of-Done sources are internal telemetry — a customer never sees flag/CI/status.
  "feature_flag",
  "ci",
  "status_page",
]);

/**
 * Which sources may legitimately attest to each evidence kind. Reconciliation and
 * the command boundary use this to reject FORGED/mislabeled evidence — e.g. a
 * `customer_reply` must actually originate from the `customer`, a `deploy` from
 * the `deploy` system. Without this, a proposer could fabricate a customer
 * confirmation on a `github` source and drive a false closure.
 */
export const KIND_SOURCES: Record<EvidenceKind, readonly EvidenceSource[]> = {
  customer_request: ["slack"],
  team_commitment: ["slack"],
  ticket_status: ["linear", "jira"],
  pr_merged: ["github"],
  deploy: ["deploy"],
  // ONLY the verified-customer channel may attest to a customer confirmation. A reply
  // in the shared Slack channel must be promoted to source:"customer" by an adapter
  // that has verified the author is the external customer — otherwise a teammate could
  // fabricate a confirmation and drive a false closure.
  customer_reply: ["customer"],
  account_context: ["crm"],
  // W4 — each proof kind may only be attested by its own proof source, so a proposer
  // can't fabricate (say) a flag-ON on a `github` source to force a false closure.
  feature_flag: ["feature_flag"],
  ci_run: ["ci"],
  status_page: ["status_page"],
};

/** True iff the evidence's source is allowed to attest to its claimed kind. */
export function isConsistentEvidence(e: Evidence): boolean {
  return KIND_SOURCES[e.kind]?.includes(e.source) ?? false;
}
