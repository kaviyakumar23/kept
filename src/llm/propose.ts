import type { LlmProvider } from "./provider.js";
import type { Classification, Extraction } from "./schemas.js";
import { classifyMessage } from "./classify.js";
import { extractObligation } from "./extract.js";
import type { DetectInput } from "../engine/obligationService.js";
import type { Actor, EventSource } from "../domain/events.js";

/** Signals that, once detected, warrant creating/attaching an obligation candidate. */
const CREATE_SIGNALS = new Set<Classification["signal"]>([
  "CUSTOMER_REQUEST",
  "TENTATIVE_COMMITMENT",
  "CONFIRMED_COMMITMENT",
]);

export interface ProposalMeta {
  actor: Actor;
  source: EventSource;
  idempotencyKey: string;
  at: string;
  now?: number;
  currentDate?: string;
}

export type Proposal =
  // `team` is intentionally omitted here — the LLM proposer doesn't know the acting
  // workspace; the orchestrator stamps it (from msg.team) before detectRequest. (W1)
  | { actionable: true; classification: Classification; extraction: Extraction; detectInput: Omit<DetectInput, "team"> }
  | { actionable: false; classification: Classification; reason: string };

/**
 * The LLM-proposes boundary: classify → (if it implies an obligation) extract →
 * build a DETECT_REQUEST input. It returns a PROPOSAL; the deterministic service
 * (and the human at Gate 1) decide whether it becomes a durable obligation.
 * The model never emits an event.
 */
export async function proposeFromMessage(
  provider: LlmProvider,
  messageText: string,
  meta: ProposalMeta,
  threadContext?: string,
): Promise<Proposal> {
  const classification = await classifyMessage(provider, { messageText, threadContext });

  if (!CREATE_SIGNALS.has(classification.signal)) {
    return {
      actionable: false,
      classification,
      reason: `signal ${classification.signal} does not create a new obligation candidate`,
    };
  }

  const extraction = await extractObligation(provider, {
    messageText,
    threadContext,
    currentDate: meta.currentDate,
  });

  const detectInput: Omit<DetectInput, "team"> = {
    direction: classification.direction,
    signal: classification.signal,
    customer: extraction.customer,
    subject_canonical: extraction.subject_canonical,
    outcome: extraction.outcome,
    due: extraction.due,
    owner: extraction.owner,
    conditions: extraction.conditions,
    actor: meta.actor,
    source: meta.source,
    idempotencyKey: meta.idempotencyKey,
    at: meta.at,
    now: meta.now,
  };

  return { actionable: true, classification, extraction, detectInput };
}
