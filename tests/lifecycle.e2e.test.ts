import { describe, it, expect } from "vitest";
import {
  buildEnv,
  ctx,
  slackSource,
  AM,
  prMerged,
  prodDeploy,
  ticketDone,
  NOW,
  ISO_NOW,
  T_ACME,
} from "../src/eval/scenarios.js";
import { buildClosureDraft } from "../src/policy/audience.js";

const detect = (env: ReturnType<typeof buildEnv>, key: string, over: Record<string, unknown> = {}) =>
  env.service.detectRequest({
    team: T_ACME,
    direction: "TEAM_OWES_CUSTOMER",
    signal: "CUSTOMER_REQUEST",
    customer: "Acme",
    subject_canonical: "SSO_LOGIN_BUG",
    outcome: "SSO login fix",
    due: "2026-06-19",
    owner: "U_ENG",
    conditions: [],
    actor: AM,
    source: slackSource("https://acme.slack.com/p/1"),
    idempotencyKey: key,
    at: ISO_NOW,
    now: NOW,
    ...over,
  });

describe("end-to-end obligation lifecycle (P0)", () => {
  it("runs the full loop: detect → Gate 1 → work → fulfillment → Gate 2 → notify → close", async () => {
    const env = buildEnv();
    const det = await detect(env, "slack:T:C:1:request_detected");
    expect(det.status).toBe("created");
    const id = det.status === "created" ? det.obligation.id : "";
    expect(det.status === "created" && det.obligation.state).toBe("CANDIDATE");

    const g1 = await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, "g1", { approvedBy: "U_ACCOUNT_MANAGER" }));
    expect(g1.obligation?.state).toBe("OPEN");

    await env.service.dispatch({ kind: "LINK_WORK_ITEM", work_system: "linear", work_ref: "PROJ-118" }, ctx(id, "link", { approvedBy: "U_ACCOUNT_MANAGER" }));
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "start"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR-449") }, ctx(id, "github:PR-449:merged"));
    const pf = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "2026.06.18") }, ctx(id, "deploy:2026.06.18:prod"));
    expect(pf.obligation?.state).toBe("POSSIBLE_FULFILLMENT");

    const g2 = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "merge + prod deploy" }, ctx(id, "verify", { approvedBy: "U_ACCOUNT_MANAGER" }));
    expect(g2.obligation?.state).toBe("VERIFIED");

    const draft = buildClosureDraft(g2.obligation!);
    expect(draft.clean).toBe(true);

    await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: draft.text, draftRef: "thread-reply" }, ctx(id, "notify", { approvedBy: "U_ACCOUNT_MANAGER" }));
    const closed = await env.service.dispatch({ kind: "RECORD_CUSTOMER_CONFIRMATION" }, ctx(id, "cust-confirm"));
    expect(closed.obligation?.state).toBe("CLOSED");

    const events = await env.service.getEvents(id);
    expect(events.length).toBeGreaterThanOrEqual(8); // full audit history
  });

  it("suppresses a duplicate detection event (idempotency)", async () => {
    const env = buildEnv();
    const a = await detect(env, "dupkey");
    const b = await detect(env, "dupkey");
    expect(a.status).toBe("created");
    expect(b.status).toBe("suppressed");
    expect((await env.store.getAllObligationIds(T_ACME)).length).toBe(1);
  });

  it("attaches a follow-up message to the same obligation (semantic dedupe)", async () => {
    const env = buildEnv();
    const a = await detect(env, "k1");
    const b = await detect(env, "k2", { outcome: "SSO status", due: null });
    expect(b.status).toBe("deduped");
    expect(b.status === "deduped" && b.obligation.id).toBe(a.status === "created" ? a.obligation.id : "");
  });

  it("never closes on a ticket-Done signal alone (no false closure)", async () => {
    const env = buildEnv();
    const id = (await detect(env, "k")).status === "created" ? (await env.store.getAllObligationIds(T_ACME))[0] : "";
    await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "o", due: "2026-06-19", owner: "U_ENG" }, ctx(id, "c", { approvedBy: "U_ACCOUNT_MANAGER" }));
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "s"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ticketDone("t", "PROJ-118") }, ctx(id, "f"));
    const verify = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "try" }, ctx(id, "v", { approvedBy: "U_ACCOUNT_MANAGER" }));
    expect(verify.status).toBe("rejected");
    expect(verify.code).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("reopens after customer dispute — obligation outlives the ticket", async () => {
    const env = buildEnv();
    const det = await detect(env, "k");
    const id = det.status === "created" ? det.obligation.id : "";
    await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "o", due: "2026-06-19", owner: "U_ENG" }, ctx(id, "c", { approvedBy: "U_ACCOUNT_MANAGER" }));
    await env.service.dispatch({ kind: "LINK_WORK_ITEM", work_system: "linear", work_ref: "PROJ-118" }, ctx(id, "lk", { approvedBy: "U_ACCOUNT_MANAGER" }));
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "s"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id, "pr"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id, "dp"));
    await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "ok" }, ctx(id, "v", { approvedBy: "U_ACCOUNT_MANAGER" }));
    await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: "Hi — the SSO login fix is now available. Could you confirm it works?", draftRef: "r" }, ctx(id, "n", { approvedBy: "U_ACCOUNT_MANAGER" }));
    const reopened = await env.service.dispatch({ kind: "REOPEN", reason: "still fails for one user" }, ctx(id, "ro"));
    expect(reopened.obligation?.state).toBe("REOPENED");
    expect(reopened.obligation?.work_item?.ref).toBe("PROJ-118");
    expect(reopened.obligation?.flags.is_disputed).toBe(true);
  });
});
