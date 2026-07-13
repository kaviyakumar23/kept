import { describe, it, expect, beforeAll } from "vitest";
import { encryptSecret, decryptSecret, secretEquals, tokenHint } from "../src/store/crypto.js";
import { InMemoryTenantConfigStore } from "../src/store/tenantConfigStore.js";

/**
 * Per-tenant integration config — the surface a workspace uses to connect ITS OWN proof sources.
 * Two guarantees under test: (1) provider tokens are encrypted at rest, and (2) a config set for
 * one workspace is never readable by another (invariant #4, P0). The Postgres store encrypts every
 * value with {@link encryptSecret}; the in-memory store carries the same (team_id, provider) key
 * discipline, so its isolation behaviour mirrors production.
 */
describe("tenant config — encryption at rest", () => {
  beforeAll(() => {
    process.env.KEPT_CONFIG_KEY = "0".repeat(64); // deterministic 32-byte hex key for the tests
  });

  it("round-trips a secret through AES-256-GCM (ciphertext never contains the plaintext)", () => {
    const secret = "xoxb-super-secret-token-123";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("uses a fresh IV per call — the same plaintext encrypts to different ciphertext", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext (GCM authentication)", () => {
    const raw = Buffer.from(encryptSecret("secret"), "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptSecret(raw.toString("base64"))).toThrow();
  });

  it("secretEquals is length-safe and correct", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
  });

  it("tokenHint is a short non-reversible fingerprint, never the token", () => {
    const h = tokenHint("ghp_some-real-looking-token");
    expect(h).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe("tenant config — notification preferences (Slack: configurable notifications)", () => {
  beforeAll(() => {
    process.env.KEPT_CONFIG_KEY = "0".repeat(64);
  });

  it("round-trips a per-workspace reminders setting; unset defaults to ON", async () => {
    const store = new InMemoryTenantConfigStore();
    // Unset → undefined → the reminder handler treats it as ON (default).
    expect(await store.get("T1", "notifications")).toBeNull();
    await store.set("T1", "notifications", { reminders: false }); // /kept notify off
    expect((await store.get("T1", "notifications"))?.reminders).toBe(false);
    await store.set("T1", "notifications", { reminders: true }); // /kept notify on
    expect((await store.get("T1", "notifications"))?.reminders).toBe(true);
  });

  it("is tenant-scoped — one workspace muting reminders never affects another (invariant #4)", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_MUTED", "notifications", { reminders: false });
    expect((await store.get("T_MUTED", "notifications"))?.reminders).toBe(false);
    expect(await store.get("T_OTHER", "notifications")).toBeNull(); // unaffected → reminders on
  });
});

describe("tenant config — per-tenant isolation (invariant #4)", () => {
  it("a config set for team A is NOT readable by team B", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "launchdarkly", { mcpToken: "A-secret", projectKey: "acme" });
    expect(await store.get("T_A", "launchdarkly")).toEqual({ mcpToken: "A-secret", projectKey: "acme" });
    expect(await store.get("T_B", "launchdarkly")).toBeNull(); // cross-tenant read → nothing
    expect(await store.listConfigured("T_B")).toEqual([]); // B sees none of A's providers
  });

  it("listConfigured returns only the acting team's configured providers", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "launchdarkly", { mcpToken: "x" });
    await store.set("T_A", "github", { token: "y" });
    await store.set("T_B", "jira", { apiToken: "z" });
    expect((await store.listConfigured("T_A")).sort()).toEqual(["github", "launchdarkly"]);
    expect(await store.listConfigured("T_B")).toEqual(["jira"]);
  });

  it("remove deletes only the (team, provider) row — never another tenant's", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_A", "github", { token: "y" });
    await store.set("T_B", "github", { token: "z" });
    await store.remove("T_A", "github");
    expect(await store.get("T_A", "github")).toBeNull();
    expect(await store.get("T_B", "github")).toEqual({ token: "z" }); // B untouched
  });

  it("stores a deep copy — mutating the caller's object doesn't bleed into stored config", async () => {
    const store = new InMemoryTenantConfigStore();
    const input = { token: "y" };
    await store.set("T_A", "github", input);
    input.token = "MUTATED";
    expect(await store.get("T_A", "github")).toEqual({ token: "y" });
  });
});
