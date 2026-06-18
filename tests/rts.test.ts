import { describe, it, expect } from "vitest";
import { LedgerRtsRetriever, SlackRtsRetriever, CompositeRtsRetriever, type SlackSearchClient, type RtsRetriever } from "../src/slack/rts.js";
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
    const ctx = await rts.retrieve({ customer: "acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.priorCommitments.map((p) => p.outcome)).toEqual(["CSV export"]); // SSO excluded (same subject); Globex excluded (other customer)
    expect(ctx.suggestedOwner).toBe("U_ENG");
  });

  it("returns no priors for a customer with no history", async () => {
    const ctx = await rts.retrieve({ customer: "Initech", subject_canonical: "X", channel: "C", userId: "U" });
    expect(ctx.priorCommitments).toEqual([]);
    expect(ctx.suggestedOwner).toBeNull();
  });

  it("never carries content destined for the event log (notes stay empty)", async () => {
    const ctx = await rts.retrieve({ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
    expect(ctx.notes).toEqual([]); // ephemeral context only; nothing to persist
  });
});

describe("SlackRtsRetriever — cross-channel search (permission-safe, ephemeral)", () => {
  it("returns nothing without a user token (permission parity)", async () => {
    const r = new SlackRtsRetriever({ clientFor: () => fakeSearch([{ channel: { name: "acme-collab" } }]) });
    const ctx = await r.retrieve({ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U" });
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
    const ctx = await r.retrieve({ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U", userToken: "xoxp-user" });
    expect(usedToken).toBe("xoxp-user");
    expect(usedQuery).toContain("sso login bug");
    expect(ctx.notes.length).toBe(1);
    expect(ctx.notes[0]).toContain("acme-collab");
    expect(JSON.stringify(ctx)).not.toContain("secret internal note"); // raw message text is never surfaced
  });

  it("a search failure never blocks the pipeline", async () => {
    const r = new SlackRtsRetriever({ clientFor: () => ({ search: { messages: async () => { throw new Error("rate limited"); } } }) });
    const ctx = await r.retrieve({ customer: "Acme", subject_canonical: "X", channel: "C", userId: "U", userToken: "t" });
    expect(ctx.notes).toEqual([]);
  });
});

describe("CompositeRtsRetriever", () => {
  it("merges ledger priors + slack-search notes", async () => {
    const ledger = new LedgerRtsRetriever({
      listObligations: async () => [mkObl("OPEN", { customer: "Acme", subject_canonical: "EXPORT_FEATURE", outcome: "CSV export" })],
      areaOwners: { SSO_LOGIN_BUG: "U_ENG" },
    });
    const slack = new SlackRtsRetriever({ clientFor: () => fakeSearch([{ channel: { name: "acme-collab" } }]) });
    const ctx = await new CompositeRtsRetriever([ledger, slack]).retrieve({ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", channel: "C", userId: "U", userToken: "t" });
    expect(ctx.priorCommitments.map((p) => p.outcome)).toEqual(["CSV export"]);
    expect(ctx.suggestedOwner).toBe("U_ENG");
    expect(ctx.notes.length).toBe(1);
  });

  it("is fault-isolated: a throwing retriever contributes nothing", async () => {
    const bad: RtsRetriever = { retrieve: async () => { throw new Error("boom"); } };
    const ledger = new LedgerRtsRetriever({ listObligations: async () => [mkObl("OPEN", { customer: "Acme", subject_canonical: "EXPORT_FEATURE", outcome: "x" })] });
    const ctx = await new CompositeRtsRetriever([bad, ledger]).retrieve({ customer: "Acme", subject_canonical: "Y", channel: "C", userId: "U" });
    expect(ctx.priorCommitments.length).toBe(1);
  });
});
