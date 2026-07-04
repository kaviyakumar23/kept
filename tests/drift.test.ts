import { describe, it, expect } from "vitest";
import type { ObligationEvent } from "../src/domain/events.js";
import type { ObligationSignal } from "../src/domain/signals.js";
import { project } from "../src/domain/projection.js";
import { driftFromEvents, driftForObligation, driftRadar } from "../src/app/drift.js";
import { answerLedgerQuery } from "../src/app/assistantQuery.js";
import { evt } from "./helpers.js";

const NOW = Date.parse("2026-07-04T12:00:00Z");

const detected = (signal: ObligationSignal, due: string | null, at: string): ObligationEvent =>
  evt(
    {
      type: "REQUEST_DETECTED",
      team: "T_ACME",
      direction: "TEAM_OWES_CUSTOMER",
      signal,
      customer: "Acme",
      subject_canonical: "SSO_LOGIN_BUG",
      outcome: "SSO login fix",
      due,
      owner: "U_ENG",
      conditions: [],
    },
    { at },
  );
const confirmed = (due: string, at: string): ObligationEvent =>
  evt({ type: "COMMITMENT_CONFIRMED", outcome: "SSO login fix", due, owner: "U_ENG" }, { at, approved_by: "U_AM" });
const slip = (from: string, to: string, at: string): ObligationEvent =>
  evt({ type: "DUE_DATE_CHANGED", from, to }, { at, approved_by: "U_AM" });
const scope = (at: string): ObligationEvent => evt({ type: "SCOPE_CHANGED", note: "added SSO for admins" }, { at });

// A confirmed promise whose date slipped twice and then went silent past the (moved) deadline.
const STALLED_LOG: ObligationEvent[] = [
  detected("CONFIRMED_COMMITMENT", "2026-06-19", "2026-06-10T00:00:00Z"),
  confirmed("2026-06-19", "2026-06-11T00:00:00Z"),
  slip("2026-06-19", "2026-06-24", "2026-06-18T00:00:00Z"),
  slip("2026-06-24", "2026-06-28", "2026-06-23T00:00:00Z"),
];

// A confirmed promise that softened (two slips + a scope change) but is NOT yet overdue.
const SOFTENED_LOG: ObligationEvent[] = [
  detected("CONFIRMED_COMMITMENT", "2026-07-20", "2026-06-28T00:00:00Z"),
  confirmed("2026-07-20", "2026-06-29T00:00:00Z"),
  slip("2026-07-20", "2026-07-25", "2026-06-30T00:00:00Z"),
  slip("2026-07-25", "2026-07-30", "2026-07-01T00:00:00Z"),
  scope("2026-07-01T00:00:00Z"),
];

// A confirmed promise, comfortably in the future, freshly updated — firm.
const FIRM_LOG: ObligationEvent[] = [
  detected("CONFIRMED_COMMITMENT", "2026-07-20", "2026-07-03T00:00:00Z"),
  confirmed("2026-07-20", "2026-07-04T00:00:00Z"),
];

describe("driftFromEvents — temporal certainty decay over the ordered log", () => {
  it("a confirmed promise that slipped twice and went silent past due → STALLED", () => {
    const d = driftFromEvents(STALLED_LOG, NOW);
    expect(d.bucket).toBe("STALLED");
    expect(d.score).toBeGreaterThan(0.9);
    expect(d.softening).toBe(true);
    expect(d.overdueWithoutUpdate).toBe(true);
    expect(d.slips).toBe(2);
    expect(d.daysOverdue).toBe(6); // due 2026-06-28 → now 2026-07-04
    expect(d.reasons.join(" ")).toMatch(/overdue .*no update/);
  });

  it("softened (CONFIRMED → slipped ×2 → scope change) but not yet overdue → drifting, not overdue", () => {
    const d = driftFromEvents(SOFTENED_LOG, NOW);
    expect(d.softening).toBe(true);
    expect(d.slips).toBe(2);
    expect(d.overdueWithoutUpdate).toBe(false);
    expect(d.bucket === "SLIPPING" || d.bucket === "SOFTENING").toBe(true);
    // Certainty genuinely decayed from its peak (a strictly lower latest ⇒ real softening).
    expect(d.score).toBeGreaterThan(0.3);
  });

  it("a fresh, confirmed, future-dated promise → FIRM (no drift)", () => {
    const d = driftFromEvents(FIRM_LOG, NOW);
    expect(d.bucket).toBe("FIRM");
    expect(d.score).toBe(0);
    expect(d.softening).toBe(false);
    expect(d.slips).toBe(0);
  });

  it("is deterministic and does not mutate the event log (pure read-model)", () => {
    const before = JSON.stringify(STALLED_LOG);
    const a = driftFromEvents(STALLED_LOG, NOW);
    const b = driftFromEvents(STALLED_LOG, NOW);
    expect(a).toEqual(b);
    expect(JSON.stringify(STALLED_LOG)).toBe(before); // no persistence, no mutation
  });

  it("terminal / candidate obligations do not drift", () => {
    const candidate = [detected("CONFIRMED_COMMITMENT", "2026-06-19", "2026-06-10T00:00:00Z")];
    const d = driftFromEvents(candidate, NOW);
    expect(d.live).toBe(false);
    expect(d.bucket).toBe("FIRM");
    expect(d.score).toBe(0);
  });
});

describe("driftForObligation — projection-based path used by the ledger surfaces", () => {
  it("flags an overdue, silent confirmed commitment as drifting", () => {
    const o = project(STALLED_LOG, { now: NOW });
    const d = driftForObligation(o, NOW);
    expect(d.live).toBe(true);
    expect(d.overdueWithoutUpdate).toBe(true);
    expect(d.bucket === "STALLED" || d.bucket === "SLIPPING").toBe(true);
  });
});

describe("driftRadar + Assistant 'what's slipping?'", () => {
  const obligations = [project(STALLED_LOG, { now: NOW }), project(FIRM_LOG, { now: NOW })];

  it("driftRadar surfaces only drifting live commitments, worst first", () => {
    const radar = driftRadar(obligations, NOW);
    expect(radar.counts.drifting).toBe(1);
    expect(radar.readings[0]!.outcome).toBe("SSO login fix");
    expect(radar.readings[0]!.bucket === "STALLED" || radar.readings[0]!.bucket === "SLIPPING").toBe(true);
  });

  it("answers 'what's slipping?' from the ledger — lists the drifting promise with its reason", () => {
    const ans = answerLedgerQuery({ intent: "slipping", customer: null, mine: false }, obligations, NOW);
    const text = JSON.stringify(ans.blocks);
    expect(ans.text).toBe("What's slipping");
    expect(text).toContain("SSO login fix");
    expect(text).toMatch(/overdue/);
  });

  it("says nothing is slipping when every commitment is firm", () => {
    const ans = answerLedgerQuery({ intent: "slipping", customer: null, mine: false }, [project(FIRM_LOG, { now: NOW })], NOW);
    expect(JSON.stringify(ans.blocks)).toContain("Nothing is drifting");
  });
});
