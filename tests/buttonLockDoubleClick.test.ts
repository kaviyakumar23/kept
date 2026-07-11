import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { mapGithubWebhook, mapDeployWebhook, applyWebhookAction } from "../src/webhooks/handlers.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * Adversary (round 8) — button-lock double-click.
 *
 * The Slack transport `ack()`s a Verify / Approve&send click immediately and only
 * swaps the card (`respond({replace_original})`) AFTER the orchestration succeeds,
 * and that swap is best-effort (`.catch(() => undefined)`). So a fast double-click —
 * or two devices — can drive TWO orchestrator calls for the same obligation while the
 * card is still live. This suite pins that the engine (state machine + optimistic
 * concurrency + idempotency key) makes both of the following unreachable:
 *   (a) posting the sanitized closure to the customer thread TWICE
 *   (b) verifying TWICE (two INTERNALLY_VERIFIED events / two closure-draft DMs)
 *
 * The CONCURRENT case is already covered (orchestrator.test.ts). The harder case is
 * the SEQUENTIAL re-click: the second click reads a fresh `state_version`, so the
 * `notify:…:<version>` / `verify:<version>` idempotency key does NOT collide — the
 * only thing standing between the customer and a duplicate is the state-machine
 * transition guard (`CUSTOMER_NOTIFIED from ["VERIFIED"]`, `INTERNALLY_VERIFIED from
 * ["POSSIBLE_FULFILLMENT"]`). If a future refactor relaxes those `from` sets, or
 * moves the customer post before the dispatch verdict, these tests fail.
 */
function buildOrch() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: new SimulatedLinearAdapter({ startAt: 118 }),
    rts: new MockRtsRetriever(),
    notifier,
    scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });
  return { store, service, notifier, orch };
}

const msg = (text: string, ts = "100") => ({ team: "T", channel: "C_ACME", threadTs: "100", ts, userId: "U_PM", text, permalink: "p" });
const merge = mapGithubWebhook({ action: "closed", pull_request: { number: 449, merged: true, merged_at: "2026-06-18T00:00:00Z", html_url: "u" }, relatesTo: { linear: "PROJ-118" } });
const deploy = mapDeployWebhook({ release: "2026.06.18", environment: "production", customer_scoped: true, relatesTo: { linear: "PROJ-118" } });

async function toPossibleFulfillment(orch: KeptOrchestrator): Promise<string> {
  const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
  const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
  await orch.confirmCommitment(id, "U_AM");
  await applyWebhookAction(orch, merge, "T");
  await applyWebhookAction(orch, deploy, "T");
  return id;
}

describe("button-lock — double-click cannot double-post or double-verify", () => {
  it("SEQUENTIAL re-click of 'Approve & send' posts to the customer exactly once", async () => {
    const { orch, service, notifier } = buildOrch();
    const id = await toPossibleFulfillment(orch);
    await orch.verify(id, "U_AM");

    // First click: the real post.
    const first = await orch.approveSend(id, "U_AM");
    expect(first.kind).toBe("notified");
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED");

    // Second click AFTER the first fully completed. state_version has advanced, so the
    // notifyKey differs and does NOT dedupe — the state machine must reject NOTIFY_CUSTOMER
    // from CUSTOMER_NOTIFIED, so no second customer post is emitted.
    const second = await orch.approveSend(id, "U_AM");
    expect(second.kind).toBe("rejected");

    // The invariant: exactly ONE sanitized message ever reached the customer thread.
    expect(notifier.customerFacingText().length).toBe(1);
    const events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "CUSTOMER_NOTIFIED").length).toBe(1);
  });

  it("SEQUENTIAL re-click of 'Verify' verifies exactly once (one INTERNALLY_VERIFIED, one draft DM)", async () => {
    const { orch, service, notifier } = buildOrch();
    const id = await toPossibleFulfillment(orch);

    const draftsBefore = notifier.calls.filter((c) => c.kind === "private" && /close the loop/i.test(c.text)).length;

    const first = await orch.verify(id, "U_AM");
    expect(first.draftSent).toBe(true);
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");

    // Second Verify click after the state already advanced to VERIFIED. verify:<version>
    // key differs; INTERNALLY_VERIFIED from VERIFIED is an illegal transition → no re-verify.
    const second = await orch.verify(id, "U_AM");
    expect(second.draftSent).toBe(false);

    const events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(1);
    const draftsAfter = notifier.calls.filter((c) => c.kind === "private" && /close the loop/i.test(c.text)).length;
    expect(draftsAfter - draftsBefore).toBe(1); // exactly one closure-draft DM
  });

  it("CONCURRENT 'Verify' clicks verify exactly once", async () => {
    const { orch, service } = buildOrch();
    const id = await toPossibleFulfillment(orch);
    const [a, b] = await Promise.all([orch.verify(id, "U_AM"), orch.verify(id, "U_AM")]);
    expect([a, b].filter((r) => r.draftSent).length).toBe(1);
    const events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(1);
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");
  });

  it("a stale 'Verify' click after the loop already closed cannot re-notify the customer", async () => {
    const { orch, service, notifier } = buildOrch();
    const id = await toPossibleFulfillment(orch);
    await orch.verify(id, "U_AM");
    await orch.approveSend(id, "U_AM");
    await orch.recordCustomerConfirmation(id);
    expect((await service.getObligation(id))!.state).toBe("CLOSED");

    // A user who still has the old Verify / Approve card in their DM clicks it again.
    const reVerify = await orch.verify(id, "U_AM");
    expect(reVerify.draftSent).toBe(false);
    const reSend = await orch.approveSend(id, "U_AM");
    expect(reSend.kind).toBe("rejected");
    expect(notifier.customerFacingText().length).toBe(1); // still exactly one customer post
  });
});
