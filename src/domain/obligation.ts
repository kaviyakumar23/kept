import type { ObligationId, UserId } from "./ids.js";
import type { Direction, ObligationSignal } from "./signals.js";
import type { ObligationState, ObligationFlags } from "./state.js";
import type { Evidence } from "./evidence.js";
import type { WorkSystem } from "./events.js";

/**
 * C4 — Entity resolution & the entity graph.
 *
 * Resolves that "SSO bug", "login issue", "SAML failure", PROJ-118, PR #449, and
 * release 2026.06.18 are the same obligation. New messages and webhooks attach to
 * an existing obligation via these refs (engine/entityGraph.ts).
 */
export interface EntityRefs {
  customer: string;
  /** Canonical subject, e.g. "SSO_LOGIN_BUG" — the join key for semantic dedupe. */
  subject_canonical: string;
  slack?: { channel: string; thread_ts: string; permalink?: string };
  linear?: string; // PROJ-118
  jira?: string;
  github?: string; // PR #449
  release?: string; // 2026.06.18
}

export interface WorkItemRef {
  system: WorkSystem;
  ref: string;
}

/**
 * The derived projection of an obligation — computed from its ordered event log.
 * This is read-only output; it is never the source of truth.
 */
export interface Obligation {
  id: ObligationId;
  state: ObligationState;
  direction: Direction;
  /** The originating typed signal (C1), retained for audit/explanation. */
  signal: ObligationSignal;
  customer: string;
  subject_canonical: string;
  outcome: string;
  due: string | null;
  owner: UserId | null;
  work_item: WorkItemRef | null;
  entity_refs: EntityRefs;
  flags: ObligationFlags;
  /** Accumulated evidence (multi-source) used at the verification gate. */
  evidence: Evidence[];
  conditions: string[];
  /** Number of events in the log (audit-history depth). */
  history_count: number;
  /** Number of state-changing events — used in notify idempotency keys. */
  state_version: number;
  created_at: string;
  updated_at: string;
}
