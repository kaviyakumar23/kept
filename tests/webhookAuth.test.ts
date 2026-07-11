import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createWebhookServer } from "../src/server/webhookServer.js";

/**
 * Adversary regression (webhook-auth, P0): in HOSTED OAuth mode `webhookOpts.requireSecret`
 * is `true` (src/server/index.ts:198). This locks that the auth block in `handleWebhook`
 * (src/server/webhookServer.ts:112) FAILS CLOSED: an unauthenticated caller can never POST a
 * forged fulfillment signal to /webhooks/*. If any unsigned inject reaches the orchestrator
 * these tests go red.
 */

// Orchestrator stub that EXPLODES if any inject method is reached — proves the auth block
// short-circuits before any obligation mutation / entity-graph resolution.
function tripwireOrch() {
  return {
    recordFulfillmentSignal: async () => {
      throw new Error("SECURITY: recordFulfillmentSignal reached without a valid secret");
    },
    startWork: async () => {
      throw new Error("SECURITY: startWork reached without a valid secret");
    },
    teamForRefs: async () => {
      throw new Error("SECURITY: teamForRefs reached without a valid secret");
    },
  } as never;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// A well-formed Linear "Done" delivery = a fulfillment signal (forged proof if unauthenticated).
const DONE_BODY = JSON.stringify({
  type: "Issue",
  action: "update",
  data: { identifier: "PROJ-118", state: { name: "Done" }, updatedAt: "2026-06-18T10:00:00Z" },
});

async function post(base: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/webhooks/linear`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: DONE_BODY,
  });
  return { status: res.status, text: await res.text() };
}

describe("hosted-mode webhook auth fails closed (forged-proof injection is unreachable)", () => {
  it("requireSecret + NO secret configured → 401 (fail closed, not open)", async () => {
    // The dangerous misconfig: someone deploys hosted (requireSecret:true) but forgets
    // KEPT_WEBHOOK_SECRET. It MUST reject, never fall through to processing.
    const base = await listen(createWebhookServer(tripwireOrch(), { requireSecret: true }));
    const r = await post(base);
    expect(r.status).toBe(401);
    expect(r.text).toBe("unauthorized");
  });

  it("requireSecret + empty-string secret → still 401 (empty secret is not a valid credential)", async () => {
    const base = await listen(createWebhookServer(tripwireOrch(), { requireSecret: true, secret: "" }));
    // Even if the attacker sends a matching empty header, `!opts.secret` short-circuits.
    const r = await post(base, { "x-kept-secret": "" });
    expect(r.status).toBe(401);
  });

  it("requireSecret + secret set, MISSING header → 401", async () => {
    const base = await listen(createWebhookServer(tripwireOrch(), { requireSecret: true, secret: "topsecret" }));
    const r = await post(base);
    expect(r.status).toBe(401);
  });

  it("requireSecret + secret set, WRONG header → 401", async () => {
    const base = await listen(createWebhookServer(tripwireOrch(), { requireSecret: true, secret: "topsecret" }));
    const r = await post(base, { "x-kept-secret": "guess" });
    expect(r.status).toBe(401);
  });

  it("requireSecret + secret set, DUPLICATED header (node joins → array/csv) → 401", async () => {
    const base = await listen(createWebhookServer(tripwireOrch(), { requireSecret: true, secret: "topsecret" }));
    // fetch can't send dupes easily; simulate the smuggle attempt with a comma-joined value.
    const r = await post(base, { "x-kept-secret": "topsecret, topsecret" });
    expect(r.status).toBe(401);
  });

  it("requireSecret + CORRECT secret → passes auth (reaches processing; here no team → 200 no-op)", async () => {
    // Prove a matching secret is genuinely accepted (not a blanket-deny bug): with no
    // team resolvable, processing safely no-ops at 200 — but crucially it is NOT 401.
    const recordingOrch = {
      recordFulfillmentSignal: async () => ({ kind: "no_match" as const }),
      startWork: async () => undefined,
      teamForRefs: async () => null,
    } as never;
    const base = await listen(createWebhookServer(recordingOrch, { requireSecret: true, secret: "topsecret" }));
    const r = await post(base, { "x-kept-secret": "topsecret" });
    expect(r.status).not.toBe(401);
    expect(r.status).toBe(200);
  });
});
