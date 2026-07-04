import type { ObligationEvent } from "./events.js";
import type { Obligation, EntityRefs } from "./obligation.js";
import type { Evidence } from "./evidence.js";
import { emptyFlags, TERMINAL_STATES, WORKABLE_STATES } from "./state.js";
import { TRANSITIONS } from "./stateMachine.js";

export const DEFAULT_RISK_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProjectionOptions {
  /** Reference "now" for time-based flags. Defaults to Date.now(). */
  now?: number;
  riskWindowMs?: number;
}

/**
 * C2 — derive the current obligation state from its ordered event log.
 * C3 — supersession (later due date wins, history retained) falls out naturally
 *       because we fold the log in order and the projection reflects the latest
 *       authoritative event.
 *
 * Pure function: same events → same projection (given the same `now`).
 */
export function project(events: ObligationEvent[], opts: ProjectionOptions = {}): Obligation {
  if (events.length === 0) {
    throw new Error("cannot project an empty event log");
  }
  const now = opts.now ?? Date.now();
  const riskWindowMs = opts.riskWindowMs ?? DEFAULT_RISK_WINDOW_MS;

  const head = events[0];
  if (head.type !== "REQUEST_DETECTED") {
    throw new Error(`event log must begin with REQUEST_DETECTED, got ${head.type}`);
  }

  const entity_refs: EntityRefs = {
    team: head.team,
    customer: head.customer,
    subject_canonical: head.subject_canonical,
  };
  if (head.source.system === "slack" && head.source.ref) {
    entity_refs.slack = { channel: "", thread_ts: "", permalink: head.source.ref };
  }
  if (head.slack) {
    entity_refs.slack = { channel: head.slack.channel, thread_ts: head.slack.thread_ts, permalink: head.slack.permalink ?? head.source.ref ?? undefined };
  }
  if (head.refs) {
    if (head.refs.linear) entity_refs.linear = head.refs.linear;
    if (head.refs.jira) entity_refs.jira = head.refs.jira;
    if (head.refs.github) entity_refs.github = head.refs.github;
    if (head.refs.release) entity_refs.release = head.refs.release;
  }

  const obligation: Obligation = {
    id: head.obligation_id,
    team: head.team,
    state: "CANDIDATE",
    direction: head.direction,
    signal: head.signal,
    customer: head.customer,
    subject_canonical: head.subject_canonical,
    outcome: head.outcome,
    due: head.due,
    owner: head.owner,
    work_item: null,
    entity_refs,
    flags: emptyFlags(),
    evidence: [],
    conditions: [...head.conditions],
    history_count: events.length,
    state_version: 0,
    created_at: head.at,
    updated_at: head.at,
  };

  let lastClarification: "flagged" | "cleared" | null = null;
  let sawScopeChange = false;
  let disputed = false;
  let stateVersion = 0;

  const attachEvidence = (ev: Evidence) => {
    // Dedupe the same logical evidence (same source+kind+ref) so a re-delivered
    // webhook with a different idempotency key can't double-count.
    const seen = obligation.evidence.some((e) => e.source === ev.source && e.kind === ev.kind && e.ref === ev.ref);
    if (!seen) obligation.evidence.push(ev);
    if (ev.source === "github") obligation.entity_refs.github = ev.ref;
    if (ev.source === "deploy") obligation.entity_refs.release = ev.ref;
  };

  for (const event of events) {
    const spec = TRANSITIONS[event.type];
    if (spec.changesState && spec.to !== "SAME") {
      obligation.state = spec.to;
      stateVersion += 1;
    }
    obligation.updated_at = event.at;

    switch (event.type) {
      case "REQUEST_DETECTED":
        // initial fields already seeded above
        break;
      case "COMMITMENT_CONFIRMED":
        obligation.outcome = event.outcome;
        obligation.due = event.due;
        obligation.owner = event.owner;
        break;
      case "CLARIFICATION_FLAGGED":
        lastClarification = "flagged";
        break;
      case "CLARIFICATION_CLEARED":
        lastClarification = "cleared";
        break;
      case "WORK_ITEM_LINKED":
        obligation.work_item = { system: event.work_system, ref: event.work_ref };
        obligation.entity_refs[event.work_system] = event.work_ref;
        break;
      case "DUE_DATE_CHANGED":
        obligation.due = event.to; // supersession; prior value retained in the log
        break;
      case "SCOPE_CHANGED":
        sawScopeChange = true;
        break;
      case "FULFILLMENT_SIGNAL_DETECTED":
        attachEvidence(event.evidence);
        break;
      case "REOPENED":
        disputed = true;
        break;
      case "CUSTOMER_CONFIRMED":
        disputed = false;
        break;
      default:
        break;
    }
  }

  obligation.state_version = stateVersion;
  obligation.history_count = events.length;

  // --- Derived flags (correction #4) ---
  const terminal = TERMINAL_STATES.has(obligation.state);
  const dueTime = obligation.due ? Date.parse(obligation.due) : null;
  const workable = WORKABLE_STATES.has(obligation.state);

  obligation.flags = {
    // Clarification is a candidate-stage concern; don't let the flag stick once
    // the obligation has been confirmed/advanced.
    needs_clarification: obligation.state === "CANDIDATE" && lastClarification === "flagged",
    has_scope_change: sawScopeChange && !terminal,
    is_disputed: disputed && obligation.state !== "CLOSED",
    is_overdue: dueTime !== null && workable && now > dueTime,
    is_at_risk:
      dueTime !== null && workable && now <= dueTime && dueTime - now <= riskWindowMs,
  };

  return obligation;
}

/** Convenience: project at most up to (and including) the event with the given id. */
export function projectAt(events: ObligationEvent[], eventId: string, opts?: ProjectionOptions): Obligation {
  const idx = events.findIndex((e) => e.event_id === eventId);
  const slice = idx >= 0 ? events.slice(0, idx + 1) : events;
  return project(slice, opts);
}
