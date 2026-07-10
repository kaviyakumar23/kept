import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { createSimulatedMcpWorkItems, createSimulatedProofServer, type SimulatedProofState } from "../src/integrations/mcp.js";
import { ProofCollector } from "../src/integrations/proofCollector.js";
import { NOW, heuristicResponder, ticketDone, prMerged, prodDeploy } from "../src/eval/scenarios.js";

/**
 * The customer closes the loop. After Kept posts the (human-signed) closure into the original
 * thread (state CUSTOMER_NOTIFIED), a customer reply IN THAT THREAD is a response — a "works"
 * phrase confirms → CLOSED, a "still fails" phrase reopens. Matched by thread and scoped to the
 * sender's team (invariant #4), and Kept NEVER auto-messages the customer (invariant #3): the
 * reply only changes state.
 */
const TEAM = "T_ACME";
const root = (text: string) => ({ team: TEAM, channel: "C_ACME", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });
const reply = (text: string, team = TEAM, ts = "200") => ({ team, channel: "C_ACME", threadTs: "100", ts, userId: "U_CUST", text, permalink: "r" });

/** Drive a fresh obligation all the way to CUSTOMER_NOTIFIED (flag ON so verify applies). */
async function makeNotifiedOrch() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const proofState: SimulatedProofState = { flags: { sso_login: { enabled: true, environment: "production" } } };
  const proof = await createSimulatedProofServer(proofState);
  const proofClock = NOW;
  const proofCollector = new ProofCollector({
    proof,
    targetsFor: (o) => (o.subject_canonical === "SSO_LOGIN_BUG" ? { flag: { key: "sso_login" } } : null),
    now: () => proofClock,
  });
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: await createSimulatedMcpWorkItems(),
    rts: new MockRtsRetriever(),
    notifier,
    proofCollectorFor: async () => proofCollector,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });
  const ing = await orch.ingestMessage(root("Can you get the SSO bug fixed by Friday?"));
  if (ing.kind !== "confirm_card_sent") throw new Error(`expected confirm card, got ${ing.kind}`);
  const id = ing.obligationId;
  const { work } = await orch.confirmCommitment(id, "U_AM");
  const refs = { linear: work!.ref };
  await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: ticketDone("t", work!.ref), idempotencyKey: "k-done" });
  await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: prMerged("p", "PR-1"), idempotencyKey: "k-pr" });
  await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: prodDeploy("d", "rel"), idempotencyKey: "k-dep" });
  const v = await orch.verify(id, "U_AM");
  if (!v.draftSent) throw new Error("expected verify to draft the closure (flag ON)");
  await orch.approveSend(id, "U_AM");
  return { orch, service, notifier, id };
}

describe("customer reply closes the loop (CUSTOMER_NOTIFIED → CLOSED)", () => {
  it("a customer 'it works' reply in the thread → CLOSED", async () => {
    const { orch, service, id } = await makeNotifiedOrch();
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED");
    const r = await orch.ingestMessage(reply("Yes, it is working."));
    expect(r.kind).toBe("customer_reply");
    expect(r.kind === "customer_reply" && r.state).toBe("CLOSED");
    expect((await service.getObligation(id))!.state).toBe("CLOSED");
  });

  it("notifies the OWNER privately but never the customer channel (invariant #3)", async () => {
    const { orch, notifier } = await makeNotifiedOrch();
    const threadBefore = notifier.calls.filter((c) => c.kind === "thread").length;
    await orch.ingestMessage(reply("works great, thanks!"));
    // A private owner notice IS sent (internal feedback, not a customer message)...
    expect(notifier.calls.some((c) => c.kind === "private" && /confirmed/i.test(c.text))).toBe(true);
    // ...and NOTHING new is posted to the customer thread.
    expect(notifier.calls.filter((c) => c.kind === "thread").length).toBe(threadBefore);
  });

  it("a customer 'still fails' reply reopens the obligation", async () => {
    const { orch, service, id } = await makeNotifiedOrch();
    const r = await orch.ingestMessage(reply("it still fails on our side"));
    expect(r.kind).toBe("customer_reply");
    expect((await service.getObligation(id))!.state).not.toBe("CLOSED");
  });

  it("invariant #4 — a reply from ANOTHER workspace never closes this team's obligation", async () => {
    const { orch, service, id } = await makeNotifiedOrch();
    const r = await orch.ingestMessage(reply("Yes, it is working.", "T_OTHER", "300"));
    expect(r.kind).not.toBe("customer_reply"); // no cross-tenant thread match
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED"); // untouched
  });

  it("the root promise message is NOT treated as a customer reply (threadTs === ts)", async () => {
    const { orch } = await makeNotifiedOrch();
    const r = await orch.ingestMessage(root("We'll ship the billing export by Tuesday."));
    expect(r.kind).not.toBe("customer_reply");
  });
});
