import { describe, it, expect } from "vitest";
import { mapLinearWebhook, mapJiraWebhook, mapGithubWebhook, mapDeployWebhook } from "../src/webhooks/handlers.js";

describe("webhook mappers (correction #1: webhooks deliver lifecycle events)", () => {
  it("maps a Linear 'Done' to a ticket_status fulfillment signal", () => {
    const a = mapLinearWebhook({ type: "Issue", action: "update", data: { identifier: "PROJ-118", state: { name: "Done" }, updatedAt: "2026-06-18T10:00:00Z" } });
    expect(a.kind).toBe("fulfillment");
    if (a.kind === "fulfillment") {
      expect(a.evidence.source).toBe("linear");
      expect(a.evidence.kind).toBe("ticket_status");
      expect(a.refs?.linear).toBe("PROJ-118");
      expect(a.idempotencyKey).toContain("PROJ-118");
    }
  });

  it("maps a Linear 'In Progress' to start_work", () => {
    const a = mapLinearWebhook({ type: "Issue", action: "update", data: { identifier: "PROJ-118", state: { name: "In Progress" }, updatedAt: "t" } });
    expect(a.kind).toBe("start_work");
  });

  it("maps a Jira 'Done' to a jira-sourced ticket_status fulfillment signal", () => {
    const a = mapJiraWebhook({ webhookEvent: "jira:issue_updated", issue: { key: "ACME-1001", fields: { status: { name: "Done" }, updated: "2026-06-18T10:00:00Z" } } });
    expect(a.kind).toBe("fulfillment");
    if (a.kind === "fulfillment") {
      expect(a.evidence.source).toBe("jira");
      expect(a.evidence.kind).toBe("ticket_status");
      expect(a.refs?.jira).toBe("ACME-1001");
      expect(a.idempotencyKey).toContain("jira:ACME-1001");
    }
  });

  it("maps a Jira 'In Progress' to start_work and ignores other statuses", () => {
    expect(mapJiraWebhook({ issue: { key: "ACME-1", fields: { status: { name: "In Progress" } } } }).kind).toBe("start_work");
    expect(mapJiraWebhook({ issue: { key: "ACME-2", fields: { status: { name: "To Do" } } } }).kind).toBe("ignore");
  });

  it("ignores a Jira event with no status (comment/delete) instead of crashing", () => {
    expect(mapJiraWebhook({ webhookEvent: "jira:issue_commented", issue: { key: "ACME-1", fields: {} } }).kind).toBe("ignore");
    expect(mapJiraWebhook({ webhookEvent: "jira:issue_deleted", issue: { key: "ACME-2" } }).kind).toBe("ignore"); // no fields at all
  });

  it("uses the retry-stable top-level timestamp so distinct transitions get distinct keys", () => {
    const a = mapJiraWebhook({ timestamp: 1, issue: { key: "ACME-9", fields: { status: { name: "Done" } } } });
    const b = mapJiraWebhook({ timestamp: 2, issue: { key: "ACME-9", fields: { status: { name: "Done" } } } });
    expect(a.kind).toBe("fulfillment");
    expect(b.kind).toBe("fulfillment");
    if (a.kind === "fulfillment" && b.kind === "fulfillment") {
      expect(a.idempotencyKey).not.toBe(b.idempotencyKey); // no collision across distinct events
      expect(a.idempotencyKey).toContain(new Date(1).toISOString());
    }
  });

  it("ignores other Linear statuses", () => {
    const a = mapLinearWebhook({ type: "Issue", action: "update", data: { identifier: "X", state: { name: "Backlog" }, updatedAt: "t" } });
    expect(a.kind).toBe("ignore");
  });

  it("maps a merged PR to a pr_merged signal carrying the linked issue ref", () => {
    const a = mapGithubWebhook({ action: "closed", pull_request: { number: 449, merged: true, merged_at: "2026-06-18T14:00:00Z", html_url: "u" }, relatesTo: { linear: "PROJ-118" } });
    expect(a.kind).toBe("fulfillment");
    if (a.kind === "fulfillment") {
      expect(a.evidence.kind).toBe("pr_merged");
      expect(a.evidence.ref).toBe("PR-449");
      expect(a.refs?.linear).toBe("PROJ-118");
      expect(a.refs?.github).toBe("PR-449");
    }
  });

  it("ignores an unmerged PR", () => {
    expect(mapGithubWebhook({ action: "closed", pull_request: { number: 1, merged: false, merged_at: null, html_url: "u" } }).kind).toBe("ignore");
  });

  it("maps a deploy to a deploy signal with release + relatesTo refs", () => {
    const a = mapDeployWebhook({ release: "2026.06.18", environment: "production", customer_scoped: true, relatesTo: { linear: "PROJ-118" } });
    expect(a.kind).toBe("fulfillment");
    if (a.kind === "fulfillment") {
      expect(a.evidence.kind).toBe("deploy");
      expect(a.evidence.data.environment).toBe("production");
      expect(a.refs?.release).toBe("2026.06.18");
      expect(a.refs?.linear).toBe("PROJ-118");
    }
  });
});
