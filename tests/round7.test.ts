import { describe, it, expect } from "vitest";
import type { Obligation } from "../src/domain/obligation.js";
import { emptyFlags } from "../src/domain/state.js";
import { analytics } from "../src/app/analytics.js";
import { answerLedgerQuery } from "../src/app/assistantQuery.js";
import { ledgerView } from "../src/slack/blocks.js";

/**
 * Round-7 adversarial hardening — the new Slack AI Assistant + analytics surfaces.
 * Each test reproduces a confirmed finding from attacking those surfaces.
 */
const NOW = Date.parse("2026-06-26T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function obl(o: Partial<Obligation> & { id: string }): Obligation {
  return {
    team: "T_ACME", state: "OPEN", direction: "TEAM_OWES_CUSTOMER", signal: "CONFIRMED_COMMITMENT",
    customer: "Acme", subject_canonical: "X", outcome: "do x", due: null, owner: "U1",
    work_item: null, entity_refs: { customer: "Acme", subject_canonical: "X" },
    flags: emptyFlags(), evidence: [], conditions: [], history_count: 1, state_version: 1,
    created_at: iso(NOW), updated_at: iso(NOW), ...o,
  };
}
const blocksText = (blocks: unknown[]) => JSON.stringify(blocks);

describe("round 7 — assistant + analytics hardening", () => {
  it("analytics() survives a very large open ledger (no Math.max spread crash)", () => {
    const big = Array.from({ length: 150000 }, (_, i) => obl({ id: "o" + i }));
    let a!: ReturnType<typeof analytics>;
    expect(() => { a = analytics(big, NOW); }).not.toThrow();
    expect(a.counts.open).toBe(150000);
    expect(typeof a.aging.oldestOpenDays).toBe("number");
  });

  it("escapes attacker-controlled `due` so it can't inject a Slack mention/link", () => {
    const obls = [obl({ id: "1", outcome: "SSO fix", due: "<!channel>", flags: { ...emptyFlags(), is_overdue: true } })];
    const json = blocksText(answerLedgerQuery({ intent: "overdue", customer: null, mine: false }, obls, NOW).blocks);
    expect(json).not.toContain("<!channel>");
    expect(json).toContain("&lt;!channel&gt;");
  });

  it("caps long answer lists so a big result set can't blow Slack's block/char limits", () => {
    const obls = Array.from({ length: 500 }, (_, i) => obl({ id: "o" + i, outcome: "obligation number " + i + " with a fairly descriptive outcome", flags: { ...emptyFlags(), is_overdue: true } }));
    const ans = answerLedgerQuery({ intent: "overdue", customer: null, mine: false }, obls, NOW);
    expect(ans.blocks.length).toBeLessThanOrEqual(50);
    for (const b of ans.blocks) {
      const t = (b as { text?: { text?: string } }).text?.text ?? "";
      expect(t.length).toBeLessThanOrEqual(3000);
    }
    expect(blocksText(ans.blocks)).toContain("more");
  });

  it("ledgerView escapes a closed obligation's outcome in the 'Recently closed' line", () => {
    const v = ledgerView("Acme", [obl({ id: "c1", state: "CLOSED", outcome: "done <!here>" })]);
    const json = blocksText(v);
    expect(json).not.toContain("<!here>");
    expect(json).toContain("&lt;!here&gt;");
  });
});
