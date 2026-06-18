import type { Evidence } from "../domain/evidence.js";
import type { ResolutionCandidate } from "../engine/entityGraph.js";
import { linearStatusKey, jiraStatusKey, githubMergeKey, deployKey } from "../engine/idempotency.js";
import type { KeptOrchestrator } from "../app/orchestrator.js";

/**
 * Webhook ingestion (correction #1): Linear/GitHub/deploy webhooks deliver
 * lifecycle events; Kept ingests them, maps each to evidence + the obligation it
 * refers to (via the entity graph), and feeds the engine. The mapping is pure and
 * unit-tested; the applier drives the orchestrator.
 */
export type WebhookAction =
  | { kind: "start_work"; refs: ResolutionCandidate["refs"]; idempotencyKey: string }
  | { kind: "fulfillment"; refs: ResolutionCandidate["refs"]; evidence: Evidence; idempotencyKey: string }
  | { kind: "ignore"; reason: string };

// --- Linear -----------------------------------------------------------------
export interface LinearWebhook {
  type: string; // "Issue"
  action: string; // "update"
  data: { identifier: string; state: { name: string }; updatedAt: string };
}

export function mapLinearWebhook(p: LinearWebhook): WebhookAction {
  if (p.type !== "Issue") return { kind: "ignore", reason: `unhandled type ${p.type}` };
  const status = p.data.state.name;
  const refs = { linear: p.data.identifier };
  if (/^in progress$/i.test(status)) {
    return { kind: "start_work", refs, idempotencyKey: linearStatusKey(p.data.identifier, p.data.updatedAt, status) };
  }
  if (/^done$/i.test(status)) {
    const evidence: Evidence = {
      id: `linear:${p.data.identifier}:${p.data.updatedAt}`,
      source: "linear",
      kind: "ticket_status",
      ref: p.data.identifier,
      at: p.data.updatedAt,
      accessible_to_user: true,
      data: { status: "Done" },
      proves: "linked ticket marked Done (internal status)",
    };
    return { kind: "fulfillment", refs, evidence, idempotencyKey: linearStatusKey(p.data.identifier, p.data.updatedAt, status) };
  }
  return { kind: "ignore", reason: `unhandled status ${status}` };
}

// --- Jira -------------------------------------------------------------------
export interface JiraWebhook {
  webhookEvent?: string; // e.g. "jira:issue_updated"
  /** Canonical webhook event time (epoch ms) — present on Jira deliveries, stable across retries. */
  timestamp?: number;
  issue: { key: string; fields?: { status?: { name?: string }; updated?: string } };
}

export function mapJiraWebhook(p: JiraWebhook): WebhookAction {
  if (!p.issue?.key) return { kind: "ignore", reason: "no issue key" };
  // Jira delivers many event types (comments, deletes, worklogs) to one URL — those
  // carry an issue but no status. Ignore them safely instead of throwing a 500.
  const status = p.issue.fields?.status?.name;
  if (!status) return { kind: "ignore", reason: `no status (event ${p.webhookEvent ?? "unknown"})` };
  const key = p.issue.key;
  // Prefer the retry-stable top-level timestamp; fall back to fields.updated. Never
  // an empty segment (which would collide across distinct transitions).
  const updated = p.timestamp ? new Date(p.timestamp).toISOString() : p.issue.fields?.updated || `unknown-${key}`;
  const refs = { jira: key };
  if (/^in progress$/i.test(status)) {
    return { kind: "start_work", refs, idempotencyKey: jiraStatusKey(key, updated, status) };
  }
  if (/^done$/i.test(status)) {
    const evidence: Evidence = {
      id: `jira:${key}:${updated}`,
      source: "jira",
      kind: "ticket_status",
      ref: key,
      at: updated,
      accessible_to_user: true,
      data: { status: "Done" },
      proves: "linked Jira ticket marked Done (internal status)",
    };
    return { kind: "fulfillment", refs, evidence, idempotencyKey: jiraStatusKey(key, updated, status) };
  }
  return { kind: "ignore", reason: `unhandled status ${status}` };
}

// --- GitHub -----------------------------------------------------------------
export interface GithubWebhook {
  action: string; // "closed"
  pull_request: { number: number; merged: boolean; merged_at: string | null; html_url: string };
  /** The issue this PR fixes (parsed from the PR body/branch in production). */
  relatesTo?: { linear?: string; jira?: string };
}

export function mapGithubWebhook(p: GithubWebhook): WebhookAction {
  if (!(p.action === "closed" && p.pull_request.merged)) {
    return { kind: "ignore", reason: "PR not merged" };
  }
  const pr = p.pull_request;
  const ref = `PR-${pr.number}`;
  const evidence: Evidence = {
    id: `github:${pr.number}:${pr.merged_at ?? "merged"}`,
    source: "github",
    kind: "pr_merged",
    ref,
    at: pr.merged_at ?? new Date(0).toISOString(),
    accessible_to_user: true,
    data: { merged: true },
    proves: "code change merged",
  };
  return {
    kind: "fulfillment",
    refs: { ...p.relatesTo, github: ref },
    evidence,
    idempotencyKey: githubMergeKey(ref, pr.merged_at ?? "merged"),
  };
}

// --- Deploy -----------------------------------------------------------------
export interface DeployWebhook {
  release: string;
  environment: string;
  customer_scoped?: boolean;
  /** The work this release ships (issue/PR), used to resolve the obligation. */
  relatesTo?: { linear?: string; jira?: string; github?: string };
}

export function mapDeployWebhook(p: DeployWebhook): WebhookAction {
  const evidence: Evidence = {
    id: `deploy:${p.release}:${p.environment}`,
    source: "deploy",
    kind: "deploy",
    ref: p.release,
    at: new Date(0).toISOString(),
    accessible_to_user: true,
    data: { environment: p.environment, customer_scoped: p.customer_scoped ?? false },
    proves: `released to ${p.environment}`,
  };
  return { kind: "fulfillment", refs: { ...p.relatesTo, release: p.release }, evidence, idempotencyKey: deployKey(p.release, p.environment) };
}

/** Drive the orchestrator from a mapped action. Returns a short status string. */
export async function applyWebhookAction(orch: KeptOrchestrator, action: WebhookAction): Promise<string> {
  if (action.kind === "ignore") return `ignored: ${action.reason}`;
  if (action.kind === "start_work") {
    const o = await orch.startWork(action.refs, action.idempotencyKey);
    return o ? `start_work → ${o.state}` : "start_work → no matching obligation";
  }
  const r = await orch.recordFulfillmentSignal({ refs: action.refs, evidence: action.evidence, idempotencyKey: action.idempotencyKey });
  if (r.kind === "no_match") return "fulfillment → no matching obligation";
  return `fulfillment → ${r.obligation.state}${r.verifyCardSent ? " (verify card sent)" : ""}`;
}
