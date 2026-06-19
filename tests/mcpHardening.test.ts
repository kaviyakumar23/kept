import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import type { WorkItemAdapter } from "../src/integrations/linear.js";
import { McpWorkItemAdapter } from "../src/integrations/mcp.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { ledgerView } from "../src/slack/blocks.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * Round-6 adversarial hardening — the MCP work-item path. Each test reproduces a
 * confirmed finding from attacking the integration against the six guarantees.
 */

const msg = (text: string) => ({ team: "T", channel: "C_ACME", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });

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

describe("MCP hardening (round 6)", () => {
  it("self-heals after a work-item failure at Gate 1: retry re-creates the item (no permanent orphan)", async () => {
    class FlakyWorkItems implements WorkItemAdapter {
      readonly system = "linear" as const;
      calls = 0;
      fail = true;
      async createIssue() {
        this.calls++;
        if (this.fail) throw new Error("MCP server down");
        return { ref: "PROJ-118", url: "https://linear.app/acme/issue/PROJ-118" };
      }
    }
    const wi = new FlakyWorkItems();
    const { orch, service } = makeOrch(wi);
    const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
    expect(id).toBeTruthy();

    // First confirm: gate persists, but the work-item create fails → surfaced, not swallowed.
    await expect(orch.confirmCommitment(id, "U_AM")).rejects.toThrow(/MCP server down/);
    expect((await service.getObligation(id))!.work_item ?? null).toBeNull();

    // Retry once the work-item system recovers — must re-attempt (not be suppressed).
    wi.fail = false;
    const retry = await orch.confirmCommitment(id, "U_AM");
    expect(wi.calls).toBe(2);
    expect(retry.work?.ref).toBe("PROJ-118");
    expect((await service.getObligation(id))!.work_item?.ref).toBe("PROJ-118");
  });

  it("does not block the event loop on adversarial uppercase text (REF_RE is not quadratic)", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    server.registerTool("create_issue", { description: "c", inputSchema: { title: z.string() } }, async () => ({
      content: [{ type: "text", text: "A".repeat(200000) }],
    }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const wi = new McpWorkItemAdapter({ system: "linear", transport: () => ct, toolName: "create_issue" });
    const t0 = Date.now();
    await expect(wi.createIssue({ title: "x" })).rejects.toThrow(); // no parseable ref → clean error
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("rejects deeply nested structuredContent cleanly (no stack overflow)", async () => {
    let deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 50000; i++) {
      const n: Record<string, unknown> = {};
      cur.n = n;
      cur = n;
    }
    const server = new McpServer({ name: "t", version: "0" });
    server.registerTool("create_issue", { description: "c", inputSchema: { title: z.string() } }, async () => ({
      content: [{ type: "text", text: "no ref here" }],
      structuredContent: deep,
    }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const wi = new McpWorkItemAdapter({ system: "linear", transport: () => ct, toolName: "create_issue" });
    await expect(wi.createIssue({ title: "x" })).rejects.not.toThrow(/call stack/i);
  });

  it("escapes an adapter-supplied work-item ref so it can't inject Slack mrkdwn into the ledger", () => {
    const collectMrkdwn = (blocks: unknown[]): string =>
      blocks.map((b) => (b as { text?: { type?: string; text?: string } }).text).filter((t) => t?.type === "mrkdwn").map((t) => t!.text).join("\n");
    const o = {
      id: "o1", customer: "Acme", outcome: "export feature", state: "IN_PROGRESS", due: null,
      flags: { is_overdue: false, is_at_risk: false, is_disputed: false, has_scope_change: false },
      work_item: { system: "linear", ref: "<!channel> <https://evil.example|click>" },
    } as unknown as Parameters<typeof ledgerView>[1][number];
    const text = collectMrkdwn(ledgerView("Acme", [o]) as unknown[]);
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<https://evil.example|click>");
  });
});
