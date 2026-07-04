import { describe, it, expect } from "vitest";
import {
  LedgerRtsRetriever,
  SlackRtsRetriever,
  SlackAssistantSearchRetriever,
  CompositeRtsRetriever,
  type SlackSearchClient,
  type AssistantSearchClient,
  type AssistantSearchResult,
  type RtsRetriever,
} from "../src/slack/rts.js";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { NOW, heuristicResponder } from "../src/eval/scenarios.js";
import { mkObl } from "./helpers.js";

const fakeSearch = (matches: { channel?: { name?: string }; text?: string; permalink?: string }[]): SlackSearchClient => ({
  search: { messages: async () => ({ messages: { matches } }) },
});

describe("LedgerRtsRetriever — real RTS sourced from the obligation ledger", () => {
  const ledger = [
    mkObl("CLOSED", { customer: "Acme", subject_canonical: "EXPORT_FEATURE", outcome: "CSV export", updated_at: "2026-06-10T00:00:00Z" }),
    mkObl("IN_PROGRESS", { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix", updated_at: "2026-06-12T00:00:00Z" }),
    mkObl("OPEN", { customer: "Globex", subject_canonical: "BILLING", outcome: "billing fix", updated_at: "2026-06-11T00:00:00Z" }),
  ];
  const rts = new LedgerRtsRetriever({ listObligations: async () => ledger, areaOwners: { SSO_LOGIN_BUG: "U_ENG" } });

  it("returns prior commitments for the same customer, excluding the current subject", async () => {
    const ctx = await rts.retrieve({ team: "T_ACME", customer: "acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.priorCommitments.map((p) => p.outcome)).toEqual(["CSV export"]); // SSO excluded (same subject); Globex excluded (other customer)
    expect(ctx.suggestedOwner).toBe("U_ENG");
  });

  it("returns no priors for a customer with no history", async () => {
    const ctx = await rts.retrieve({ team: "T_ACME", customer: "Initech", subject_canonical: "X", channel: "C", userId: "U" });
    expect(ctx.priorCommitments).toEqual([]);
    expect(ctx.suggestedOwner).toBeNull();
  });

  it("never carries content destined for the event log (notes stay empty)", async () => {
    const ctx = await rts.retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.notes).toEqual([]); // ephemeral context only; nothing to persist
  });
});

describe("SlackRtsRetriever — cross-channel search (permission-safe, ephemeral)", () => {
  it("returns nothing without a user token (permission parity)", async () => {
    const r = new SlackRtsRetriever({ clientFor: () => fakeSearch([{ channel: { name: "acme-collab" } }]) });
    const ctx = await r.retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.notes).toEqual([]);
  });

  it("searches with the user token and surfaces channel-scoped notes — never raw text", async () => {
    let usedToken = "";
    let usedQuery = "";
    const r = new SlackRtsRetriever({
      clientFor: (t) => {
        usedToken = t;
        return {
          search: {
            messages: async (a: { query: string }) => {
              usedQuery = a.query;
              return { messages: { matches: [{ channel: { name: "acme-collab" }, text: "secret internal note", permalink: "p" }] } };
            },
          },
        };
      },
    });
    const ctx = await r.retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U", userToken: "xoxp-user" });
    expect(usedToken).toBe("xoxp-user");
    expect(usedQuery).toContain("sso login bug");
    expect(ctx.notes.length).toBe(1);
    expect(ctx.notes[0]).toContain("acme-collab");
    expect(JSON.stringify(ctx)).not.toContain("secret internal note"); // raw message text is never surfaced
  });

  it("a search failure never blocks the pipeline", async () => {
    const r = new SlackRtsRetriever({ clientFor: () => ({ search: { messages: async () => { throw new Error("rate limited"); } } }) });
    const ctx = await r.retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "X", channel: "C", userId: "U", userToken: "t" });
    expect(ctx.notes).toEqual([]);
  });
});

describe("SlackAssistantSearchRetriever — W3 Real-Time Search API (assistant.search.context)", () => {
  const RAW = "SECRET RAW MESSAGE BODY — never persist or surface";
  const results = (): AssistantSearchResult[] => [
    { channel_name: "acme-collab", channel_id: "C1", team_id: "T", content: RAW, author_user_id: "U9", permalink: "https://s/p1" },
    { channel_name: "other-workspace", channel_id: "C2", team_id: "T_OTHER", content: "cross-tenant body", permalink: "https://s/p2" },
  ];
  const mockClient = (captured: { args?: any }): AssistantSearchClient => ({
    assistant: { search: { context: async (args) => { captured.args = args; return { results: { messages: results() } }; } } },
  });

  it("no-ops without an action_token (bot-token calls require it)", async () => {
    const r = new SlackAssistantSearchRetriever({ clientFor: () => mockClient({}) });
    const ctx = await r.retrieve({ team: "T", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.notes).toEqual([]);
  });

  it("calls with the bot client + action_token and surfaces channel-scoped notes — never content", async () => {
    const captured: { args?: any } = {};
    const r = new SlackAssistantSearchRetriever({ clientFor: () => mockClient(captured) });
    const ctx = await r.retrieve({ team: "T", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U", actionToken: "xtok" });
    expect(captured.args.action_token).toBe("xtok");
    expect(captured.args.content_types).toEqual(["messages"]);
    expect(captured.args.query).toContain("sso login bug");
    // Cross-tenant result (T_OTHER) is filtered; only the same-team channel note surfaces.
    expect(ctx.notes).toEqual(["related discussion in #acme-collab"]);
    expect(JSON.stringify(ctx)).not.toContain(RAW); // raw message content is never surfaced
  });

  it("a search failure (e.g. not-allowlisted / paid plan) never blocks the pipeline", async () => {
    const r = new SlackAssistantSearchRetriever({
      clientFor: () => ({ assistant: { search: { context: async () => { throw new Error("not_allowed"); } } } }),
    });
    const ctx = await r.retrieve({ team: "T", customer: "Acme", subject_canonical: "X", channel: "C", userId: "U", actionToken: "xtok" });
    expect(ctx.notes).toEqual([]);
  });

  it("surfaces the note on the Gate-1 confirm card AND persists NO result text (zero-copy)", async () => {
    const store = new InMemoryEventStore();
    const service = new ObligationService(store, () => NOW);
    const notifier = new RecordingNotifier();
    const orch = new KeptOrchestrator({
      service,
      llm: new MockLlmProvider(heuristicResponder),
      workItems: new SimulatedLinearAdapter({ startAt: 200 }),
      rts: new SlackAssistantSearchRetriever({ clientFor: () => mockClient({}) }),
      notifier,
      scheduler: new InMemoryScheduler(() => {}),
      clock: () => NOW,
      currentDate: () => "2026-06-16",
      fallbackOwner: "U_AM",
    });

    const ing = await orch.ingestMessage({
      team: "T", channel: "C_ACME", threadTs: "100", ts: "100", userId: "U_PM",
      text: "Can you get the SSO bug fixed by Friday?", permalink: "p", actionToken: "xtok",
    });
    expect(ing.kind).toBe("confirm_card_sent");
    const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";

    // The RTS note surfaces on the private confirm card…
    const card = notifier.calls.find((c) => c.kind === "private");
    const cardJson = JSON.stringify(card?.blocks);
    expect(cardJson).toContain("related discussion in #acme-collab");
    expect(cardJson).not.toContain(RAW);

    // …but NOTHING from the RTS result reaches the durable event log (zero-copy, invariant #2).
    const events = await service.getEvents(id);
    const logJson = JSON.stringify(events);
    expect(logJson).not.toContain(RAW);
    expect(logJson).not.toContain("related discussion"); // not even the derived note is persisted
    expect(logJson).not.toContain("acme-collab");
  });
});

describe("CompositeRtsRetriever", () => {
  it("merges ledger priors + slack-search notes", async () => {
    const ledger = new LedgerRtsRetriever({
      listObligations: async () => [mkObl("OPEN", { customer: "Acme", subject_canonical: "EXPORT_FEATURE", outcome: "CSV export" })],
      areaOwners: { SSO_LOGIN_BUG: "U_ENG" },
    });
    const slack = new SlackRtsRetriever({ clientFor: () => fakeSearch([{ channel: { name: "acme-collab" } }]) });
    const ctx = await new CompositeRtsRetriever([ledger, slack]).retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U", userToken: "t" });
    expect(ctx.priorCommitments.map((p) => p.outcome)).toEqual(["CSV export"]);
    expect(ctx.suggestedOwner).toBe("U_ENG");
    expect(ctx.notes.length).toBe(1);
  });

  it("is fault-isolated: a throwing retriever contributes nothing", async () => {
    const bad: RtsRetriever = { retrieve: async () => { throw new Error("boom"); } };
    const ledger = new LedgerRtsRetriever({ listObligations: async () => [mkObl("OPEN", { customer: "Acme", subject_canonical: "EXPORT_FEATURE", outcome: "x" })] });
    const ctx = await new CompositeRtsRetriever([bad, ledger]).retrieve({ team: "T_ACME", customer: "Acme", subject_canonical: "Y", channel: "C", userId: "U" });
    expect(ctx.priorCommitments.length).toBe(1);
  });
});
