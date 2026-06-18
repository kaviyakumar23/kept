import type { WorkItemAdapter, CreateIssueInput, CreatedWorkItem } from "./linear.js";

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
