import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { createSimulatedMcpWorkItems } from "../src/integrations/mcp.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * #5 — agent-made promises. When an AI agent (a bot) makes a customer promise in a channel, the
 * sender is a bot, so owner-defaulting to the sender would break (a bot can't confirm/verify).
 * Kept still holds it: the promise routes to the configured HUMAN owner and the Gate-1 card is
 * badged "Promised by <agent>". A human signs Gate 1.
 */
const HUMAN = "U0PRIYA1"; // the configured fallback owner (a real-shaped Slack id)
const PROMISE = "We'll ship the SSO fix for Acme by Friday.";

async function makeOrch() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: await createSimulatedMcpWorkItems(),
    rts: new MockRtsRetriever(),
    notifier,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: HUMAN,
  });
  return { orch, notifier };
}
const cardText = (notifier: RecordingNotifier) => JSON.stringify(notifier.calls.find((c) => c.kind === "private")?.blocks);

describe("#5 — agent-made promises", () => {
  it("an agent promise routes to a HUMAN owner (not the bot sender) and badges the card", async () => {
    const { orch, notifier } = await makeOrch();
    const r = await orch.ingestMessage({
      team: "T_A", channel: "C", threadTs: "1", ts: "1", userId: "U0BOT001", text: PROMISE,
      agent: { name: "SupportAgent" },
    });
    expect(r.kind).toBe("confirm_card_sent");
    expect(r.kind === "confirm_card_sent" && r.owner).toBe(HUMAN); // the human, NOT the bot
    expect(cardText(notifier)).toContain("Promised by SupportAgent"); // agent badge on the card
  });

  it("a human promise still defaults the owner to the sender, with no agent badge", async () => {
    const { orch, notifier } = await makeOrch();
    const r = await orch.ingestMessage({
      team: "T_A", channel: "C", threadTs: "2", ts: "2", userId: "U0HUMAN9", text: PROMISE,
    });
    expect(r.kind).toBe("confirm_card_sent");
    expect(r.kind === "confirm_card_sent" && r.owner).toBe("U0HUMAN9"); // the sender
    expect(cardText(notifier)).not.toContain("Promised by"); // no agent badge
  });
});
