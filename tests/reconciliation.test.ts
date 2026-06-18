import { describe, it, expect } from "vitest";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { ticketDone, prMerged, prodDeploy, stagingDeploy, customerConfirmed } from "../src/eval/scenarios.js";

describe("multi-source reconciliation (C5)", () => {
  it("ticket Done alone is NOT sufficient to verify", () => {
    const a = assessFulfillment([ticketDone("t", "PROJ-1")]);
    expect(a.available).toBe(false);
    expect(a.sufficientForVerification).toBe(false);
  });

  it("PR merged alone is NOT sufficient", () => {
    expect(assessFulfillment([prMerged("p", "PR-1")]).sufficientForVerification).toBe(false);
  });

  it("PR merged + non-customer (staging) deploy is NOT sufficient", () => {
    const a = assessFulfillment([prMerged("p", "PR-1"), stagingDeploy("s", "rel")]);
    expect(a.sufficientForVerification).toBe(false);
  });

  it("PR merged + deploy to the customer's environment IS sufficient", () => {
    const a = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel")]);
    expect(a.available).toBe(true);
    expect(a.sufficientForVerification).toBe(true);
    expect(a.customerConfirmed).toBe(false);
  });

  it("customer confirmation is the strongest signal", () => {
    const a = assessFulfillment([customerConfirmed("c", "reply-1")]);
    expect(a.available).toBe(true);
    expect(a.customerConfirmed).toBe(true);
    expect(a.confidence).toBeGreaterThan(0.9);
  });
});
