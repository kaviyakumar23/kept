import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { InMemoryTrustLinkStore } from "../src/store/trustLinkStore.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { ObligationService, type DetectInput } from "../src/engine/obligationService.js";
import { AM, NOW, ISO_NOW, slackSource } from "../src/eval/scenarios.js";

/**
 * Invariant #4 + Marketplace data-deletion: `EventStore.purgeTeam(teamId)` must delete
 * EVERYTHING for one tenant — its obligation event log AND its derived rows (trust links,
 * reminders) — while leaving every OTHER tenant's data completely intact. This is the
 * regression guard for the Slack `app_uninstalled` data-deletion handler.
 */

const T_ALPHA = "T_ALPHA";
const T_BETA = "T_BETA";

async function seed(
  service: ObligationService,
  team: string,
  over: Partial<DetectInput> & { customer: string; subject_canonical: string; outcome: string; idempotencyKey: string },
) {
  const det = await service.detectRequest({
    team,
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CUSTOMER_REQUEST",
    due: null,
    owner: null,
    conditions: [],
    actor: AM,
    source: slackSource("p"),
    at: ISO_NOW,
    now: NOW,
    ...over,
  });
  if (det.status !== "created") throw new Error(`expected created, got ${det.status}`);
  return det.obligation;
}

/** Two tenants sharing one in-memory substrate: event store + trust links + reminders. */
async function buildTwoTenants() {
  const trustLinks = new InMemoryTrustLinkStore();
  const scheduler = new InMemoryScheduler(() => {});
  const store = new InMemoryEventStore({ trustLinks, reminders: scheduler });
  const service = new ObligationService(store, () => NOW);

  // Obligations (both tenants use the SAME customer + subject — a real collision).
  const alpha1 = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1" });
  const alpha2 = await seed(service, T_ALPHA, { customer: "Globex", subject_canonical: "EXPORT_FEATURE", outcome: "alpha export", idempotencyKey: "a:2" });
  const beta1 = await seed(service, T_BETA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "beta SSO fix", idempotencyKey: "b:1" });

  // Trust links (one active capability per tenant).
  const alphaLink = await trustLinks.mint(T_ALPHA, "Acme");
  const betaLink = await trustLinks.mint(T_BETA, "Acme");

  // Reminders keyed to each tenant's obligations.
  await scheduler.schedule({ id: `${alpha1.id}:OVERDUE`, obligationId: alpha1.id, kind: "OVERDUE", fireAt: NOW + 1000 });
  await scheduler.schedule({ id: `${alpha2.id}:AT_RISK`, obligationId: alpha2.id, kind: "AT_RISK", fireAt: NOW + 1000 });
  await scheduler.schedule({ id: `${beta1.id}:OVERDUE`, obligationId: beta1.id, kind: "OVERDUE", fireAt: NOW + 1000 });

  return { store, service, trustLinks, scheduler, alpha1, alpha2, beta1, alphaLink, betaLink };
}

describe("invariant #4 — purgeTeam: uninstall deletes ONE tenant's data, leaves others intact", () => {
  it("purges team A's obligations + trust links + reminders; team B is untouched", async () => {
    const { store, service, trustLinks, scheduler, beta1, alphaLink, betaLink } = await buildTwoTenants();

    // Sanity: before the purge both tenants are fully populated.
    expect(await store.getAllObligationIds(T_ALPHA)).toHaveLength(2);
    expect(await store.getAllObligationIds(T_BETA)).toHaveLength(1);
    expect(await trustLinks.resolve(alphaLink.token)).not.toBeNull();
    expect(scheduler.pending()).toHaveLength(3);

    const summary = await store.purgeTeam(T_ALPHA);

    // --- Team A: everything is gone ---
    expect(await store.getAllObligationIds(T_ALPHA)).toEqual([]);
    expect(await service.listObligations(T_ALPHA)).toEqual([]);
    expect(await trustLinks.resolve(alphaLink.token)).toBeNull();
    expect(scheduler.pending().every((j) => j.obligationId === beta1.id)).toBe(true);

    // --- Team B: completely intact ---
    expect(await store.getAllObligationIds(T_BETA)).toHaveLength(1);
    const betaLedger = await service.listObligations(T_BETA);
    expect(betaLedger.map((o) => o.outcome)).toEqual(["beta SSO fix"]);
    expect(await trustLinks.resolve(betaLink.token)).not.toBeNull();
    expect(scheduler.pending()).toHaveLength(1);
    expect(scheduler.pending()[0]!.obligationId).toBe(beta1.id);

    // --- The audit summary reports exactly what was deleted ---
    expect(summary).toEqual({ obligations: 2, trustLinks: 1, reminders: 2, roadmap: 0 });
  });

  it("is idempotent and fail-safe: re-purging (or purging an unknown team) is a zero no-op", async () => {
    const { store, trustLinks, betaLink } = await buildTwoTenants();

    await store.purgeTeam(T_ALPHA);
    // Re-running the same purge (a re-delivered app_uninstalled event) deletes nothing.
    expect(await store.purgeTeam(T_ALPHA)).toEqual({ obligations: 0, trustLinks: 0, reminders: 0, roadmap: 0 });
    // Purging a tenant that never existed is also a no-op — never touches another team.
    expect(await store.purgeTeam("T_NOBODY")).toEqual({ obligations: 0, trustLinks: 0, reminders: 0, roadmap: 0 });
    // Team B survived every one of those calls.
    expect(await store.getAllObligationIds(T_BETA)).toHaveLength(1);
    expect(await trustLinks.resolve(betaLink.token)).not.toBeNull();
  });

  it("purges only the event log when no derived stores are attached (Postgres colocates them)", async () => {
    // A bare event store (no injected trust/reminder siblings) still purges its own log.
    const store = new InMemoryEventStore();
    const service = new ObligationService(store, () => NOW);
    await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "x", idempotencyKey: "a:1" });
    await seed(service, T_BETA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "y", idempotencyKey: "b:1" });

    const summary = await store.purgeTeam(T_ALPHA);
    expect(summary).toEqual({ obligations: 1, trustLinks: 0, reminders: 0, roadmap: 0 });
    expect(await store.getAllObligationIds(T_ALPHA)).toEqual([]);
    expect(await store.getAllObligationIds(T_BETA)).toHaveLength(1);
  });
});
