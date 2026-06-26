import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { ConcurrencyError } from "../src/store/errors.js";
import type { EventStore, AppendOpts } from "../src/store/eventStore.js";
import type { ObligationEvent } from "../src/domain/events.js";
import type { ObligationId } from "../src/domain/ids.js";
import { AM, NOW, ISO_NOW, slackSource } from "../src/eval/scenarios.js";

/** Optimistic concurrency (expectedVersion compare-and-append) — hermetic. */

async function seedCandidate(svc: ObligationService): Promise<string> {
  const det = await svc.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG",
    outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG", conditions: [],
    actor: AM, source: slackSource("p"), idempotencyKey: "seed:req", at: ISO_NOW, now: NOW,
  });
  if (det.status !== "created") throw new Error(`expected created, got ${det.status}`);
  return det.obligation.id;
}
const confirm = { kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" } as const;
const confirmCtx = (id: string, key: string) => ({
  obligationId: id as ObligationId, actor: AM, source: slackSource("p"), idempotencyKey: key,
  at: ISO_NOW, approvedBy: "U_AM", now: NOW,
});

describe("optimistic concurrency", () => {
  it("store throws ConcurrencyError on a stale expectedVersion, succeeds on a match", async () => {
    // Two real, distinct events (zero-copy-clean) from a seeded flow.
    const seed = new InMemoryEventStore();
    const ss = new ObligationService(seed, () => NOW);
    const id = await seedCandidate(ss);
    await ss.dispatch(confirm, confirmCtx(id, "c"));
    const [e0, e1] = await seed.getEvents(id);

    const store = new InMemoryEventStore();
    await store.append([e0]); // count → 1
    await expect(store.append([e1], { expectedVersion: 0 })).rejects.toBeInstanceOf(ConcurrencyError); // stale
    expect(await store.append([e1], { expectedVersion: 1 })).toHaveLength(1); // matches → persists
  });

  it("dispatch retries past a transient conflict and applies exactly once", async () => {
    const inner = new InMemoryEventStore();
    const id = await seedCandidate(new ObligationService(inner, () => NOW));

    // A store that throws ConcurrencyError on the FIRST append, then delegates.
    class ConflictOnce implements EventStore {
      private armed = true;
      constructor(private readonly i: EventStore) {}
      async append(events: ObligationEvent[], opts?: AppendOpts) {
        if (this.armed) { this.armed = false; throw new ConcurrencyError(opts?.expectedVersion ?? 0, (opts?.expectedVersion ?? 0) + 1, events[0]?.obligation_id); }
        return this.i.append(events, opts);
      }
      hasIdempotencyKey(k: string) { return this.i.hasIdempotencyKey(k); }
      getEvents(o: ObligationId) { return this.i.getEvents(o); }
      getAllObligationIds() { return this.i.getAllObligationIds(); }
    }
    const svc = new ObligationService(new ConflictOnce(inner), () => NOW);
    const r = await svc.dispatch(confirm, confirmCtx(id, "c"));
    expect(r.status).toBe("applied");
    expect((await inner.getEvents(id)).filter((e) => e.type === "COMMITMENT_CONFIRMED")).toHaveLength(1);
  });

  it("dispatch surfaces 'conflict' when the version never settles", async () => {
    const inner = new InMemoryEventStore();
    const id = await seedCandidate(new ObligationService(inner, () => NOW));
    class AlwaysConflict implements EventStore {
      constructor(private readonly i: EventStore) {}
      async append(events: ObligationEvent[], opts?: AppendOpts): Promise<ObligationEvent[]> {
        throw new ConcurrencyError(opts?.expectedVersion ?? 0, (opts?.expectedVersion ?? 0) + 1, events[0]?.obligation_id);
      }
      hasIdempotencyKey(k: string) { return this.i.hasIdempotencyKey(k); }
      getEvents(o: ObligationId) { return this.i.getEvents(o); }
      getAllObligationIds() { return this.i.getAllObligationIds(); }
    }
    const svc = new ObligationService(new AlwaysConflict(inner), () => NOW);
    const r = await svc.dispatch(confirm, confirmCtx(id, "c"));
    expect(r.status).toBe("conflict");
    expect((await inner.getEvents(id)).some((e) => e.type === "COMMITMENT_CONFIRMED")).toBe(false);
  });

  it("concurrent same-key dispatches apply exactly once (no double event)", async () => {
    const store = new InMemoryEventStore();
    const svc = new ObligationService(store, () => NOW);
    const id = await seedCandidate(svc);
    const [a, b] = await Promise.all([svc.dispatch(confirm, confirmCtx(id, "c")), svc.dispatch(confirm, confirmCtx(id, "c"))]);
    expect([a, b].filter((r) => r.status === "applied").length).toBe(1);
    expect((await store.getEvents(id)).filter((e) => e.type === "COMMITMENT_CONFIRMED")).toHaveLength(1);
  });
});
