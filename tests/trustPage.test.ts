import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { InMemoryTrustLinkStore } from "../src/store/trustLinkStore.js";
import { ObligationService, type DetectInput } from "../src/engine/obligationService.js";
import { SimulatedLinearAdapter } from "../src/integrations/linear.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { buildTrustView } from "../src/app/trustView.js";
import {
  renderTrustPage,
  renderTrustNotFound,
  handleTrustRequest,
  TrustRateLimiter,
} from "../src/server/trustPage.js";
import {
  AM,
  NOW,
  ISO_NOW,
  slackSource,
  heuristicResponder,
  ticketDone,
  prMerged,
  featureFlag,
  ciRun,
  statusPage,
} from "../src/eval/scenarios.js";
import { mkObl } from "./helpers.js";

/**
 * W6 — the customer trust page. It is a NEW SURFACE over the SAME D1 audience gate
 * (invariant #5) and it is absolutely tenant/customer-scoped (invariant #4). These are
 * the acceptance cases: a leaky outcome renders generic; a token reads only its own
 * (team, customer); internal-only evidence never surfaces; a revoked/unknown token 404s.
 */

const T_A = "T_ALPHA";
const T_B = "T_BETA";

async function seedOpen(
  service: ObligationService,
  orch: KeptOrchestrator,
  team: string,
  over: Partial<DetectInput> & { customer: string; subject_canonical: string; outcome: string; idempotencyKey: string },
) {
  const det = await service.detectRequest({
    team,
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CUSTOMER_REQUEST",
    due: "2026-06-30",
    owner: null,
    conditions: [],
    actor: AM,
    source: slackSource("p"),
    at: ISO_NOW,
    now: NOW,
    ...over,
  });
  if (det.status !== "created") throw new Error(`expected created, got ${det.status}`);
  // Gate 1 → OPEN, so the commitment is displayable on the trust page.
  await orch.confirmCommitment(det.obligation.id, "U_AM");
  return det.obligation;
}

function buildStack() {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const trustLinks = new InMemoryTrustLinkStore();
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: new SimulatedLinearAdapter({ startAt: 1 }),
    rts: new MockRtsRetriever(),
    notifier: new RecordingNotifier(),
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
    trustLinks,
  });
  return { store, service, orch, trustLinks };
}

/** Minimal ServerResponse stand-in that records status/headers/body. */
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    body: "",
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
  };
}
function fakeReq(token: string | undefined, ip = "9.9.9.9") {
  return { params: token ? { token } : {}, headers: {}, socket: { remoteAddress: ip }, url: `/trust/${token ?? ""}` };
}

describe("W6 — customer trust page", () => {
  it("(a) a leaky outcome ('done PROJ-118') renders the generic label, never the raw ref", () => {
    const o = mkObl("IN_PROGRESS", { customer: "Acme", outcome: "done PROJ-118" });
    const view = buildTrustView([o], "Acme", NOW);

    expect(view.items).toHaveLength(1);
    expect(view.items[0].label).toBe("Commitment #1");
    expect(view.items[0].label).not.toContain("PROJ-118");

    const html = renderTrustPage(view);
    expect(html).toContain("Commitment #1");
    expect(html).not.toContain("PROJ-118");
    expect(html).not.toMatch(/PROJ/i);
  });

  it("(b) a token for (teamA, Acme) cannot read (teamB, *) or (teamA, Globex)", async () => {
    const { service, orch } = buildStack();
    await seedOpen(service, orch, T_A, { customer: "Acme", subject_canonical: "LOGIN_FIX", outcome: "alpha acme login fix", idempotencyKey: "a:1" });
    await seedOpen(service, orch, T_A, { customer: "Globex", subject_canonical: "EXPORT", outcome: "alpha globex export", idempotencyKey: "a:2" });
    await seedOpen(service, orch, T_B, { customer: "Acme", subject_canonical: "BILLING", outcome: "beta acme billing fix", idempotencyKey: "b:1" });

    const link = await orch.mintTrustLink(T_A, "Acme");
    const view = await orch.trustPageForToken(link.token);
    expect(view).not.toBeNull();

    // Only teamA's Acme commitment is present.
    expect(view!.customer).toBe("Acme");
    expect(view!.items.map((i) => i.label)).toEqual(["alpha acme login fix"]);

    const html = renderTrustPage(view!);
    expect(html).toContain("alpha acme login fix");
    // Cross-tenant (teamB/Acme) and same-tenant-other-customer (teamA/Globex) never leak.
    expect(html).not.toContain("beta acme billing fix"); // different TEAM
    expect(html).not.toContain("alpha globex export"); // different CUSTOMER
    expect(view!.counts.in_progress).toBe(1);
  });

  it("(c) an obligation carrying internal-only evidence shows no internal source or ref", () => {
    const o = mkObl("VERIFIED", {
      customer: "Acme",
      outcome: "SSO login fix",
      evidence: [
        ticketDone("t", "PROJ-118"),
        prMerged("p", "PR-449"),
        featureFlag("f", "sso_login@2026-06-18T12:00:00Z", true),
        ciRun("c", "app#42@2026-06-18T12:00:00Z", "success"),
        statusPage("s", "api@2026-06-18T12:00:00Z", "operational"),
      ],
    });
    const view = buildTrustView([o], "Acme", NOW);

    // The sanitizer ran (invariant #5) and withheld the internal-only facts.
    expect(view.redactedInternalCount).toBeGreaterThanOrEqual(4);
    expect(view.items[0].label).toBe("SSO login fix");

    const html = renderTrustPage(view);
    expect(html).toContain("SSO login fix"); // the shareable outcome is fine
    for (const forbidden of ["PROJ-118", "PR-449", "sso_login@", "app#42", "api@2026", "linear", "jira", "github", "feature_flag", "status_page"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("(d) a revoked or unknown token → 404 (no existence leak, noindex + no-store headers)", async () => {
    const { service, orch } = buildStack();
    await seedOpen(service, orch, T_A, { customer: "Acme", subject_canonical: "LOGIN_FIX", outcome: "alpha acme login fix", idempotencyKey: "a:1" });
    const link = await orch.mintTrustLink(T_A, "Acme");

    // Live token resolves.
    expect(await orch.trustPageForToken(link.token)).not.toBeNull();

    // Revoke → the SAME token no longer resolves.
    expect(await orch.revokeTrustLink(T_A, "Acme")).toBe(1);
    expect(await orch.trustPageForToken(link.token)).toBeNull();

    const limiter = new TrustRateLimiter();
    // Revoked token → 404.
    const revokedRes = fakeRes();
    await handleTrustRequest(() => orch, limiter, fakeReq(link.token) as never, revokedRes as never);
    // Unknown token → 404, byte-identical body (no existence leak).
    const unknownRes = fakeRes();
    await handleTrustRequest(() => orch, limiter, fakeReq("totally-made-up") as never, unknownRes as never);

    expect(revokedRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(revokedRes.body).toBe(unknownRes.body);
    expect(revokedRes.body).toBe(renderTrustNotFound());
    expect(revokedRes.headers["x-robots-tag"]).toBe("noindex");
    expect(revokedRes.headers["cache-control"]).toBe("private, no-store");
  });

  it("serves a live token with 200 + audience-safe headers", async () => {
    const { service, orch } = buildStack();
    await seedOpen(service, orch, T_A, { customer: "Acme", subject_canonical: "LOGIN_FIX", outcome: "alpha acme login fix", idempotencyKey: "a:1" });
    const link = await orch.mintTrustLink(T_A, "Acme");

    const res = fakeRes();
    await handleTrustRequest(() => orch, new TrustRateLimiter(), fakeReq(link.token) as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toContain("alpha acme login fix");
    expect(res.body).toContain("Generated by Kept");
  });

  it("mint is idempotent per (team, customer); buckets map states correctly", async () => {
    const { orch } = buildStack();
    const a = await orch.mintTrustLink(T_A, "Acme");
    const b = await orch.mintTrustLink(T_A, "acme"); // case-insensitive
    expect(a.token).toBe(b.token);

    const view = buildTrustView(
      [
        mkObl("CLOSED", { customer: "Acme", outcome: "kept one", updated_at: "2026-06-10T00:00:00.000Z" }),
        mkObl("IN_PROGRESS", { customer: "Acme", outcome: "working one" }),
        mkObl("POSSIBLE_FULFILLMENT", { customer: "Acme", outcome: "verifying one" }),
        mkObl("OPEN", { customer: "Acme", outcome: "risky one", flags: { ...mkObl("OPEN").flags, is_overdue: true } }),
        mkObl("CANDIDATE", { customer: "Acme", outcome: "hidden candidate" }), // pre-Gate-1 → hidden
        mkObl("IN_PROGRESS", { customer: "Globex", outcome: "other customer" }), // filtered out
      ],
      "Acme",
      NOW,
    );
    expect(view.counts).toEqual({ kept: 1, in_progress: 1, verifying: 1, at_risk: 1 });
    expect(view.items.map((i) => i.label)).not.toContain("hidden candidate");
    expect(view.items.map((i) => i.label)).not.toContain("other customer");
    const kept = view.items.find((i) => i.bucket === "kept");
    expect(kept?.keptOn).toBe("2026-06-10T00:00:00.000Z");
  });

  it("rate limiter blocks once the per-window budget is exceeded", () => {
    const limiter = new TrustRateLimiter(2, 60_000);
    expect(limiter.allow("ip", 0)).toBe(true);
    expect(limiter.allow("ip", 0)).toBe(true);
    expect(limiter.allow("ip", 0)).toBe(false); // over budget
    expect(limiter.allow("ip", 60_001)).toBe(true); // window rolled over
  });
});
