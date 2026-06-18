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
