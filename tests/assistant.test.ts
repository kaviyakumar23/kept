import { describe, it, expect } from "vitest";
import type { Obligation } from "../src/domain/obligation.js";
import { emptyFlags } from "../src/domain/state.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import type { StructuredRequest } from "../src/llm/provider.js";
import { classifyLedgerQuery, answerLedgerQuery, QueryIntentSchema } from "../src/app/assistantQuery.js";

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

/** A deterministic offline "router": keyword-maps the question to an intent (validated by the real schema). */
const router = new MockLlmProvider((req: StructuredRequest<unknown>) => {
  const q = req.user.toLowerCase();
  if (/overdue|late|past due/.test(q)) return { intent: "overdue" };
  if (/waiting on me|on me|for me/.test(q)) return { intent: "awaiting_verify", mine: true };
  if (/acme/.test(q)) return { intent: "by_customer", customer: "Acme" };
  if (/summary|how are we/.test(q)) return { intent: "summary" };
  return { intent: "help" };
});

const blockText = (blocks: unknown[]): string => JSON.stringify(blocks);

describe("Slack AI Assistant — NL ledger query router", () => {
  it("routes natural-language questions into the fixed intent grammar", async () => {
    expect((await classifyLedgerQuery(router, "what's overdue?")).intent).toBe("overdue");
    const cust = await classifyLedgerQuery(router, "what did we promise Acme this week?");
    expect(cust.intent).toBe("by_customer");
    expect(cust.customer).toBe("Acme");
    const mine = await classifyLedgerQuery(router, "anything waiting on me to verify?");
    expect(mine.intent).toBe("awaiting_verify");
    expect(mine.mine).toBe(true);
  });

  it("the schema accepts a bare intent (customer/mine optional)", () => {
    const v = QueryIntentSchema.parse({ intent: "overdue" });
    expect(v.intent).toBe("overdue");
    expect(v.customer == null).toBe(true);
    expect(v.mine ?? false).toBe(false);
  });

  it("answers 'overdue' from the ledger, not the model", () => {
    const obls = [
      obl({ id: "1", outcome: "SSO fix", flags: { ...emptyFlags(), is_overdue: true } }),
      obl({ id: "2", outcome: "export feature" }),
    ];
    const ans = answerLedgerQuery({ intent: "overdue", customer: null, mine: false }, obls, NOW);
    expect(ans.text).toBe("Overdue");
    expect(blockText(ans.blocks)).toContain("SSO fix");
    expect(blockText(ans.blocks)).not.toContain("export feature");
  });

  it("'awaiting_verify mine' filters to the viewer", () => {
    const obls = [
      obl({ id: "1", state: "POSSIBLE_FULFILLMENT", owner: "U_ME", outcome: "mine-item" }),
      obl({ id: "2", state: "POSSIBLE_FULFILLMENT", owner: "U_OTHER", outcome: "other-item" }),
    ];
    const ans = answerLedgerQuery({ intent: "awaiting_verify", customer: null, mine: true }, obls, NOW, "U_ME");
    expect(blockText(ans.blocks)).toContain("mine-item");
    expect(blockText(ans.blocks)).not.toContain("other-item");
  });

  it("'by_customer' renders the customer ledger view", () => {
    const obls = [obl({ id: "1", customer: "Acme", outcome: "SSO fix" }), obl({ id: "2", customer: "Globex", outcome: "thing" })];
    const ans = answerLedgerQuery({ intent: "by_customer", customer: "Acme", mine: false }, obls, NOW);
    expect(blockText(ans.blocks)).toContain("What we owe Acme");
    expect(blockText(ans.blocks)).toContain("SSO fix");
    expect(blockText(ans.blocks)).not.toContain("thing");
  });

  it("'summary' reports counts from analytics", () => {
    const obls = [
      obl({ id: "1", flags: { ...emptyFlags(), is_overdue: true } }),
      obl({ id: "2", state: "POSSIBLE_FULFILLMENT" }),
      obl({ id: "3", state: "CLOSED" }),
    ];
    const ans = answerLedgerQuery({ intent: "summary", customer: null, mine: false }, obls, NOW);
    const t = blockText(ans.blocks);
    expect(t).toContain("Ledger summary");
    expect(t).toContain("*Open:* 2");
  });
});
