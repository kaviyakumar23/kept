import type { McpQueryClient, McpStructured } from "./mcp.js";

/**
 * Linear/Jira adapter (correction #1): work items are created/linked through the
 * provider's API (or MCP tools); webhooks deliver lifecycle events back. MCP is
 * NOT the ingestion layer. The engine depends only on this interface.
 */
export interface CreatedWorkItem {
  ref: string; // e.g. "PROJ-118"
  url: string;
}

export interface CreateIssueInput {
  /** Short title — derived from the obligation outcome (never the raw message). */
  title: string;
  /** Optional internal description (never sent to the customer). */
  description?: string;
}

export interface WorkItemAdapter {
  readonly system: "linear" | "jira";
  createIssue(input: CreateIssueInput): Promise<CreatedWorkItem>;
}

/**
 * Simulated adapter (hybrid substrate default): deterministic issue keys, no
 * network. Mirrors the shape a real Linear/Jira create returns.
 */
export class SimulatedLinearAdapter implements WorkItemAdapter {
  readonly system = "linear" as const;
  private next: number;
  constructor(opts: { startAt?: number; prefix?: string } = {}) {
    this.next = opts.startAt ?? 118;
    this.prefix = opts.prefix ?? "PROJ";
  }
  private prefix: string;
  async createIssue(_input: CreateIssueInput): Promise<CreatedWorkItem> {
    const ref = `${this.prefix}-${this.next++}`;
    return { ref, url: `https://linear.app/acme/issue/${ref}` };
  }
}

/**
 * Real Linear adapter via the GraphQL API. Skeleton wired for production use
 * (set LINEAR_API_KEY + LINEAR_TEAM_ID). Kept out of the hermetic test path.
 */
export class LinearApiAdapter implements WorkItemAdapter {
  readonly system = "linear" as const;
  constructor(private readonly opts: { apiKey: string; teamId: string; endpoint?: string }) {}

  async createIssue(input: CreateIssueInput): Promise<CreatedWorkItem> {
    const endpoint = this.opts.endpoint ?? "https://api.linear.app/graphql";
    const query = `mutation Create($title:String!,$teamId:String!,$desc:String){
      issueCreate(input:{title:$title, teamId:$teamId, description:$desc}){ success issue { identifier url } } }`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.opts.apiKey },
      body: JSON.stringify({ query, variables: { title: input.title, teamId: this.opts.teamId, desc: input.description ?? null } }),
    });
    if (!res.ok) throw new Error(`Linear createIssue failed: ${res.status}`);
    const json = (await res.json()) as { data?: { issueCreate?: { issue?: { identifier: string; url: string } } } };
    const issue = json.data?.issueCreate?.issue;
    if (!issue) throw new Error("Linear createIssue returned no issue");
    return { ref: issue.identifier, url: issue.url };
  }
}

/**
 * W4 — REAL Linear proof source (issue status). Reads the ACTUAL workflow-state of a linked
 * Linear issue and reports `{ status }`, normalized so Linear's `completed` state type maps
 * to "Done" (which reconciliation reads as fulfilled). The proof-collector turns this into
 * `ticket_status` evidence attributed to `linear`.
 *
 * MCP preferred (matches the work-item precedence): when a Linear MCP read client is injected
 * we call it (CODE picks the tool — tool names on the hosted server aren't pinned, so it is
 * configurable with a default and the result parsed defensively); otherwise the Linear GraphQL
 * API (`issue(id){ state { name type } }`). Neither configured → `undefined`, and proofSources.ts
 * routes to the simulated proof server so the offline demo/tests are unchanged.
 *
 * Same discipline as GitHubActionsProofAdapter (invariant #1): CODE picks the tool + args;
 * it only PROPOSES a derived scalar; any error → `undefined` (graceful skip).
 */
export interface LinearProofOptions {
  /** GraphQL: a Linear personal API key. */
  apiKey?: string;
  /** GraphQL endpoint override. */
  endpoint?: string;
  /** MCP: a read client bound to the hosted Linear MCP server (built in proofSources.ts). */
  mcp?: McpQueryClient;
  /** MCP: the issue-read tool name (uncertain across server versions; overridable). */
  mcpStatusTool?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Normalize a Linear workflow state → "Done" when its type is completed, else the display name. */
function normalizeLinearStatus(name: string | undefined, type: string | undefined): string | undefined {
  if (type && type.toLowerCase() === "completed") return "Done";
  return name && name.trim() ? name.trim() : undefined;
}

export class LinearProofAdapter implements McpQueryClient {
  constructor(private readonly opts: LinearProofOptions = {}) {}

  /** Is a real Linear read path (MCP or GraphQL) configured? */
  configured(): boolean {
    return Boolean(this.opts.mcp || this.opts.apiKey);
  }

  /**
   * query("get_issue_status", { key }) → { status } (and `state_type` when known).
   * Wrong tool / missing key / no configured path / any error → undefined.
   */
  async query(name: string, args: Record<string, unknown>): Promise<McpStructured> {
    if (name !== "get_issue_status") return undefined;
    const key = String(args.key ?? "").trim();
    if (!key) return undefined;
    if (this.opts.mcp) return this.viaMcp(key);
    if (this.opts.apiKey) return this.viaGraphql(key);
    return undefined;
  }

  private async viaGraphql(key: string): Promise<McpStructured> {
    const endpoint = this.opts.endpoint ?? "https://api.linear.app/graphql";
    // Linear's `issue(id:)` accepts the human identifier (e.g. "ENG-123") as well as the UUID.
    const query = `query IssueState($id:String!){ issue(id:$id){ state { name type } } }`;
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.opts.apiKey!, "user-agent": "kept" },
        body: JSON.stringify({ query, variables: { id: key } }),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { data?: { issue?: { state?: { name?: string; type?: string } } } };
      const state = json.data?.issue?.state;
      const status = normalizeLinearStatus(state?.name, state?.type);
      if (!status) return undefined;
      return { status, state_type: state?.type ?? "unknown" };
    } catch {
      return undefined;
    }
  }

  private async viaMcp(key: string): Promise<McpStructured> {
    try {
      const tool = this.opts.mcpStatusTool ?? process.env.LINEAR_MCP_STATUS_TOOL ?? "get_issue";
      const sc = await this.opts.mcp!.query(tool, { id: key, issueId: key, identifier: key });
      const status = pickLinearStatus(sc);
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
function pickLinearStatus(sc: McpStructured): string | undefined {
  if (!sc) return undefined;
  for (const k of ["status", "statusName", "stateName"]) {
    const v = sc[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Nested { state: { name, type } } shape.
  const state = sc.state;
  if (state && typeof state === "object") {
    const s = state as { name?: unknown; type?: unknown };
    const name = typeof s.name === "string" ? s.name : undefined;
    const type = typeof s.type === "string" ? s.type : undefined;
    return normalizeLinearStatus(name, type);
  }
  return undefined;
}
