import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * W4 — REAL LaunchDarkly proof source (feature-flag state).
 *
 * Reads the ACTUAL production-environment state of a feature flag and reports
 * `{ enabled, environment }` — the exact structured fact the proof-collector turns into
 * `feature_flag` evidence. This is what powers the blocking-negative lane in
 * `assessFulfillment`: a flag that is OFF in production means the ticket may be Done and the
 * code deployed, yet the capability is NOT reachable.
 *
 * Two real paths, MCP preferred (matches the Jira precedence): when a LaunchDarkly MCP read
 * client is injected we read the flag over the hosted LaunchDarkly MCP server (CODE picks the
 * tool — hosted tool names aren't pinned, so it's configurable with a sensible default and the
 * result parsed defensively); otherwise the LaunchDarkly REST API
 * (`GET /api/v2/flags/{project}/{flag}?env={env}`). With neither configured → `undefined`, and
 * proofSources.ts routes to the simulated proof server so the offline demo/tests are unchanged.
 *
 * Same contract + discipline as GitHubActionsProofAdapter (invariant #1): CODE picks the
 * tool + args; the model is never in the loop; the adapter only PROPOSES structured facts.
 * Graceful degradation is deliberate — offline, without a token, on a wrong tool name, or on
 * any API/MCP error it returns `undefined`, and the collector then proposes NO flag evidence
 * (a missing proof is not a negative proof; it never fabricates a state).
 *
 * ZERO-COPY: returns only derived scalars (`enabled`, `environment`); the collector encodes
 * the check instant into the evidence `ref`.
 */
export interface LaunchDarklyOptions {
  /** MCP: a read client bound to the hosted LaunchDarkly MCP server (built in proofSources.ts). */
  mcp?: McpQueryClient;
  /** MCP: the flag-read tool name (uncertain across server versions; overridable). Defaults to `get-feature-flag`. */
  mcpFlagTool?: string;
  /** LaunchDarkly REST API access token. Falls back to LAUNCHDARKLY_API_TOKEN. */
  apiToken?: string;
  /** LaunchDarkly project key (e.g. "default"). Falls back to LAUNCHDARKLY_PROJECT_KEY. Used by both paths. */
  projectKey?: string;
  /** Environment key whose `on` state we read (e.g. "production"). Falls back to LAUNCHDARKLY_ENVIRONMENT, then "production". */
  environment?: string;
  /** REST API base (override for federal / self-hosted). Defaults to the public API. */
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

  /** Is a real LaunchDarkly read path (MCP or REST) configured? (Used for real-vs-simulated selection.) */
  configured(): boolean {
    if (this.opts.mcp) return true;
    return Boolean((this.opts.apiToken ?? process.env.LAUNCHDARKLY_API_TOKEN) && (this.opts.projectKey ?? process.env.LAUNCHDARKLY_PROJECT_KEY));
  }

  /**
   * query("get_flag_state", { flag_key, environment? }) → { enabled, environment }.
   * Any other tool name, missing flag, no configured path, or a network/MCP error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_flag_state") return undefined;

    const flag = String(args.flag_key ?? "").trim();
    if (!flag) return undefined;
    const env = String(args.environment ?? this.opts.environment ?? process.env.LAUNCHDARKLY_ENVIRONMENT ?? "production").trim() || "production";

    if (this.opts.mcp) return this.viaMcp(flag, env);
    return this.viaRest(flag, env);
  }

  private async viaRest(flag: string, env: string): Promise<McpStructured> {
    const token = this.opts.apiToken ?? process.env.LAUNCHDARKLY_API_TOKEN;
    const project = this.opts.projectKey ?? process.env.LAUNCHDARKLY_PROJECT_KEY;
    if (!token || !project) return undefined; // no credentials → skip (offline-safe; sim answers upstream)

    const base = this.opts.baseUrl ?? "https://app.launchdarkly.com";
    // `?env=<key>` limits the response to the one environment we care about.
    const url = `${base}/api/v2/flags/${encodeURIComponent(project)}/${encodeURIComponent(flag)}?env=${encodeURIComponent(env)}`;
    const doFetch = this.opts.fetchImpl ?? fetch;

    try {
      const res = await doFetch(url, {
        headers: {
          authorization: token, // LaunchDarkly REST uses the raw access token (no "Bearer" prefix)
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

  private async viaMcp(flag: string, env: string): Promise<McpStructured> {
    try {
      const tool = this.opts.mcpFlagTool ?? process.env.LAUNCHDARKLY_MCP_FLAG_TOOL ?? "get-feature-flag";
      const project = this.opts.projectKey ?? process.env.LAUNCHDARKLY_PROJECT_KEY;
      // CODE picks the tool + args. LaunchDarkly's hosted MCP `get-feature-flag` returns the flag
      // resource with `environments.<env>.on`; arg names aren't pinned across versions, so we pass
      // the common aliases (redundant keys the server ignores) — same discipline as the Jira MCP path.
      const sc = await this.opts.mcp!.query(tool, {
        flagKey: flag,
        key: flag,
        flag_key: flag,
        environmentKey: env,
        environment: env,
        env,
        ...(project ? { projectKey: project, project } : {}),
      });
      const on = pickLaunchDarklyOn(sc, env);
      if (on === undefined) return undefined; // unparseable → propose nothing (never fabricate a state)
      return { enabled: on, environment: env };
    } catch {
      return undefined; // MCP transport / tool error → graceful skip
    }
  }

  async close(): Promise<void> {
    if (this.opts.mcp) await this.opts.mcp.close();
    // REST path is stateless — nothing to tear down.
  }
}

/** Defensively extract a flag's `on` boolean for `env` from a loosely-typed MCP flag-read result. */
function pickLaunchDarklyOn(sc: McpStructured, env: string): boolean | undefined {
  if (!sc) return undefined;
  // Canonical shape: the flag resource with per-environment config → environments.<env>.on.
  const environments = sc.environments;
  if (environments && typeof environments === "object") {
    const envObj = (environments as Record<string, unknown>)[env];
    if (envObj && typeof envObj === "object") {
      const on = (envObj as { on?: unknown }).on;
      if (typeof on === "boolean") return on;
    }
  }
  // Flatter shapes some tools return: a single-environment `{ on }` or `{ enabled }`.
  if (typeof sc.on === "boolean") return sc.on;
  if (typeof sc.enabled === "boolean") return sc.enabled;
  return undefined;
}
