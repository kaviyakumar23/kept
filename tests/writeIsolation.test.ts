import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService, type DetectInput } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator, CrossTenantWriteError } from "../src/app/orchestrator.js";
import { AM, NOW, ISO_NOW, slackSource, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * W2 (invariant #4) — write-side tenant isolation. The Bolt action handlers pass the
 * clicking user's `body.team.id` as `actingTeam`; a write to an obligation owned by a
 * DIFFERENT workspace must be blocked BEFORE any event is appended. This drives the
 * orchestrator enforcement point the handlers use.
 */
const T_ALPHA = "T_ALPHA";
const T_BETA = "T_BETA";

async function seed(
  service: ObligationService,
  team: string,
  over: Partial<DetectInput> & { customer: string; subject_canonical: string; outcome: string; idempotencyKey: string },
) {
  const det = await service.detectRequest({
    team,
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CUSTOMER_REQUEST",
    due: null,
    owner: null,
    conditions: [],
    actor: AM,
    source: slackSource("p"),
    at: ISO_NOW,
    now: NOW,
    ...over,
  });
  if (det.status !== "created") throw new Error(`expected created, got ${det.status}`);
  return det.obligation;
}

function buildStack() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: new SimulatedLinearAdapter({ startAt: 1 }),
    rts: new MockRtsRetriever(),
    notifier: new RecordingNotifier(),
    scheduler: new InMemoryScheduler(() => {}),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });
  return { service, orch };
}

describe("W2 — write-side tenant isolation (P0): a workspace can only write its own obligations", () => {
  it("blocks cross-tenant confirm / dismiss / verify / approveSend with CrossTenantWriteError", async () => {
    const { service, orch } = buildStack();
    const alpha = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1" });

    // Beta (the acting workspace) tries to act on Alpha's obligation → blocked, every path.
    await expect(orch.confirmCommitment(alpha.id, "U_BETA", undefined, T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.dismiss(alpha.id, "U_BETA", T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.verify(alpha.id, "U_BETA", T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.approveSend(alpha.id, "U_BETA", T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.approveSendWithText(alpha.id, "U_BETA", "hi", T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);

    // The blocked writes had NO side effect: the obligation is untouched (still CANDIDATE).
    const after = await orch.obligation(alpha.id);
    expect(after?.state).toBe("CANDIDATE");
  });

  it("allows a same-tenant write (the acting team owns the obligation)", async () => {
    const { service, orch } = buildStack();
    const alpha = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1" });

    const res = await orch.confirmCommitment(alpha.id, "U_ALPHA", undefined, T_ALPHA);
    // The gate passed and advanced the obligation out of CANDIDATE (no cross-tenant block).
    expect(res.obligation).not.toBeNull();
    expect(res.obligation?.state).not.toBe("CANDIDATE");
  });

  it("omitting actingTeam preserves the internal/demo path (no cross-tenant check)", async () => {
    const { service, orch } = buildStack();
    const alpha = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1" });
    // No actingTeam → internal callers (eval/demo) still work.
    const res = await orch.confirmCommitment(alpha.id, "U_ALPHA");
    expect(res.obligation?.state).not.toBe("CANDIDATE");
  });

  it("blocks cross-tenant modal READS (obligation / closureDraftText / auditFor)", async () => {
    const { service, orch } = buildStack();
    const alpha = await seed(service, T_ALPHA, { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "alpha SSO fix", idempotencyKey: "a:1" });
    await expect(orch.obligation(alpha.id, T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.closureDraftText(alpha.id, T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    await expect(orch.auditFor(alpha.id, T_BETA)).rejects.toBeInstanceOf(CrossTenantWriteError);
    // same-tenant modal read still works
    expect(await orch.auditFor(alpha.id, T_ALPHA)).not.toBeNull();
    expect((await orch.obligation(alpha.id, T_ALPHA))?.customer).toBe("Acme");
  });

  it("skips ingest of a team-less message instead of minting synthetic tenant 'T'", async () => {
    const { orch } = buildStack();
    const res = await orch.ingestMessage({ team: "", channel: "C", threadTs: "1", ts: "1", userId: "U", text: "we'll ship the SSO fix by Friday" });
    expect(res).toEqual({ kind: "skipped", signal: "no_team" });
  });
});
