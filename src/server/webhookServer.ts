import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { KeptOrchestrator } from "../app/orchestrator.js";
import { mapLinearWebhook, mapJiraWebhook, mapGithubWebhook, mapDeployWebhook, applyWebhookAction } from "../webhooks/handlers.js";

/**
 * Webhook ingestion server (Linear / GitHub / deploy). Dependency-light (node:http).
 * In the hybrid substrate these are driven by replayable fixtures; in production
 * the same routes receive real provider webhooks (add HMAC verification per source).
 */
export interface WebhookServerOpts {
  /** Shared-secret guard via the `x-kept-secret` header (stand-in for per-source HMAC). */
  secret?: string;
  /**
   * W1 — the tenant a webhook belongs to. A request may override per-delivery via the
   * `x-kept-team` header; otherwise this default applies. TODO(W2): derive the team
   * from the installation / per-source routing rather than one configured default.
   */
  teamId?: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handle(req: IncomingMessage, res: ServerResponse, orch: KeptOrchestrator, opts: WebhookServerOpts): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }
  if (opts.secret && req.headers["x-kept-secret"] !== opts.secret) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }

  // W1 — the webhook must name its tenant (header override, else the configured default).
  const headerTeam = req.headers["x-kept-team"];
  const teamId = (Array.isArray(headerTeam) ? headerTeam[0] : headerTeam) ?? opts.teamId;
  if (!teamId) {
    res.statusCode = 400;
    res.end("missing team (set x-kept-team or configure a default)");
    return;
  }

  const body = await readJson(req);
  let status: string;
  switch (req.url) {
    case "/webhooks/linear":
      status = await applyWebhookAction(orch, mapLinearWebhook(body as never), teamId);
      break;
    case "/webhooks/jira":
      status = await applyWebhookAction(orch, mapJiraWebhook(body as never), teamId);
      break;
    case "/webhooks/github":
      status = await applyWebhookAction(orch, mapGithubWebhook(body as never), teamId);
      break;
    case "/webhooks/deploy":
      status = await applyWebhookAction(orch, mapDeployWebhook(body as never), teamId);
      break;
    default:
      res.statusCode = 404;
      res.end("not found");
      return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status }));
}

export function createWebhookServer(orch: KeptOrchestrator, opts: WebhookServerOpts = {}): Server {
  return createServer((req, res) => {
    handle(req, res, orch, opts).catch((err) => {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? err.message : err));
    });
  });
}
