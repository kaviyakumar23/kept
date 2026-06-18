import type { Scheduler, ReminderJob, ReminderHandler } from "./scheduler.js";
import type { ObligationId } from "../domain/ids.js";

/**
 * Deterministic, timer-free scheduler for tests and the demo. Jobs are advanced
 * explicitly via runDue(now), so reminder timing is fully reproducible (no wall
 * clock, no flakiness). Each (obligation, kind) job fires at most once.
 */
export class InMemoryScheduler implements Scheduler {
  private readonly jobs = new Map<string, ReminderJob>();
  private readonly fired = new Set<string>();

  constructor(private readonly handler: ReminderHandler) {}

  async schedule(job: ReminderJob): Promise<void> {
    this.jobs.set(job.id, job); // dedupe by id; reschedule replaces
  }

  async cancelForObligation(obligationId: ObligationId): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.obligationId === obligationId) this.jobs.delete(id);
    }
  }

  /** Fire all due, not-yet-fired jobs as of `now`. Returns the jobs fired. */
  async runDue(now: number): Promise<ReminderJob[]> {
    const due = [...this.jobs.values()]
      .filter((j) => j.fireAt <= now && !this.fired.has(j.id))
      .sort((a, b) => a.fireAt - b.fireAt);
    for (const job of due) {
      this.fired.add(job.id);
      await this.handler(job);
    }
    return due;
  }

  pending(): ReminderJob[] {
    return [...this.jobs.values()].filter((j) => !this.fired.has(j.id));
  }
}
