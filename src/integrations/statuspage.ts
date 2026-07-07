import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * W4 — REAL Atlassian Statuspage proof source (component operational health).
 *
 * Reads the ACTUAL status of a Statuspage component from the Statuspage REST API and
 * reports `{ component_status }` — the structured fact the proof-collector turns into
 * `status_page` evidence. A component that is not `operational` corroborates that the
 * capability isn't actually healthy in production.
 *
 * Same contract + discipline as GitHubActionsProofAdapter (invariant #1): CODE picks the
 * tool + args; the model is never in the loop; the adapter only PROPOSES a derived fact.
 * Offline / no key / wrong tool / any API error → `undefined` (a missing proof is not a
 * negative proof). Real-vs-simulated selection happens in proofSources.ts: with no
 * Statuspage credentials the simulated MCP proof server answers instead, so the offline
 * demo and hermetic tests are unchanged.
 *
 * ZERO-COPY: returns only the derived `component_status` enum string.
 */
export interface StatuspageOptions {
  /** Statuspage API key (an Organization/API token). Falls back to STATUSPAGE_API_KEY. */
  apiKey?: string;
  /** The page id the component lives on. Falls back to STATUSPAGE_PAGE_ID. */
  pageId?: string;
  /** API base (override if self-hosted). Defaults to the public API. */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** The slice of `GET /v1/pages/{page}/components/{id}` we read. */
interface ComponentResponse {
  status?: string; // operational | degraded_performance | partial_outage | major_outage | under_maintenance
}

export class StatuspageProofAdapter implements McpQueryClient {
  constructor(private readonly opts: StatuspageOptions = {}) {}

  /** Is a real Statuspage key + page configured? (Used for real-vs-simulated selection.) */
  configured(): boolean {
    return Boolean((this.opts.apiKey ?? process.env.STATUSPAGE_API_KEY) && (this.opts.pageId ?? process.env.STATUSPAGE_PAGE_ID));
  }

  /**
   * query("get_status_page", { component }) → { component_status }, where `component` is a
   * Statuspage component id. Any other tool, missing key/page/component, or an HTTP error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_status_page") return undefined;

    const key = this.opts.apiKey ?? process.env.STATUSPAGE_API_KEY;
    const page = this.opts.pageId ?? process.env.STATUSPAGE_PAGE_ID;
    if (!key || !page) return undefined; // no credentials → skip (offline-safe; sim answers upstream)

    const componentId = String(args.component ?? "").trim();
    if (!componentId) return undefined;

    const base = this.opts.baseUrl ?? "https://api.statuspage.io";
    const url = `${base}/v1/pages/${encodeURIComponent(page)}/components/${encodeURIComponent(componentId)}`;
    const doFetch = this.opts.fetchImpl ?? fetch;

    try {
      const res = await doFetch(url, {
        headers: {
          authorization: `OAuth ${key}`, // Statuspage REST auth scheme
          "content-type": "application/json",
          "user-agent": "kept",
        },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as ComponentResponse;
      const status = typeof json.status === "string" && json.status ? json.status : "unknown";
      return { component_status: status };
    } catch {
      return undefined; // offline / DNS / transport error → graceful skip
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to tear down.
  }
}
