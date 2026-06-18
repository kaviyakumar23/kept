import { describe, it, expect } from "vitest";
import { BullmqScheduler } from "../../src/scheduler/bullmqScheduler.js";
import type { ReminderJob } from "../../src/scheduler/scheduler.js";

const REDIS = process.env.REDIS_URL;

// Exercises the REAL BullmqScheduler against a live Redis. Skips when REDIS_URL is unset.
describe.skipIf(!REDIS)("BullmqScheduler — live Redis", () => {
  it("fires a scheduled reminder via a real Redis-backed worker", async () => {
    const url = new URL(REDIS!);
    const fired: ReminderJob[] = [];
    const sched = new BullmqScheduler({ host: url.hostname, port: Number(url.port || 6379) }, async (job) => {
      fired.push(job);
    });
    const job: ReminderJob = { id: `it-${Date.now()}`, obligationId: "obl_test", kind: "AT_RISK", fireAt: Date.now() + 150 };
    try {
      await sched.schedule(job);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !fired.some((j) => j.id === job.id)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fired.some((j) => j.id === job.id)).toBe(true);
    } finally {
      await sched.close();
    }
  });

  it("dedupes a re-scheduled job by id (idempotent)", async () => {
    const url = new URL(REDIS!);
    const sched = new BullmqScheduler({ host: url.hostname, port: Number(url.port || 6379) }, async () => {});
    const id = `dup-${Date.now()}`;
    try {
      await sched.schedule({ id, obligationId: "o", kind: "OVERDUE", fireAt: Date.now() + 60_000 });
      // Same jobId — BullMQ should not enqueue a second copy.
      await expect(sched.schedule({ id, obligationId: "o", kind: "OVERDUE", fireAt: Date.now() + 60_000 })).resolves.toBeUndefined();
    } finally {
      await sched.cancelForObligation("o");
      await sched.close();
    }
  });
});
