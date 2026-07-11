import { describe, it, expect } from "vitest";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { featureFlag } from "../src/eval/scenarios.js";
import type { Evidence } from "../src/domain/evidence.js";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { NoopWorkItemAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/** Production-hardening regressions: Option A (integrations optional) + no fabricated work items. */
const AT = new Date(NOW).toISOString();
const manual = (id: string): Evidence => ({
  id, source: "owner", kind: "manual_delivery", ref: `manual@${AT}`, at: AT,
  accessible_to_user: true, data: { by: "U_PM" }, proves: "owner attested the work is delivered",
});

function buildOrch(workItems = new NoopWorkItemAdapter()) {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const orch = new KeptOrchestrator({
    service, llm: new MockLlmProvider(heuristicResponder), workItems,
    rts: new MockRtsRetriever(), notifier, scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW, currentDate: () => "2026-06-16", fallbackOwner: "U_AM",
  });
  return { orch, service, notifier };
}
const msg = (text: string) => ({ team: "T", channel: "C", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });

describe("production hardening", () => {
  describe("Option A — manual delivery reconciliation", () => {
    it("a manual owner attestation alone is sufficient to verify (integrations optional)", () => {
      const a = assessFulfillment([manual("m1")]);
      expect(a.available).toBe(true);
      expect(a.sufficientForVerification).toBe(true);
    });
    it("a connected flag that is OFF still BLOCKS a manually-attested delivery (guardrail wins)", () => {
      const a = assessFulfillment([manual("m1"), featureFlag("f1", "x@t", false)]);
      expect(a.available).toBe(false);
      expect(a.sufficientForVerification).toBe(false);
    });
    it("manual attestation + flag ON is available", () => {
      const a = assessFulfillment([manual("m1"), featureFlag("f1", "x@t", true)]);
      expect(a.available).toBe(true);
      expect(a.sufficientForVerification).toBe(true);
    });
  });

  it("no tracker connected → confirming a promise links NO work item (no fabricated ref)", async () => {
    const { orch, service } = buildOrch();
    const ing = await orch.ingestMessage(msg("We'll ship the SSO fix for Acme by Friday."));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM");
    const o = await service.getObligation(id);
    expect(o?.work_item).toBeNull(); // never a phantom PROJ-118
  });

  it("Option A — Mark delivered drives a promise to verifiable with ZERO integrations", async () => {
    const { orch } = buildOrch();
    const ing = await orch.ingestMessage(msg("We'll ship the SSO fix for Acme by Friday."));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM");
    const res = await orch.markDelivered(id, "U_PM");
    expect(res.obligation?.state).toBe("POSSIBLE_FULFILLMENT");
    expect(res.verifyCardSent).toBe(true); // sufficient — the owner can Verify
    const v = await orch.verify(id, "U_AM");
    expect(v.draftSent).toBe(true); // Gate 2 succeeds with no integration connected
  });
});
