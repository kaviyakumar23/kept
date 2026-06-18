/**
 * Kept demo storyboard (spec E3) — the full loop, end to end, with the REAL
 * orchestrator + engine, recording/simulated adapters, and offline heuristic LLM.
 * Run: `npm run demo`. No Slack workspace, database, or network required.
 *
 * It exercises every winning beat: detect → Gate 1 → Linear issue → in-progress →
 * duplicate-webhook suppression → semantic dedupe → multi-source reconciliation →
 * Gate 2 verify → sanitized in-thread closure → close → reopen (outlives ticket) →
 * the two-sided ledger + full audit history.
 */
import { InMemoryEventStore } from "../store/memoryStore.js";
import { ObligationService } from "../engine/obligationService.js";
import { InMemoryScheduler } from "../scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../llm/mock.js";
import { createSimulatedMcpWorkItems } from "../integrations/mcp.js";
import { LedgerRtsRetriever } from "../slack/rts.js";
import { RecordingNotifier } from "../slack/notifier.js";
import { KeptOrchestrator } from "../app/orchestrator.js";
import { ledgerView, auditHistoryView, appHomeView, editObligationModal, editDraftModal, type SlackBlock } from "../slack/blocks.js";
import {
  mapLinearWebhook,
  mapGithubWebhook,
  mapDeployWebhook,
  applyWebhookAction,
} from "../webhooks/handlers.js";
import { NOW, heuristicResponder } from "../eval/scenarios.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderBlocks(blocks: SlackBlock[]): string {
  const out: string[] = [];
  for (const raw of blocks) {
    const b = raw as any;
    if (b.type === "header") out.push(`  ┃ ${b.text.text}`);
    else if (b.type === "section") {
      const acc = b.accessory?.text?.text ? `   ⟦${b.accessory.text.text}⟧` : "";
      if (b.text) out.push(`  ┃ ${String(b.text.text).replace(/\n/g, "\n  ┃ ")}${acc}`);
      if (b.fields) out.push("  ┃ " + b.fields.map((f: any) => f.text).join("   ·   "));
    } else if (b.type === "context") out.push(`  ┃ ⟨${b.elements.map((e: any) => e.text).join(" ")}⟩`);
    else if (b.type === "actions") out.push(`  ┃ [ ${b.elements.map((e: any) => e.text.text).join(" ] [ ")} ]`);
    else if (b.type === "input") out.push(`  ┃ ${b.label.text}: ${b.element?.initial_value ?? "—"}`);
    else if (b.type === "divider") out.push("  ┃ ────────");
  }
  return out.join("\n");
}

const log = (s = "") => console.log(s);
const beat = (t: string) => {
  log();
  log(`━━━ ${t} ${"━".repeat(Math.max(0, 64 - t.length))}`);
};

async function main() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const reminders: string[] = [];
  const scheduler = new InMemoryScheduler((j) => {
    reminders.push(`${j.kind}@${new Date(j.fireAt).toISOString().slice(0, 10)}`);
  });
  // Work items are created through a REAL MCP client↔server round-trip (an
  // in-process simulated MCP server) — Kept's deterministic MCP client, no network.
  const workItems = await createSimulatedMcpWorkItems({ startAt: 118 });
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems,
    // Real, ledger-backed RTS: prior commitments come from the obligation ledger; the
    // area owner from a configurable map. Results are ephemeral (never persisted).
    rts: new LedgerRtsRetriever({
      listObligations: () => service.listObligations(NOW),
      areaOwners: { SSO_LOGIN_BUG: "U_ENG" },
    }),
    // Approved roadmap — Friday (06-19) is earlier than the SSO target (06-30) → conflict.
    roadmap: [{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" }],
    notifier,
    scheduler,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_ACCOUNT_MANAGER",
  });

  const channel = "C_ACME_COLLAB";
  const thread = "1718.0001";
  const lastPrivateCard = () => {
    const c = [...notifier.calls].reverse().find((x) => x.kind === "private");
    return c?.blocks ? renderBlocks(c.blocks) : "(no card)";
  };

  // Seed a prior Acme commitment so the ledger-backed RTS has real context to surface.
  const seed = await orch.ingestMessage({ team: "T_ACME", channel, threadTs: "1700.0001", ts: "1700.0001", userId: "U_ACME_PM", text: "Can you add the CSV export feature?", permalink: "p0" });
  if (seed.kind === "confirm_card_sent") await orch.confirmCommitment(seed.obligationId, "U_AM");
  log(`  (seeded a prior Acme commitment — "CSV export feature" — so RTS has real ledger context)`);

  beat("0:00  Customer in #acme-collab");
  log(`  @acme_pm: "Can you get the SSO bug fixed by Friday?"`);

  beat("0:15  Kept classifies + extracts → private confirm card (Gate 1)");
  const ingest = await orch.ingestMessage({
    team: "T_ACME", channel, threadTs: thread, ts: "1718.0001", userId: "U_ACME_PM",
    text: "Can you get the SSO bug fixed by Friday?", permalink: "https://acme.slack.com/archives/C/p1718",
  });
  if (ingest.kind !== "confirm_card_sent") throw new Error(`expected confirm card, got ${ingest.kind}`);
  const id = ingest.obligationId;
  log(`  → private to <@${ingest.owner}> (never the customer channel):`);
  log(lastPrivateCard());

  beat("0:25  Account manager clicks Confirm → one Linear issue, events appended");
  const { work } = await orch.confirmCommitment(id, "U_AM");
  if (!work) throw new Error("confirm was not applied");
  log(`  → created ${work.ref} (${work.url}) — via an MCP create_issue tool call (code chose the tool, not the model)`);
  log(`  → reminders scheduled: ${scheduler.pending().map((j) => j.kind).join(", ")}`);
  log(renderBlocks(ledgerView("Acme", await orch.ledgerFor("Acme"))));

  beat("0:35  Linear says In Progress → ledger advances; duplicate webhook suppressed");
  const inProgress = { type: "Issue", action: "update", data: { identifier: work.ref, state: { name: "In Progress" }, updatedAt: "2026-06-17T09:00:00Z" } };
  log(`  webhook#1 ${await applyWebhookAction(orch, mapLinearWebhook(inProgress))}`);
  log(`  webhook#2 (duplicate) ${await applyWebhookAction(orch, mapLinearWebhook(inProgress))}  ← idempotent`);

  beat("0:45  'any update on that login issue?' → attaches to the same obligation");
  const dedupe = await orch.ingestMessage({
    team: "T_ACME", channel, threadTs: thread, ts: "1718.0099", userId: "U_ACME_PM",
    text: "any update on that login issue?", permalink: "https://acme.slack.com/archives/C/p1718b",
  });
  log(`  → ${dedupe.kind}${dedupe.kind === "deduped" ? ` (same obligation ${dedupe.obligationId === id ? "✓" : "✗"})` : ""}; obligations on file: ${(await store.getAllObligationIds()).length}`);

  beat("0:55  Engineering ships — reconciliation: merge + prod deploy = available");
  const ghMerged = { action: "closed", pull_request: { number: 449, merged: true, merged_at: "2026-06-18T14:00:00Z", html_url: "https://github.com/acme/app/pull/449" }, relatesTo: { linear: work.ref } };
  log(`  PR merged:  ${await applyWebhookAction(orch, mapGithubWebhook(ghMerged))}  ← merge alone is NOT enough`);
  const deploy = { release: "2026.06.18", environment: "production", customer_scoped: true, relatesTo: { linear: work.ref } };
  log(`  deployed:   ${await applyWebhookAction(orch, mapDeployWebhook(deploy))}`);
  log(`  → Gate-2 verify card sent privately to the owner.`);
  log(lastPrivateCard());

  beat("1:10  Account manager verifies (Gate 2) → sanitized closure draft");
  await orch.verify(id, "U_AM");
  log(lastPrivateCard());

  beat("1:25  Approve & send → posted in the ORIGINAL thread (sanitized)");
  const sent = await orch.approveSend(id, "U_AM");
  if (sent.kind !== "notified") throw new Error(`notify rejected: ${sent.reason}`);
  for (const c of notifier.customerFacingText()) log(`  #acme-collab ▸ ${c}`);

  beat("1:40  Customer confirms → CLOSED");
  await orch.recordCustomerConfirmation(id);
  log(`  state: ${(await service.getObligation(id))!.state}`);

  beat("1:50  Customer: 'it still fails for one user' → REOPENED (outlives the ticket)");
  const reopened = await orch.reopen(id, "still fails for one user");
  log(`  state: ${reopened!.state} · ticket still ${reopened!.work_item?.ref} (Done) · disputed=${reopened!.flags.is_disputed}`);

  beat("2:00  Two-sided view — what we owe Acme");
  log(renderBlocks(ledgerView("Acme", await orch.ledgerFor("Acme"))));

  beat("2:10  Full audit history (event-sourced, explainable)");
  const audit = await orch.auditFor(id);
  if (audit) log(renderBlocks(auditHistoryView(audit.obligation, audit.events)));

  beat("2:20  App Home — the live obligation-ledger dashboard");
  log(renderBlocks((appHomeView(await orch.allObligations()) as { blocks: SlackBlock[] }).blocks));

  beat("(polish)  Edit modals — edit-and-confirm at Gate 1, edit-the-reply at closure");
  const sample = await orch.obligation(id);
  if (sample) {
    log("  ‹ Edit & confirm modal ›");
    log(renderBlocks((editObligationModal(sample) as { blocks: SlackBlock[] }).blocks));
    log("  ‹ Edit reply modal (re-leak-checked on submit) ›");
    log(renderBlocks((editDraftModal(sample, (await orch.closureDraftText(id)) ?? "") as { blocks: SlackBlock[] }).blocks));
  }

  log();
  log(`  Surfaces used: ${notifier.calls.filter((c) => c.kind === "private").length} private cards/nudges · ${notifier.calls.filter((c) => c.kind === "thread").length} customer-channel post(s).`);
  log("  Every consequential transition required a human gate; every customer-facing word passed the sanitizer.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
