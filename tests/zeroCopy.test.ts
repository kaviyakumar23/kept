import { describe, it, expect } from "vitest";
import { assertNoRawContent, findRawContent } from "../src/domain/zeroCopy.js";
import { GuardViolation } from "../src/domain/errors.js";
import { evt } from "./helpers.js";

describe("zero-copy guard (correction #3)", () => {
  it("accepts events with only derived structured fields", () => {
    const e = evt({
      type: "REQUEST_DETECTED",
      direction: "TEAM_OWES_CUSTOMER",
      signal: "CUSTOMER_REQUEST",
      customer: "Acme",
      subject_canonical: "SSO_LOGIN_BUG",
      outcome: "SSO login fix",
      due: "2026-06-19",
      owner: null,
      conditions: [],
    });
    expect(findRawContent(e)).toEqual([]);
    expect(() => assertNoRawContent(e)).not.toThrow();
  });

  it("rejects an event carrying a raw message body", () => {
    const e = evt({
      type: "REQUEST_DETECTED",
      direction: "TEAM_OWES_CUSTOMER",
      signal: "CUSTOMER_REQUEST",
      customer: "Acme",
      subject_canonical: "SSO_LOGIN_BUG",
      outcome: "SSO login fix",
      due: null,
      owner: null,
      conditions: [],
    });
    // Simulate a leak of raw content into the durable log.
    (e as unknown as Record<string, unknown>).message_text = "Can you fix the SSO bug by Friday?";
    expect(findRawContent(e).length).toBeGreaterThan(0);
    expect(() => assertNoRawContent(e)).toThrow(GuardViolation);
  });

  it("detects raw content nested inside evidence data", () => {
    const e = evt({
      type: "FULFILLMENT_SIGNAL_DETECTED",
      evidence: {
        id: "x",
        source: "github",
        kind: "pr_merged",
        ref: "PR-1",
        at: "2026-06-18T00:00:00Z",
        accessible_to_user: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: { merged: true, raw: "secret transcript" } as any,
        proves: "merged",
      },
    });
    expect(findRawContent(e).length).toBeGreaterThan(0);
  });
});
