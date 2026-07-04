import type { ObligationService } from "../engine/obligationService.js";
import type { Obligation } from "../domain/obligation.js";
import type { CommandContext } from "../domain/commands.js";
import type { Evidence } from "../domain/evidence.js";
import type { ObligationId } from "../domain/ids.js";
import { userActor } from "../domain/events.js";
import { project } from "../domain/projection.js";
import { resolve, type ResolutionCandidate } from "../engine/entityGraph.js";
import { assessFulfillment } from "../engine/reconciliation.js";
import { notifyKey } from "../engine/idempotency.js";
import { buildClosureDraft } from "../policy/audience.js";
import { buildTrustView, type TrustView } from "./trustView.js";
import type { TrustLink, TrustLinkStore } from "../store/trustLinkStore.js";
import { checkRoadmapConflict, type RoadmapEntry, type RoadmapSource } from "../policy/roadmap.js";
import { computeReminders, type Scheduler } from "../scheduler/scheduler.js";
import type { LlmProvider } from "../llm/provider.js";
import { proposeFromMessage } from "../llm/propose.js";
import type { WorkItemAdapter, CreatedWorkItem } from "../integrations/linear.js";
import type { ProofCollector } from "../integrations/proofCollector.js";
import type { RtsRetriever } from "../slack/rts.js";
import { EMPTY_RTS, type RtsContext } from "../slack/rts.js";
import type { Notifier, SentMessage } from "../slack/notifier.js";
import { confirmCard, possibleFulfillmentCard, closureDraftCard } from "../slack/blocks.js";

export interface OrchestratorDeps {
  service: ObligationService;
  llm: LlmProvider;
  workItems: WorkItemAdapter;
  rts: RtsRetriever;
  notifier: Notifier;
  scheduler?: Scheduler;
  clock?: () => number;
  currentDate?: () => string;
  /** Who receives the private cards for an obligation (defaults: owner → RTS owner → fallback). */
  ownerResolver?: (o: Obligation, rts: RtsContext) => string;
  fallbackOwner?: string;
  /** Approved roadmap targets — a committed date earlier than the target raises a private warning. */
  roadmap?: RoadmapEntry[];
  /** A live roadmap source (takes precedence over the static `roadmap` array). */
  roadmapSource?: RoadmapSource;
  /**
   * W4 — the agent that gathers Proof-of-Done (flag / CI / status) via MCP and PROPOSES
   * evidence. Optional and config-gated: when unset (default) proof collection is a no-op,
   * so production stays deterministic and the demo/tests can drive a simulated proof server.
   */
  proofCollector?: ProofCollector;
  /**
   * W6 — capability store for the customer trust page. When set, the acting team can mint
   * a per-(team, customer) trust link, and `GET /trust/:token` resolves it to a scoped,
   * audience-safe view. When unset, trust-page methods are no-ops / rejections.
   */
  trustLinks?: TrustLinkStore;
}

export interface SlackMessage {
  team: string;
  channel: string;
  threadTs: string;
  ts: string;
  userId: string;
  userToken?: string;
  /** W3 — RTS `action_token` from the Slack event context (Real-Time Search API). */
  actionToken?: string;
  text: string;
  permalink?: string;
}

export type IngestResult =
  | { kind: "confirm_card_sent"; obligationId: ObligationId; owner: string; sent: SentMessage }
  | { kind: "deduped"; obligationId: ObligationId }
  | { kind: "skipped"; signal: string };

export type NotifyResult =
  | { kind: "notified"; obligation: Obligation; posted: SentMessage | null }
  | { kind: "rejected"; reason: string };

/**
 * W2 (invariant #4 — tenant isolation): raised when the acting workspace tries to
 * write to an obligation owned by a DIFFERENT workspace. The transport layer passes
 * `body.team.id` as `actingTeam`; a mismatch is blocked before any event is appended.
 */
export class CrossTenantWriteError extends Error {
  constructor(
    readonly actingTeam: string,
    readonly obligationTeam: string,
    readonly obligationId: ObligationId,
  ) {
    super(`cross-tenant write blocked: team ${actingTeam} may not act on ${obligationId} (owned by ${obligationTeam})`);
    this.name = "CrossTenantWriteError";
  }
}

/**
 * KeptOrchestrator — the transport-agnostic application layer. The Bolt app, the
 * webhook server, and the demo all drive THESE methods. It enforces, end to end,
 * that: a human approves each gate; customer-facing text passes the sanitizer;
 * RTS context is used but never persisted; reminders/notifications go to the owner.
 */
export class KeptOrchestrator {
  private readonly now: () => number;
  private readonly today: () => string;
  /** Per-obligation lock serializing work-item create+link (concurrency- and retry-safe). */
  private readonly linkLocks = new Map<ObligationId, Promise<unknown>>();
  constructor(private readonly d: OrchestratorDeps) {
    this.now = d.clock ?? (() => Date.now());
    this.today = d.currentDate ?? (() => new Date(this.now()).toISOString().slice(0, 10));
  }

  private ctx(obligationId: ObligationId, idempotencyKey: string, approvedBy?: string | null, actorId?: string): CommandContext {
    const now = this.now();
    return {
      obligationId,
      actor: actorId ? userActor(actorId) : "system",
      source: { system: "slack", ref: null, accessible_to_user: true },
      idempotencyKey,
      at: new Date(now).toISOString(),
      approvedBy: approvedBy ?? null,
      now,
    };
  }

  private owner(o: Obligation, rts: RtsContext): string {
    if (this.d.ownerResolver) return this.d.ownerResolver(o, rts);
    return o.owner ?? rts.suggestedOwner ?? this.d.fallbackOwner ?? "U_ACCOUNT_MANAGER";
  }

  /**
   * Load an obligation for a WRITE, enforcing tenant isolation (W2/invariant #4): if
   * an `actingTeam` is supplied (the workspace of the clicking user) it must equal the
   * obligation's owning team, else the write is blocked before any side effect. When
   * `actingTeam` is omitted (demo/eval/internal callers) no cross-tenant check applies.
   */
  private async loadForWrite(id: ObligationId, actingTeam?: string): Promise<Obligation | null> {
    const o = await this.d.service.getObligation(id);
    if (o && actingTeam && o.team !== actingTeam) throw new CrossTenantWriteError(actingTeam, o.team, id);
    return o;
  }

  // --- inbound: a new customer-channel message -----------------------------
  /** Detect a request/commitment in a message and send the Gate-1 confirm card. */
  async ingestMessage(msg: SlackMessage): Promise<IngestResult> {
    const at = new Date(this.now()).toISOString();
    const proposal = await proposeFromMessage(
      this.d.llm,
      msg.text,
      {
        actor: userActor(msg.userId),
        source: { system: "slack", ref: msg.permalink ?? null, accessible_to_user: true },
        idempotencyKey: `slack:${msg.team}:${msg.channel}:${msg.ts}:request_detected`,
        at,
        now: this.now(),
        currentDate: this.today(),
      },
    );
    if (!proposal.actionable) return { kind: "skipped", signal: proposal.classification.signal };

    // RTS context — permission-safe, EPHEMERAL (never persisted). Scoped to the team.
    const rts = await this.d.rts.retrieve({
      team: msg.team,
      customer: proposal.detectInput.customer,
      subject_canonical: proposal.detectInput.subject_canonical,
      channel: msg.channel,
      userId: msg.userId,
      userToken: msg.userToken,
      actionToken: msg.actionToken,
    });

    // W1 — stamp the acting workspace onto the obligation (the proposer omits it).
    const result = await this.d.service.detectRequest({
      ...proposal.detectInput,
      team: msg.team,
      owner: proposal.detectInput.owner ?? rts.suggestedOwner,
      slack: { channel: msg.channel, thread_ts: msg.threadTs, permalink: msg.permalink },
    });

    if (result.status === "deduped") return { kind: "deduped", obligationId: result.obligation.id };
    if (result.status !== "created") return { kind: "skipped", signal: proposal.classification.signal };

    // Secondary beat: warn (privately, on the card) if the committed date contradicts the roadmap.
    const roadmap = this.d.roadmapSource ? await this.d.roadmapSource.list() : (this.d.roadmap ?? []);
    const warning = roadmap.length ? checkRoadmapConflict(result.obligation, roadmap) : null;

    const owner = this.owner(result.obligation, rts);
    const sent = await this.d.notifier.sendPrivate(owner, {
      text: `New obligation: ${result.obligation.customer} — ${result.obligation.outcome}`,
      blocks: confirmCard(result.obligation, proposal.classification, rts, warning?.conflict ? warning.message : undefined),
    }, result.obligation.team);
    return { kind: "confirm_card_sent", obligationId: result.obligation.id, owner, sent };
  }

  // --- Gate 1: account owner confirms --------------------------------------
  async confirmCommitment(
    obligationId: ObligationId,
    approverId: string,
    edits?: { outcome?: string; due?: string | null; owner?: string },
    actingTeam?: string,
  ): Promise<{ obligation: Obligation | null; work: CreatedWorkItem | null }> {
    const o = await this.loadForWrite(obligationId, actingTeam);
    if (!o) throw new Error(`unknown obligation ${obligationId}`);

    // Gate 1 FIRST — no side effects until the human approval is validated AND
    // persisted. A rejected gate (e.g. blank approver) or a raced concurrent click
    // (idempotent loser → suppressed) creates no Linear issue.
    const confirm = await this.d.service.dispatch(
      { kind: "CONFIRM_COMMITMENT", outcome: edits?.outcome ?? o.outcome, due: edits?.due ?? o.due, owner: edits?.owner ?? o.owner ?? approverId },
      this.ctx(obligationId, `${obligationId}:confirm`, approverId, approverId),
    );
    const confirmed = confirm.obligation ?? (await this.d.service.getObligation(obligationId));
    // Gate rejected (e.g. blank approver) or not a commitment → no side effects.
    if (!confirmed || ["CANDIDATE", "DISMISSED", "CANCELLED"].includes(confirmed.state)) {
      return { obligation: confirmed ?? o, work: null };
    }

    // Create + link exactly one system-of-record work item — driven by STATE (confirmed +
    // unlinked), not the consumed `:confirm` key, so a retry after a transient work-item
    // failure self-heals instead of leaving a confirmed-but-orphaned obligation. The
    // per-obligation lock makes it concurrency-safe (no double-create on racing clicks).
    const work = await this.ensureWorkItem(obligationId, approverId);

    const updated = await this.d.service.getObligation(obligationId);
    if (this.d.scheduler && updated) {
      for (const job of computeReminders(updated)) await this.d.scheduler.schedule(job);
    }
    return { obligation: updated, work };
  }

  /**
   * Provision the work item once for a confirmed obligation. Serialized per obligation:
   * concurrent confirms can't double-create (the loser sees the linked item and mints
   * nothing → returns null), and a failed attempt leaves no LINK event so a later retry
   * re-attempts. A work-item failure propagates so the caller can surface it.
   */
  private async ensureWorkItem(obligationId: ObligationId, approverId: string): Promise<CreatedWorkItem | null> {
    const prev = this.linkLocks.get(obligationId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async (): Promise<CreatedWorkItem | null> => {
      const cur = await this.d.service.getObligation(obligationId);
      if (!cur || cur.work_item) return null; // already linked (or gone) → this call mints nothing
      const work = await this.d.workItems.createIssue({
        title: cur.outcome,
        description: `Tracked by Kept for ${cur.customer}.`,
      });
      await this.d.service.dispatch(
        { kind: "LINK_WORK_ITEM", work_system: this.d.workItems.system, work_ref: work.ref },
        this.ctx(obligationId, `${obligationId}:link`, approverId, approverId),
      );
      return work;
    });
    this.linkLocks.set(obligationId, run.catch(() => {}));
    return run;
  }

  async dismiss(obligationId: ObligationId, approverId: string, actingTeam?: string): Promise<Obligation | null> {
    await this.loadForWrite(obligationId, actingTeam); // W2 — block cross-tenant dismiss
    const r = await this.d.service.dispatch({ kind: "DISMISS" }, this.ctx(obligationId, `${obligationId}:dismiss`, approverId, approverId));
    return r.obligation ?? null;
  }

  /**
   * W2 — resolve which installed tenant a webhook's refs belong to. A webhook arrives
   * out-of-band (no Slack auth), so its team is found by trying each installed
   * workspace's (team-scoped) ledger; the first that resolves the refs wins. Returns
   * null when none match → the caller no-ops safely (never touches a wrong tenant).
   */
  async teamForRefs(candidateTeamIds: string[], refs: ResolutionCandidate["refs"]): Promise<string | null> {
    for (const team of candidateTeamIds) {
      if (await this.findByRefs(team, refs)) return team;
    }
    return null;
  }

  // --- inbound webhooks: evidence ------------------------------------------
  /**
   * Resolve the obligation a webhook refers to via the entity graph — WITHIN the
   * given team. Scoping the candidate set by team means a webhook (which arrives
   * out-of-band, without Slack auth) can never resolve to another tenant's obligation. (W1)
   */
  private async findByRefs(teamId: string, refs: ResolutionCandidate["refs"]): Promise<Obligation | null> {
    const all = await this.d.service.listObligations(teamId, this.now());
    return resolve({ customer: "", subject_canonical: "", refs }, all);
  }

  /** A work item moved to "in progress" (e.g. Linear status webhook). */
  async startWork(teamId: string, refs: ResolutionCandidate["refs"], idempotencyKey: string): Promise<Obligation | null> {
    const o = await this.findByRefs(teamId, refs);
    if (!o) return null;
    const r = await this.d.service.dispatch({ kind: "START_WORK" }, this.ctx(o.id, idempotencyKey));
    return r.obligation ?? null;
  }

  /**
   * A fulfillment signal (PR merged, deploy, ticket Done, customer reply) arrived.
   * Records it as evidence; if reconciliation now shows availability, sends the
   * Gate-2 verify card to the owner.
   */
  async recordFulfillmentSignal(input: {
    teamId: string;
    refs: ResolutionCandidate["refs"];
    evidence: Evidence;
    idempotencyKey: string;
  }): Promise<{ kind: "no_match" } | { kind: "recorded"; obligation: Obligation; verifyCardSent: boolean }> {
    const o = await this.findByRefs(input.teamId, input.refs);
    if (!o) return { kind: "no_match" };
    const r = await this.d.service.dispatch(
      { kind: "RECORD_FULFILLMENT_SIGNAL", evidence: input.evidence },
      this.ctx(o.id, input.idempotencyKey),
    );
    // Invariant #3 — assemble the Evidence Packet: gather flag/CI/status proof via MCP
    // and PROPOSE each as evidence. assessFulfillment (below) + Gate 2 decide; the agent
    // never verifies. A flag that is OFF here is what BLOCKS an otherwise "done" close.
    const updated = await this.collectProof(r.obligation ?? (await this.d.service.getObligation(o.id))!);

    let verifyCardSent = false;
    if (updated.state === "POSSIBLE_FULFILLMENT") {
      const assessment = assessFulfillment(updated.evidence);
      if (assessment.sufficientForVerification) {
        await this.d.notifier.sendPrivate(this.owner(updated, EMPTY_RTS), {
          text: `Possible fulfillment — verify ${updated.customer} / ${updated.outcome}?`,
          blocks: possibleFulfillmentCard(updated, assessment),
        }, updated.team);
        verifyCardSent = true;
      }
    }
    return { kind: "recorded", obligation: updated, verifyCardSent };
  }

  /**
   * W4 — run the agent proof-collector for an obligation, dispatching each PROPOSED
   * evidence as RECORD_FULFILLMENT_SIGNAL, then return the freshly re-projected obligation.
   * No-op unless a collector is configured and the obligation is in POSSIBLE_FULFILLMENT
   * (the only window where extra fulfillment evidence is admissible). Best-effort: a
   * collection error is swallowed so proof-gathering never blocks the pipeline. Each
   * observation carries its check instant in `ref`, so an unchanged read is idempotent
   * and a genuine toggle (later instant) lands as a new fact.
   */
  private async collectProof(o: Obligation): Promise<Obligation> {
    if (!this.d.proofCollector || o.state !== "POSSIBLE_FULFILLMENT") return o;
    let proposed: Evidence[];
    try {
      proposed = await this.d.proofCollector.collect(o);
    } catch {
      return o;
    }
    for (const ev of proposed) {
      await this.d.service.dispatch(
        { kind: "RECORD_FULFILLMENT_SIGNAL", evidence: ev },
        this.ctx(o.id, `proof:${o.id}:${ev.source}:${ev.ref}`),
      );
    }
    return (await this.d.service.getObligation(o.id)) ?? o;
  }

  // --- Gate 2: verify, then draft + approve the customer-facing closure -----
  async verify(obligationId: ObligationId, approverId: string, actingTeam?: string): Promise<{ obligation: Obligation | null; draftSent: boolean }> {
    const loaded = await this.loadForWrite(obligationId, actingTeam);
    if (!loaded) throw new Error(`unknown obligation ${obligationId}`);
    // Re-gather proof at the moment of verification so a just-flipped flag (ON) is seen.
    const before = await this.collectProof(loaded);
    const assessment = assessFulfillment(before.evidence);
    const r = await this.d.service.dispatch(
      { kind: "VERIFY_FULFILLMENT", rationale: assessment.rationale },
      this.ctx(obligationId, `${obligationId}:verify:${before.state_version}`, approverId, approverId),
    );
    if (r.status !== "applied" || !r.obligation) return { obligation: r.obligation ?? null, draftSent: false };

    const draft = buildClosureDraft(r.obligation);
    await this.d.notifier.sendPrivate(this.owner(r.obligation, EMPTY_RTS), {
      text: `Ready to close the loop with ${r.obligation.customer}`,
      blocks: closureDraftCard(r.obligation, draft),
    }, r.obligation.team);
    return { obligation: r.obligation, draftSent: true };
  }

  /** Approve & send the auto-generated sanitized closure into the ORIGINAL thread. */
  async approveSend(obligationId: ObligationId, approverId: string, actingTeam?: string): Promise<NotifyResult> {
    const o = await this.loadForWrite(obligationId, actingTeam);
    if (!o) throw new Error(`unknown obligation ${obligationId}`);
    return this.notifyWithText(o, approverId, buildClosureDraft(o).text);
  }

  /** Approve & send a HUMAN-EDITED reply — still leak-checked by the engine before it goes out. */
  async approveSendWithText(obligationId: ObligationId, approverId: string, text: string, actingTeam?: string): Promise<NotifyResult> {
    const o = await this.loadForWrite(obligationId, actingTeam);
    if (!o) throw new Error(`unknown obligation ${obligationId}`);
    return this.notifyWithText(o, approverId, text);
  }

  private async notifyWithText(o: Obligation, approverId: string, text: string): Promise<NotifyResult> {
    // The engine re-checks leak-safety on this command and rejects a leaky draft.
    const res = await this.d.service.dispatch(
      { kind: "NOTIFY_CUSTOMER", draftText: text, draftRef: null },
      this.ctx(o.id, notifyKey(o.id, "CUSTOMER_NOTIFIED", o.state_version), approverId, approverId),
    );
    if (res.status !== "applied" || !res.obligation) return { kind: "rejected", reason: res.reason ?? "notify rejected" };

    let posted: SentMessage | null = null;
    const s = res.obligation.entity_refs.slack;
    if (s?.channel && s.thread_ts) {
      posted = await this.d.notifier.postInThread({ channel: s.channel, threadTs: s.thread_ts, text }, res.obligation.team);
    }
    return { kind: "notified", obligation: res.obligation, posted };
  }

  // --- customer reply: confirm or reopen -----------------------------------
  async recordCustomerConfirmation(obligationId: ObligationId): Promise<Obligation | null> {
    const r = await this.d.service.dispatch({ kind: "RECORD_CUSTOMER_CONFIRMATION" }, this.ctx(obligationId, `${obligationId}:cust_confirm`));
    return r.obligation ?? null;
  }

  /** Customer says it still fails — reopen, even though the ticket is Done, and resume work. */
  async reopen(obligationId: ObligationId, reason: string): Promise<Obligation | null> {
    await this.d.service.dispatch({ kind: "REOPEN", reason }, this.ctx(obligationId, `${obligationId}:reopen`));
    const r = await this.d.service.dispatch({ kind: "START_WORK" }, this.ctx(obligationId, `${obligationId}:resume`));
    return r.obligation ?? (await this.d.service.getObligation(obligationId));
  }

  /**
   * Best-effort routing of a customer reply on an existing obligation: a success
   * phrase confirms; a "still fails" phrase reopens. (The demo also calls
   * recordCustomerConfirmation / reopen directly for determinism.)
   */
  async ingestCustomerReply(msg: SlackMessage, subject_canonical: string, customer: string): Promise<Obligation | null> {
    const all = await this.d.service.listObligations(msg.team, this.now()); // W1 — same-tenant only
    const o = resolve({ customer, subject_canonical }, all.filter((x) => ["CUSTOMER_NOTIFIED", "CLOSED"].includes(x.state)));
    if (!o) return null;
    if (/\b(still|again)\b.*(fail|broken|not working|doesn'?t work)/i.test(msg.text)) {
      return this.reopen(o.id, "customer reports it still fails");
    }
    if (/\b(works|working|resolved|fixed|confirmed|looks good)\b/i.test(msg.text)) {
      return this.recordCustomerConfirmation(o.id);
    }
    return o;
  }

  // --- read surfaces (ledger / audit / home / modals) ----------------------
  // W1 — every read surface is scoped by the acting workspace's team id.
  async ledgerFor(teamId: string, customer: string): Promise<Obligation[]> {
    const all = await this.d.service.listObligations(teamId, this.now());
    return all.filter((o) => o.customer.toUpperCase() === customer.toUpperCase());
  }

  /** All obligations for one workspace, for the App Home dashboard. */
  async allObligations(teamId: string): Promise<Obligation[]> {
    return this.d.service.listObligations(teamId, this.now());
  }

  /** A single obligation projection (for opening a modal). */
  async obligation(id: ObligationId): Promise<Obligation | null> {
    return this.d.service.getObligation(id, this.now());
  }

  /** The auto-generated sanitized closure text (to prefill the edit-reply modal). */
  async closureDraftText(id: ObligationId): Promise<string | null> {
    const o = await this.d.service.getObligation(id, this.now());
    return o ? buildClosureDraft(o).text : null;
  }

  async auditFor(obligationId: ObligationId): Promise<{ obligation: Obligation; events: import("../domain/events.js").ObligationEvent[] } | null> {
    const events = await this.d.service.getEvents(obligationId);
    if (events.length === 0) return null;
    return { obligation: project(events, { now: this.now() }), events };
  }

  // --- W6: customer trust page (audience-safe, per-(team, customer) capability) ------
  /** Mint (or reuse) a trust link scoped to the ACTING team. The token IS the authorization. */
  async mintTrustLink(teamId: string, customer: string): Promise<TrustLink> {
    if (!this.d.trustLinks) throw new Error("trust links are not configured");
    return this.d.trustLinks.mint(teamId, customer, this.now());
  }

  /** Revoke every active trust link for (acting team, customer). Returns how many were revoked. */
  async revokeTrustLink(teamId: string, customer: string): Promise<number> {
    if (!this.d.trustLinks) throw new Error("trust links are not configured");
    return this.d.trustLinks.revoke(teamId, customer, this.now());
  }

  /**
   * Resolve an opaque trust token to its audience-safe view — the read method that feeds
   * `GET /trust/:token`. Tenant isolation (invariant #4) is absolute: the team comes from
   * the token record, and `listObligations` is team-scoped, so a token for (teamA, Acme)
   * can never read another team or another of teamA's customers. Unknown/revoked → null
   * (the route renders a 404 with no existence leak).
   */
  async trustPageForToken(token: string): Promise<TrustView | null> {
    if (!this.d.trustLinks) return null;
    const link = await this.d.trustLinks.resolve(token);
    if (!link) return null;
    const now = this.now();
    const obligations = await this.d.service.listObligations(link.team_id, now); // W1 — scoped by token's team
    return buildTrustView(obligations, link.customer, now);
  }
}
