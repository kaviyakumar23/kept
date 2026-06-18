import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Scheduler, ReminderJob, ReminderHandler } from "./scheduler.js";
import type { ObligationId } from "../domain/ids.js";

/**
 * Production reminder scheduler on Redis + BullMQ. Delayed jobs fire AT_RISK /
 * OVERDUE notifications to the internal owner. The deterministic job id provides
 * idempotency (BullMQ dedupes by jobId), so a re-scheduled obligation replaces
 * rather than duplicates its reminder.
 */
const QUEUE_NAME = "kept-reminders";

export class BullmqScheduler implements Scheduler {
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly connection: ConnectionOptions,
    handler: ReminderHandler,
  ) {
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker<ReminderJob>(
      QUEUE_NAME,
      async (job) => {
        await handler(job.data);
      },
      { connection },
    );
  }

  async schedule(job: ReminderJob): Promise<void> {
    const delay = Math.max(0, job.fireAt - Date.now());
    await this.queue.add(job.kind, job, {
      jobId: job.id, // idempotent: same id is not enqueued twice
      delay,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async cancelForObligation(obligationId: ObligationId): Promise<void> {
    for (const kind of ["AT_RISK", "OVERDUE"] as const) {
      const job = await this.queue.getJob(`${obligationId}:${kind}`);
      if (job) await job.remove();
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
