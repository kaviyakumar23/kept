import type { ObligationEvent, EventType } from "../domain/events.js";
import type { ObligationId } from "../domain/ids.js";

/**
 * C6 — Idempotency keys.
 *
 * Slack events and webhooks arrive more than once. These deterministic keys
 * prevent duplicate obligations, tickets, reminders, messages, and repeated
 * transitions. The store enforces uniqueness; the service checks before acting.
 */
export const slackRequestKey = (team: string, channel: string, ts: string): string =>
  `slack:${team}:${channel}:${ts}:request_detected`;

export const slackEventKey = (team: string, channel: string, ts: string, kind: string): string =>
  `slack:${team}:${channel}:${ts}:${kind}`;

export const linearStatusKey = (issue: string, updatedAt: string, status: string): string =>
  `linear:${issue}:${updatedAt}:${status}`;

export const jiraStatusKey = (issue: string, updatedAt: string, status: string): string =>
  `jira:${issue}:${updatedAt}:${status}`;

export const githubMergeKey = (pr: string, mergedAt: string): string =>
  `github:${pr}:${mergedAt}:merged`;

export const deployKey = (release: string, environment: string): string =>
  `deploy:${release}:${environment}`;

/** Notifications/transitions are keyed by obligation + type + state version. */
export const notifyKey = (obligationId: ObligationId, type: EventType, stateVersion: number): string =>
  `notify:${obligationId}:${type}:${stateVersion}`;

export const transitionKey = (obligationId: ObligationId, type: EventType, stateVersion: number): string =>
  `transition:${obligationId}:${type}:${stateVersion}`;

export function hasIdempotencyKey(events: ObligationEvent[], key: string): boolean {
  return events.some((e) => e.idempotency_key === key);
}
