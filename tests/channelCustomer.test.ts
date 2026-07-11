import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/** The "right model": a channel→customer binding anchors the customer identity to the channel,
 *  overriding the LLM's per-message extraction (no more "Acme" vs "Acme Corp" fragmentation). */
function buildOrch() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const orch = new KeptOrchestrator({
    service, llm: new MockLlmProvider(heuristicResponder),
    workItems: new SimulatedLinearAdapter({ startAt: 1 }),
    rts: new MockRtsRetriever(), notifier: new RecordingNotifier(),
    scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW, currentDate: () => "2026-06-16", fallbackOwner: "U_AM",
  });
  return { orch, service };
}
const msg = (over: Record<string, unknown> = {}) => ({
  team: "T", channel: "C_SHARED", threadTs: "100", ts: "100", userId: "U_PM",
  text: "We'll ship the SSO fix for Acme by Friday.", permalink: "p", ...over,
});
const customerOf = async (orch: KeptOrchestrator, service: ObligationService, over = {}) => {
  const r = await orch.ingestMessage(msg(over));
  const id = r.kind === "confirm_card_sent" ? r.obligationId : "";
  return (await service.getObligation(id))?.customer;
};

describe("channel → customer binding", () => {
  it("a channel binding OVERRIDES the LLM's extracted customer", async () => {
    const { orch, service } = buildOrch();
    expect(await customerOf(orch, service, { customerBinding: "Globex Inc" })).toBe("Globex Inc");
  });

  it("with NO binding, the customer falls back to LLM extraction from the text", async () => {
    const { orch, service } = buildOrch();
    expect(await customerOf(orch, service)).toBe("Acme");
  });

  it("a blank/whitespace binding is ignored (falls back to extraction)", async () => {
    const { orch, service } = buildOrch();
    expect(await customerOf(orch, service, { customerBinding: "   " })).toBe("Acme");
  });
});
