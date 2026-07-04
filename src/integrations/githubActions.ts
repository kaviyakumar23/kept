import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * W4 — the ONE genuine live proof source (honesty framing, CLAUDE.md invariant #7).
 *
 * Flags (LaunchDarkly) and status pages (Atlassian Statuspage) are honestly SIMULATED
 * for the demo; a real GitHub Actions workflow-run `conclusion` is fetched here from the
 * live GitHub REST API. It implements the same `query()` contract as the simulated proof
 * client, so the proof-collector treats every source uniformly — CODE picks the tool and
 * arguments; the model is never in the loop.
 *
 * Graceful degradation is deliberate: offline, without a token, or on any API error it
 * returns `undefined`. The proof-collector then simply proposes NO ci_run evidence — it
 * never throws and never blocks the pipeline (a missing proof is not a negative proof).
 */
export interface GitHubActionsOptions {
  /** Personal-access / app token. Falls back to the GITHUB_TOKEN env var. */
  token?: string;
  /** API base (override for GitHub Enterprise). Defaults to the public API. */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface WorkflowRunResponse {
  conclusion?: string | null; // "success" | "failure" | "cancelled" | "timed_out" | null (in-progress)
  status?: string | null; // "queued" | "in_progress" | "completed"
}

export class GitHubActionsProofAdapter implements McpQueryClient {
  constructor(private readonly opts: GitHubActionsOptions = {}) {}

  /**
   * query("get_workflow_run", { owner, repo, run_id }) → { conclusion, status }.
   * Any other tool name, missing args/token, or a network/HTTP error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_workflow_run") return undefined;

    const token = this.opts.token ?? process.env.GITHUB_TOKEN;
    if (!token) return undefined; // no credentials → skip the live source gracefully (offline-safe)

    const owner = String(args.owner ?? "").trim();
    const repo = String(args.repo ?? "").trim();
    const runId = String(args.run_id ?? args.runId ?? "").trim();
    if (!owner || !repo || !runId) return undefined;

    const base = this.opts.baseUrl ?? "https://api.github.com";
    const url = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${encodeURIComponent(runId)}`;
    const doFetch = this.opts.fetchImpl ?? fetch;

    try {
      const res = await doFetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "kept",
        },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as WorkflowRunResponse;
      return {
        conclusion: typeof json.conclusion === "string" ? json.conclusion : "unknown",
        status: typeof json.status === "string" ? json.status : "unknown",
      };
    } catch {
      return undefined; // offline / DNS / transport error → graceful skip
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to tear down.
  }
}
