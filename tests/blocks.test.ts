import { describe, it, expect } from "vitest";
import {
  confirmCard,
  possibleFulfillmentCard,
  closureDraftCard,
  ledgerView,
  auditHistoryView,
  reminderMessage,
  appHomeView,
  auditModal,
  editObligationModal,
  editDraftModal,
  actionId,
  parseActionId,
  ACTIONS,
  CALLBACKS,
  FIELDS,
} from "../src/slack/blocks.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { buildClosureDraft } from "../src/policy/audience.js";
import { EMPTY_RTS } from "../src/slack/rts.js";
import { mkObl, evt } from "./helpers.js";
import { prMerged, prodDeploy, ticketDone } from "../src/eval/scenarios.js";
import type { Classification } from "../src/llm/schemas.js";

const classification: Classification = { signal: "CUSTOMER_REQUEST", direction: "TEAM_OWES_CUSTOMER", confidence: 0.9, rationale: "ask" };

describe("Block Kit builders", () => {
  it("action id round-trips obligation id", () => {
    expect(parseActionId(actionId(ACTIONS.confirm, "obl_1"))).toEqual({ action: ACTIONS.confirm, obligationId: "obl_1" });
  });

  it("confirm card carries the three Gate-1 buttons and stays private", () => {
    const blocks = confirmCard(mkObl("CANDIDATE", { id: "obl_1" }), classification, EMPTY_RTS);
    const actions = blocks.find((b) => (b as { type?: string }).type === "actions") as { elements: { action_id: string }[] };
    const ids = actions.elements.map((e) => e.action_id);
    expect(ids).toEqual([actionId(ACTIONS.confirm, "obl_1"), actionId(ACTIONS.edit, "obl_1"), actionId(ACTIONS.dismiss, "obl_1")]);
    expect(JSON.stringify(blocks)).toContain("Private to you");
  });

  it("confirm card shows a roadmap-conflict warning when provided", () => {
    const blocks = confirmCard(mkObl("CANDIDATE", { id: "o1" }), classification, EMPTY_RTS, "committed date is earlier than the roadmap target");
    expect(JSON.stringify(blocks)).toContain("Roadmap conflict");
  });

  it("possible-fulfillment card lists reconciled evidence + verify button", () => {
    const o = mkObl("POSSIBLE_FULFILLMENT", { id: "obl_2", evidence: [prMerged("p", "PR-449"), prodDeploy("d", "rel")] });
    const blocks = possibleFulfillmentCard(o, assessFulfillment(o.evidence));
    const json = JSON.stringify(blocks);
    expect(json).toContain(actionId(ACTIONS.verify, "obl_2"));
    expect(json).toContain("merged");
  });

  it("closure draft card shows the sanitized text and a leak-safe marker", () => {
    const o = mkObl("VERIFIED", { id: "obl_3", outcome: "SSO login fix", evidence: [ticketDone("t", "PROJ-118"), prMerged("p", "PR-449"), prodDeploy("d", "rel")] });
    const draft = buildClosureDraft(o);
    const json = JSON.stringify(closureDraftCard(o, draft));
    expect(json).toContain("SSO login fix");
    expect(json).toContain(actionId(ACTIONS.approveSend, "obl_3"));
    expect(json).not.toContain("PROJ-118"); // internal ref never in the draft
  });

  it("ledger view groups open vs closed", () => {
    const blocks = ledgerView("Acme", [mkObl("IN_PROGRESS", { outcome: "SSO login fix" }), mkObl("CLOSED", { outcome: "Export feature" })]);
    const json = JSON.stringify(blocks);
    expect(json).toContain("What we owe Acme");
    expect(json).toContain("SSO login fix");
  });

  it("audit history renders one line per event", () => {
    const events = [
      evt({ type: "REQUEST_DETECTED", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: [] }),
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: null, owner: "U_ENG" }, { approved_by: "U_AM" }),
    ];
    const json = JSON.stringify(auditHistoryView(mkObl("OPEN"), events));
    expect(json).toContain("REQUEST_DETECTED");
    expect(json).toContain("COMMITMENT_CONFIRMED");
  });

  it("reminder message is owner-facing", () => {
    const { text } = reminderMessage(mkObl("IN_PROGRESS", { due: "2026-06-19", outcome: "SSO login fix" }), "OVERDUE");
    expect(text).toContain("Overdue");
    expect(text).toContain("SSO login fix");
  });

  it("App Home groups by customer and offers a History drill-in", () => {
    const view = appHomeView([
      mkObl("IN_PROGRESS", { id: "o1", customer: "Acme", outcome: "SSO login fix" }),
      mkObl("OPEN", { id: "o2", customer: "Globex", outcome: "Export feature" }),
    ]) as { type: string };
    expect(view.type).toBe("home");
    const json = JSON.stringify(view);
    expect(json).toContain("Acme");
    expect(json).toContain("Globex");
    expect(json).toContain(actionId(ACTIONS.history, "o1"));
  });

  it("edit-obligation modal prefills fields and carries the obligation id", () => {
    const view = editObligationModal(mkObl("CANDIDATE", { id: "o9", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" })) as { type: string; callback_id: string; private_metadata: string };
    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(CALLBACKS.editObligation);
    expect(view.private_metadata).toBe("o9");
    const json = JSON.stringify(view);
    expect(json).toContain("SSO login fix");
    expect(json).toContain("2026-06-19");
    expect(json).toContain(FIELDS.outcome.action);
  });

  it("edit-draft modal prefills the customer reply text", () => {
    const o = mkObl("VERIFIED", { id: "o3", outcome: "SSO login fix", evidence: [prMerged("p", "PR"), prodDeploy("d", "rel")] });
    const view = editDraftModal(o, buildClosureDraft(o).text) as { callback_id: string };
    expect(view.callback_id).toBe(CALLBACKS.editDraft);
    expect(JSON.stringify(view)).toContain("available on your side");
  });

  it("audit modal wraps the history view", () => {
    const view = auditModal(mkObl("OPEN"), [evt({ type: "REQUEST_DETECTED", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: [] })]) as { type: string };
    expect(view.type).toBe("modal");
    expect(JSON.stringify(view)).toContain("REQUEST_DETECTED");
  });
});
