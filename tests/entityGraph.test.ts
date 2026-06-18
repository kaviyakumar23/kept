import { describe, it, expect } from "vitest";
import { resolve } from "../src/engine/entityGraph.js";
import { mkObl } from "./helpers.js";

describe("entity resolution & semantic dedupe (C4/C6)", () => {
  const sso = mkObl("IN_PROGRESS", {
    id: "obl_sso",
    customer: "Acme",
    subject_canonical: "SSO_LOGIN_BUG",
    entity_refs: { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", linear: "PROJ-118", github: "PR-449" },
  });
  const other = mkObl("OPEN", {
    id: "obl_export",
    customer: "Acme",
    subject_canonical: "EXPORT_FEATURE",
    entity_refs: { customer: "Acme", subject_canonical: "EXPORT_FEATURE" },
  });

  it("matches on an exact cross-system ref (linear)", () => {
    const m = resolve({ customer: "Globex", subject_canonical: "WHATEVER", refs: { linear: "PROJ-118" } }, [other, sso]);
    expect(m?.id).toBe("obl_sso");
  });

  it("matches on customer + canonical subject (semantic dedupe)", () => {
    // "any update on that login issue?" → same canonical subject.
    const m = resolve({ customer: "acme", subject_canonical: "sso_login_bug" }, [sso, other]);
    expect(m?.id).toBe("obl_sso");
  });

  it("does not match a different subject", () => {
    expect(resolve({ customer: "Acme", subject_canonical: "BILLING_BUG" }, [sso, other])).toBeNull();
  });

  it("does not attach to a terminal obligation", () => {
    const closed = mkObl("CLOSED", { id: "c", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", entity_refs: { customer: "Acme", subject_canonical: "SSO_LOGIN_BUG" } });
    expect(resolve({ customer: "Acme", subject_canonical: "SSO_LOGIN_BUG" }, [closed])).toBeNull();
  });
});
