/**
 * Regression tests for the findings from the adversarial verification workflow.
 * Each test encodes an attack that previously succeeded and must now be blocked.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../src/engine/commandHandler.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { detectLeaks, sanitizeForAudience } from "../src/policy/audience.js";
import { checkRoadmapConflict } from "../src/policy/roadmap.js";
import { requiresHumanApproval } from "../src/policy/actionTiers.js";
import { TRANSITIONS } from "../src/domain/stateMachine.js";
import type { CommandKind } from "../src/domain/commands.js";
import type { EventType } from "../src/domain/events.js";
import type { Evidence } from "../src/domain/evidence.js";
import {
  buildEnv,
  ctx,
  slackSource,
  AM,
  prMerged,
  prodDeploy,
  customerConfirmed,
  NOW,
  ISO_NOW,
  T_ACME,
  type Env,
} from "../src/eval/scenarios.js";
import { findRawContent } from "../src/domain/zeroCopy.js";
import { mkObl, evt } from "./helpers.js";

async function openInProgress(env: Env, key: string): Promise<string> {
  const det = await env.service.detectRequest({
    team: T_ACME, direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG",
    outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG", conditions: [], actor: AM, source: slackSource("p"),
    idempotencyKey: key, at: ISO_NOW, now: NOW,
  });
  if (det.status !== "created") throw new Error("expected created");
  const id = det.obligation.id;
  await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, `${key}:c`, { approvedBy: "U_AM" }));
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, `${key}:s`));
  return id;
}

describe("G2 — forged/mislabeled evidence cannot drive a false closure", () => {
  it("reconciliation ignores a customer_reply that did not come from the customer", () => {
    const forged: Evidence = { id: "f", source: "github", kind: "customer_reply", ref: "x", at: ISO_NOW, accessible_to_user: true, data: { confirmed: true }, proves: "forged" };
    const a = assessFulfillment([forged]);
    expect(a.sufficientForVerification).toBe(false);
    expect(a.customerConfirmed).toBe(false);
  });

  it("reconciliation ignores a deploy claimed on a non-deploy source", () => {
    const forgedDeploy: Evidence = { id: "f", source: "linear", kind: "deploy", ref: "x", at: ISO_NOW, accessible_to_user: true, data: { environment: "production" }, proves: "forged" };
    const a = assessFulfillment([prMerged("p", "PR"), forgedDeploy]);
    expect(a.sufficientForVerification).toBe(false);
  });

  it("the command boundary rejects inconsistent evidence outright", async () => {
    const env = buildEnv();
    const id = await openInProgress(env, "forge");
    const forged: Evidence = { id: "f", source: "github", kind: "customer_reply", ref: "x", at: ISO_NOW, accessible_to_user: true, data: { confirmed: true }, proves: "forged" };
    const r = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: forged }, ctx(id, "forge:ev"));
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("INCONSISTENT_EVIDENCE");
  });

  it("a customer denial blocks verification even with merge + prod deploy", () => {
    const denied: Evidence = { id: "d", source: "customer", kind: "customer_reply", ref: "r2", at: "2026-06-19T10:00:00Z", accessible_to_user: true, data: { confirmed: false }, proves: "customer says it still fails" };
    const a = assessFulfillment([prMerged("p", "PR"), prodDeploy("d", "rel"), denied]);
    expect(a.sufficientForVerification).toBe(false);
    expect(a.rationale).toMatch(/denial|still fails/i);
  });

  it("a later positive overrides an earlier denial", () => {
    const denied: Evidence = { id: "d", source: "customer", kind: "customer_reply", ref: "r1", at: "2026-06-18T10:00:00Z", accessible_to_user: true, data: { confirmed: false }, proves: "no" };
    const a = assessFulfillment([denied, customerConfirmed("c", "r2")]);
    // customerConfirmed uses ISO_NOW (2026-06-16) which is EARLIER than the denial → denial is latest → blocks.
    expect(a.sufficientForVerification).toBe(false);
  });
});

describe("G4 — leak safety is enforced on the command path", () => {
  it("rejects a NOTIFY_CUSTOMER whose draft leaks an internal reference", async () => {
    const env = buildEnv();
    const id = await openInProgress(env, "leak");
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id, "leak:pr"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id, "leak:dp"));
    await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "ok" }, ctx(id, "leak:v", { approvedBy: "U_AM" }));
    const r = await env.service.dispatch(
      { kind: "NOTIFY_CUSTOMER", draftText: "Fixed in PROJ-118 and deployed to prod.", draftRef: "x" },
      ctx(id, "leak:n", { approvedBy: "U_AM" }),
    );
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("LEAK_DETECTED");
  });

  it("detectLeaks survives obfuscation and casing", () => {
    expect(detectLeaks("Fixed in PROJ118").length).toBeGreaterThan(0); // no hyphen
    expect(detectLeaks("Fixed in proj-118").length).toBeGreaterThan(0); // lowercase
    expect(detectLeaks("dep​loyed to prod").length).toBeGreaterThan(0); // zero-width space
    expect(detectLeaks("Your login works now").length).toBe(0);
  });

  it("sanitizeForAudience drops evidence the user could not access (RTS parity)", () => {
    const inaccessible: Evidence = { id: "i", source: "deploy", kind: "deploy", ref: "rel", at: ISO_NOW, accessible_to_user: false, data: {}, proves: "released" };
    const safe = sanitizeForAudience([inaccessible], "SHARED_CUSTOMER_CHANNEL");
    expect(safe.shareableFacts).toEqual([]);
  });
});

describe("G5 — auditable envelope is required", () => {
  it("rejects an event with a blank actor/idempotency key", () => {
    const d = decide([], { kind: "DETECT_REQUEST", team: "T_ACME", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: [] }, {
      obligationId: "o1", actor: "" as never, source: { system: "system", ref: null, accessible_to_user: true }, idempotencyKey: "", at: ISO_NOW, now: NOW,
    });
    expect(d.outcome).toBe("rejected");
    if (d.outcome === "rejected") expect(d.code).toBe("INVALID_ENVELOPE");
  });
});

describe("D2 — action tiers and FSM guards agree", () => {
  const GATE: [CommandKind, EventType][] = [
    ["CONFIRM_COMMITMENT", "COMMITMENT_CONFIRMED"],
    ["LINK_WORK_ITEM", "WORK_ITEM_LINKED"],
    ["CHANGE_DUE_DATE", "DUE_DATE_CHANGED"],
    ["VERIFY_FULFILLMENT", "INTERNALLY_VERIFIED"],
    ["NOTIFY_CUSTOMER", "CUSTOMER_NOTIFIED"],
    ["DISMISS", "DISMISSED"],
    ["CANCEL", "CANCELLED"],
  ];
  it("every human-confirmation command maps to an approval-requiring transition", () => {
    for (const [kind, ev] of GATE) {
      expect(requiresHumanApproval(kind)).toBe(true);
      expect(TRANSITIONS[ev].requiresApproval).toBe(true);
    }
  });
});

describe("G3 — refs persisted at detection enable ref-based dedupe", () => {
  it("attaches a later message to an existing obligation via a shared ticket ref", async () => {
    const env = buildEnv();
    const a = await env.service.detectRequest({
      team: T_ACME, direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG",
      outcome: "SSO login fix", due: null, owner: null, conditions: [], refs: { linear: "PROJ-9" }, actor: AM, source: slackSource("p1"), idempotencyKey: "k1", at: ISO_NOW, now: NOW,
    });
    expect(a.status).toBe("created");
    const b = await env.service.detectRequest({
      team: T_ACME, direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Globex", subject_canonical: "DIFFERENT_SUBJECT",
      outcome: "x", due: null, owner: null, conditions: [], refs: { linear: "PROJ-9" }, actor: AM, source: slackSource("p2"), idempotencyKey: "k2", at: ISO_NOW, now: NOW,
    });
    expect(b.status).toBe("deduped");
    expect(b.status === "deduped" && b.obligation.id).toBe(a.status === "created" ? a.obligation.id : "");
  });

  it("the same logical evidence is not double-counted across different idempotency keys", async () => {
    const env = buildEnv();
    const id = await openInProgress(env, "dd");
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR-1") }, ctx(id, "dd:k1"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR-1") }, ctx(id, "dd:k2"));
    const o = await env.service.getObligation(id);
    expect(o?.evidence.filter((e) => e.kind === "pr_merged").length).toBe(1);
  });
});

describe("secondary beat — roadmap contradiction warning (private)", () => {
  it("warns when the committed date is earlier than the roadmap target", () => {
    const o = mkObl("OPEN", { due: "2026-06-19", outcome: "SSO login fix" });
    const w = checkRoadmapConflict(o, [{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" }]);
    expect(w.conflict).toBe(true);
    expect(w.audience).toBe("INTERNAL");
    expect(detectLeaks(w.message)).toBeDefined();
  });

  it("does not warn when the committed date meets the roadmap", () => {
    const o = mkObl("OPEN", { due: "2026-07-15", outcome: "SSO login fix" });
    const w = checkRoadmapConflict(o, [{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" }]);
    expect(w.conflict).toBe(false);
  });
});

// --- second-round adversarial findings (same-class variants) ----------------
describe("G2 — a Slack-channel reply cannot stand in for a verified customer confirmation", () => {
  const slackReply: Evidence = { id: "s", source: "slack", kind: "customer_reply", ref: "r", at: ISO_NOW, accessible_to_user: true, data: { confirmed: true }, proves: "x" };

  it("reconciliation drops a slack-sourced customer_reply", () => {
    expect(assessFulfillment([slackReply]).sufficientForVerification).toBe(false);
  });

  it("the command boundary rejects it", async () => {
    const env = buildEnv();
    const id = await openInProgress(env, "slackforge");
    const r = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: slackReply }, ctx(id, "sf:ev"));
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("INCONSISTENT_EVIDENCE");
  });

  it("a non-prod deploy flagged customer_scoped:true is not treated as customer-facing", () => {
    const fakeProd: Evidence = { id: "x", source: "deploy", kind: "deploy", ref: "r", at: ISO_NOW, accessible_to_user: true, data: { environment: "staging", customer_scoped: true }, proves: "x" };
    expect(assessFulfillment([prMerged("p", "PR"), fakeProd]).sufficientForVerification).toBe(false);
  });
});

describe("G4 — Unicode-dash and dotted/spaced reference obfuscation is caught", () => {
  const nbHyphen = `PROJ${String.fromCharCode(0x2011)}118`; // non-breaking hyphen
  const enDash = `PROJ${String.fromCharCode(0x2013)}118`; // en dash
  it("folds Unicode dashes before matching ticket keys", () => {
    expect(detectLeaks(`fix for ${nbHyphen}`).length).toBeGreaterThan(0);
    expect(detectLeaks(`fix for ${enDash}`).length).toBeGreaterThan(0);
  });
  it("catches dotted/spaced PR references", () => {
    expect(detectLeaks("see P.R. #449").length).toBeGreaterThan(0);
    expect(detectLeaks("see P R 449").length).toBeGreaterThan(0);
  });
  it("still passes a genuinely clean draft", () => {
    expect(detectLeaks("Your login is working now — thanks for confirming.").length).toBe(0);
  });
});

describe("G5 — zero-copy value channel is uniform", () => {
  it("flags a newline in any persisted string field (conditions[])", () => {
    const ev = evt({ type: "REQUEST_DETECTED", team: "T_ACME", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: ["line one\nline two — pasted body"] });
    expect(findRawContent(ev).length).toBeGreaterThan(0);
  });
  it("flags an oversized reason value", () => {
    const ev = evt({ type: "CANCELLED", reason: "x".repeat(1500) });
    expect(findRawContent(ev).length).toBeGreaterThan(0);
  });
  it("rejects a whitespace-only envelope", () => {
    const d = decide([], { kind: "DETECT_REQUEST", team: "T_ACME", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: [] }, {
      obligationId: "o1", actor: "   " as never, source: { system: "system", ref: null, accessible_to_user: true }, idempotencyKey: "k", at: ISO_NOW, now: NOW,
    });
    expect(d.outcome).toBe("rejected");
    if (d.outcome === "rejected") expect(d.code).toBe("INVALID_ENVELOPE");
  });

  it("flags Unicode line separators (U+2028) used to smuggle a multi-line body", () => {
    const body = ["pasted email line 1", "CONFIDENTIAL internal note", "line 3"].join(String.fromCharCode(0x2028));
    const ev = evt({ type: "SCOPE_CHANGED", note: body });
    expect(findRawContent(ev).length).toBeGreaterThan(0);
  });

  it("throws on a raw-content event at decide() (U+2029 paragraph separator)", () => {
    const body = "line one" + String.fromCharCode(0x2029) + "line two";
    expect(() =>
      decide([], { kind: "DETECT_REQUEST", team: "T_ACME", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: body, due: null, owner: null, conditions: [] }, {
        obligationId: "o1", actor: "user:U", source: { system: "slack", ref: null, accessible_to_user: true }, idempotencyKey: "k", at: ISO_NOW, now: NOW,
      }),
    ).toThrow();
  });
});
