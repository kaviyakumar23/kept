import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { createSimulatedMcpWorkItems } from "../src/integrations/mcp.js";
import { InMemoryUsageStore } from "../src/store/usageStore.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * The "pilot" free-tier guardrail. Kept's dominant variable cost is the LLM classification run on
 * every ingested message; a per-workspace monthly cap (usage meter + pilotLimitFor) stops a
 * busy/abusive tenant from running up an unbounded AI bill. Over the cap → no further LLM call, a
 * `pilot_llm_limit` skip. Metering is scoped by team_id (invariant #4).
 */
const PROMISE = "Can you get the SSO bug fixed by Friday?";
const rootMsg = (team: string, ts: string, text = PROMISE) => ({ team, channel: "C", threadTs: ts, ts, userId: "U0PM0001", text, permalink: "p" });

async function makeOrch(pilotLimitFor: (team: string) => Promise<number>) {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const usage = new InMemoryUsageStore();
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: await createSimulatedMcpWorkItems(),
    rts: new MockRtsRetriever(),
    notifier: new RecordingNotifier(),
    usage,
    pilotLimitFor,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U0AM0001",
  });
  return { orch, usage };
}
const isPilotLimit = (r: { kind: string; signal?: string }) => r.kind === "skipped" && r.signal === "pilot_llm_limit";

describe("usage meter", () => {
  it("bump increments and is scoped per (team, period)", async () => {
    const u = new InMemoryUsageStore();
    expect(await u.bump("T_A", "2026-07")).toBe(1);
    expect(await u.bump("T_A", "2026-07")).toBe(2);
    expect(await u.get("T_A", "2026-07")).toBe(2);
    expect(await u.get("T_B", "2026-07")).toBe(0); // another workspace's counter is separate
    expect(await u.get("T_A", "2026-08")).toBe(0); // a new month resets
  });

  it("purgeTeam deletes only that team's counters (uninstall data deletion)", async () => {
    const u = new InMemoryUsageStore();
    await u.bump("T_A", "2026-07");
    await u.bump("T_A", "2026-08");
    await u.bump("T_B", "2026-07");
    expect(await u.purgeTeam("T_A")).toBe(2); // both of A's monthly rows
    expect(await u.get("T_A", "2026-07")).toBe(0);
    expect(await u.get("T_B", "2026-07")).toBe(1); // B untouched
  });
});

describe("pilot cap — LLM classifications per workspace per month", () => {
  it("classifies up to the cap, then returns pilot_llm_limit (no further LLM call)", async () => {
    const { orch } = await makeOrch(async () => 2);
    const a = await orch.ingestMessage(rootMsg("T_A", "1"));
    const b = await orch.ingestMessage(rootMsg("T_A", "2"));
    const c = await orch.ingestMessage(rootMsg("T_A", "3"));
    expect(isPilotLimit(a)).toBe(false); // within cap → classified
    expect(isPilotLimit(b)).toBe(false);
    expect(isPilotLimit(c)).toBe(true); // over cap → blocked
  });

  it("invariant #4 — the cap is per workspace; team B is unaffected by team A hitting its limit", async () => {
    const { orch } = await makeOrch(async () => 1);
    await orch.ingestMessage(rootMsg("T_A", "1")); // A: 1/1
    expect(isPilotLimit(await orch.ingestMessage(rootMsg("T_A", "2")))).toBe(true); // A over cap
    expect(isPilotLimit(await orch.ingestMessage(rootMsg("T_B", "3")))).toBe(false); // B's first — fine
  });

  it("a per-tenant unlimited plan (Infinity) never caps", async () => {
    const { orch } = await makeOrch(async () => Number.POSITIVE_INFINITY);
    for (let i = 0; i < 5; i++) {
      expect(isPilotLimit(await orch.ingestMessage(rootMsg("T_A", `m${i}`)))).toBe(false);
    }
  });
});
