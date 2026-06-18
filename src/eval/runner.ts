/**
 * Kept evaluation harness (E4) — independent, reproducible, honest numbers.
 *
 * Two families of metrics:
 *   1. Lifecycle & safety — driven entirely through the deterministic engine, so
 *      duplicate-suppression, false-closure, unauthorized-action, and leakage
 *      results are guarantees (by construction), demonstrated across many scenarios.
 *   2. Classification — runs the configured LLM provider over a gold-labeled
 *      corpus. Offline (no API key) it scores a heuristic baseline; with
 *      ANTHROPIC_API_KEY set it reports the real model's numbers.
 *
 * Run: `npm run eval`  (alias: `npm run demo`)
 */
import { loadConfig } from "../config.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { MockLlmProvider } from "../llm/mock.js";
import { classifyMessage } from "../llm/classify.js";
import { extractObligation } from "../llm/extract.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ObligationSignal } from "../domain/signals.js";
import { buildClosureDraft, detectLeaks } from "../policy/audience.js";
import { computeReminders } from "../scheduler/scheduler.js";
import type { Evidence } from "../domain/evidence.js";
import {
  buildEnv,
  ctx,
  slackSource,
  CLASSIFICATION_CORPUS,
  heuristicResponder,
  ticketDone,
  prMerged,
  prodDeploy,
  stagingDeploy,
  customerConfirmed,
  NOW,
  ISO_NOW,
  type Env,
} from "./scenarios.js";

type Category = "transition" | "dedupe" | "false_closure" | "unauthorized" | "leakage" | "reminder" | "reopen" | "supersession";
interface Check { name: string; pass: boolean; category: Category; detail?: string }

const ok = (name: string, pass: boolean, category: Category, detail?: string): Check => ({ name, pass, category, detail });

// --------------------------------------------------------------------------
// Lifecycle / safety scenarios (deterministic engine)
// --------------------------------------------------------------------------

/** Drive a fresh obligation up to a chosen point. Returns env + obligation id. */
async function detectAndOpen(env: Env, key: string): Promise<string> {
  const det = await env.service.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST",
    customer: "Acme",
    subject_canonical: "SSO_LOGIN_BUG",
    outcome: "SSO login fix",
    due: "2026-06-19",
    owner: "U_ENG",
    conditions: [],
    actor: AM_USER,
    source: slackSource("https://acme.slack.com/p/1"),
    idempotencyKey: key,
    at: new Date(NOW).toISOString(),
    now: NOW,
  });
  if (det.status !== "created") throw new Error(`expected created, got ${det.status}`);
  const id = det.obligation.id;
  await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, `${key}:confirm`, { approvedBy: "U_ACCOUNT_MANAGER" }));
  return id;
}
const AM_USER = "user:U_ACCOUNT_MANAGER" as const;

async function happyPathClosure(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const id = await detectAndOpen(env, "slack:T:C:1:request_detected");

  const link = await env.service.dispatch({ kind: "LINK_WORK_ITEM", work_system: "linear", work_ref: "PROJ-118" }, ctx(id, "link:PROJ-118", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("work item linked", link.status === "applied", "transition"));

  const start = await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "start:1"));
  c.push(ok("OPEN→IN_PROGRESS", start.status === "applied" && start.obligation?.state === "IN_PROGRESS", "transition"));

  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("e_pr", "PR-449") }, ctx(id, "github:PR-449:merged"));
  const sig = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("e_dep", "2026.06.18") }, ctx(id, "deploy:2026.06.18:prod"));
  c.push(ok("IN_PROGRESS→POSSIBLE_FULFILLMENT", sig.obligation?.state === "POSSIBLE_FULFILLMENT", "transition"));

  const verify = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "merge + prod deploy reach Acme" }, ctx(id, "verify:1", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("Gate 2 verify (sufficient evidence + approval)", verify.status === "applied" && verify.obligation?.state === "VERIFIED", "transition"));

  // Build + check the customer-facing draft BEFORE notifying.
  const draft = buildClosureDraft(verify.obligation!);
  c.push(ok("closure draft is leak-free", draft.clean, "leakage", draft.text));
  c.push(ok("internal sources redacted from customer view", draft.safe.redactedCount > 0, "leakage"));

  const notify = await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: draft.text, draftRef: "thread-reply-1" }, ctx(id, "notify:1", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("VERIFIED→CUSTOMER_NOTIFIED", notify.obligation?.state === "CUSTOMER_NOTIFIED", "transition"));

  const close = await env.service.dispatch({ kind: "RECORD_CUSTOMER_CONFIRMATION" }, ctx(id, "confirm:cust:1"));
  c.push(ok("CUSTOMER_NOTIFIED→CLOSED", close.obligation?.state === "CLOSED", "transition"));

  const events = await env.service.getEvents(id);
  c.push(ok("full audit history retained", events.length >= 8, "transition", `${events.length} events`));
  return c;
}

async function duplicateSuppression(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const key = "slack:T:C:42:request_detected";
  const first = await env.service.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix",
    due: "2026-06-19", owner: null, conditions: [], actor: AM_USER, source: slackSource("p"), idempotencyKey: key, at: new Date(NOW).toISOString(), now: NOW,
  });
  const dup = await env.service.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix",
    due: "2026-06-19", owner: null, conditions: [], actor: AM_USER, source: slackSource("p"), idempotencyKey: key, at: new Date(NOW).toISOString(), now: NOW,
  });
  c.push(ok("duplicate Slack event suppressed", first.status === "created" && dup.status === "suppressed", "dedupe"));

  if (first.status !== "created") throw new Error("expected created obligation");
  const id = first.obligation.id;
  await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, "c:1", { approvedBy: "U_ACCOUNT_MANAGER" }));
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "s:1"));
  const w1 = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ticketDone("t1", "PROJ-118") }, ctx(id, "linear:PROJ-118:2026-06-18T10:00:Done"));
  const w2 = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ticketDone("t1", "PROJ-118") }, ctx(id, "linear:PROJ-118:2026-06-18T10:00:Done"));
  c.push(ok("duplicate Linear webhook suppressed", w1.status === "applied" && w2.status === "suppressed", "dedupe"));
  return c;
}

async function semanticDedupe(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const a = await env.service.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix",
    due: "2026-06-19", owner: null, conditions: [], actor: AM_USER, source: slackSource("p1"), idempotencyKey: "slack:T:C:1:request_detected", at: new Date(NOW).toISOString(), now: NOW,
  });
  // "any update on that login issue?" → same canonical subject, different ts → attach.
  const b = await env.service.detectRequest({
    direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login status",
    due: null, owner: null, conditions: [], actor: AM_USER, source: slackSource("p2"), idempotencyKey: "slack:T:C:2:request_detected", at: new Date(NOW).toISOString(), now: NOW,
  });
  c.push(ok("semantic dedupe attaches to existing obligation", a.status === "created" && b.status === "deduped" && b.obligation?.id === a.obligation?.id, "dedupe"));
  const ids = await env.store.getAllObligationIds();
  c.push(ok("no duplicate obligation created", ids.length === 1, "dedupe"));
  return c;
}

async function reopenOutlivesTicket(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const id = await detectAndOpen(env, "slack:T:C:7:request_detected");
  await env.service.dispatch({ kind: "LINK_WORK_ITEM", work_system: "linear", work_ref: "PROJ-118" }, ctx(id, "lk", { approvedBy: "U_ACCOUNT_MANAGER" }));
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "st"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("pr", "PR-449") }, ctx(id, "pr"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("dp", "rel") }, ctx(id, "dp"));
  await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "ok" }, ctx(id, "vf", { approvedBy: "U_ACCOUNT_MANAGER" }));
  await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: "Hi — the SSO login fix is now available. Could you confirm it works?", draftRef: "r" }, ctx(id, "nt", { approvedBy: "U_ACCOUNT_MANAGER" }));
  const reopened = await env.service.dispatch({ kind: "REOPEN", reason: "customer says it still fails for one user" }, ctx(id, "ro"));
  c.push(ok("customer dispute reopens obligation", reopened.obligation?.state === "REOPENED", "reopen"));
  c.push(ok("reopened obligation is flagged disputed", reopened.obligation?.flags.is_disputed === true, "reopen"));
  c.push(ok("obligation outlives the ticket (work_item still linked)", reopened.obligation?.work_item?.ref === "PROJ-118", "reopen"));
  const back = await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "ro:start"));
  c.push(ok("REOPENED→IN_PROGRESS", back.obligation?.state === "IN_PROGRESS", "reopen"));
  return c;
}

/** Adversarial: every insufficient-evidence verification must be rejected (no false closure). */
async function falseClosureFamily(): Promise<Check[]> {
  const c: Check[] = [];
  const insufficient: { name: string; evidence: ReturnType<typeof ticketDone>[] }[] = [
    { name: "ticket Done only", evidence: [ticketDone("t", "PROJ-1")] },
    { name: "PR merged only", evidence: [prMerged("p", "PR-1")] },
    { name: "staging deploy only", evidence: [stagingDeploy("s", "rel-staging")] },
    { name: "ticket Done + PR merged (no deploy)", evidence: [ticketDone("t", "PROJ-1"), prMerged("p", "PR-1")] },
    { name: "PR merged + staging deploy (not customer-scoped)", evidence: [prMerged("p", "PR-1"), stagingDeploy("s", "rel-staging")] },
    { name: "ticket Done + staging deploy", evidence: [ticketDone("t", "PROJ-1"), stagingDeploy("s", "rel-staging")] },
  ];
  for (const combo of insufficient) {
    const env = buildEnv();
    const id = await detectAndOpen(env, `fc:${combo.name}`);
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, `${combo.name}:start`));
    let i = 0;
    for (const ev of combo.evidence) {
      await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ev }, ctx(id, `${combo.name}:ev:${i++}`));
    }
    const verify = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "attempt" }, ctx(id, `${combo.name}:verify`, { approvedBy: "U_ACCOUNT_MANAGER" }));
    c.push(ok(`verify rejected: ${combo.name}`, verify.status === "rejected" && verify.code === "INSUFFICIENT_EVIDENCE", "false_closure", verify.reason));
  }

  // Also: cannot notify before verifying, and cannot close before notifying.
  const env = buildEnv();
  const id = await detectAndOpen(env, "fc:order");
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "ord:start"));
  const earlyNotify = await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: "Hi — the SSO login fix is available. Could you confirm it works?", draftRef: "x" }, ctx(id, "ord:notify", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("cannot notify customer before VERIFIED", earlyNotify.status === "rejected", "false_closure"));
  const earlyClose = await env.service.dispatch({ kind: "RECORD_CUSTOMER_CONFIRMATION" }, ctx(id, "ord:close"));
  c.push(ok("cannot close before CUSTOMER_NOTIFIED", earlyClose.status === "rejected", "false_closure"));
  return c;
}

/** Adversarial: forged/mislabeled evidence and customer denials cannot drive closure. */
async function forgedEvidenceFamily(): Promise<Check[]> {
  const c: Check[] = [];
  const forged: { name: string; ev: Pick<Evidence, "source" | "kind" | "data"> }[] = [
    { name: "customer_reply forged on github source", ev: { source: "github", kind: "customer_reply", data: { confirmed: true } } },
    { name: "deploy claimed on linear source", ev: { source: "linear", kind: "deploy", data: { environment: "production" } } },
    { name: "pr_merged claimed on deploy source", ev: { source: "deploy", kind: "pr_merged", data: { merged: true } } },
  ];
  for (const f of forged) {
    const env = buildEnv();
    const id = await detectAndOpen(env, `forge:${f.name}`);
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, `${f.name}:s`));
    const ev: Evidence = { id: "x", ref: "r", at: ISO_NOW, accessible_to_user: true, proves: "forged", ...f.ev };
    const r = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ev }, ctx(id, `${f.name}:ev`));
    c.push(ok(`forged evidence rejected: ${f.name}`, r.status === "rejected" && r.code === "INCONSISTENT_EVIDENCE", "false_closure", r.reason));
  }

  // A customer denial blocks verification even with merge + prod deploy present.
  const env = buildEnv();
  const id = await detectAndOpen(env, "denial");
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "den:s"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id, "den:pr"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id, "den:dp"));
  await env.service.dispatch(
    { kind: "RECORD_FULFILLMENT_SIGNAL", evidence: { id: "cd", source: "customer", kind: "customer_reply", ref: "r2", at: "2026-06-20T00:00:00Z", accessible_to_user: true, data: { confirmed: false }, proves: "customer says it still fails" } },
    ctx(id, "den:cd"),
  );
  const verify = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "try" }, ctx(id, "den:v", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("customer denial blocks verification", verify.status === "rejected" && verify.code === "INSUFFICIENT_EVIDENCE", "false_closure", verify.reason));
  return c;
}

/** Adversarial: every gate transition without human approval must be rejected. */
async function unauthorizedActionFamily(): Promise<Check[]> {
  const c: Check[] = [];

  // CONFIRM_COMMITMENT without approval
  {
    const env = buildEnv();
    const det = await env.service.detectRequest({
      direction: "TEAM_OWES_CUSTOMER", signal: "CUSTOMER_REQUEST", customer: "Acme", subject_canonical: "SSO_LOGIN_BUG", outcome: "SSO login fix",
      due: "2026-06-19", owner: null, conditions: [], actor: AM_USER, source: slackSource("p"), idempotencyKey: "ua:1", at: new Date(NOW).toISOString(), now: NOW,
    });
    if (det.status !== "created") throw new Error("expected created obligation");
    const id = det.obligation.id;
    const r = await env.service.dispatch({ kind: "CONFIRM_COMMITMENT", outcome: "SSO login fix", due: "2026-06-19", owner: "U_ENG" }, ctx(id, "ua:confirm")); // no approvedBy
    c.push(ok("Gate 1 blocked without approval", r.status === "rejected" && r.code === "APPROVAL_REQUIRED", "unauthorized"));
  }
  // VERIFY without approval (with sufficient evidence)
  {
    const env = buildEnv();
    const id = await detectAndOpen(env, "ua:2");
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "ua2:s"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id, "ua2:pr"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id, "ua2:dp"));
    const r = await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "x" }, ctx(id, "ua2:v")); // no approvedBy
    c.push(ok("Gate 2 verify blocked without approval", r.status === "rejected" && r.code === "APPROVAL_REQUIRED", "unauthorized"));
  }
  // NOTIFY without approval
  {
    const env = buildEnv();
    const id = await detectAndOpen(env, "ua:3");
    await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "ua3:s"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id, "ua3:pr"));
    await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id, "ua3:dp"));
    await env.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "x" }, ctx(id, "ua3:v", { approvedBy: "U_ACCOUNT_MANAGER" }));
    const r = await env.service.dispatch({ kind: "NOTIFY_CUSTOMER", draftText: "Hi — the SSO login fix is available. Could you confirm it works?", draftRef: "x" }, ctx(id, "ua3:n")); // no approvedBy
    c.push(ok("Customer notify blocked without approval", r.status === "rejected" && r.code === "APPROVAL_REQUIRED", "unauthorized"));
  }
  // CHANGE_DUE_DATE without approval
  {
    const env = buildEnv();
    const id = await detectAndOpen(env, "ua:4");
    const r = await env.service.dispatch({ kind: "CHANGE_DUE_DATE", to: "2026-06-26" }, ctx(id, "ua4:dd")); // no approvedBy
    c.push(ok("Due-date change blocked without approval", r.status === "rejected" && r.code === "APPROVAL_REQUIRED", "unauthorized"));
  }
  return c;
}

/** Leakage: customer-facing drafts must never contain internal detail; the detector must catch injected leaks. */
async function leakageFamily(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const id = await detectAndOpen(env, "lk:1");
  await env.service.dispatch({ kind: "LINK_WORK_ITEM", work_system: "linear", work_ref: "PROJ-118" }, ctx(id, "lk:link", { approvedBy: "U_ACCOUNT_MANAGER" }));
  await env.service.dispatch({ kind: "START_WORK" }, ctx(id, "lk:s"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ticketDone("t", "PROJ-118") }, ctx(id, "lk:td"));
  await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR-449") }, ctx(id, "lk:pr"));
  const v = await env.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "2026.06.18") }, ctx(id, "lk:dp"));
  const draft = buildClosureDraft(v.obligation!);
  c.push(ok("draft contains no Linear/PR/deploy/internal terms", draft.clean, "leakage", draft.text));
  c.push(ok("internal evidence redacted (github/linear)", draft.safe.redactedCount >= 2, "leakage", `redacted ${draft.safe.redactedCount}`));
  // The detector must catch an injected leak (proves it isn't a no-op).
  c.push(ok("leak detector flags injected internal ref", detectLeaks("The fix in PROJ-118 / PR #449 is deployed").length > 0, "leakage"));

  // Command-path enforcement: a leaky NOTIFY_CUSTOMER draft is rejected end-to-end.
  const env2 = buildEnv();
  const id2 = await detectAndOpen(env2, "leakcmd");
  await env2.service.dispatch({ kind: "START_WORK" }, ctx(id2, "lc:s"));
  await env2.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prMerged("p", "PR") }, ctx(id2, "lc:pr"));
  await env2.service.dispatch({ kind: "RECORD_FULFILLMENT_SIGNAL", evidence: prodDeploy("d", "rel") }, ctx(id2, "lc:dp"));
  await env2.service.dispatch({ kind: "VERIFY_FULFILLMENT", rationale: "ok" }, ctx(id2, "lc:v", { approvedBy: "U_ACCOUNT_MANAGER" }));
  const leakyNotify = await env2.service.dispatch(
    { kind: "NOTIFY_CUSTOMER", draftText: "Fixed in PROJ-118, deployed to prod.", draftRef: "x" },
    ctx(id2, "lc:n", { approvedBy: "U_ACCOUNT_MANAGER" }),
  );
  c.push(ok("leaky customer draft rejected on the command path", leakyNotify.status === "rejected" && leakyNotify.code === "LEAK_DETECTED", "leakage", leakyNotify.reason));
  return c;
}

async function reminderTiming(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const id = await detectAndOpen(env, "rm:1");
  const o = (await env.service.getObligation(id))!;
  const jobs = computeReminders(o);
  for (const j of jobs) await env.scheduler.schedule(j);
  const dueTime = Date.parse("2026-06-19");
  const riskTime = dueTime - 24 * 60 * 60 * 1000;
  await env.scheduler.runDue(riskTime - 1);
  c.push(ok("no reminder fires before AT_RISK window", env.fired.length === 0, "reminder"));
  await env.scheduler.runDue(riskTime);
  c.push(ok("AT_RISK fires at due - 24h", env.fired.some((j) => j.kind === "AT_RISK"), "reminder"));
  await env.scheduler.runDue(dueTime);
  c.push(ok("OVERDUE fires at due", env.fired.some((j) => j.kind === "OVERDUE"), "reminder"));
  return c;
}

async function dueDateSupersession(): Promise<Check[]> {
  const c: Check[] = [];
  const env = buildEnv();
  const id = await detectAndOpen(env, "ss:1");
  const r = await env.service.dispatch({ kind: "CHANGE_DUE_DATE", to: "2026-06-26" }, ctx(id, "ss:dd", { approvedBy: "U_ACCOUNT_MANAGER" }));
  c.push(ok("approved due-date change supersedes", r.obligation?.due === "2026-06-26", "supersession"));
  const events = await env.service.getEvents(id);
  c.push(ok("prior due retained in history", events.some((e) => e.type === "DUE_DATE_CHANGED"), "supersession"));
  return c;
}

// --------------------------------------------------------------------------
// Classification metrics
// --------------------------------------------------------------------------
function classificationMetrics(pairs: { gold: ObligationSignal; pred: ObligationSignal }[]) {
  const total = pairs.length;
  const correct = pairs.filter((p) => p.gold === pred(p)).length;
  function pred(p: { pred: ObligationSignal }) { return p.pred; }
  const classes = [...new Set(pairs.map((p) => p.gold))];
  let f1sum = 0;
  for (const cls of classes) {
    const tp = pairs.filter((p) => p.gold === cls && p.pred === cls).length;
    const fp = pairs.filter((p) => p.gold !== cls && p.pred === cls).length;
    const fn = pairs.filter((p) => p.gold === cls && p.pred !== cls).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    f1sum += precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  }
  const commitmentClasses = new Set<ObligationSignal>(["CUSTOMER_REQUEST", "TENTATIVE_COMMITMENT", "CONFIRMED_COMMITMENT"]);
  const commitmentSubset = pairs.filter((p) => commitmentClasses.has(p.gold));
  const commitmentCorrect = commitmentSubset.filter((p) => p.gold === p.pred).length;
  return {
    accuracy: correct / total,
    macroF1: f1sum / classes.length,
    commitmentClassAccuracy: commitmentSubset.length ? commitmentCorrect / commitmentSubset.length : 1,
  };
}

async function runClassification(provider: LlmProvider) {
  const pairs: { gold: ObligationSignal; pred: ObligationSignal }[] = [];
  for (const m of CLASSIFICATION_CORPUS) {
    const res = await classifyMessage(provider, { messageText: m.text });
    pairs.push({ gold: m.gold, pred: res.signal });
  }
  const metrics = classificationMetrics(pairs);
  // Due-date extraction accuracy on the "Friday" messages.
  const fridayMsgs = CLASSIFICATION_CORPUS.filter((m) => /friday/i.test(m.text));
  let dueCorrect = 0;
  for (const m of fridayMsgs) {
    const ex = await extractObligation(provider, { messageText: m.text, currentDate: "2026-06-16" });
    if (ex.due === "2026-06-19") dueCorrect += 1;
  }
  return { ...metrics, dueDateAccuracy: fridayMsgs.length ? dueCorrect / fridayMsgs.length : 1 };
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

async function main() {
  const config = loadConfig();
  const provider: LlmProvider = config.anthropicApiKey
    ? new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.llmModel })
    : new MockLlmProvider(heuristicResponder);

  const scenarioGroups = await Promise.all([
    happyPathClosure(),
    duplicateSuppression(),
    semanticDedupe(),
    reopenOutlivesTicket(),
    falseClosureFamily(),
    forgedEvidenceFamily(),
    unauthorizedActionFamily(),
    leakageFamily(),
    reminderTiming(),
    dueDateSupersession(),
  ]);
  const checks = scenarioGroups.flat();

  const byCat = (cat: Category) => checks.filter((c) => c.category === cat);
  const passed = checks.filter((c) => c.pass);
  const failed = checks.filter((c) => !c.pass);

  const falseClosures = byCat("false_closure").filter((c) => !c.pass).length; // a fail here == a false closure slipped through
  const dupChecks = byCat("dedupe");
  const dupSuppressed = dupChecks.filter((c) => c.pass).length;
  const unauthorized = byCat("unauthorized").filter((c) => !c.pass).length; // fail == unauthorized action got through
  const leakChecks = byCat("leakage");
  const leaks = leakChecks.filter((c) => !c.pass).length;
  const transition = byCat("transition");
  const transitionPass = transition.filter((c) => c.pass).length;

  const cls = await runClassification(provider);

  const lines: string[] = [];
  lines.push("");
  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push("  KEPT — evaluation report");
  lines.push("══════════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push(`  Lifecycle & safety scenarios: ${checks.length} checks, ${passed.length} passed, ${failed.length} failed`);
  lines.push("");
  lines.push("  ── Lifecycle ─────────────────────────────────────────────────");
  lines.push(`   correct-transition rate ........ ${transition.length ? pct(transitionPass / transition.length) : "n/a"} (${transitionPass}/${transition.length})`);
  lines.push(`   duplicate-suppression rate ..... ${dupChecks.length ? pct(dupSuppressed / dupChecks.length) : "n/a"} (${dupSuppressed}/${dupChecks.length})`);
  lines.push(`   reopened-obligation handling ... ${byCat("reopen").every((c) => c.pass) ? "PASS" : "FAIL"}`);
  lines.push(`   reminder-timing accuracy ....... ${byCat("reminder").every((c) => c.pass) ? "PASS" : "FAIL"}`);
  lines.push(`   due-date supersession .......... ${byCat("supersession").every((c) => c.pass) ? "PASS" : "FAIL"}`);
  lines.push(`   FALSE-CLOSURE RATE ............. ${falseClosures} across ${byCat("false_closure").length} adversarial closure checks`);
  lines.push("");
  lines.push("  ── Safety ────────────────────────────────────────────────────");
  lines.push(`   customer-facing leakage rate ... ${leakChecks.length ? pct(leaks / leakChecks.length) : "0%"} (${leaks} leaks / ${leakChecks.length} checks)`);
  lines.push(`   unauthorized-action count ...... ${unauthorized} across ${byCat("unauthorized").length} gate checks`);
  lines.push(`   permission-boundary pass rate .. ${byCat("unauthorized").length ? pct(byCat("unauthorized").filter((c) => c.pass).length / byCat("unauthorized").length) : "n/a"}`);
  lines.push("");
  lines.push(`  ── Extraction / classification (provider: ${provider.name}) ──`);
  lines.push(`   signal accuracy ................ ${pct(cls.accuracy)}`);
  lines.push(`   macro-F1 ....................... ${cls.macroF1.toFixed(2)}`);
  lines.push(`   request/tentative/confirmed acc  ${pct(cls.commitmentClassAccuracy)}`);
  lines.push(`   due-date accuracy .............. ${pct(cls.dueDateAccuracy)}`);
  lines.push("");
  lines.push("  ── Headline ──────────────────────────────────────────────────");
  lines.push(`   ${pct(cls.commitmentClassAccuracy)} commitment-classification accuracy · ` +
    `${dupChecks.length ? pct(dupSuppressed / dupChecks.length) : "n/a"} duplicate-event suppression · ` +
    `${unauthorized} unauthorized customer actions · ${falseClosures} false closures`);
  lines.push("══════════════════════════════════════════════════════════════════");
  if (failed.length > 0) {
    lines.push("  FAILURES:");
    for (const f of failed) lines.push(`   ✗ [${f.category}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    lines.push("");
  }

  console.log(lines.join("\n"));

  return { checks, failed: failed.length };
}

main()
  .then((r) => {
    process.exit(r.failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
