import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import { createSimulatedMcpWorkItems, createSimulatedProofServer, type SimulatedProofState } from "../src/integrations/mcp.js";
import { ProofCollector } from "../src/integrations/proofCollector.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import { project } from "../src/domain/projection.js";
import type { ObligationEvent } from "../src/domain/events.js";
import type { Evidence } from "../src/domain/evidence.js";
import { NOW, heuristicResponder, ticketDone, prMerged, prodDeploy, featureFlag } from "../src/eval/scenarios.js";
import { evt } from "./helpers.js";

/**
 * W4 — Proof-of-Done. The headline differentiator: Jira says Done → Kept gathers proof
 * via MCP → the LaunchDarkly flag is OFF in production → Kept BLOCKS the close and shows
 * the Evidence Packet. Flip the flag ON (a newer observation) → verify applies.
 */

const TEAM = "T_ACME";
const msg = (text: string) => ({ team: TEAM, channel: "C_ACME", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });

/** An orchestrator wired to a simulated proof server, with a controllable proof clock. */
async function makeProofOrch(flagEnabled: boolean) {
  const store = new InMemoryEventStore();
  const service = new ObligationService(store, () => NOW);
  const notifier = new RecordingNotifier();
  const proofState: SimulatedProofState = {
    flags: { sso_login: { enabled: flagEnabled, environment: "production" } },
  };
  const proof = await createSimulatedProofServer(proofState);
  // Proof-check instants advance independently of the fixed engine clock, so a genuine
  // OFF→ON toggle lands as a NEW fact (distinct ref) rather than being deduped.
  let proofClock = NOW;
  const proofCollector = new ProofCollector({
    proof,
    targetsFor: (o) => (o.subject_canonical === "SSO_LOGIN_BUG" ? { flag: { key: "sso_login" } } : null),
    now: () => proofClock,
  });
  const orch = new KeptOrchestrator({
    service,
    llm: new MockLlmProvider(heuristicResponder),
    workItems: await createSimulatedMcpWorkItems(),
    rts: new MockRtsRetriever(),
    notifier,
    proofCollector,
    clock: () => NOW,
    currentDate: () => "2026-06-16",
    fallbackOwner: "U_AM",
  });

  // Drive to POSSIBLE_FULFILLMENT with the "internally done" signals (Done + PR + prod deploy).
  const ing = await orch.ingestMessage(msg("Can you get the SSO bug fixed by Friday?"));
  if (ing.kind !== "confirm_card_sent") throw new Error(`expected confirm card, got ${ing.kind}`);
  const id = ing.obligationId;
  const { work } = await orch.confirmCommitment(id, "U_AM");
  const linear = work!.ref;
  const refs = { linear };
  await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: ticketDone("t", linear), idempotencyKey: "k-done" });
  await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: prMerged("p", "PR-1"), idempotencyKey: "k-pr" });
  const last = await orch.recordFulfillmentSignal({ teamId: TEAM, refs, evidence: prodDeploy("d", "rel"), idempotencyKey: "k-dep" });

  return { orch, service, notifier, proofState, id, last, advanceProofClock: (ms: number) => (proofClock += ms) };
}

describe("W4 — Proof-of-Done (flag OFF blocks the close)", () => {
  it("(a) Done + PR + prod-deploy + a later flag-OFF ⇒ verify is rejected INSUFFICIENT_EVIDENCE", async () => {
    const { orch, service, id, last } = await makeProofOrch(false);

    // The agent gathered the flag state (OFF) → no verify card, because it's blocked.
    expect(last.kind).toBe("recorded");
    expect(last.kind === "recorded" && last.verifyCardSent).toBe(false);

    const o = (await service.getObligation(id))!;
    expect(o.evidence.some((e) => e.kind === "feature_flag" && e.data.enabled === false)).toBe(true);
    const assessment = assessFulfillment(o.evidence);
    expect(assessment.available).toBe(false);
    expect(assessment.sufficientForVerification).toBe(false);
    expect(assessment.rationale).toContain("OFF");

    // Gate 2: the engine refuses to verify (INSUFFICIENT_EVIDENCE) even though the ticket
    // is Done and the code is merged + deployed.
    const v = await orch.verify(id, "U_AM");
    expect(v.draftSent).toBe(false);
    expect((await service.getObligation(id))!.state).toBe("POSSIBLE_FULFILLMENT"); // NOT verified/closed
  });

  it("(b) flipping the flag ON (a newer ref) lets verify apply", async () => {
    const { orch, service, proofState, id, advanceProofClock } = await makeProofOrch(false);

    // First verify while OFF → still blocked.
    const blocked = await orch.verify(id, "U_AM");
    expect(blocked.draftSent).toBe(false);

    // Someone flips the LaunchDarkly flag ON in production, at a later instant.
    proofState.flags.sso_login.enabled = true;
    advanceProofClock(60_000);

    // verify re-gathers proof (flag now ON) → available → applies, and drafts the closure.
    const applied = await orch.verify(id, "U_AM");
    expect(applied.draftSent).toBe(true);
    const o = (await service.getObligation(id))!;
    expect(o.state).toBe("VERIFIED");
    expect(o.evidence.some((e) => e.kind === "feature_flag" && e.data.enabled === true)).toBe(true);
    // Both the OFF and the ON observation are retained (distinct refs) — the audit trail
    // shows the toggle, and reconciliation honored the latest (ON).
    const flags = o.evidence.filter((e) => e.kind === "feature_flag");
    expect(flags.length).toBe(2);
  });

  it("(c) reads the flag state over a real simulated-MCP round-trip via query()", async () => {
    const state: SimulatedProofState = {
      flags: { billing_v2: { enabled: false, environment: "production" } },
    };
    const proof = await createSimulatedProofServer(state);

    const off = await proof.query("get_flag_state", { flag_key: "billing_v2" });
    expect(off).toEqual({ enabled: false, environment: "production" });

    // Mutating server state models a live toggle — the next query reflects it.
    state.flags.billing_v2.enabled = true;
    const on = await proof.query("get_flag_state", { flag_key: "billing_v2" });
    expect(on).toEqual({ enabled: true, environment: "production" });

    // An unknown flag defaults to OFF; the round-trip really goes over MCP.
    const unknown = await proof.query("get_flag_state", { flag_key: "nope" });
    expect(unknown).toEqual({ enabled: false, environment: "production" });

    await proof.close();
  });

  it("(d) toggle-dedupe: OFF→ON→OFF with distinct refs keeps all three; latest OFF wins", () => {
    // Distinct refs (each encodes its instant) → projection keeps all three observations.
    const distinct: Evidence[] = [
      featureFlag("f1", "billing_v2@2026-06-18T10:00:00Z", false, "2026-06-18T10:00:00Z"),
      featureFlag("f2", "billing_v2@2026-06-18T11:00:00Z", true, "2026-06-18T11:00:00Z"),
      featureFlag("f3", "billing_v2@2026-06-18T12:00:00Z", false, "2026-06-18T12:00:00Z"),
    ];
    const oDistinct = projectFlags(distinct);
    expect(oDistinct.evidence.filter((e) => e.kind === "feature_flag").length).toBe(3);
    const a = assessFulfillment(oDistinct.evidence);
    expect(a.available).toBe(false); // latest observation (12:00) is OFF → blocked
    expect(a.rationale).toContain("OFF");

    // A STABLE ref would silently collapse all three to the first-seen OFF — proving WHY
    // the check instant must live in the ref (otherwise the ON→OFF toggle is lost).
    const stable: Evidence[] = [
      featureFlag("g1", "billing_v2", false, "2026-06-18T10:00:00Z"),
      featureFlag("g2", "billing_v2", true, "2026-06-18T11:00:00Z"),
      featureFlag("g3", "billing_v2", false, "2026-06-18T12:00:00Z"),
    ];
    const oStable = projectFlags(stable);
    expect(oStable.evidence.filter((e) => e.kind === "feature_flag").length).toBe(1);
    expect(oStable.evidence[0].data.enabled).toBe(false); // only the first-seen (OFF) survived
  });
});

/** Build a minimal event log (request → the given flag signals) and project it. */
function projectFlags(flags: Evidence[]): ReturnType<typeof project> {
  const log: ObligationEvent[] = [
    evt({
      type: "REQUEST_DETECTED",
      team: TEAM,
      direction: "TEAM_OWES_CUSTOMER",
      signal: "CUSTOMER_REQUEST",
      customer: "Acme",
      subject_canonical: "BILLING_V2",
      outcome: "billing v2",
      due: null,
      owner: null,
      conditions: [],
    }),
    ...flags.map((f) => evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: f })),
  ];
  return project(log, { now: NOW });
}
