import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { NoopWorkItemAdapter, type WorkItemAdapter, type CreatedWorkItem } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * Adversary round 8 — no-fabrication (invariant #7 honesty).
 *
 * Attack: in hosted OAuth mode with NO real Jira/Linear configured, can a confirmed
 * promise EVER get a fabricated work-item ref (e.g. "PROJ-118") linked to it?
 *
 * The only production path that dispatches LINK_WORK_ITEM is KeptOrchestrator.ensureWorkItem
 * (src/app/orchestrator.ts). Hosted OAuth mode (src/server/index.ts) selects NoopWorkItemAdapter
 * whose `enabled === false`, and ensureWorkItem must short-circuit to null BEFORE calling
 * createIssue — so no fake ref is ever minted, invented, or linked.
 */

const msg = () => ({ team: "T", channel: "C_ACME", threadTs: "100", ts: "100", userId: "U_PM", text: "Can you get the SSO bug fixed by Friday?", permalink: "p" });

function makeOrch(workItems: WorkItemAdapter) {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems,
    rts: new MockRtsRetriever(),
    notifier: new RecordingNotifier(),
    scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });
  return { orch, service };
}

describe("no-fabrication: hosted OAuth NoopWorkItemAdapter never links a fake ref", () => {
  it("NoopWorkItemAdapter is disabled and its createIssue throws (never returns a placeholder)", async () => {
    const noop = new NoopWorkItemAdapter();
    expect(noop.enabled).toBe(false);
    await expect(noop.createIssue()).rejects.toThrow(/no issue tracker connected/i);
  });

  it("confirming a promise with the Noop adapter links NO work item (no PROJ-118 fabricated)", async () => {
    const noop = new NoopWorkItemAdapter();
    const { orch, service } = makeOrch(noop);

    const ing = await orch.ingestMessage(msg());
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    expect(id).toBeTruthy();

    // Gate 1 confirm: the human signs, the commitment persists — but with no tracker
    // connected (enabled === false) ensureWorkItem must return null, not invent a ref.
    const { obligation, work } = await orch.confirmCommitment(id, "U_AM");
    expect(work).toBeNull();
    expect(obligation).not.toBeNull();
    // The obligation is a real, confirmed commitment...
    expect(obligation!.state).not.toBe("CANDIDATE");
    // ...but carries NO fabricated work-item link.
    expect(obligation!.work_item ?? null).toBeNull();
    expect((await service.getObligation(id))!.work_item ?? null).toBeNull();
  });

  it("the orchestrator guard blocks linking even if a rogue disabled adapter WOULD return a fake ref", async () => {
    // Defense-in-depth: the guard keys on `enabled === false`, not on createIssue throwing.
    // A misbehaving "no-tracker" adapter that returns a placeholder must STILL never be linked.
    let called = 0;
    class RogueDisabledAdapter implements WorkItemAdapter {
      readonly system = "linear" as const;
      readonly enabled = false;
      async createIssue(): Promise<CreatedWorkItem> {
        called++;
        return { ref: "PROJ-118", url: "https://linear.app/acme/issue/PROJ-118" };
      }
    }
    const { orch, service } = makeOrch(new RogueDisabledAdapter());

    const ing = await orch.ingestMessage(msg());
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    expect(id).toBeTruthy();

    const { work } = await orch.confirmCommitment(id, "U_AM");
    // createIssue must never be invoked when enabled === false...
    expect(called).toBe(0);
    // ...so no PROJ-118 ever reaches the ledger.
    expect(work).toBeNull();
    expect((await service.getObligation(id))!.work_item ?? null).toBeNull();
  });
});
