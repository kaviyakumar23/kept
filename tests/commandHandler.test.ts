import { describe, it, expect } from "vitest";
import { decide } from "../src/engine/commandHandler.js";
import type { CommandContext } from "../src/domain/commands.js";
import { evt, OBL, TS } from "./helpers.js";
import type { ObligationEvent } from "../src/domain/events.js";

const NOW = Date.parse(TS);

const baseCtx = (over: Partial<CommandContext> = {}): CommandContext => ({
  obligationId: OBL,
  actor: "system",
  source: { system: "system", ref: null, accessible_to_user: true },
  idempotencyKey: "k_unique",
  at: TS,
  approvedBy: null,
  now: NOW,
  ...over,
});

const candidate = (): ObligationEvent[] => [
  evt({ type: "REQUEST_DETECTED", direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix", due: "2026-06-19", owner: null, conditions: [] }, { idempotency_key: "req" }),
];

describe("decide() — the LLM-proposes / engine-decides core", () => {
  it("emits an event for a valid, approved Gate 1 commitment", () => {
    const d = decide(candidate(), { kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, baseCtx({ approvedBy: "U_AM" }));
    expect(d.outcome).toBe("emit");
    if (d.outcome === "emit") {
      expect(d.events[0].type).toBe("COMMITMENT_CONFIRMED");
      expect(d.events[0].approved_by).toBe("U_AM");
    }
  });

  it("rejects an unapproved Gate 1 commitment", () => {
    const d = decide(candidate(), { kind: "CONFIRM_COMMITMENT", outcome: "o", due: null, owner: "U_ENG" }, baseCtx());
    expect(d).toMatchObject({ outcome: "rejected", code: "APPROVAL_REQUIRED" });
  });

  it("suppresses a command whose idempotency key is already applied", () => {
    const events = candidate();
    const d = decide(events, { kind: "START_WORK" }, baseCtx({ idempotencyKey: "req" }));
    expect(d.outcome).toBe("suppressed");
  });

  it("rejects an illegal transition (verify from CANDIDATE)", () => {
    const d = decide(candidate(), { kind: "VERIFY_FULFILLMENT", rationale: "x" }, baseCtx({ approvedBy: "U_AM" }));
    expect(d).toMatchObject({ outcome: "rejected" });
  });

  it("blocks verification when reconciled evidence is insufficient", () => {
    // Build a POSSIBLE_FULFILLMENT obligation backed only by a Done ticket.
    const events: ObligationEvent[] = [
      ...candidate(),
      evt({ type: "COMMITMENT_CONFIRMED", outcome: "o", due: "2026-06-19", owner: "U_ENG" }, { approved_by: "U_AM", idempotency_key: "c" }),
      evt({ type: "WORK_STARTED" }, { idempotency_key: "s" }),
      evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: { id: "t", source: "linear", kind: "ticket_status", ref: "PROJ-1", at: TS, accessible_to_user: true, data: { status: "Done" }, proves: "done" } }, { idempotency_key: "f" }),
    ];
    const d = decide(events, { kind: "VERIFY_FULFILLMENT", rationale: "x" }, baseCtx({ approvedBy: "U_AM", idempotencyKey: "v" }));
    expect(d).toMatchObject({ outcome: "rejected", code: "INSUFFICIENT_EVIDENCE" });
  });
});
