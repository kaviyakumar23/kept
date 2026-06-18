import { describe, it, expect } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRoadmapSource, StaticRoadmapSource } from "../src/policy/roadmap.js";

describe("roadmap sources", () => {
  it("StaticRoadmapSource returns its entries", async () => {
    const src = new StaticRoadmapSource([{ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" }]);
    expect(await src.list()).toHaveLength(1);
  });

  it("FileRoadmapSource reads and validates a JSON file (drops malformed rows)", async () => {
    const path = join(tmpdir(), `kept-roadmap-${Date.now()}.json`);
    await writeFile(
      path,
      JSON.stringify([
        { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" },
        { bad: "entry" },
        { customer: "Globex", subject_canonical: "BILLING", targetDate: "2026-07-15" },
      ]),
    );
    try {
      const all = await new FileRoadmapSource(path).list();
      expect(all).toEqual([
        { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", targetDate: "2026-06-30" },
        { customer: "Globex", subject_canonical: "BILLING", targetDate: "2026-07-15" },
      ]);
    } finally {
      await rm(path, { force: true });
    }
  });
});
