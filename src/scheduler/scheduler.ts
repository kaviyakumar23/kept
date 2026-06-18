import type { Obligation } from "../domain/obligation.js";
import type { ObligationId } from "../domain/ids.js";
import { WORKABLE_STATES } from "../domain/state.js";
import { DEFAULT_RISK_WINDOW_MS } from "../domain/projection.js";

/**
 * Reminder scheduling for AT_RISK / OVERDUE obligations. Notifications go to the
 * internal owner — never the shared customer channel (D3: no public noise). The
 * job id is deterministic per (obligation, kind) so re-scheduling replaces rather
 * than duplicates; firing uses a notify idempotency key keyed on state_version.
 */
export type ReminderKind = "AT_RISK" | "OVERDUE";

export interface ReminderJob {
  id: string;
  obligationId: ObligationId;
  kind: ReminderKind;
  fireAt: number; // epoch ms
}

export type ReminderHandler = (job: ReminderJob) => void | Promise<void>;

export interface Scheduler {
  schedule(job: ReminderJob): Promise<void>;
  cancelForObligation(obligationId: ObligationId): Promise<void>;
}

/** Derive the reminder jobs an obligation currently warrants (pure). */
export function computeReminders(
  obligation: Obligation,
  riskWindowMs: number = DEFAULT_RISK_WINDOW_MS,
): ReminderJob[] {
  if (!obligation.due || !WORKABLE_STATES.has(obligation.state)) return [];
  const dueTime = Date.parse(obligation.due);
  if (Number.isNaN(dueTime)) return [];
  return [
    { id: `${obligation.id}:AT_RISK`, obligationId: obligation.id, kind: "AT_RISK", fireAt: dueTime - riskWindowMs },
    { id: `${obligation.id}:OVERDUE`, obligationId: obligation.id, kind: "OVERDUE", fireAt: dueTime },
  ];
}
