import type { EventId, ObligationId, UserId } from "./ids.js";
import type { Direction, ObligationSignal } from "./signals.js";
import type { Evidence } from "./evidence.js";

/** Cross-system references captured at detection time (C4 entity graph). */
export interface DetectedRefs {
  linear?: string;
  jira?: string;
  github?: string;
  release?: string;
}

/**
 * C2 — Event-sourced obligation model.
 *
 * The obligation state is NEVER a mutable row. It is DERIVED (projection.ts) from
 * this append-only log. Benefits: full audit trail, safe retries, replay after
 * logic changes, explainable transitions, natural reopen support.
 *
 * Zero-copy (correction #3): event payloads carry IDs, permalinks, and *derived*
 * structured fields (customer, normalized outcome, due date, owner) — never Slack
 * message bodies, quotations, RTS results, prompts, or model responses.
 */

export type Actor =
  | "system"
  | "linear"
  | "jira"
  | "github"
  | "deploy"
  | "customer"
  | `user:${UserId}`;

export const userActor = (id: UserId): Actor => `user:${id}`;

export type SourceSystem = "slack" | "linear" | "jira" | "github" | "deploy" | "crm" | "system";

export interface EventSource {
  system: SourceSystem;
  /** permalink | issue key | PR | release id — a reference, not content. */
  ref: string | null;
  /** Permission parity: was the underlying source accessible to the acting user? */
  accessible_to_user: boolean;
}

export type WorkSystem = "linear" | "jira";

/** The body (discriminant + payload) of each event type. */
export type EventBody =
  | {
      type: "REQUEST_DETECTED";
      direction: Direction;
      /** The originating typed signal (C1) — preserves request vs tentative vs confirmed. */
      signal: ObligationSignal;
      customer: string;
      subject_canonical: string;
      outcome: string;
      due: string | null;
      owner: UserId | null;
      conditions: string[];
      refs?: DetectedRefs;
      /** Original-thread coordinates so the loop can be closed where it started (IDs/links only). */
      slack?: { channel: string; thread_ts: string; permalink?: string };
    }
  | { type: "COMMITMENT_CONFIRMED"; outcome: string; due: string | null; owner: UserId }
  | { type: "DISMISSED" }
  | { type: "CLARIFICATION_FLAGGED" }
  | { type: "CLARIFICATION_CLEARED" }
  | { type: "WORK_ITEM_LINKED"; work_system: WorkSystem; work_ref: string }
  | { type: "WORK_STARTED" }
  | { type: "DUE_DATE_CHANGED"; from: string | null; to: string | null }
  | { type: "SCOPE_CHANGED"; note: string }
  | { type: "FULFILLMENT_SIGNAL_DETECTED"; evidence: Evidence }
  | { type: "INTERNALLY_VERIFIED"; rationale: string }
  | { type: "VERIFICATION_FAILED"; reason: string }
  | { type: "CUSTOMER_NOTIFIED"; draft_ref: string | null }
  | { type: "CUSTOMER_CONFIRMED" }
  | { type: "REOPENED"; reason: string }
  | { type: "CANCELLED"; reason: string };

export type EventType = EventBody["type"];

export interface EventEnvelope {
  event_id: EventId;
  obligation_id: ObligationId;
  at: string; // ISO timestamp
  actor: Actor;
  source: EventSource;
  /** C6 — deduplicates events, tickets, reminders, messages, repeated transitions. */
  idempotency_key: string;
  reason?: string;
  confidence?: number;
  /** Set only when a human approved a consequential transition (Gate 1 / Gate 2). */
  approved_by?: UserId | null;
}

export type ObligationEvent = EventEnvelope & EventBody;

/** Narrow an event to a specific body type. */
export function isEvent<T extends EventType>(
  e: ObligationEvent,
  type: T,
): e is ObligationEvent & { type: T } {
  return e.type === type;
}
