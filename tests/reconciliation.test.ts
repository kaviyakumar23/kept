import { describe, it, expect } from "vitest";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { ticketDone, prMerged, prodDeploy, stagingDeploy, customerConfirmed, featureFlag, ciRun, statusPage } from "../src/eval/scenarios.js";

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

  // W4 — Proof-of-Done gates the merge+deploy lane.
  it("merge + prod deploy but flag OFF is BLOCKED (blocking negative)", () => {
    const a = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel"), featureFlag("f", "flag@t", false)]);
    expect(a.available).toBe(false);
    expect(a.sufficientForVerification).toBe(false);
    expect(a.rationale).toContain("OFF");
  });

  it("merge + prod deploy + flag ON is sufficient and MORE confident than without proof", () => {
    const base = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel")]);
    const withFlag = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel"), featureFlag("f", "flag@t", true)]);
    expect(withFlag.available).toBe(true);
    expect(withFlag.sufficientForVerification).toBe(true);
    expect(withFlag.confidence).toBeGreaterThan(base.confidence);
  });

  it("merge + prod deploy but CI failed falls through to progress (not available)", () => {
    const a = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel"), ciRun("c", "app#1@t", "failure")]);
    expect(a.available).toBe(false);
    expect(a.sufficientForVerification).toBe(false);
    expect(a.rationale).toContain("CI");
  });

  it("merge + prod deploy but status page degraded falls through to progress", () => {
    const a = assessFulfillment([prMerged("p", "PR-1"), prodDeploy("d", "rel"), statusPage("s", "api@t", "degraded")]);
    expect(a.available).toBe(false);
    expect(a.sufficientForVerification).toBe(false);
  });

  it("the LATEST flag observation wins (OFF→ON→OFF ⇒ OFF blocks)", () => {
    const a = assessFulfillment([
      prMerged("p", "PR-1"),
      prodDeploy("d", "rel"),
      featureFlag("f1", "flag@t1", false, "2026-06-18T10:00:00Z"),
      featureFlag("f2", "flag@t2", true, "2026-06-18T11:00:00Z"),
      featureFlag("f3", "flag@t3", false, "2026-06-18T12:00:00Z"),
    ]);
    expect(a.available).toBe(false);
    expect(a.rationale).toContain("OFF");
  });
});
