import { describe, it, expect, vi } from "vitest";
import { isOAuthMode, assertProductionOAuth, type KeptConfig } from "../src/config.js";
import { buildSlackApp } from "../src/server/slackApp.js";
import { SlackNotifier, type SlackClientLike } from "../src/server/slackNotifier.js";
import type { Notifier } from "../src/slack/notifier.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * W2 / invariant #6 — OAuth posture (adversary round 8).
 *
 * The deployed app must authorize via per-workspace OAuth (InstallationStore) with NO
 * hard-coded single-workspace bot token: even the developer's own workspace installs
 * through OAuth. These tests lock the two structural guarantees that make that true:
 *
 *  1. Mode selection is driven ONLY by the OAuth trio (client id/secret + state secret).
 *     A lone SLACK_BOT_TOKEN never masquerades as OAuth mode.
 *  2. Every out-of-band send (reminders, webhook-driven closures) resolves the acting
 *     tenant's bot token through `installationStore.fetchInstallation`, never a captured
 *     global/static token.
 *  3. A production process fails CLOSED: `assertProductionOAuth` throws at boot if the OAuth
 *     trio is absent, so a stray SLACK_BOT_TOKEN can never silently run single-workspace in
 *     production (the single-token / Socket Mode path is local-dev only). Belt to the
 *     manual fly.toml secret-name check.
 */

function cfg(over: Partial<KeptConfig["slack"]>): KeptConfig {
  return {
    slack: {
      botToken: undefined,
      signingSecret: "sign",
      appToken: undefined,
      clientId: undefined,
      clientSecret: undefined,
      stateSecret: undefined,
      ...over,
    },
  } as unknown as KeptConfig;
}

function fakeClient(tag: string) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    tag,
    calls,
    chat: {
      postMessage: async (a: any) => {
        calls.push({ m: "postMessage", ...a });
        return { ts: "1712.0001", channel: a.channel };
      },
      update: async (a: any) => {
        calls.push({ m: "update", ...a });
      },
    },
    conversations: {
      open: async (a: any) => {
        calls.push({ m: "open", ...a });
        return { channel: { id: `D_${tag}` } };
      },
    },
  };
  return client as unknown as SlackClientLike & { tag: string; calls: Array<Record<string, unknown>> };
}

describe("OAuth posture — mode selection is driven only by the OAuth trio", () => {
  it("enables OAuth mode iff clientId + clientSecret + stateSecret are all present", () => {
    expect(isOAuthMode(cfg({ clientId: "c", clientSecret: "s", stateSecret: "st" }))).toBe(true);
    // Trio wins even if a bot token is also present.
    expect(isOAuthMode(cfg({ clientId: "c", clientSecret: "s", stateSecret: "st", botToken: "xoxb-x" }))).toBe(true);
  });

  it("a lone SLACK_BOT_TOKEN never masquerades as OAuth mode (single-token/dev path)", () => {
    expect(isOAuthMode(cfg({ botToken: "xoxb-hardcoded" }))).toBe(false);
  });

  it("any missing member of the trio disables OAuth mode (fails toward the dev path, never a half-configured OAuth)", () => {
    expect(isOAuthMode(cfg({ clientId: "c", clientSecret: "s" }))).toBe(false); // no stateSecret
    expect(isOAuthMode(cfg({ clientId: "c", stateSecret: "st" }))).toBe(false); // no clientSecret
    expect(isOAuthMode(cfg({ clientSecret: "s", stateSecret: "st" }))).toBe(false); // no clientId
  });
});

describe("OAuth posture — production fails closed on the single-workspace token path", () => {
  it("a production process without the OAuth trio throws at boot (a stray SLACK_BOT_TOKEN can't run single-workspace)", () => {
    expect(() => assertProductionOAuth(cfg({ botToken: "xoxb-hardcoded" }), "production")).toThrow(/Production requires OAuth/);
    expect(() => assertProductionOAuth(cfg({}), "production")).toThrow(/Production requires OAuth/);
  });

  it("a production process WITH the OAuth trio boots fine (even if a bot token is also present)", () => {
    expect(() => assertProductionOAuth(cfg({ clientId: "c", clientSecret: "s", stateSecret: "st" }), "production")).not.toThrow();
    expect(() => assertProductionOAuth(cfg({ clientId: "c", clientSecret: "s", stateSecret: "st", botToken: "xoxb-x" }), "production")).not.toThrow();
  });

  it("outside production the single-token dev path is still allowed (no throw)", () => {
    expect(() => assertProductionOAuth(cfg({ botToken: "xoxb-dev" }), "development")).not.toThrow();
    expect(() => assertProductionOAuth(cfg({ botToken: "xoxb-dev" }), undefined)).not.toThrow();
  });
});

describe("OAuth posture — out-of-band sends resolve the per-tenant token", () => {
  it("SlackNotifier routes a team-scoped send to that tenant's client, never the captured default", async () => {
    const def = fakeClient("DEFAULT");
    const tenant = fakeClient("T_B");
    const clientForTeam = async (teamId: string): Promise<SlackClientLike> => {
      if (teamId === "T_B") return tenant;
      throw new Error(`unexpected team ${teamId}`);
    };
    const notifier = new SlackNotifier(def, clientForTeam);

    await notifier.sendPrivate("U_OWNER", { text: "nudge" }, "T_B");
    expect(tenant.calls.some((c) => c.m === "postMessage")).toBe(true);
    // The single captured (dev) client must NOT be used for a tenant-scoped send.
    expect(def.calls.length).toBe(0);
  });

  it("SlackNotifier falls back to the captured client only when NO team is supplied (dev path)", async () => {
    const def = fakeClient("DEFAULT");
    const clientForTeam = vi.fn(async () => fakeClient("SHOULD_NOT_BE_CALLED"));
    const notifier = new SlackNotifier(def, clientForTeam);

    await notifier.sendPrivate("U_OWNER", { text: "nudge" }); // no team
    expect(def.calls.some((c) => c.m === "postMessage")).toBe(true);
    expect(clientForTeam).not.toHaveBeenCalled();
  });
});

describe("OAuth posture — buildSlackApp wires per-tenant tokens through the InstallationStore", () => {
  it("in OAuth mode, an out-of-band send resolves the acting team's token via installationStore.fetchInstallation (no static token)", async () => {
    // fetchInstallation records the query, then throws a sentinel so no real WebClient
    // network call is attempted. The throw proves the send path went THROUGH the install
    // store (per-tenant) rather than a captured global/static token.
    const fetchInstallation = vi.fn(async ({ teamId }: any) => {
      throw new Error(`SENTINEL_${teamId}`);
    });
    const installationStore = {
      fetchInstallation,
      storeInstallation: async () => {},
      deleteInstallation: async () => {},
    } as any;

    let captured: Notifier | undefined;
    buildSlackApp({
      signingSecret: "sign",
      oauth: {
        clientId: "c",
        clientSecret: "cs",
        stateSecret: "ss",
        scopes: ["chat:write"],
        installationStore,
      },
      llm: {} as any,
      makeOrchestrator: (n) => {
        captured = n;
        return {} as any;
      },
    });

    expect(captured).toBeDefined();
    await expect(captured!.sendPrivate("U_OWNER", { text: "reminder" }, "T_TENANT")).rejects.toThrow(/SENTINEL_T_TENANT/);
    expect(fetchInstallation).toHaveBeenCalledWith(expect.objectContaining({ teamId: "T_TENANT" }));
  });
});
