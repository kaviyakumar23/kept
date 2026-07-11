import { describe, it, expect } from "vitest";
import { decide } from "../src/engine/commandHandler.js";
import { assessFulfillment } from "../src/engine/reconciliation.js";
import {
  isConsistentEvidence,
  KIND_SOURCES,
  type Evidence,
  type EvidenceSource,
} from "../src/domain/evidence.js";
import { assertNoRawContent } from "../src/domain/zeroCopy.js";
import type { Command, CommandContext } from "../src/domain/commands.js";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { NoopWorkItemAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator } from "../src/app/orchestrator.js";
import type { ProofCollector } from "../src/integrations/proofCollector.js";
import { NOW, ISO_NOW, heuristicResponder, featureFlag } from "../src/eval/scenarios.js";
import { evt } from "./helpers.js";

/**
 * Adversary round 8 — manual-attest-integrity.
 *
 * Locks the three attacks against Option A (owner `manual_delivery`):
 *   (1) forge a manual_delivery from a non-owner source to fake an attestation
 *   (2) an OFF proof source (flag) must still BLOCK a manually-attested delivery
 *   (3) the {by: userId} evidence must not smuggle raw content past zero-copy
 * plus the standing guarantee that Verify (Gate 2) is still required — markDelivered
 * only reaches POSSIBLE_FULFILLMENT and never auto-closes.
 */

const manual = (over: Partial<Evidence> = {}): Evidence => ({
  id: "m1",
  source: "owner",
  kind: "manual_delivery",
  ref: `manual@${ISO_NOW}`,
  at: ISO_NOW,
  accessible_to_user: true,
  data: { by: "U_PM" },
  proves: "owner attested the work is delivered",
  ...over,
});

const ctx = (idempotencyKey: string, over: Partial<CommandContext> = {}): CommandContext => ({
  obligationId: "obl_test",
  actor: "user:U_PM",
  source: { system: "slack", ref: null, accessible_to_user: true },
  idempotencyKey,
  at: ISO_NOW,
  approvedBy: null,
  now: NOW,
  ...over,
});

/** A confirmed, OPEN obligation log (RECORD_FULFILLMENT_SIGNAL is admissible from OPEN). */
const openLog = () => [
  evt({
    type: "REQUEST_DETECTED",
    team: "T",
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CONFIRMED_COMMITMENT",
    customer: "Acme",
    subject_canonical: "SSO_LOGIN_BUG",
    outcome: "Ship the SSO fix",
    due: null,
    owner: "U_PM",
    conditions: [],
  }),
  evt({ type: "COMMITMENT_CONFIRMED", outcome: "Ship the SSO fix", due: null, owner: "U_PM" }, { approved_by: "U_AM" }),
];

describe("manual-attest-integrity (adversary round 8)", () => {
  // --- Attack 1: forge a manual_delivery from a non-owner source ------------
  describe("attack 1 — a forged manual_delivery from a non-owner source is rejected", () => {
    it("KIND_SOURCES pins manual_delivery to the owner source only", () => {
      expect(KIND_SOURCES.manual_delivery).toEqual(["owner"]);
    });

    it("isConsistentEvidence rejects manual_delivery from EVERY non-owner source", () => {
      const others: EvidenceSource[] = [
        "slack", "linear", "jira", "github", "deploy", "customer", "crm", "feature_flag", "ci", "status_page",
      ];
      for (const source of others) {
        expect(isConsistentEvidence(manual({ source }))).toBe(false);
      }
      expect(isConsistentEvidence(manual({ source: "owner" }))).toBe(true);
    });

    it("assessFulfillment DROPS a forged github-sourced manual_delivery (no false verification)", () => {
      const a = assessFulfillment([manual({ source: "github", data: { by: "U_ATTACKER" } })]);
      expect(a.available).toBe(false);
      expect(a.sufficientForVerification).toBe(false);
    });

    it("decide() rejects RECORD_FULFILLMENT_SIGNAL for a forged source but accepts the genuine owner", () => {
      const base = openLog();
      const forged = decide(
        base,
        { kind: "RECORD_FULFILLMENT_SIGNAL", evidence: manual({ source: "github" }) } as Command,
        ctx("forged-key"),
      );
      expect(forged.outcome).toBe("rejected");
      if (forged.outcome === "rejected") expect(forged.code).toBe("INCONSISTENT_EVIDENCE");

      const genuine = decide(
        base,
        { kind: "RECORD_FULFILLMENT_SIGNAL", evidence: manual() } as Command,
        ctx("genuine-key"),
      );
      expect(genuine.outcome).toBe("emit");
    });
  });

  // --- Attack 2: an OFF proof source must block a manual attestation --------
  describe("attack 2 — a proof source that is OFF blocks a manually-attested delivery", () => {
    it("manual attestation + flag OFF is NOT sufficient (guardrail wins)", () => {
      const a = assessFulfillment([manual(), featureFlag("f", "billing_v2@t", false)]);
      expect(a.available).toBe(false);
      expect(a.sufficientForVerification).toBe(false);
    });

    it("the LATEST flag wins over reordering/replay: manual + ON@t1 + OFF@t2 stays blocked", () => {
      const on = featureFlag("f1", "billing_v2@t1", true, "2026-06-18T10:00:00Z");
      const off = featureFlag("f2", "billing_v2@t2", false, "2026-06-18T12:00:00Z");
      // Insertion order must not matter — assessment sorts by `at`.
      for (const evidence of [[manual(), on, off], [off, manual(), on], [on, off, manual()]]) {
        const a = assessFulfillment(evidence);
        expect(a.available).toBe(false);
        expect(a.sufficientForVerification).toBe(false);
      }
    });

    it("the PURE engine (decide) refuses to Verify over an OFF flag even with a manual attestation", () => {
      const withOffFlag = [
        ...openLog(),
        evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: manual() }),
        evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: featureFlag("f", "billing_v2@t", false) }),
      ];
      const blocked = decide(
        withOffFlag,
        { kind: "VERIFY_FULFILLMENT", rationale: "x" } as Command,
        ctx("verify-blocked", { approvedBy: "U_AM" }),
      );
      expect(blocked.outcome).toBe("rejected");
      if (blocked.outcome === "rejected") expect(blocked.code).toBe("INSUFFICIENT_EVIDENCE");

      // Contrast: manual attestation with NO contradicting proof source may Verify (human still signs).
      const manualOnly = [...openLog(), evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: manual() })];
      const ok = decide(
        manualOnly,
        { kind: "VERIFY_FULFILLMENT", rationale: "x" } as Command,
        ctx("verify-ok", { approvedBy: "U_AM" }),
      );
      expect(ok.outcome).toBe("emit");
    });
  });

  // --- Attack 3: {by: userId} must pass zero-copy ---------------------------
  describe("attack 3 — the manual_delivery evidence respects zero-copy", () => {
    it("a normal manual_delivery signal event passes assertNoRawContent", () => {
      const ev = evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: manual() });
      expect(() => assertNoRawContent(ev)).not.toThrow();
    });

    it("a raw body smuggled into data.by (newline / oversized) is REJECTED", () => {
      const newline = evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: manual({ data: { by: "U_PM\nleaked raw body line" } }) });
      expect(() => assertNoRawContent(newline)).toThrow();
      const oversized = evt({ type: "FULFILLMENT_SIGNAL_DETECTED", evidence: manual({ data: { by: "x".repeat(1001) } }) });
      expect(() => assertNoRawContent(oversized)).toThrow();
    });
  });

  // --- Gate 2 still required: markDelivered never auto-closes ---------------
  describe("Gate 2 is still required — markDelivered proposes, it never verifies", () => {
    function buildOrch(proofCollector?: ProofCollector) {
      const store = new InMemoryEventStore();
      const service = new ObligationService(store, () => NOW);
      const notifier = new RecordingNotifier();
      const orch = new KeptOrchestrator({
        service,
        llm: new MockLlmProvider(heuristicResponder),
        workItems: new NoopWorkItemAdapter(),
        rts: new MockRtsRetriever(),
        notifier,
        scheduler: new InMemoryScheduler(() => {}),
        clock: () => NOW,
        currentDate: () => "2026-06-16",
        fallbackOwner: "U_AM",
        ...(proofCollector ? { proofCollectorFor: async () => proofCollector } : {}),
      });
      return { orch, service };
    }
    const msg = (text: string) => ({ team: "T", channel: "C", threadTs: "100", ts: "100", userId: "U_PM", text, permalink: "p" });

    async function seedConfirmed(orch: KeptOrchestrator) {
      const ing = await orch.ingestMessage(msg("We'll ship the SSO fix for Acme by Friday."));
      const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
      await orch.confirmCommitment(id, "U_AM");
      return id;
    }

    it("markDelivered reaches POSSIBLE_FULFILLMENT and never VERIFIED/CLOSED on its own", async () => {
      const { orch, service } = buildOrch();
      const id = await seedConfirmed(orch);
      const res = await orch.markDelivered(id, "U_PM");
      expect(res.obligation?.state).toBe("POSSIBLE_FULFILLMENT");
      const o = await service.getObligation(id);
      expect(["VERIFIED", "CUSTOMER_NOTIFIED", "CLOSED"]).not.toContain(o?.state);
    });

    it("end-to-end: a connected flag OFF blocks the manual attestation — no verify card, verify() refuses", async () => {
      // A proof collector that reports the production flag OFF at the moment of markDelivered.
      const collector = {
        collect: async () => [featureFlag("f", "billing_v2@block", false, ISO_NOW)],
      } as unknown as ProofCollector;
      const { orch, service } = buildOrch(collector);
      const id = await seedConfirmed(orch);

      const res = await orch.markDelivered(id, "U_PM");
      expect(res.obligation?.state).toBe("POSSIBLE_FULFILLMENT");
      expect(res.verifyCardSent).toBe(false); // blocked packet — the owner sees it but cannot verify

      const v = await orch.verify(id, "U_AM");
      expect(v.draftSent).toBe(false); // Gate 2 refuses over an OFF flag
      const o = await service.getObligation(id);
      expect(o?.state).toBe("POSSIBLE_FULFILLMENT"); // still not verified/closed
    });
  });
});
