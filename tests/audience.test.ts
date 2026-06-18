import { describe, it, expect } from "vitest";
import { sanitizeForAudience, buildClosureDraft, detectLeaks } from "../src/policy/audience.js";
import { mkObl } from "./helpers.js";
import { ticketDone, prMerged, prodDeploy } from "../src/eval/scenarios.js";

describe("audience policy (D1)", () => {
  const evidence = [ticketDone("t", "PROJ-118"), prMerged("p", "PR-449"), prodDeploy("d", "2026.06.18")];

  it("INTERNAL audience sees everything", () => {
    const safe = sanitizeForAudience(evidence, "INTERNAL");
    expect(safe.redactedCount).toBe(0);
    expect(safe.shareableFacts.length).toBe(evidence.length);
  });

  it("SHARED_CUSTOMER_CHANNEL redacts internal-only sources", () => {
    const safe = sanitizeForAudience(evidence, "SHARED_CUSTOMER_CHANNEL");
    // linear + github are internal-only; deploy is operational but its `proves`
    // text trips the leak filter, so the shared fact list is conservative.
    expect(safe.redactedSources).toContain("linear");
    expect(safe.redactedSources).toContain("github");
    expect(safe.redactedCount).toBeGreaterThanOrEqual(2);
  });

  it("closure draft is built only from the shareable outcome and is leak-free", () => {
    const o = mkObl("VERIFIED", { outcome: "SSO login fix", evidence });
    const draft = buildClosureDraft(o);
    expect(draft.clean).toBe(true);
    expect(detectLeaks(draft.text)).toEqual([]);
    expect(draft.text).toContain("SSO login fix");
  });

  it("leak detector catches internal references", () => {
    expect(detectLeaks("Fixed in PROJ-118").length).toBeGreaterThan(0);
    expect(detectLeaks("Merged PR #449 and deployed").length).toBeGreaterThan(0);
    expect(detectLeaks("Your login is working now").length).toBe(0);
  });
});
