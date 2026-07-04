import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Installation } from "@slack/oauth";
import { PostgresInstallationStore } from "../../src/store/installationStore.js";
import { PostgresScheduler } from "../../src/scheduler/postgresScheduler.js";
import type { ReminderJob } from "../../src/scheduler/scheduler.js";

const DB = process.env.DATABASE_URL;

// Exercises the REAL W2 Postgres adapters against a live database. Skips when
// DATABASE_URL is unset, so `npm test` stays hermetic.
describe.skipIf(!DB)("W2 — PostgresInstallationStore + PostgresScheduler (live database)", () => {
  describe("PostgresInstallationStore: store → fetch → delete, keyed by team.id", () => {
    let store: PostgresInstallationStore;
    beforeAll(async () => {
      store = new PostgresInstallationStore({ connectionString: DB });
      await store.init();
    });
    afterAll(async () => {
      await store.close();
    });

    it("persists a workspace install and returns its bot token; delete removes it", async () => {
      const teamId = `T_INST_${Date.now()}`;
      const installation: Installation = {
        team: { id: teamId, name: "Test Workspace" },
        enterprise: undefined,
        user: { id: "U_INSTALLER", token: undefined, scopes: undefined },
        bot: { token: `xoxb-${teamId}`, scopes: ["chat:write", "commands"], id: "B_TEST", userId: "UB_TEST" },
        isEnterpriseInstall: false,
        authVersion: "v2",
        appId: "A_TEST",
      };

      await store.storeInstallation(installation);

      const query = { teamId, enterpriseId: undefined, isEnterpriseInstall: false as const };
      const fetched = await store.fetchInstallation(query);
      expect(fetched.team?.id).toBe(teamId);
      expect(fetched.bot?.token).toBe(`xoxb-${teamId}`);
      expect(fetched.bot?.userId).toBe("UB_TEST");

      // Enumerable for webhook → tenant routing.
      expect(await store.listTeamIds()).toContain(teamId);

      // Delete → fetch now fails (no installation).
      await store.deleteInstallation(query);
      await expect(store.fetchInstallation(query)).rejects.toThrow();
      expect(await store.listTeamIds()).not.toContain(teamId);
    });
  });

  describe("PostgresScheduler: schedule → runDue fires once → cancel", () => {
    it("claims a due job exactly once and cancel removes pending jobs", async () => {
      const fired: ReminderJob[] = [];
      const scheduler = new PostgresScheduler({ connectionString: DB }, async (job) => {
        fired.push(job);
      });
      try {
        await scheduler.init();

        const obligationId = `obl_sched_${Date.now()}`;
        const past = Date.now() - 1000;
        const job: ReminderJob = { id: `${obligationId}:AT_RISK`, obligationId, kind: "AT_RISK", fireAt: past };
        await scheduler.schedule(job);

        // First poll fires the due job.
        const firstRun = await scheduler.runDue(Date.now());
        expect(firstRun.map((j) => j.id)).toContain(job.id);
        expect(fired.map((j) => j.id)).toContain(job.id);

        // Second poll does NOT re-fire (fired_at is set) — the multi-instance guard.
        const before = fired.length;
        await scheduler.runDue(Date.now());
        expect(fired.length).toBe(before);

        // Reschedule re-arms the job so a moved due date fires again.
        await scheduler.schedule({ ...job, fireAt: Date.now() - 1000 });
        const reRun = await scheduler.runDue(Date.now());
        expect(reRun.map((j) => j.id)).toContain(job.id);

        // Cancel removes any pending job for the obligation (a future one never fires).
        const future = Date.now() + 60_000;
        await scheduler.schedule({ id: `${obligationId}:OVERDUE`, obligationId, kind: "OVERDUE", fireAt: future });
        await scheduler.cancelForObligation(obligationId);
        const afterCancel = await scheduler.runDue(future + 1);
        expect(afterCancel.some((j) => j.obligationId === obligationId)).toBe(false);
      } finally {
        await scheduler.close();
      }
    });
  });
});
