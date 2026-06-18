import { newEventId } from "../src/domain/ids.js";
import type { ObligationEvent, EventBody, Actor, EventSource } from "../src/domain/events.js";
import type { Obligation } from "../src/domain/obligation.js";
import type { ObligationState } from "../src/domain/state.js";
import { emptyFlags } from "../src/domain/state.js";

export const OBL = "obl_test";
export const TS = "2026-06-16T12:00:00.000Z";

let keyCounter = 0;

export function evt(
  body: EventBody,
  over: Partial<{
    obligation_id: string;
    at: string;
    actor: Actor;
    source: EventSource;
    idempotency_key: string;
    approved_by: string | null;
  }> = {},
): ObligationEvent {
  return {
    event_id: newEventId(),
    obligation_id: over.obligation_id ?? OBL,
    at: over.at ?? TS,
    actor: over.actor ?? "system",
    source: over.source ?? { system: "system", ref: null, accessible_to_user: true },
    idempotency_key: over.idempotency_key ?? `k_${keyCounter++}`,
    approved_by: over.approved_by ?? null,
    ...body,
  };
}

export function mkObl(state: ObligationState, over: Partial<Obligation> = {}): Obligation {
  return {
    id: "o",
    state,
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CUSTOMER_REQUEST",
    customer: "Acme",
    subject_canonical: "SSO_LOGIN_BUG",
    outcome: "SSO login fix",
    due: null,
    owner: null,
    work_item: null,
    entity_refs: { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG" },
    flags: emptyFlags(),
    evidence: [],
    conditions: [],
    history_count: 1,
    state_version: 1,
    created_at: TS,
    updated_at: TS,
    ...over,
  };
}
