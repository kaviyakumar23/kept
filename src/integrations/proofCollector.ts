import type { Obligation } from "../domain/obligation.js";
import type { Evidence } from "../domain/evidence.js";
import type { McpQueryClient } from "./mcp.js";

/**
 * W4 — the agent proof-collector (CLAUDE.md invariants #1 & #3).
 *
 * Given an obligation's linked refs, it gathers Proof-of-Done from real proof sources
 * over MCP — a feature flag's production state, a status page's health, a CI run's
 * conclusion — and returns proposed `Evidence[]`. It ONLY proposes: the orchestrator
 * dispatches each as RECORD_FULFILLMENT_SIGNAL, and `assessFulfillment` + Gate 2 decide.
 * The agent never mutates state, never verifies, never chooses a tool the way an
 * open-ended agent would — CODE (targetsFor) picks the tools and arguments.
 *
 * ZERO-COPY / DEDUPE: each observation encodes its check instant in `ref`
 * (`<key>@<iso>`), because projection dedupes on source+kind+ref. A stable ref would
 * silently drop a later OFF→ON→OFF toggle. `now()` therefore MUST advance between
 * observations (the demo/tests inject a controllable clock); reads at the same instant
 * are intentionally idempotent.
 */
export interface ProofTarget {
  /** A feature flag gating the capability (queried via get_flag_state). */
  flag?: { key: string; environment?: string };
  /** A status-page component whose health corroborates availability (get_status_page). */
  status?: { component: string };
  /** A GitHub Actions workflow run whose conclusion proves the build passed (get_workflow_run). */
  ci?: { owner: string; repo: string; runId: number | string };
}

export interface ProofCollectorDeps {
  /** MCP client exposing get_flag_state + get_status_page (simulated LaunchDarkly / Statuspage). */
  proof?: McpQueryClient;
  /** The live GitHub Actions source (its own get_workflow_run under the same query() contract). */
  ci?: McpQueryClient;
  /** CODE decides which proof targets apply to an obligation. Return null to gather nothing. */
  targetsFor: (o: Obligation) => ProofTarget | null;
  /** Clock for the check instant (encoded into `ref`). Defaults to Date.now. */
  now?: () => number;
}

/** Short-enum caps so adapter-supplied values stay single-line and pass assertNoRawContent. */
const cap = (v: unknown, fallback: string): string =>
  typeof v === "string" && v ? v.replace(/\s+/g, " ").slice(0, 40) : fallback;

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined; // one flaky source must never sink the whole collection
  }
}

export class ProofCollector {
  constructor(private readonly d: ProofCollectorDeps) {}

  private nowIso(): string {
    return new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
  }

  /** Gather proof for one obligation → proposed Evidence[]. Never throws; empty when nothing applies. */
  async collect(o: Obligation): Promise<Evidence[]> {
    const target = this.d.targetsFor(o);
    if (!target) return [];
    const at = this.nowIso();
    const out: Evidence[] = [];

    if (target.flag && this.d.proof) {
      const sc = await safe(() =>
        this.d.proof!.query("get_flag_state", {
          flag_key: target.flag!.key,
          environment: target.flag!.environment ?? "production",
        }),
      );
      if (sc) {
        const enabled = sc.enabled === true;
        const environment = cap(sc.environment, target.flag.environment ?? "production");
        out.push({
          id: `feature_flag:${target.flag.key}:${at}`,
          source: "feature_flag",
          kind: "feature_flag",
          ref: `${target.flag.key}@${at}`,
          at,
          accessible_to_user: true,
          data: { enabled, environment },
          proves: enabled ? "feature flag is ON in production" : "feature flag is OFF in production",
        });
      }
    }

    if (target.status && this.d.proof) {
      const sc = await safe(() => this.d.proof!.query("get_status_page", { component: target.status!.component }));
      if (sc) {
        const status = cap(sc.component_status, "unknown");
        out.push({
          id: `status_page:${target.status.component}:${at}`,
          source: "status_page",
          kind: "status_page",
          ref: `${target.status.component}@${at}`,
          at,
          accessible_to_user: true,
          data: { component_status: status },
          proves: status === "operational" ? "status page component operational" : "status page component not operational",
        });
      }
    }

    if (target.ci && this.d.ci) {
      const sc = await safe(() =>
        this.d.ci!.query("get_workflow_run", { owner: target.ci!.owner, repo: target.ci!.repo, run_id: target.ci!.runId }),
      );
      if (sc) {
        const conclusion = cap(sc.conclusion, "unknown");
        out.push({
          id: `ci:${target.ci.repo}:${target.ci.runId}:${at}`,
          source: "ci",
          kind: "ci_run",
          ref: `${target.ci.repo}#${target.ci.runId}@${at}`,
          at,
          accessible_to_user: true,
          data: { conclusion },
          proves: conclusion === "success" ? "CI run concluded success" : "CI run did not pass",
        });
      }
    }

    return out;
  }
}
