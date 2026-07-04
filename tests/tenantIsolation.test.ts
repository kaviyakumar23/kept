import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService, type DetectInput } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { appHomeView } from "../src/slack/blocks.js";
import { answerLedgerQuery } from "../src/app/assistantQuery.js";
import type { Evidence } from "../src/domain/evidence.js";
import { AM, NOW, ISO_NOW, slackSource, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * W1 — multi-tenant partition (invariant #4: tenant isolation is P0).
 *
 * Two workspaces share one event store. EVERY read surface must return ONLY the
 * calling workspace's obligations — even when both tenants use the same customer
 * name and the same canonical subject (a real collision that must NOT leak).
 */

const T_ALPHA = "T_ALPHA";
const T_BETA = "T_BETA";

/** Seed one obligation into a given team, with full control over its scoping fields. */
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

function buildStack() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: new SimulatedLinearAdapter({ startAt: 1 }),
    rts: new MockRtsRetriever(),
    notifier: new RecordingNotifier(),
    scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });
  return { store, service, orch };
}

describe("W1 — tenant isolation (P0): every read is scoped by team", () => {
  it("listObligations / allObligations / ledgerFor / App Home / Assistant each return ONLY the caller's team", async () => {
    const { service, orch } = buildStack();

    // Alpha owns two obligations; one of them shares the customer name "Globex" with Beta.
    const alphaSso = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO login fix", idempotencyKey: "a:1", refs: { linear: "PROJ-1" } });
    const alphaGlobex = await seed(service, T_ALPHA, { customer: "Globex", subject_canonical: "EXPORT_FEATURE", outcome: "alpha CSV export", idempotencyKey: "a:2" });
    // Beta owns one obligation — SAME customer name AND same subject as an Alpha item.
    const betaGlobex = await seed(service, T_BETA, { customer: "Globex", subject_canonical: "EXPORT_FEATURE", outcome: "beta billing invoice fix", idempotencyKey: "b:1" });

    // Same (customer, subject) across tenants must NOT dedupe into one obligation.
    expect(alphaGlobex.id).not.toBe(betaGlobex.id);

    // --- listObligations (the engine choke point) ---
    const alphaList = await service.listObligations(T_ALPHA);
    const betaList = await service.listObligations(T_BETA);
    expect(alphaList.map((o) => o.id).sort()).toEqual([alphaSso.id, alphaGlobex.id].sort());
    expect(betaList.map((o) => o.id)).toEqual([betaGlobex.id]);
    // Structural guarantee: every returned obligation is stamped with the caller's team.
    expect(alphaList.every((o) => o.team === T_ALPHA)).toBe(true);
    expect(betaList.every((o) => o.team === T_BETA)).toBe(true);
    // Neither list contains a single obligation belonging to the other tenant.
    expect(alphaList.some((o) => o.id === betaGlobex.id)).toBe(false);
    expect(betaList.some((o) => o.id === alphaSso.id || o.id === alphaGlobex.id)).toBe(false);

    // --- allObligations (App Home data source) ---
    expect((await orch.allObligations(T_ALPHA)).map((o) => o.id).sort()).toEqual([alphaSso.id, alphaGlobex.id].sort());
    expect((await orch.allObligations(T_BETA)).map((o) => o.id)).toEqual([betaGlobex.id]);

    // --- ledgerFor: SAME customer name "Globex" resolves per-tenant, never across ---
    const alphaGlobexLedger = await orch.ledgerFor(T_ALPHA, "Globex");
    const betaGlobexLedger = await orch.ledgerFor(T_BETA, "Globex");
    expect(alphaGlobexLedger.map((o) => o.id)).toEqual([alphaGlobex.id]);
    expect(betaGlobexLedger.map((o) => o.id)).toEqual([betaGlobex.id]);
    expect(alphaGlobexLedger[0]!.outcome).toBe("alpha CSV export");
    expect(betaGlobexLedger[0]!.outcome).toBe("beta billing invoice fix");

    // --- App Home blocks: Alpha's view never renders Beta's obligation ---
    const alphaHome = JSON.stringify(appHomeView(await orch.allObligations(T_ALPHA), NOW));
    expect(alphaHome).toContain("alpha SSO login fix");
    expect(alphaHome).toContain("alpha CSV export");
    expect(alphaHome).not.toContain("beta billing invoice fix");
    expect(alphaHome).not.toContain(betaGlobex.id);
    const betaHome = JSON.stringify(appHomeView(await orch.allObligations(T_BETA), NOW));
    expect(betaHome).toContain("beta billing invoice fix");
    expect(betaHome).not.toContain("alpha SSO login fix");
    expect(betaHome).not.toContain(alphaSso.id);

    // --- Assistant answers: routed intent runs over the SCOPED ledger only ---
    const alphaAnswer = answerLedgerQuery({ intent: "by_customer", customer: "Globex" }, await orch.allObligations(T_ALPHA), NOW);
    expect(JSON.stringify(alphaAnswer.blocks)).toContain("alpha CSV export");
    expect(JSON.stringify(alphaAnswer.blocks)).not.toContain("beta billing invoice fix");
    const betaSummary = answerLedgerQuery({ intent: "summary" }, await orch.allObligations(T_BETA), NOW);
    // Beta's summary counts only Beta's single open obligation, never Alpha's two.
    expect(JSON.stringify(betaSummary.blocks)).toContain("*Open:* 1");
  });

  it("findByRefs is team-scoped: a webhook cannot resolve to another tenant's obligation", async () => {
    const { service, orch } = buildStack();
    // Alpha owns the obligation carrying linear ref PROJ-1.
    await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1", refs: { linear: "PROJ-1" } });

    const evidence: Evidence = {
      id: "e1", source: "linear", kind: "ticket_status", ref: "PROJ-1", at: ISO_NOW,
      accessible_to_user: true, data: { status: "Done" }, proves: "linked ticket marked Done",
    };

    // Beta ingesting a webhook for Alpha's ref → NO match (cross-tenant resolution blocked).
    const crossTenant = await orch.recordFulfillmentSignal({ teamId: T_BETA, refs: { linear: "PROJ-1" }, evidence, idempotencyKey: "wh:beta" });
    expect(crossTenant.kind).toBe("no_match");

    // Alpha ingesting the same webhook → resolves within its own tenant.
    const sameTenant = await orch.recordFulfillmentSignal({ teamId: T_ALPHA, refs: { linear: "PROJ-1" }, evidence, idempotencyKey: "wh:alpha" });
    expect(sameTenant.kind).toBe("recorded");
  });

  it("guard: there is NO unscoped ledger read — a team id is mandatory at the type level", async () => {
    const store = new InMemoryEventStore();
    const service = new ObligationService(store, () => NOW);
    await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "x", idempotencyKey: "g:1" });

    // These calls MUST NOT compile without a team id. The @ts-expect-error assertions
    // fail the build if an unscoped overload is ever (re)introduced — that is the guard.
    // @ts-expect-error W1: getAllObligationIds requires a teamId; an unscoped read is a compile error.
    void store.getAllObligationIds();
    // @ts-expect-error W1: listObligations requires a teamId; an unscoped read is a compile error.
    void service.listObligations();

    // And at runtime: an unknown team sees an empty ledger — never another tenant's data.
    expect(await service.listObligations("T_NOBODY")).toEqual([]);
    expect(await store.getAllObligationIds("T_NOBODY")).toEqual([]);
  });
});
