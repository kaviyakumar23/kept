import { describe, it, expect } from "vitest";
import { requireTeam } from "../src/server/slackApp.js";

/**
 * W2 (invariant #4) — the acting-workspace resolver must fail CLOSED. A signed Slack
 * write whose payload carries no resolvable team must be rejected, not silently routed
 * onto the orchestrator's internal (no-cross-tenant-check) path.
 */
describe("requireTeam — fail-closed acting-workspace resolver", () => {
  it("rejects a Slack write with no resolvable acting team", () => {
    expect(() => requireTeam({ user: { id: "U" } })).toThrow(); // no team.id and no user.team_id
    expect(requireTeam({ team: { id: "T_X" } })).toBe("T_X");
    expect(requireTeam({ user: { id: "U", team_id: "T_Y" } })).toBe("T_Y");
  });
});
