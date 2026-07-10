import { describe, it, expect } from "vitest";
import { InMemoryTenantConfigStore, INTEGRATION_PROVIDERS } from "../src/store/tenantConfigStore.js";

/**
 * Adversary round 8 — uninstall data-deletion for per-tenant SECRETS (invariant #4 + the
 * Marketplace "data is deleted on uninstall" guarantee stated in slackApp.ts:205-206).
 *
 * The bug this locks: the uninstall purge (`app_uninstalled` / `tokens_revoked` →
 * `purgeTenant` → `store.purgeTeam`) deletes obligations / trust links / reminders / roadmap,
 * and `deleteInstallation` drops the bot token — but NOTHING ever deletes the departed
 * workspace's `tenant_config` rows. Those rows hold the workspace's encrypted proof-source
 * secrets (LaunchDarkly / Jira / GitHub API tokens). Neither `PostgresEventStore.purgeTeam`
 * nor the in-memory purge nor any Connections handler calls `TenantConfigStore.remove`, so a
 * customer's provider tokens are retained indefinitely after they uninstall Kept.
 *
 * The fix wires a single team-scoped purge into the uninstall path. We assert the store can
 * purge every provider row for ONE team in one call, leaving other tenants intact. This test
 * FAILS today (`purgeTeam` is not implemented on the config store) and PASSES once the fix
 * adds it and the `purgeTenant` closure in server/index.ts invokes it.
 */
describe("invariant #4 — uninstall must delete a tenant's stored provider secrets", () => {
  it("TenantConfigStore purges ALL of one team's provider rows; other tenants untouched", async () => {
    const store = new InMemoryTenantConfigStore();
    // Departing tenant configured three secret-bearing providers + a proof-target map.
    await store.set("T_GONE", "github", { token: "ghp_departing_secret" });
    await store.set("T_GONE", "launchdarkly", { mcpToken: "ld_departing_secret", projectKey: "acme" });
    await store.set("T_GONE", "jira", { apiToken: "jira_departing_secret", email: "a@b.co", baseUrl: "https://x.atlassian.net" });
    await store.set("T_GONE", "proof_targets", { Acme: { flag: { key: "acme-ga" } } });
    // A different, still-installed tenant configured GitHub — must survive the purge.
    await store.set("T_STAYS", "github", { token: "ghp_other_tenant" });

    // Precondition: the departing tenant's secrets are present.
    expect((await store.listConfigured("T_GONE")).sort()).toEqual(["github", "jira", "launchdarkly", "proof_targets"]);

    // The uninstall data-deletion path must purge every provider row for the team in ONE call.
    // (Fails today: InMemoryTenantConfigStore has no `purgeTeam`.)
    const purge = (store as unknown as { purgeTeam?: (teamId: string) => Promise<number> }).purgeTeam;
    expect(typeof purge).toBe("function");
    await purge!.call(store, "T_GONE");

    // Every secret-bearing row for the departed tenant is gone.
    expect(await store.listConfigured("T_GONE")).toEqual([]);
    for (const p of INTEGRATION_PROVIDERS) {
      expect(await store.get("T_GONE", p)).toBeNull();
    }

    // The still-installed tenant is completely intact.
    expect(await store.get("T_STAYS", "github")).toEqual({ token: "ghp_other_tenant" });
    expect(await store.listConfigured("T_STAYS")).toEqual(["github"]);
  });

  it("purging a tenant with no config is a zero no-op (idempotent, re-delivered uninstall)", async () => {
    const store = new InMemoryTenantConfigStore();
    await store.set("T_STAYS", "github", { token: "keep" });
    const purge = (store as unknown as { purgeTeam?: (teamId: string) => Promise<number> }).purgeTeam;
    expect(typeof purge).toBe("function");
    await purge!.call(store, "T_UNKNOWN"); // never configured → deletes nothing, touches no one
    expect(await store.get("T_STAYS", "github")).toEqual({ token: "keep" });
  });
});
