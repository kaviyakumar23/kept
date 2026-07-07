import type { WorkItemAdapter, CreateIssueInput, CreatedWorkItem } from "./linear.js";
import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * Jira adapter — proof that the work-item integration is genuinely provider-agnostic.
 * The engine already models `jira` as a first-class work system (WorkSystem,
 * KIND_SOURCES.ticket_status, entity_refs.jira); this is a drop-in adapter behind
 * the same WorkItemAdapter interface as Linear. (Per spec E2, the demo runs on
 * Linear; this exists to show the abstraction holds.)
 */
export class SimulatedJiraAdapter implements WorkItemAdapter {
  readonly system = "jira" as const;
  private next: number;
  private prefix: string;
  constructor(opts: { startAt?: number; prefix?: string } = {}) {
    this.next = opts.startAt ?? 1001;
    this.prefix = opts.prefix ?? "ACME";
  }
  async createIssue(_input: CreateIssueInput): Promise<CreatedWorkItem> {
    const ref = `${this.prefix}-${this.next++}`;
    return { ref, url: `https://acme.atlassian.net/browse/${ref}` };
  }
}

/**
 * Real Jira Cloud adapter via the REST v3 API. Skeleton wired for production
 * (set JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY). Kept out
 * of the hermetic test path.
 */
export class JiraApiAdapter implements WorkItemAdapter {
  readonly system = "jira" as const;
  constructor(private readonly opts: { baseUrl: string; email: string; apiToken: string; projectKey: string }) {}

  async createIssue(input: CreateIssueInput): Promise<CreatedWorkItem> {
    const auth = Buffer.from(`${this.opts.email}:${this.opts.apiToken}`).toString("base64");
    const body = {
      fields: {
        project: { key: this.opts.projectKey },
        summary: input.title,
        issuetype: { name: "Task" },
        ...(input.description
          ? { description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: input.description }] }] } }
          : {}),
      },
    };
    const res = await fetch(`${this.opts.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira createIssue failed: ${res.status}`);
    const json = (await res.json()) as { key?: string };
    if (!json.key) throw new Error("Jira createIssue returned no key");
    return { ref: json.key, url: `${this.opts.baseUrl}/browse/${json.key}` };
  }
}

/**
 * W4 — REAL Jira proof source (issue status). Reads the ACTUAL status of a linked Jira
 * issue and reports `{ status }` (normalized so a Jira "done" status category always maps
 * to "Done", which reconciliation reads as fulfilled). The proof-collector turns this into
 * `ticket_status` evidence attributed to `jira`.
 *
 * Two real paths, MCP preferred (matches the work-item precedence): when an Atlassian MCP
 * read client is injected we call it (CODE picks the tool — tool names on the hosted server
 * aren't pinned, so the tool name is configurable with a sensible default and the result is
 * parsed defensively); otherwise Jira Cloud REST v3 (`GET /rest/api/3/issue/{key}?fields=status`).
 * With neither configured → `undefined`, and proofSources.ts routes to the simulated proof
 * server so the offline demo/tests are unchanged.
 *
 * Same discipline as GitHubActionsProofAdapter (invariant #1): CODE picks the tool + args;
 * it only PROPOSES a derived scalar; any error → `undefined` (graceful skip).
 */
export interface JiraProofOptions {
  /** REST: Jira Cloud base URL (e.g. https://acme.atlassian.net). */
  baseUrl?: string;
  /** REST: account email for Basic auth. */
  email?: string;
  /** REST: API token for Basic auth. */
  apiToken?: string;
  /** MCP: a read client bound to the hosted Atlassian MCP server (built in proofSources.ts). */
  mcp?: McpQueryClient;
  /** MCP: the issue-read tool name (uncertain across server versions; overridable). */
  mcpStatusTool?: string;
  /** MCP: Atlassian cloud id (some tools require it). */
  cloudId?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Normalize a Jira status → "Done" when its category is done, else the display name. */
function normalizeJiraStatus(name: string | undefined, categoryKey: string | undefined): string | undefined {
  if (categoryKey && categoryKey.toLowerCase() === "done") return "Done";
  return name && name.trim() ? name.trim() : undefined;
}

export class JiraProofAdapter implements McpQueryClient {
  constructor(private readonly opts: JiraProofOptions = {}) {}

  /** Is a real Jira read path (MCP or REST) configured? */
  configured(): boolean {
    if (this.opts.mcp) return true;
    return Boolean(this.opts.baseUrl && this.opts.email && this.opts.apiToken);
  }

  /**
   * query("get_issue_status", { key }) → { status } (and `category` when known).
   * Wrong tool / missing key / no configured path / any error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_issue_status") return undefined;
    const key = String(args.key ?? "").trim();
    if (!key) return undefined;
    if (this.opts.mcp) return this.viaMcp(key);
    if (this.opts.baseUrl && this.opts.email && this.opts.apiToken) return this.viaRest(key);
    return undefined;
  }

  private async viaRest(key: string): Promise<McpStructured> {
    const auth = Buffer.from(`${this.opts.email}:${this.opts.apiToken}`).toString("base64");
    const url = `${this.opts.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`;
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url, {
        headers: { authorization: `Basic ${auth}`, accept: "application/json", "user-agent": "kept" },
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { fields?: { status?: { name?: string; statusCategory?: { key?: string } } } };
      const st = json.fields?.status;
      const status = normalizeJiraStatus(st?.name, st?.statusCategory?.key);
      if (!status) return undefined;
      return { status, category: st?.statusCategory?.key ?? "unknown" };
    } catch {
      return undefined;
    }
  }

  private async viaMcp(key: string): Promise<McpStructured> {
    try {
      const tool = this.opts.mcpStatusTool ?? process.env.JIRA_MCP_STATUS_TOOL ?? "getJiraIssue";
      const sc = await this.opts.mcp!.query(tool, {
        issueIdOrKey: key,
        key,
        ...(this.opts.cloudId ? { cloudId: this.opts.cloudId } : {}),
      });
      const status = pickJiraStatus(sc);
      if (!status) return undefined;
      return { status };
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.opts.mcp) await this.opts.mcp.close();
  }
}

/** Defensively extract a normalized status from a loosely-typed MCP issue-read result. */
function pickJiraStatus(sc: McpStructured): string | undefined {
  if (!sc) return undefined;
  // Common direct-status keys the hosted server might use.
  for (const k of ["status", "statusName", "issueStatus", "state"]) {
    const v = sc[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Nested { status: { name, statusCategory: { key } } } shape.
  const status = sc.status;
  if (status && typeof status === "object") {
    const s = status as { name?: unknown; statusCategory?: { key?: unknown } };
    const name = typeof s.name === "string" ? s.name : undefined;
    const cat = typeof s.statusCategory?.key === "string" ? s.statusCategory.key : undefined;
    return normalizeJiraStatus(name, cat);
  }
  return undefined;
}
