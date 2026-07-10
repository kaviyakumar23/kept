import { createSimulatedProofServer, type SimulatedProofState } from "../integrations/mcp.js";
import { ProofCollector, type ProofTarget } from "../integrations/proofCollector.js";
import type { Obligation } from "../domain/obligation.js";

/**
 * Judge-operable demo runtime (#1). The hero moment — "Jira Done + flag OFF → BLOCKED" — depends
 * on external system state (Jira / CI / a LaunchDarkly flag) a judge can't naturally manipulate.
 * So the designated demo tenant (KEPT_DEMO_TEAM) reads proof from a CONTROLLABLE in-process
 * simulated source instead of live integrations: the Demo Controls buttons mutate this state and
 * the demo tenant's proof collector reflects it instantly. This also makes the demo immune to a
 * lapsed LaunchDarkly/Jira trial mid-judging — it never touches a live account.
 *
 * The flag starts OFF so a judge who clicks Verify is personally REFUSED by the engine
 * (INSUFFICIENT_EVIDENCE), sees the red flag row, flips it, and watches the close go through.
 */
export const DEMO_FLAG_KEY = "sso-login-fix";

/** Mutable proof state the Demo Controls own. Read by the demo collector (by reference). */
export const demoProofState: SimulatedProofState = {
  flags: { [DEMO_FLAG_KEY]: { enabled: false, environment: "production" } },
};

let cached: ProofCollector | null = null;

/** The demo tenant's proof collector — reads the controllable {@link demoProofState}. */
export async function getDemoCollector(now: () => number): Promise<ProofCollector> {
  if (cached) return cached;
  const proof = await createSimulatedProofServer(demoProofState);
  cached = new ProofCollector({
    proof,
    // Every demo obligation maps to the one demo flag (the demo tenant only holds demo promises).
    targetsFor: (_o: Obligation): ProofTarget => ({ flag: { key: DEMO_FLAG_KEY, environment: "production" } }),
    now,
  });
  return cached;
}

/** Flip the production flag the demo collector reads (the judge's "Toggle flag" button). */
export function setDemoFlag(on: boolean): void {
  demoProofState.flags[DEMO_FLAG_KEY].enabled = on;
}
export function demoFlagOn(): boolean {
  return demoProofState.flags[DEMO_FLAG_KEY].enabled === true;
}

/** Reset the demo to its opening state (flag OFF) — the "Reset demo" button. */
export function resetDemoProof(): void {
  setDemoFlag(false);
}
