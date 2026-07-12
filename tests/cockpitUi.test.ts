import { describe, it, expect } from "vitest";
import {
  appHomeView,
  verifyPacketModal,
  verifyNudge,
  sendNudge,
  possibleFulfillmentCard,
  actionId,
  ACTIONS,
  CALLBACKS,
} from "../src/slack/blocks.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { featureFlag, NOW, heuristicResponder } from "../src/eval/scenarios.js";
import type { Evidence } from "../src/domain/evidence.js";
import { mkObl } from "./helpers.js";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { NoopWorkItemAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";

const AT = new Date(NOW).toISOString();
const manual = (id: string): Evidence => ({
  id, source: "owner", kind: "manual_delivery", ref: `manual@${AT}`, at: AT,
  accessible_to_user: true, data: { by: "U_PM" }, proves: "owner attested the work is delivered",
});

describe("App Home cockpit — every open promise carries its next action inline", () => {
  const view = appHomeView([
    mkObl("CANDIDATE", { id: "cand", customer: "Acme", outcome: "SSO fix" }),
    mkObl("OPEN", { id: "open", customer: "Acme", outcome: "Export feature" }),
    mkObl("POSSIBLE_FULFILLMENT", { id: "poss", customer: "Globex", outcome: "Billing v2" }),
    mkObl("VERIFIED", { id: "ver", customer: "Globex", outcome: "Webhooks" }),
    mkObl("CLOSED", { id: "done", customer: "Acme", outcome: "Onboarding flow" }),
  ]);
  const json = JSON.stringify(view);

  it("CANDIDATE → Confirm, OPEN → Mark delivered, POSSIBLE → Verify, VERIFIED → Send", () => {
    expect(json).toContain(actionId(ACTIONS.confirm, "cand"));
    expect(json).toContain(actionId(ACTIONS.markDelivered, "open"));
    expect(json).toContain(actionId(ACTIONS.verify, "poss"));
    expect(json).toContain(actionId(ACTIONS.editDraft, "ver")); // "📣 Send" opens the closure-draft modal
  });

  it("every active row can still open Receipts (the event-sourced audit log)", () => {
    for (const id of ["cand", "open", "poss", "ver"]) {
      expect(json).toContain(actionId(ACTIONS.history, id));
    }
  });

  it("closed promises collapse into a one-line 'Kept' summary, not a full action row", () => {
    expect(json).toContain("Onboarding flow"); // shown in the collapsed line
    expect(json).toContain("Kept:"); // the collapse label
    // …and a closed promise never offers a gate action.
    expect(json).not.toContain(actionId(ACTIONS.markDelivered, "done"));
    expect(json).not.toContain(actionId(ACTIONS.verify, "done"));
  });

  it("surfaces a 'Needs you now' pointer for items awaiting the owner", () => {
    expect(json).toContain("Needs you now");
  });
});

describe("Gate-2 verify modal — the human signs the verdict in a focused surface", () => {
  const o = mkObl("POSSIBLE_FULFILLMENT", { id: "p1", customer: "Acme", outcome: "SSO fix", evidence: [manual("m1"), featureFlag("f1", "sso@t", false)] });
  const modal = verifyPacketModal(o, assessFulfillment(o.evidence)) as { type: string; callback_id: string; private_metadata: string };

  it("is a modal whose submit IS the signature, carrying the obligation id", () => {
    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe(CALLBACKS.verifyPacket);
    expect(modal.private_metadata).toBe("p1");
    expect(JSON.stringify(modal)).toContain("Verify it's available"); // the submit button
  });

  it("shows the assembled evidence — including the blocking flag-OFF row", () => {
    const j = JSON.stringify(modal);
    expect(j).toContain("What Kept gathered");
    expect(j).toContain("Production flag *OFF*"); // the money row is visible before signing
    expect(j).toContain("Not ready to close"); // verdict reflects the blocked packet
  });
});

describe("Thin DM nudges — the app's message history stays scannable, not a wall of cards", () => {
  const o = mkObl("POSSIBLE_FULFILLMENT", { id: "n1", customer: "Acme", outcome: "SSO fix", evidence: [manual("m1")] });

  it("verifyNudge is one button that opens the packet — NOT the full packet card", () => {
    const j = JSON.stringify(verifyNudge(o));
    expect(j).toContain(actionId(ACTIONS.verify, "n1"));
    expect(j).toContain("Review & verify");
    expect(j).not.toContain("What Kept gathered"); // the evidence lives in the modal, one click away
  });

  it("sendNudge is one button that opens the closure draft", () => {
    const j = JSON.stringify(sendNudge(o));
    expect(j).toContain(actionId(ACTIONS.editDraft, "n1"));
    expect(j).toContain("Review & send");
  });

  it("the full packet card still renders identically where used (backward compatible)", () => {
    const j = JSON.stringify(possibleFulfillmentCard(o, assessFulfillment(o.evidence)));
    expect(j).toContain("What Kept gathered");
    expect(j).toContain(actionId(ACTIONS.verify, "n1"));
  });
});

describe("Orchestrator DMs the owner a thin nudge (not the full card) through the lifecycle", () => {
  function buildOrch() {
    const store = new InMemoryEventStore();
    const service = new ObligationService(store, () => NOW);
    const notifier = new RecordingNotifier();
    const orch = new KeptOrchestrator({
      service, llm: new MockLlmProvider(heuristicResponder), workItems: new NoopWorkItemAdapter(),
      rts: new MockRtsRetriever(), notifier, scheduler: new InMemoryScheduler(() => {}),
      clock: () => NOW, currentDate: () => "2026-06-16", fallbackOwner: "U_AM",
    });
    return { orch, notifier };
  }
  const msg = (text: string) => ({ team: "T", channel: "C", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });

  it("mark-delivered → a Review & verify nudge; verify → a Review & send nudge (no packet/draft cards in the DM)", async () => {
    const { orch, notifier } = buildOrch();
    const ing = await orch.ingestMessage(msg("We'll ship the SSO fix for Acme by Friday."));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM");

    await orch.markDelivered(id, "U_PM");
    const afterDeliver = JSON.stringify(notifier.calls.filter((c) => c.kind === "private").at(-1));
    expect(afterDeliver).toContain("Review & verify");
    expect(afterDeliver).not.toContain("What Kept gathered"); // thinned — the packet is in the modal now

    await orch.verify(id, "U_AM");
    const afterVerify = JSON.stringify(notifier.calls.filter((c) => c.kind === "private").at(-1));
    expect(afterVerify).toContain("Review & send");
  });
});
