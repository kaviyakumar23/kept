import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "../src/store/memoryStore.js";
import { ObligationService } from "../src/engine/obligationService.js";
import { InMemoryScheduler } from "../src/scheduler/inMemoryScheduler.js";
import { MockLlmProvider } from "../src/llm/mock.js";
import { NoopWorkItemAdapter } from "../src/integrations/linear.js";
import { MockRtsRetriever } from "../src/slack/rts.js";
import { RecordingNotifier } from "../src/slack/notifier.js";
import { KeptOrchestrator, CrossTenantWriteError } from "../src/app/orchestrator.js";
import { requireTeam } from "../src/server/slackApp.js";
import { verifyPacketModal } from "../src/slack/blocks.js";
import type { ProofCollector } from "../src/integrations/proofCollector.js";
import { NOW, featureFlag, heuristicResponder } from "../src/eval/scenarios.js";

/**
 * Adversary (round 8) — the Gate-2 "verify modal" refactor.
 *
 * The UI change re-routed Gate 2: the App Home "👀 Verify" row / DM nudge now OPENS
 * `verifyPacketModal` (a read via `orch.assemblePacket`), and the MODAL SUBMIT
 * (`app.view(CALLBACKS.verifyPacket)`) is the human signature — it calls
 * `orch.verify(id, user, team)`, then either acks-closed (draftSent) or re-renders the
 * packet with `response_action: "update"` (blocked). `private_metadata` carries the
 * obligation id and is attacker-controllable in theory.
 *
 * These tests reproduce the handler's exact control flow (team resolved from the
 * signature-verified body via `requireTeam`; obligation id from `private_metadata`) and
 * pin the two invariants the refactor could regress:
 *   • Gate integrity (#3): a BLOCKED packet (flag OFF) can NEVER be verified from the
 *     modal submit — the engine re-gathers proof and refuses (draftSent=false, no
 *     INTERNALLY_VERIFIED). Flipping the flag ON and re-submitting verifies exactly once.
 *   • Tenant isolation (#4, P0): workspace B cannot OPEN or SUBMIT the verify modal for
 *     workspace A's obligation — neither the `assemblePacket` read nor the `verify` write
 *     may cross tenants, even though `private_metadata` names A's obligation id.
 */

// Mirror of the app.view(CALLBACKS.verifyPacket) handler in src/server/slackApp.ts.
// Returns what the handler would do to the modal: "closed" (ack()) on success,
// "update" (ack({response_action:"update",view})) on block, "blocked-cross-tenant"
// / "team-less" on the fail-closed DM branches.
async function submitVerifyModal(
  orch: KeptOrchestrator,
  body: { team?: { id: string }; user: { id: string; team_id?: string } },
  privateMetadata: string,
): Promise<{ action: "closed" | "update" | "cross-tenant" | "team-less"; view?: unknown }> {
  const id = privateMetadata; // view.private_metadata — attacker-controllable in theory
  let team: string;
  try {
    team = requireTeam(body);
  } catch {
    return { action: "team-less" }; // ack() + "couldn't determine your workspace"
  }
  try {
    const { draftSent } = await orch.verify(id, body.user.id, team);
    if (draftSent) return { action: "closed" }; // ack() — modal closes, send nudge DM'd
    const packet = await orch.assemblePacket(id, team); // re-render the still-failing packet
    return { action: "update", view: packet ? verifyPacketModal(packet.obligation, packet.assessment) : {} };
  } catch (err) {
    if (err instanceof CrossTenantWriteError) return { action: "cross-tenant" }; // ack() + lock DM
    throw err;
  }
}

function buildOrch(collector?: ProofCollector) {
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
    ...(collector ? { proofCollectorFor: async () => collector } : {}),
  });
  return { orch, service, notifier };
}

const msg = (team: string, userId: string, text: string) => ({
  team, channel: "C", threadTs: "100", ts: "100", userId, text, permalink: "p",
});

async function toPossibleFulfillment(orch: KeptOrchestrator, team: string, owner: string): Promise<string> {
  const ing = await orch.ingestMessage(msg(team, owner, "We'll ship the SSO fix for Acme by Friday."));
  const id = ing.kind === "confirm_card_sent" ? ing.obligationId : "";
  await orch.confirmCommitment(id, owner, undefined, team);
  await orch.markDelivered(id, owner, team); // manual_delivery → POSSIBLE_FULFILLMENT
  return id;
}

describe("Gate-2 verify-modal refactor — the modal submit cannot bypass the engine gate", () => {
  it("a flag-OFF packet is REFUSED on submit (modal re-renders, no verify); flipping ON verifies exactly once", async () => {
    // A per-tenant proof collector whose flag we can flip between submits. Distinct instants
    // per read so OFF→OFF→ON are separate facts (latest wins) and none dedupes by ref.
    let flagOn = false;
    let tick = 0;
    const collector = {
      collect: async () => {
        tick += 1;
        const at = new Date(NOW + tick * 60_000).toISOString();
        return [featureFlag(`f${tick}`, `billing_v2@${at}`, flagOn, at)];
      },
    } as unknown as ProofCollector;

    const { orch, service, notifier } = buildOrch(collector);
    const id = await toPossibleFulfillment(orch, "T", "U_AM");
    const body = { team: { id: "T" }, user: { id: "U_AM" } };

    // --- Blocked submit: flag OFF. The engine re-gathers proof and refuses. ---
    const blocked = await submitVerifyModal(orch, body, id);
    expect(blocked.action).toBe("update"); // modal stays open, re-rendered — NOT acked-closed
    // The re-rendered packet shows the blocked verdict (what the owner sees), never "ready".
    expect(JSON.stringify(blocked.view)).toContain("Not ready to close");
    // No signature was recorded and the state never advanced.
    let events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(0);
    expect((await service.getObligation(id))!.state).toBe("POSSIBLE_FULFILLMENT");
    // No "close the loop" send nudge was DM'd on a blocked packet.
    expect(notifier.calls.some((c) => c.kind === "private" && /close the loop/i.test(c.text))).toBe(false);

    // --- Now the flag flips ON; re-submitting the SAME modal verifies. ---
    flagOn = true;
    const ok = await submitVerifyModal(orch, body, id);
    expect(ok.action).toBe("closed"); // ack() — modal closes
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");

    // Exactly one signature, and one send nudge.
    events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(1);
    expect(notifier.calls.filter((c) => c.kind === "private" && /close the loop/i.test(c.text)).length).toBe(1);
  });

  it("a double-submit of the modal (both while POSSIBLE_FULFILLMENT) verifies exactly once", async () => {
    const { orch, service } = buildOrch(); // no collector → manual attestation alone reconciles
    const id = await toPossibleFulfillment(orch, "T", "U_AM");
    const body = { team: { id: "T" }, user: { id: "U_AM" } };

    const [a, b] = await Promise.all([
      submitVerifyModal(orch, body, id),
      submitVerifyModal(orch, body, id),
    ]);
    // One submit closes the modal (verified); the loser re-renders — never a second signature.
    expect([a, b].filter((r) => r.action === "closed").length).toBe(1);
    const events = await service.getEvents(id);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(1);
    expect((await service.getObligation(id))!.state).toBe("VERIFIED");
  });
});

describe("Gate-2 verify-modal refactor — tenant isolation (P0) on open + submit", () => {
  it("workspace B can neither OPEN nor SUBMIT the verify modal for workspace A's obligation", async () => {
    const { orch, service } = buildOrch(); // shared store; both teams live in the same ledger
    const idA = await toPossibleFulfillment(orch, "T_ALPHA", "U_ALPHA");

    // Opening the modal is a tenant-scoped read: B's assemblePacket on A's id is blocked.
    await expect(orch.assemblePacket(idA, "T_BETA")).rejects.toBeInstanceOf(CrossTenantWriteError);

    // Submitting: even though private_metadata names A's obligation id, the team comes from
    // B's signature-verified body — the write is blocked and the handler reports cross-tenant.
    const bodyB = { team: { id: "T_BETA" }, user: { id: "U_BETA" } };
    const res = await submitVerifyModal(orch, bodyB, idA);
    expect(res.action).toBe("cross-tenant");

    // A's obligation is completely untouched — no signature, still awaiting its own owner.
    const after = await orch.obligation(idA, "T_ALPHA");
    expect(after?.state).toBe("POSSIBLE_FULFILLMENT");
    const events = await service.getEvents(idA);
    expect(events.filter((e) => e.type === "INTERNALLY_VERIFIED").length).toBe(0);

    // Sanity: A's own owner CAN verify from the modal (the guard only blocks cross-tenant).
    const bodyA = { team: { id: "T_ALPHA" }, user: { id: "U_ALPHA" } };
    const okA = await submitVerifyModal(orch, bodyA, idA);
    expect(okA.action).toBe("closed");
    expect((await service.getObligation(idA))!.state).toBe("VERIFIED");
  });

  it("requireTeam fails CLOSED: a team-less submit is refused (never runs on the unchecked path)", async () => {
    // The handler's team resolution — from body.team.id, or the org-install user.team_id fallback.
    expect(requireTeam({ team: { id: "T_BETA" }, user: { id: "U_BETA" } })).toBe("T_BETA");
    expect(requireTeam({ user: { id: "U", team_id: "T_ORG" } })).toBe("T_ORG");

    const { orch } = buildOrch();
    const id = await toPossibleFulfillment(orch, "T", "U_AM");
    // A payload with NO resolvable team must not reach orch.verify with an undefined actingTeam
    // (which would be the internal, unchecked path). The handler returns "team-less" instead.
    const res = await submitVerifyModal(orch, { user: { id: "U_STRAY" } }, id);
    expect(res.action).toBe("team-less");
  });
});
