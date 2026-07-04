import { describe, it, expect } from "vitest";
import { project } from "../src/domain/projection.js";
import { evt, TS } from "./helpers.js";
import type { ObligationEvent } from "../src/domain/events.js";

const NOW = Date.parse("2026-06-16T12:00:00Z");

const request = (over = {}): ObligationEvent =>
  evt(
    { type: "REQUEST_DETECTED", team: "T_ACME", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix", due: "2026-06-19", owner: null, conditions: [] },
    over,
  );

describe("projection (C2/C3)", () => {
  it("derives CANDIDATE from a single REQUEST_DETECTED", () => {
    const o = project([request()], { now: NOW });
    expect(o.state).toBe("CANDIDATE");
    expect(o.customer).toBe("Acme");
    expect(o.history_count).toBe(1);
  });

  it("folds the log into the current state and counts state transitions", () => {
    const log = [
      request(),
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, { approved_by: "U_AM" }),
      evt({ type: "WORK_STARTED" }),
    ];
    const o = project(log, { now: NOW });
    expect(o.state).toBe("IN_PROGRESS");
    expect(o.owner).toBe("U_ENG");
    expect(o.state_version).toBe(3); // REQUEST_DETECTED, COMMITMENT_CONFIRMED, WORK_STARTED
  });

  it("supersession: a later due date wins, history retained in the log", () => {
    const log = [
      request({}),
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: "2026-06-19", owner: "U_ENG" }, { approved_by: "U_AM" }),
      evt({ type: "DUE_DATE_CHANGED", from: "2026-06-19", to: "2026-06-26" }, { approved_by: "U_AM" }),
    ];
    const o = project(log, { now: NOW });
    expect(o.due).toBe("2026-06-26");
    expect(log.filter((e) => e.type === "DUE_DATE_CHANGED")).toHaveLength(1);
  });

  it("derived flags: overdue and at-risk are conditions, not states", () => {
    const open = [request(), evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: "2026-06-19", owner: "U" }, { approved_by: "U_AM" })];
    // 5 days before due → at risk window (24h) not yet entered
    const early = project(open, { now: Date.parse("2026-06-14T12:00:00Z") });
    expect(early.flags.is_at_risk).toBe(false);
    expect(early.flags.is_overdue).toBe(false);
    // 12h before due → at risk
    const atRisk = project(open, { now: Date.parse("2026-06-18T18:00:00Z") });
    expect(atRisk.flags.is_at_risk).toBe(true);
    // after due → overdue
    const overdue = project(open, { now: Date.parse("2026-06-20T12:00:00Z") });
    expect(overdue.flags.is_overdue).toBe(true);
    expect(overdue.state).toBe("OPEN"); // still OPEN — overdue is a flag, not a state
  });

  it("needs_clarification flag reflects the latest flag/clear event", () => {
    const base = [request()];
    expect(project([...base, evt({ type: "CLARIFICATION_FLAGGED" })], { now: NOW }).flags.needs_clarification).toBe(true);
    expect(
      project([...base, evt({ type: "CLARIFICATION_FLAGGED" }), evt({ type: "CLARIFICATION_CLEARED" })], { now: NOW }).flags
        .needs_clarification,
    ).toBe(false);
  });

  it("scope-change flag is set by the SCOPE_CHANGED event", () => {
    const log = [
      request(),
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: "2026-06-19", owner: "U" }, { approved_by: "U_AM" }),
      evt({ type: "SCOPE_CHANGED", note: "now also covers SCIM" }),
    ];
    expect(project(log, { now: NOW }).flags.has_scope_change).toBe(true);
  });

  it("throws on a log not starting with REQUEST_DETECTED", () => {
    expect(() => project([evt({ type: "WORK_STARTED" })], { now: NOW })).toThrow();
  });
});
