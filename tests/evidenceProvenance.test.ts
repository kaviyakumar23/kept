import { describe, it, expect } from "vitest";
import { ProofCollector } from "../src/integrations/proofCollector.js";
import type { McpQueryClient, McpStructured } from "../src/integrations/mcp.js";
import { possibleFulfillmentCard } from "../src/slack/blocks.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { closureDraftCard } from "../src/slack/blocks.js";
import { buildClosureDraft } from "../src/policy/audience.js";
import { mkObl } from "./helpers.js";
import { ticketDone, featureFlag } from "../src/eval/scenarios.js";

/**
 * ADVERSARY (area: copy-provenance) — the Proof-of-Done evidence packet must honestly
 * distinguish HOW Kept knows each fact: "read live" (Kept queried the source just now)
 * vs "reported" (your pipeline pushed the event to Kept's webhook) vs "attested".
 *
 * GAP under test: `evidencePacketRows` tags provenance by evidence KIND, not by how the
 * evidence was actually obtained. But `ticket_status` has TWO provenances:
 *   • webhook push (mapLinearWebhook / mapJiraWebhook)      → genuinely "reported"
 *   • ProofCollector live MCP read (get_issue_status)       → actually "read live"
 * The packet hardcodes "reported" for every ticket_status, so a ticket status that Kept
 * read LIVE off Jira/Linear (identical MCP query mechanism as the flag/CI rows it labels
 * "read live") is misrepresented to the human reviewer as a pipeline push.
 */

/** Fake MCP surface: the linked Jira issue reads "Done" over a LIVE get_issue_status query. */
const liveJiraDone: McpQueryClient = {
  async query(name: string): Promise<McpStructured> {
    if (name === "get_issue_status") return { status: "Done", system: "jira" };
    return undefined;
  },
  async close() {},
};

/** Pull the "What Kept gathered" packet section text out of a possibleFulfillmentCard. */
function gatheredText(blocks: ReturnType<typeof possibleFulfillmentCard>): string {
  const section = blocks.find(
    (b) => (b as { type?: string }).type === "section" &&
      String((b as { text?: { text?: string } }).text?.text ?? "").startsWith("*What Kept gathered*"),
  ) as { text: { text: string } } | undefined;
  return section?.text.text ?? "";
}

describe("evidence-packet provenance honesty (copy-provenance)", () => {
  it("labels a LIVE-read ticket status as read live, never 'reported' (your pipeline pushed it)", async () => {
    // CODE (targetsFor) picks the linked Jira issue; the collector reads it LIVE via MCP —
    // exactly the same query() path that produces the flag/CI 'read live' rows.
    const collector = new ProofCollector({
      proof: liveJiraDone,
      targetsFor: () => ({ work: { system: "jira", key: "PROJ-123" } }),
      now: () => Date.parse("2026-07-04T12:00:00.000Z"),
    });

    const o = mkObl("POSSIBLE_FULFILLMENT", { id: "obl_live" });
    const evidence = await collector.collect(o);

    // Sanity: this is unambiguously a live read — same mechanism as flag/CI, with the
    // check-instant encoded in the ref (`<key>@<iso>`), which a webhook push never carries.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ kind: "ticket_status", source: "jira" });
    expect(evidence[0].data.status).toBe("Done");
    expect(evidence[0].ref).toMatch(/^PROJ-123@\d{4}-/);

    const blocks = possibleFulfillmentCard({ ...o, evidence }, assessFulfillment(evidence));
    const gathered = gatheredText(blocks);
    const ticketLine = gathered.split("\n").find((l) => l.includes("Ticket"));

    expect(ticketLine, "packet must render a ticket row").toBeTruthy();
    // The misrepresentation: a live MCP read shown to the reviewer as a pipeline push.
    expect(ticketLine).not.toContain("reported");
  });

  it("still labels a WEBHOOK-pushed ticket status as reported (the honest case must survive the fix)", () => {
    // A webhook-sourced ticket_status carries a bare ref (no `@<iso>` instant) — genuinely
    // "reported". Locking this so a fix distinguishes the two provenances instead of flipping
    // every ticket row to 'read live'.
    const o = mkObl("POSSIBLE_FULFILLMENT", { id: "obl_reported", evidence: [ticketDone("t", "PROJ-118")] });
    const gathered = gatheredText(possibleFulfillmentCard(o, assessFulfillment(o.evidence)));
    const ticketLine = gathered.split("\n").find((l) => l.includes("Ticket"));
    expect(ticketLine, "packet must render a ticket row").toBeTruthy();
    expect(ticketLine).toContain("reported");
  });

  it("closure draft to the customer never carries an internal source name or ref (holds)", () => {
    // Guardrail for the OTHER axis: internal provenance/source detail must not reach the
    // customer-facing draft text even when the packet is full of internal evidence.
    const o = mkObl("VERIFIED", {
      id: "obl_draft",
      outcome: "SSO login fix",
      evidence: [ticketDone("t", "PROJ-118"), featureFlag("f", "sso@x", true)],
    });
    const draft = buildClosureDraft(o);
    const cardJson = JSON.stringify(closureDraftCard(o, draft));
    // draft.text is the only thing the customer receives; it must be leak-clean.
    for (const token of ["PROJ-118", "jira", "linear", "github", "feature flag", "flag", "reported", "read live"]) {
      expect(draft.text.toLowerCase()).not.toContain(token.toLowerCase());
    }
    expect(draft.clean).toBe(true);
    // The safety line + tags live on the owner-facing card, never in draft.text.
    expect(cardJson).toContain("SSO login fix");
  });
});
