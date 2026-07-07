import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * W4 — REAL LaunchDarkly proof source (feature-flag state).
 *
 * Reads the ACTUAL production-environment state of a feature flag from the LaunchDarkly
 * REST API and reports `{ enabled, environment }` — the exact structured fact the
 * proof-collector turns into `feature_flag` evidence. This is what powers the
 * blocking-negative lane in `assessFulfillment`: a flag that is OFF in production means
 * the ticket may be Done and the code deployed, yet the capability is NOT reachable.
 *
 * Same contract + discipline as GitHubActionsProofAdapter (invariant #1): CODE picks
 * the tool + args; the model is never in the loop; the adapter only PROPOSES structured
 * facts. Graceful degradation is deliberate — offline, without a token, on a wrong tool
 * name, or on any API error it returns `undefined`, and the collector then proposes NO
 * flag evidence (a missing proof is not a negative proof). Selection between this real
 * adapter and the simulated MCP proof server happens one layer up (proofSources.ts): when
 * no LaunchDarkly credentials are configured, the simulated server answers instead, so
 * `npm run demo` and the hermetic tests still run offline unchanged.
 *
 * ZERO-COPY: returns only derived scalars (`enabled`, `environment`); the collector
 * encodes the check instant into the evidence `ref`.
 */
export interface LaunchDarklyOptions {
  /** LaunchDarkly REST API access token. Falls back to LAUNCHDARKLY_API_TOKEN. */
  apiToken?: string;
  /** LaunchDarkly project key (e.g. "default"). Falls back to LAUNCHDARKLY_PROJECT_KEY. */
  projectKey?: string;
  /** Environment key whose `on` state we read (e.g. "production"). Falls back to LAUNCHDARKLY_ENVIRONMENT, then "production". */
  environment?: string;
  /** API base (override for federal / self-hosted). Defaults to the public API. */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Shape of the slice of `GET /api/v2/flags/{proj}/{flag}` we read (the rest is ignored). */
interface FlagResponse {
  environments?: Record<string, { on?: boolean } | undefined>;
}

export class LaunchDarklyProofAdapter implements McpQueryClient {
  constructor(private readonly opts: LaunchDarklyOptions = {}) {}

  /** Is a real LaunchDarkly credential + project configured? (Used for real-vs-simulated selection.) */
  configured(): boolean {
    return Boolean((this.opts.apiToken ?? process.env.LAUNCHDARKLY_API_TOKEN) && (this.opts.projectKey ?? process.env.LAUNCHDARKLY_PROJECT_KEY));
  }

  /**
   * query("get_flag_state", { flag_key, environment? }) → { enabled, environment }.
   * Any other tool name, missing token/project/flag, or a network/HTTP error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_flag_state") return undefined;

    const token = this.opts.apiToken ?? process.env.LAUNCHDARKLY_API_TOKEN;
    const project = this.opts.projectKey ?? process.env.LAUNCHDARKLY_PROJECT_KEY;
    if (!token || !project) return undefined; // no credentials → skip (offline-safe; sim answers upstream)

    const flag = String(args.flag_key ?? "").trim();
    if (!flag) return undefined;
    const env = String(args.environment ?? this.opts.environment ?? process.env.LAUNCHDARKLY_ENVIRONMENT ?? "production").trim() || "production";

    const base = this.opts.baseUrl ?? "https://app.launchdarkly.com";
    // `?env=<key>` limits the response to the one environment we care about.
    const url = `${base}/api/v2/flags/${encodeURIComponent(project)}/${encodeURIComponent(flag)}?env=${encodeURIComponent(env)}`;
    const doFetch = this.opts.fetchImpl ?? fetch;

    try {
      const res = await doFetch(url, {
        headers: {
          authorization: token, // LaunchDarkly uses the raw access token (no "Bearer" prefix)
          "content-type": "application/json",
          "user-agent": "kept",
        },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as FlagResponse;
      const on = json.environments?.[env]?.on;
      return { enabled: on === true, environment: env };
    } catch {
      return undefined; // offline / DNS / transport error → graceful skip
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP — nothing to tear down.
  }
}
