import { describe, it, expect } from "vitest";
import { canApply } from "../src/domain/stateMachine.js";
import { evt, mkObl } from "./helpers.js";

describe("guarded state machine (C7)", () => {
  it("creation: REQUEST_DETECTED only from no obligation", () => {
    const create = evt({ type: "REQUEST_DETECTED", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "X", outcome: "o", due: null, owner: null, conditions: [] });
    expect(canApply(null, create).ok).toBe(true);
    expect(canApply(mkObl("CANDIDATE"), create)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("Gate 1: CONFIRM requires approval and CANDIDATE state", () => {
    const confirm = (approved: boolean) =>
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: null, owner: "U_ENG" }, approved ? { approved_by: "U_AM" } : {});
    expect(canApply(mkObl("CANDIDATE"), confirm(true))).toMatchObject({ ok: true, to: "OPEN" });
    expect(canApply(mkObl("CANDIDATE"), confirm(false))).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(canApply(mkObl("OPEN"), confirm(true))).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
  });

  it("Gate 2: INTERNALLY_VERIFIED needs both approval and sufficient evidence", () => {
    const verify = evt({ type: "INTERNALLY_VERIFIED", rationale: "r" }, { approved_by: "U_AM" });
    const from = mkObl("POSSIBLE_FULFILLMENT");
    expect(canApply(from, verify, { evidenceSufficient: true })).toMatchObject({ ok: true, to: "VERIFIED" });
    expect(canApply(from, verify, { evidenceSufficient: false })).toMatchObject({ ok: false, code: "INSUFFICIENT_EVIDENCE" });
    const noApproval = evt({ type: "INTERNALLY_VERIFIED", rationale: "r" });
    expect(canApply(from, noApproval, { evidenceSufficient: true })).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
  });

  it("closing path is strict: notify needs VERIFIED, close needs CUSTOMER_NOTIFIED", () => {
    const notify = evt({ type: "CUSTOMER_NOTIFIED", draft_ref: null }, { approved_by: "U_AM" });
    expect(canApply(mkObl("IN_PROGRESS"), notify)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(canApply(mkObl("VERIFIED"), notify)).toMatchObject({ ok: true, to: "CUSTOMER_NOTIFIED" });

    const confirm = evt({ type: "CUSTOMER_CONFIRMED" });
    expect(canApply(mkObl("VERIFIED"), confirm)).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(canApply(mkObl("CUSTOMER_NOTIFIED"), confirm)).toMatchObject({ ok: true, to: "CLOSED" });
  });

  it("REOPENED is allowed from CLOSED and routes back to IN_PROGRESS", () => {
    const reopen = evt({ type: "REOPENED", reason: "still fails" });
    expect(canApply(mkObl("CLOSED"), reopen)).toMatchObject({ ok: true, to: "REOPENED" });
    const start = evt({ type: "WORK_STARTED" });
    expect(canApply(mkObl("REOPENED"), start)).toMatchObject({ ok: true, to: "IN_PROGRESS" });
  });

  it("consequential edits require approval (due-date change, cancel)", () => {
    const change = evt({ type: "DUE_DATE_CHANGED", from: null, to: "2026-07-01" });
    expect(canApply(mkObl("IN_PROGRESS"), change)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const cancel = evt({ type: "CANCELLED", reason: "withdrawn" });
    expect(canApply(mkObl("OPEN"), cancel)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
  });
});
