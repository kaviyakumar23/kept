import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { createSimulatedMcpWorkItems, createSimulatedProofServer } from "../src/integrations/mcp.js";
import { ProofCollector } from "../src/integrations/proofCollector.js";
import { LedgerRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { detectLeaks } from "../src/policy/audience.js";
import { demoProofState, setDemoFlag, resetDemoProof, demoFlagOn, DEMO_FLAG_KEY } from "../src/demo/demoRuntime.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * The judge-operable "🎬 Demo Controls" hero loop, driven through the orchestrator exactly as the
 * Slack handlers drive it. The whole point of the flow is that a judge is PERSONALLY blocked by the
 * engine while the controllable production flag is OFF, then unblocks it — so this proves the block
 * is real (verify() re-reads proof and refuses) and the toggle genuinely changes what it sees.
 */
const DEMO_TEAM = "T_DEMO";
const JUDGE = "U_JUDGE";

async function buildDemoOrch() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const scheduler = new InMemoryScheduler(() => {});
  const workItems = await createSimulatedMcpWorkItems({ startAt: 900 });
  // The demo tenant's CONTROLLABLE proof source: it reads `demoProofState` by reference (same wiring
  // as production's getDemoCollector), so setDemoFlag() changes what verify() sees — no live account.
  const proof = await createSimulatedProofServer(demoProofState);
  let proofClock = NOW;
  const proofCollector = new ProofCollector({
    proof,
    targetsFor: () => ({ flag: { key: DEMO_FLAG_KEY, environment: "production" } }),
    now: () => proofClock,
  });
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems,
    rts: new LedgerRtsRetriever({ listObligations: (t) => service.listObligations(t, NOW) }),
    notifier,
    scheduler,
    // Only the demo team gets the controllable collector (invariant #4).
    proofCollectorFor: async (teamId) => (teamId === DEMO_TEAM ? proofCollector : null),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_ACCOUNT_MANAGER",
  });
  return { store, service, notifier, orch, advanceProofClock: (ms: number) => (proofClock += ms) };
}

describe("Demo Controls — judge-operable hero loop", () => {
  beforeEach(() => resetDemoProof()); // flag OFF at the start of each scenario

  it("seed → mark shipped → Verify BLOCKED while flag OFF → toggle ON → Verify PASSES", async () => {
    const { orch, service, notifier, advanceProofClock } = await buildDemoOrch();
    expect(demoFlagOn()).toBe(false);

    // 1) Seed a fresh OPEN promise, OWNED BY the judge (so every private card routes to them).
    const seeded = await orch.seedDemo(DEMO_TEAM, JUDGE);
    expect(seeded?.state).toBe("OPEN");
    expect(seeded?.owner).toBe(JUDGE);
    expect(seeded?.customer).toBe("Acme");
    expect(seeded?.work_item?.ref).toBeTruthy();
    const id = seeded!.id;

    // 2) Mark work shipped → Jira Done + PR merged + prod deploy → POSSIBLE_FULFILLMENT, and the
    //    demo flag being OFF makes the assembled evidence packet BLOCKED, DM'd to the judge (owner).
    const shipped = await orch.markDemoShipped(DEMO_TEAM, id);
    expect(shipped?.state).toBe("POSSIBLE_FULFILLMENT");
    const packet = [...notifier.calls].reverse().find((c) => c.kind === "private" && /Proof-of-Done blocked/.test(c.text));
    expect(packet?.to).toBe(JUDGE); // the packet reached the judge, not the customer
    const o1 = (await orch.obligation(id, DEMO_TEAM))!;
    expect(o1.evidence.some((e) => e.kind === "ticket_status")).toBe(true);
    expect(o1.evidence.some((e) => e.kind === "pr_merged")).toBe(true);
    expect(o1.evidence.some((e) => e.kind === "deploy")).toBe(true);
    expect(o1.evidence.some((e) => e.kind === "feature_flag" && e.data.enabled === false)).toBe(true);
    expect(notifier.customerFacingText()).toEqual([]); // nothing posted to the customer yet

    // 3) Verify while the flag is OFF → the engine PERSONALLY REFUSES (INSUFFICIENT_EVIDENCE).
    const blocked = await orch.verify(id, JUDGE, DEMO_TEAM);
    expect(blocked.draftSent).toBe(false);
    expect((await service.getObligation(id))!.state).toBe("POSSIBLE_FULFILLMENT");

    // 4) Toggle the production flag ON → re-verify → it PASSES → closure draft DM.
    setDemoFlag(true);
    advanceProofClock(60_000); // a later observation → a new, distinct proof fact (ON), not deduped
    const passed = await orch.verify(id, JUDGE, DEMO_TEAM);
    expect(passed.draftSent).toBe(true);
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");
  });

  it("closure posts a sanitized reply into the demo-channel thread; reset wipes demo state", async () => {
    const { orch, service, notifier, advanceProofClock } = await buildDemoOrch();

    const seeded = await orch.seedDemo(DEMO_TEAM, JUDGE, "C_DEMO", "1700.0001");
    const id = seeded!.id;
    expect(seeded?.entity_refs.slack?.channel).toBe("C_DEMO");

    await orch.markDemoShipped(DEMO_TEAM, id);
    setDemoFlag(true);
    advanceProofClock(60_000);
    await orch.verify(id, JUDGE, DEMO_TEAM);

    // Approve & send → one sanitized post into the ORIGINAL thread (no internal leak).
    const sent = await orch.approveSend(id, JUDGE, DEMO_TEAM);
    expect(sent.kind).toBe("notified");
    const posts = notifier.customerFacingText();
    expect(posts.length).toBe(1);
    expect(detectLeaks(posts[0]!)).toEqual([]);
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED");

    // "Customer replies: still fails" → reopen via the engine (never messages the customer).
    const reopened = await orch.reopen(id, "customer reports it still fails");
    expect(reopened!.state).toBe("IN_PROGRESS");
    expect(notifier.customerFacingText().length).toBe(1); // reopen posted nothing new to the customer

    // "↺ Reset demo" → the demo tenant's ledger is wiped (team-scoped).
    await orch.resetDemo(DEMO_TEAM);
    expect(await orch.allObligations(DEMO_TEAM)).toEqual([]);

    // A fresh seed after reset comes back OPEN and owned by the (new) judge.
    const reseeded = await orch.seedDemo(DEMO_TEAM, "U_JUDGE2");
    expect(reseeded?.state).toBe("OPEN");
    expect(reseeded?.owner).toBe("U_JUDGE2");
  });
});
