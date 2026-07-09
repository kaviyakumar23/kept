/**
 * Linear/Jira adapter (correction #1): work items are created/linked through the
 * provider's API (or MCP tools); webhooks deliver lifecycle events back. MCP is
 * NOT the ingestion layer. The engine depends only on this interface.
 *
 * NOTE: Linear is retained as a domain `WorkSystem` (evidence source + entity ref) and as the
 * offline SIMULATED work-item stand-in below, but Kept no longer ships a CONFIGURED Linear
 * integration — the real Linear GraphQL work-item adapter and the Linear proof adapter were
 * removed. Jira is the live work system; the simulated adapters back the offline demo/tests.
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

// The real Linear GraphQL work-item adapter and the Linear proof adapter were removed when
// Linear was dropped as a configured integration. Linear remains a domain WorkSystem and the
// simulated adapter above still models it for the offline demo/tests; Jira is the live work
// system (see JiraApiAdapter / JiraProofAdapter in jira.ts).
