import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { CustomRoute } from "@slack/bolt";
import type { KeptOrchestrator } from "../app/orchestrator.js";
import {
  mapLinearWebhook,
  mapJiraWebhook,
  mapGithubWebhook,
  mapDeployWebhook,
  applyWebhookAction,
  type WebhookAction,
} from "../webhooks/handlers.js";
import { handleTrustRequest, trustCustomRoute, TrustRateLimiter } from "./trustPage.js";

/**
 * Webhook ingestion (Linear / Jira / GitHub / deploy). In the hybrid substrate these
 * are driven by replayable fixtures; in production the same routes receive real
 * provider webhooks (add HMAC verification per source).
 *
 * W2 — two hosts for the SAME logic:
 *   • Socket Mode / single-token dev: a standalone `node:http` server (createWebhookServer).
 *   • OAuth HTTP mode: folded into Bolt `customRoutes` so everything is served on one PORT.
 */
export interface WebhookServerOpts {
  /** Shared-secret guard via the `x-kept-secret` header (stand-in for per-source HMAC). */
  secret?: string;
  /**
   * Hosted mode: authentication is MANDATORY. When true, a delivery is rejected unless a
   * secret is configured AND the `x-kept-secret` header matches it — so an unauthenticated
   * caller can never inject forged proof. Fails closed if no secret is configured.
   */
  requireSecret?: boolean;
  /**
   * Default tenant when a delivery does not name one (single-tenant dev / the demo
   * driver). A request may still override per-delivery via the `x-kept-team` header.
   */
  teamId?: string;
  /**
   * W2 — OAuth multi-tenant routing: enumerate installed workspace ids so a webhook
   * with neither header nor default is routed to whichever tenant's ledger resolves
   * its refs. Unknown → no-op (never touches a wrong tenant).
   */
  listTeamIds?: () => Promise<string[]>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

/** Map a webhook path + body onto a provider-agnostic action (null → unknown path). */
function mapByPath(pathname: string, body: unknown): WebhookAction | null {
  switch (pathname) {
    case "/webhooks/linear":
      return mapLinearWebhook(body as never);
    case "/webhooks/jira":
      return mapJiraWebhook(body as never);
    case "/webhooks/github":
      return mapGithubWebhook(body as never);
    case "/webhooks/deploy":
      return mapDeployWebhook(body as never);
    default:
      return null;
  }
}

/**
 * Resolve the tenant a delivery belongs to: explicit `x-kept-team` header → configured
 * default → (OAuth mode) payload-based routing across installed tenants. Returns null
 * when it cannot be determined, so the caller no-ops safely.
 */
async function resolveTeam(
  orch: KeptOrchestrator,
  action: WebhookAction,
  headerTeam: string | undefined,
  opts: WebhookServerOpts,
): Promise<string | null> {
  const explicit = headerTeam ?? opts.teamId;
  if (explicit) return explicit;
  if (opts.listTeamIds && action.kind !== "ignore") {
    const teams = await opts.listTeamIds();
    return orch.teamForRefs(teams, action.refs);
  }
  return null;
}

function endJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** The shared request handler — identical for the standalone server and Bolt customRoutes. */
async function handleWebhook(
  orch: KeptOrchestrator,
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebhookServerOpts,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end("method not allowed");
    return;
  }
  // Authenticate the delivery. In hosted mode (requireSecret) a matching secret is MANDATORY
  // and we fail closed if none is configured — so no one can POST forged proof to /webhooks/*.
  if (opts.requireSecret || opts.secret) {
    if (!opts.secret || req.headers["x-kept-secret"] !== opts.secret) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
  }

  const action = mapByPath(pathnameOf(req), await readJson(req));
  if (action === null) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const headerTeam = req.headers["x-kept-team"];
  const team = await resolveTeam(orch, action, Array.isArray(headerTeam) ? headerTeam[0] : headerTeam, opts);
  if (!team) {
    // Safe failure mode (W1/W2): a delivery we cannot attribute to a tenant is a no-op.
    endJson(res, 200, { status: "no-op: unknown team" });
    return;
  }

  const status = await applyWebhookAction(orch, action, team);
  endJson(res, 200, { status });
}

/** Standalone webhook server (Socket Mode / single-token dev path). Also serves the W6 trust page. */
export function createWebhookServer(orch: KeptOrchestrator, opts: WebhookServerOpts = {}): Server {
  const trustLimiter = new TrustRateLimiter();
  return createServer((req, res) => {
    // W6 — `GET /trust/:token` (params aren't populated by the bare node server, so the
    // handler falls back to parsing the token out of the path).
    if (req.method === "GET" && pathnameOf(req).startsWith("/trust/")) {
      handleTrustRequest(() => orch, trustLimiter, req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err instanceof Error ? err.message : err));
      });
      return;
    }
    handleWebhook(orch, req, res, opts).catch((err) => {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? err.message : err));
    });
  });
}

/**
 * W2 — the same webhook routes as Bolt `customRoutes`, served on the single OAuth
 * HTTP PORT alongside `/slack/events`. Also adds `GET /healthz` and W6's
 * `GET /trust/:token` (the customer trust page). `getOrch` is a getter so the
 * routes can be built (at App construction) before the orchestrator exists.
 */
export function keptCustomRoutes(getOrch: () => KeptOrchestrator, opts: WebhookServerOpts = {}): CustomRoute[] {
  const webhook = (req: IncomingMessage, res: ServerResponse): void => {
    handleWebhook(getOrch(), req, res, opts).catch((err) => {
      res.statusCode = 500;
      res.end(String(err instanceof Error ? err.message : err));
    });
  };
  const webhookRoute = (path: string): CustomRoute => ({ path, method: "POST", handler: webhook });

  return [
    webhookRoute("/webhooks/linear"),
    webhookRoute("/webhooks/jira"),
    webhookRoute("/webhooks/github"),
    webhookRoute("/webhooks/deploy"),
    {
      path: "/healthz",
      method: "GET",
      handler: (_req, res) => endJson(res, 200, { status: "ok" }),
    },
    // W6 — the customer trust page. Resolves the opaque token to a scoped, audience-safe
    // view; unknown/revoked → 404 (no existence leak); noindex + no-store + rate-limited.
    trustCustomRoute(getOrch),
  ];
}
