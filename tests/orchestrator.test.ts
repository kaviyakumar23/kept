import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter, type WorkItemAdapter } from "../src/integrations/linear.js";
import { SimulatedJiraAdapter } from "../src/integrations/jira.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { mapLinearWebhook, mapJiraWebhook, mapGithubWebhook, mapDeployWebhook, applyWebhookAction } from "../src/webhooks/handlers.js";
import { detectLeaks } from "../src/policy/audience.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

function buildOrch(
  roadmap?: { customer: string; subject_canonical: string; targetDate: string }[],
  workItems: WorkItemAdapter = new SimulatedLinearAdapter({ startAt: 118 }),
) {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const scheduler = new InMemoryScheduler(() => {});
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems,
    rts: new MockRtsRetriever(),
    notifier,
    scheduler,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
    roadmap,
  });
  return { store, service, notifier, scheduler, orch };
}

const msg = (text: string, ts = "100") => ({ team: "T", channel: "C_ACME", threadTs: "100", ts, userId: "U_PM", text, permalink: "p" });

const merge = mapGithubWebhook({ action: "closed", pull_request: { number: 449, merged: true, merged_at: "2026-06-18T00:00:00Z", html_url: "u" }, relatesTo: { linear: "PROJ-118" } });
const deploy = mapDeployWebhook({ release: "2026.06.18", environment: "production", customer_scoped: true, relatesTo: { linear: "PROJ-118" } });

async function toVerified(orch: KeptOrchestrator): Promise<string> {
  const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
  const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
  await orch.confirmCommitment(id, "U_AM");
  await applyWebhookAction(orch, merge, "T");
  await applyWebhookAction(orch, deploy, "T");
  await orch.verify(id, "U_AM");
  return id;
}

describe("KeptOrchestrator — the full loop on top of the engine", () => {
  it("detect → Gate 1 → work → reconcile → Gate 2 → in-thread closure → close → reopen", async () => {
    const { orch, service, notifier } = buildOrch();

    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    expect(ing.kind).toBe("confirm_card_sent");
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    expect(notifier.customerFacingText()).toEqual([]); // no public noise yet

    const { work } = await orch.confirmCommitment(id, "U_AM");
    expect(work?.ref).toBe("PROJ-118");
    expect((await service.getObligation(id))!.state).toBe("OPEN");

    await applyWebhookAction(orch, mapLinearWebhook({ type: "Issue", action: "update", data: { identifier: "PROJ-118", state: { name: "In Progress" }, updatedAt: "2026-06-17T00:00:00Z" } }), "T");
    expect((await service.getObligation(id))!.state).toBe("IN_PROGRESS");

    await applyWebhookAction(orch, merge, "T"); // not enough alone
    await applyWebhookAction(orch, deploy, "T"); // merge + prod deploy = available
    expect((await service.getObligation(id))!.state).toBe("POSSIBLE_FULFILLMENT");
    expect(notifier.calls.some((c) => c.kind === "private" && c.text.includes("Possible fulfillment"))).toBe(true);

    await orch.verify(id, "U_AM");
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");
    expect(notifier.customerFacingText()).toEqual([]); // still nothing posted to the customer

    const sent = await orch.approveSend(id, "U_AM");
    expect(sent.kind).toBe("notified");
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED");
    const posts = notifier.customerFacingText();
    expect(posts.length).toBe(1);
    expect(detectLeaks(posts[0]!)).toEqual([]); // sanitized
    expect(posts[0]).toContain("SSO login fix");

    await orch.recordCustomerConfirmation(id);
    expect((await service.getObligation(id))!.state).toBe("CLOSED");

    const reopened = await orch.reopen(id, "still fails for one user");
    expect(reopened!.state).toBe("IN_PROGRESS");
    expect(reopened!.work_item?.ref).toBe("PROJ-118"); // obligation outlives the ticket
    expect(reopened!.flags.is_disputed).toBe(true);
  });

  it("refuses to post a leaky draft to the customer channel", async () => {
    const { orch, notifier } = buildOrch();
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM", { outcome: "Fix PROJ-118 login" }); // leaky outcome
    await applyWebhookAction(orch, merge, "T");
    await applyWebhookAction(orch, deploy, "T");
    await orch.verify(id, "U_AM");
    const sent = await orch.approveSend(id, "U_AM");
    expect(sent.kind).toBe("rejected");
    expect(notifier.customerFacingText()).toEqual([]); // nothing leaked to the customer
  });

  it("attaches a follow-up message to the same obligation (semantic dedupe)", async () => {
    const { orch, store } = buildOrch();
    const a = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?", "100"));
    const b = await orch.ingestMessage(msg("any update on that login issue?", "200"));
    expect(a.kind).toBe("confirm_card_sent");
    expect(b.kind).toBe("deduped");
    expect((await store.getAllObligationIds("T")).length).toBe(1);
  });

  it("warns on the confirm card when the committed date contradicts the roadmap", async () => {
    const { orch, notifier } = buildOrch([{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" }]);
    await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?")); // due 2026-06-19 < target 2026-06-30
    const card = notifier.calls.find((c) => c.kind === "private");
    expect(JSON.stringify(card?.blocks)).toContain("Roadmap conflict");
  });

  it("no roadmap warning when the committed date meets the target", async () => {
    const { orch, notifier } = buildOrch([{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-10" }]);
    await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?")); // due 2026-06-19 >= target → no conflict
    const card = notifier.calls.find((c) => c.kind === "private");
    expect(JSON.stringify(card?.blocks)).not.toContain("Roadmap conflict");
  });

  it("runs the full loop on a Jira adapter (provider-agnostic work items)", async () => {
    const { orch, service } = buildOrch(undefined, new SimulatedJiraAdapter({ startAt: 1001 }));
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";

    const { work } = await orch.confirmCommitment(id, "U_AM");
    expect(work?.ref).toBe("ACME-1001");
    const opened = await service.getObligation(id);
    expect(opened?.work_item?.system).toBe("jira");
    expect(opened?.entity_refs.jira).toBe("ACME-1001");

    await applyWebhookAction(orch, mapJiraWebhook({ issue: { key: "ACME-1001", fields: { status: { name: "In Progress" }, updated: "2026-06-17T00:00:00Z" } } }), "T");
    expect((await service.getObligation(id))?.state).toBe("IN_PROGRESS");

    // GitHub + deploy resolve the obligation via the Jira ref.
    await applyWebhookAction(orch, mapGithubWebhook({ action: "closed", pull_request: { number: 7, merged: true, merged_at: "2026-06-18T00:00:00Z", html_url: "u" }, relatesTo: { jira: "ACME-1001" } }), "T");
    await applyWebhookAction(orch, mapDeployWebhook({ release: "2026.06.18", environment: "production", customer_scoped: true, relatesTo: { jira: "ACME-1001" } }), "T");
    expect((await service.getObligation(id))?.state).toBe("POSSIBLE_FULFILLMENT");

    await orch.verify(id, "U_AM");
    const sent = await orch.approveSend(id, "U_AM");
    expect(sent.kind).toBe("notified");
    await orch.recordCustomerConfirmation(id);
    expect((await service.getObligation(id))?.state).toBe("CLOSED"); // same guarantees, different provider
  });

  it("skips non-actionable chatter", async () => {
    const { orch, notifier } = buildOrch();
    const r = await orch.ingestMessage(msg("thanks so much for the great support!"));
    expect(r.kind).toBe("skipped");
    expect(notifier.calls.length).toBe(0);
  });

  it("concurrent 'Confirm' clicks create exactly one Linear work item", async () => {
    const { orch, service } = buildOrch();
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    const [r1, r2] = await Promise.all([orch.confirmCommitment(id, "U_AM"), orch.confirmCommitment(id, "U_AM")]);
    expect([r1.work, r2.work].filter(Boolean).length).toBe(1); // only the winner minted an issue
    const events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "COMMITMENT_CONFIRMED").length).toBe(1);
    expect(events.filter((e) => e.type === "WORK_ITEM_LINKED").length).toBe(1);
  });

  it("concurrent 'Approve & send' posts to the customer exactly once", async () => {
    const { orch, notifier, service } = buildOrch();
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM");
    await applyWebhookAction(orch, merge, "T");
    await applyWebhookAction(orch, deploy, "T");
    await orch.verify(id, "U_AM");
    const [s1, s2] = await Promise.all([orch.approveSend(id, "U_AM"), orch.approveSend(id, "U_AM")]);
    expect(notifier.customerFacingText().length).toBe(1); // exactly one customer post
    expect([s1, s2].filter((s) => s.kind === "notified").length).toBe(1);
    expect((await service.getObligation(id))!.state).toBe("CUSTOMER_NOTIFIED");
  });

  it("approveSendWithText sends a human-edited (clean) reply", async () => {
    const { orch, notifier } = buildOrch();
    const id = await toVerified(orch);
    const res = await orch.approveSendWithText(id, "U_AM", "Hi — your login should be working now. Can you confirm on your side?");
    expect(res.kind).toBe("notified");
    const posts = notifier.customerFacingText();
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("login should be working");
  });

  it("approveSendWithText refuses a human-edited reply that leaks internal detail", async () => {
    const { orch, notifier } = buildOrch();
    const id = await toVerified(orch);
    const res = await orch.approveSendWithText(id, "U_AM", "Done — see PROJ-118, deployed to prod.");
    expect(res.kind).toBe("rejected");
    expect(notifier.customerFacingText()).toEqual([]); // the edited leak never reaches the customer
  });

  it("never posts to the customer before approval (no public noise)", async () => {
    const { orch, notifier } = buildOrch();
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    await orch.confirmCommitment(id, "U_AM");
    await applyWebhookAction(orch, merge, "T");
    await applyWebhookAction(orch, deploy, "T");
    await orch.verify(id, "U_AM");
    expect(notifier.customerFacingText()).toEqual([]);
    expect(notifier.calls.every((c) => c.kind === "private")).toBe(true);
  });
});
