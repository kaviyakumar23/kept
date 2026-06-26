import { describe, it, expect } from "vitest";
import type { Obligation } from "../src/domain/obligation.js";
import { emptyFlags } from "../src/domain/state.js";
import { analytics, awaitingVerifyFor, isOpen } from "../src/app/analytics.js";

const NOW = Date.parse("2026-06-26T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function obl(o: Partial<Obligation> & { id: string }): Obligation {
  return {
    state: "OPEN",
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CONFIRMED_COMMITMENT",
    customer: "Acme",
    subject_canonical: "X",
    outcome: "do x",
    due: null,
    owner: "U1",
    work_item: null,
    entity_refs: { customer: "Acme", subject_canonical: "X" },
    flags: emptyFlags(),
    evidence: [],
    conditions: [],
    history_count: 1,
    state_version: 1,
    created_at: iso(NOW),
    updated_at: iso(NOW),
    ...o,
  };
}

describe("analytics() — pure ledger read-model", () => {
  it("counts open vs total and tallies by state", () => {
    const a = analytics(
      [obl({ id: "1" }), obl({ id: "2", state: "IN_PROGRESS" }), obl({ id: "3", state: "CLOSED" }), obl({ id: "4", state: "DISMISSED" })],
      NOW,
    );
    expect(a.counts.total).toBe(4);
    expect(a.counts.open).toBe(2);
    expect(a.counts.byState.CLOSED).toBe(1);
    expect(a.counts.byState.OPEN).toBe(1);
  });

  it("uses engine flags for overdue/at-risk and excludes overdue from at-risk", () => {
    const a = analytics(
      [
        obl({ id: "1", flags: { ...emptyFlags(), is_overdue: true } }),
        obl({ id: "2", flags: { ...emptyFlags(), is_at_risk: true } }),
        obl({ id: "3", flags: { ...emptyFlags(), is_overdue: true, is_at_risk: true } }), // overdue wins
        obl({ id: "4", state: "CLOSED", flags: { ...emptyFlags(), is_overdue: true } }), // closed → not counted
      ],
      NOW,
    );
    expect(a.overdue.map((o) => o.id).sort()).toEqual(["1", "3"]);
    expect(a.atRisk.map((o) => o.id)).toEqual(["2"]);
  });

  it("surfaces POSSIBLE_FULFILLMENT as awaiting-verify, filterable per owner", () => {
    const a = analytics(
      [
        obl({ id: "1", state: "POSSIBLE_FULFILLMENT", owner: "U_AM" }),
        obl({ id: "2", state: "POSSIBLE_FULFILLMENT", owner: "U_ENG" }),
        obl({ id: "3", state: "IN_PROGRESS", owner: "U_AM" }),
      ],
      NOW,
    );
    expect(a.awaitingVerify.map((o) => o.id).sort()).toEqual(["1", "2"]);
    expect(awaitingVerifyFor(a, "U_AM").map((o) => o.id)).toEqual(["1"]);
  });

  it("flags obligations promised within the next week (open, due-dated)", () => {
    const a = analytics(
      [
        obl({ id: "soon", due: "2026-06-29" }), // +3d
        obl({ id: "later", due: "2026-07-20" }), // beyond the window
        obl({ id: "nodate", due: null }),
        obl({ id: "soon-but-closed", state: "CLOSED", due: "2026-06-29" }),
      ],
      NOW,
    );
    expect(a.promisedThisWeek.map((o) => o.id)).toEqual(["soon"]);
  });

  it("aggregates by owner and customer, sorted by overdue then open", () => {
    const a = analytics(
      [
        obl({ id: "1", owner: "U_A", customer: "Acme", flags: { ...emptyFlags(), is_overdue: true } }),
        obl({ id: "2", owner: "U_A", customer: "Acme" }),
        obl({ id: "3", owner: "U_B", customer: "Globex" }),
      ],
      NOW,
    );
    expect(a.byOwner[0]).toMatchObject({ owner: "U_A", open: 2, overdue: 1 });
    expect(a.byCustomer[0]).toMatchObject({ customer: "Acme", open: 2, overdue: 1 });
  });

  it("buckets open obligations by age and reports the oldest", () => {
    const a = analytics(
      [
        obl({ id: "new", created_at: iso(NOW) }),
        obl({ id: "wk", created_at: iso(NOW - 4 * DAY) }),
        obl({ id: "old", created_at: iso(NOW - 40 * DAY) }),
      ],
      NOW,
    );
    expect(a.aging.oldestOpenDays).toBe(40);
    expect(a.aging.buckets.find((b) => b.label === ">30d")!.count).toBe(1);
    expect(a.aging.buckets.find((b) => b.label === "2–7d")!.count).toBe(1);
  });

  it("isOpen excludes terminal states", () => {
    expect(isOpen(obl({ id: "1", state: "OPEN" }))).toBe(true);
    expect(isOpen(obl({ id: "2", state: "CANCELLED" }))).toBe(false);
  });
});
