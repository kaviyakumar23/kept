import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresEventStore } from "../../src/store/postgresStore.js";
import { ObligationService } from "../../src/engine/obligationService.js";
import { ConcurrencyError } from "../../src/store/errors.js";
import { ctx, AM, ISO_NOW, NOW, prMerged, prodDeploy } from "../../src/eval/scenarios.js";

const DB = process.env.DATABASE_URL;

// Exercises the REAL PostgresEventStore against a live database. Skips when
// DATABASE_URL is unset, so `npm test` stays hermetic.
describe.skipIf(!DB)("PostgresEventStore — live database", () => {
  let store: PostgresEventStore;
  beforeAll(async () => {
    store = new PostgresEventStore({ connectionString: DB });
    await store.init();
  });
  afterAll(async () => {
    await store.close();
  });

  it("persists a full lifecycle, dedups idempotently, and survives a reconnect", async () => {
    const tag = `pg-${Date.now()}`;
    const K = (s: string) => `${tag}:${s}`;
    const service = new ObligationService(store, () => NOW);

    const det = await service.detectRequest({
      direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: `Acme-${tag}`, subject_canonical: "SSO_LOGIN_BUG",
      outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG", conditions: [],
      actor: AM, source: { system: "slack", ref: "p", accessible_to_user: true }, idempotencyKey: K("req"), at: ISO_NOW, now: NOW,
    });
    expect(det.status).toBe("created");
    const id = det.status === "created" ? det.obligation.id : "";

    await service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, K("c"), { approvedBy: "U_AM" }));
    await service.dispatch({ kind: "START_WORK" }, ctx(id, K("s")));
    await service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged(K("pr"), "PR-1") }, ctx(id, K("prk")));
    await service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy(K("dp"), "rel") }, ctx(id, K("dpk")));
    await service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "merge + prod deploy" }, ctx(id, K("v"), { approvedBy: "U_AM" }));
    await service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: "Hi — the SSO login fix is available. Could you confirm?", draftRef: null }, ctx(id, K("n"), { approvedBy: "U_AM" }));
    const closed = await service.dispatch({ kind: "RECORD_CUSTOMER_CONFIRMATION" }, ctx(id, K("cc")));
    expect(closed.obligation?.state).toBe("CLOSED");

    // Durable across a brand-new connection — the projection rebuilds from Postgres.
    const store2 = new PostgresEventStore({ connectionString: DB });
    try {
      const events = await store2.getEvents(id);
      expect(events.length).toBeGreaterThanOrEqual(8);
      const reloaded = await new ObligationService(store2, () => NOW).getObligation(id);
      expect(reloaded?.state).toBe("CLOSED");
    } finally {
      await store2.close();
    }

    // Idempotent at the store: reusing a key is suppressed, not double-applied.
    const dup = await service.dispatch({ kind: "START_WORK" }, ctx(id, K("c")));
    expect(dup.status).toBe("suppressed");
  });

  it("compare-and-append is race-safe: two appends at the same version → exactly one wins", async () => {
    // A real, zero-copy-clean event to clone for a fresh obligation id.
    const seedSvc = new ObligationService(store, () => NOW);
    const det = await seedSvc.detectRequest({
      direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: `Acme-ct-${Date.now()}`, subject_canonical: "X",
      outcome: "ct seed", due: null, owner: null, conditions: [], actor: AM, source: { system: "slack", ref: "p", accessible_to_user: true },
      idempotencyKey: `ct-seed-${Date.now()}`, at: ISO_NOW, now: NOW,
    });
    const real = (await store.getEvents(det.status === "created" ? det.obligation.id : ""))[0];

    const oid = `obl_ct_${Date.now()}`;
    const clone = (k: string) => ({ ...real, obligation_id: oid, idempotency_key: k });
    // Both target version 0 of a brand-new obligation; the advisory lock serializes them.
    const results = await Promise.allSettled([
      store.append([clone(`ct-a-${Date.now()}`)], { expectedVersion: 0 }),
      store.append([clone(`ct-b-${Date.now()}`)], { expectedVersion: 0 }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled" && r.value.length === 1).length;
    const conflicted = results.filter((r) => r.status === "rejected" && r.reason instanceof ConcurrencyError).length;
    expect(won).toBe(1);
    expect(conflicted).toBe(1);
    expect(await store.getEvents(oid)).toHaveLength(1);
  });

  it("rejects raw content before it can be persisted (zero-copy at the store)", async () => {
    const service = new ObligationService(store, () => NOW);
    await expect(
      service.detectRequest({
        direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: `Acme-raw-${Date.now()}`,
        subject_canonical: "X", outcome: "line one\nline two — pasted raw body", due: null, owner: null, conditions: [],
        actor: AM, source: { system: "slack", ref: "p", accessible_to_user: true }, idempotencyKey: `raw-${Date.now()}`, at: ISO_NOW, now: NOW,
      }),
    ).rejects.toThrow();
  });
});
