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
import { usagePeriod, type UsageStore } from "../store/usageStore.js";
import type { RtsRetriever } from "../slack/rts.js";
import { EMPTY_RTS, type RtsContext } from "../slack/rts.js";
import type { Notifier, SentMessage } from "../slack/notifier.js";
import { confirmCard, possibleFulfillmentCard, closureDraftCard } from "../slack/blocks.js";
import { ticketDone, prMerged, prodDeploy } from "../eval/scenarios.js";

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
  /** Per-tenant proof collector: resolves the acting workspace's own Connections config (invariant #4). */
  proofCollectorFor?: (teamId: string) => Promise<ProofCollector | null>;
  /** "Pilot" metering: monthly LLM-classification counter per workspace (with pilotLimitFor, caps AI spend). */
  usage?: UsageStore;
  /** Resolves a workspace's monthly LLM-classification cap (per-tenant plan override, else the env default). */
  pilotLimitFor?: (teamId: string) => Promise<number>;
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
  /** #5 — set when the promise was authored by an app / AI agent (not a human): the engine routes
   *  it to a HUMAN owner and the Gate-1 card is badged "Promised by <agent>". */
  agent?: { name: string };
  permalink?: string;
}

export type IngestResult =
  | { kind: "confirm_card_sent"; obligationId: ObligationId; owner: string; sent: SentMessage }
  | { kind: "deduped"; obligationId: ObligationId }
  | { kind: "customer_reply"; obligationId: ObligationId; state: string }
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
    // Defense-in-depth (invariant #4): an unattributable delivery has no tenant to scope
    // to, so it is dropped — never collapsed into a synthetic/placeholder ledger.
    if (!msg.team) return { kind: "skipped", signal: "no_team" };
    // A reply in an existing obligation's thread is a customer RESPONSE (a success phrase confirms
    // → CLOSED; a "still fails" phrase reopens), not a new commitment — handle it (team-scoped, no
    // LLM call) and return before new-commitment detection.
    const reply = await this.tryCustomerReply(msg);
    if (reply) return { kind: "customer_reply", obligationId: reply.id, state: reply.state };
    // "Pilot" free-tier guardrail: cap LLM classifications per workspace per month so a busy/abusive
    // tenant can't run up an unbounded AI bill. The counter increments per message; over the cap we
    // stop classifying (no further AI spend). Thread replies above never reach here (no LLM call).
    if (this.d.usage && this.d.pilotLimitFor) {
      const used = await this.d.usage.bump(msg.team, usagePeriod(this.now()));
      const limit = await this.d.pilotLimitFor(msg.team);
      if (used > limit) return { kind: "skipped", signal: "pilot_llm_limit" };
    }
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
      // Owner must be a real Slack user id. The proposer/RTS can hand back an LLM-guessed NAME (or
      // a placeholder like U_ACCOUNT_MANAGER — the underscore isn't a valid id), which then poisons
      // both the Gate-1 DM (conversations.open rejects it) and the card's <@owner> mention. Accept a
      // proposed owner only if it's a valid id; otherwise default to the message SENDER, who made
      // the promise and is always a valid in-workspace user.
      // An agent-authored promise has a BOT sender, so route it to the configured HUMAN owner
      // (fallbackOwner) instead of the bot; a human still signs Gate 1 (#5).
      owner: [proposal.detectInput.owner, rts.suggestedOwner, msg.agent ? this.d.fallbackOwner : msg.userId].find((o): o is string => !!o && /^[UW][A-Z0-9]{2,}$/.test(o)) ?? msg.userId,
      slack: { channel: msg.channel, thread_ts: msg.threadTs, permalink: msg.permalink },
    });

    // Re-send the Gate-1 confirm when a promise is re-posted but its obligation is still a
    // CANDIDATE — i.e. created earlier yet never confirmed (e.g. the first confirm DM failed to
    // send). Without this, a stuck CANDIDATE can never surface its card: every repeat dedupes and
    // returns silently. A deduped obligation already past CANDIDATE (OPEN+) is left untouched.
    const isNew = result.status === "created";
    const isUnconfirmedDup = result.status === "deduped" && result.obligation.state === "CANDIDATE";
    if (!isNew && !isUnconfirmedDup) {
      return result.status === "deduped"
        ? { kind: "deduped", obligationId: result.obligation.id }
        : { kind: "skipped", signal: proposal.classification.signal };
    }

    // Secondary beat: warn (privately, on the card) if the committed date contradicts the roadmap.
    // W1 — scope the roadmap read to the acting workspace (invariant #4).
    const roadmap = this.d.roadmapSource ? await this.d.roadmapSource.list(result.obligation.team) : (this.d.roadmap ?? []);
    const warning = roadmap.length ? checkRoadmapConflict(result.obligation, roadmap) : null;

    // The confirm must target a REAL Slack user in the origin channel. A resolved owner can be a
    // placeholder ("U_ACCOUNT_MANAGER" — the underscore fails Slack's user-id regex) or an
    // LLM-proposed name; both are rejected by conversations.open / chat.postEphemeral. Fall back to
    // the message SENDER, who made the promise and is guaranteed a valid in-channel user.
    const resolved = this.owner(result.obligation, rts);
    const owner = /^[UW][A-Z0-9]{2,}$/.test(resolved) ? resolved : msg.userId;
    const card = {
      text: `New obligation: ${result.obligation.customer} — ${result.obligation.outcome}`,
      blocks: confirmCard(result.obligation, proposal.classification, rts, warning?.conflict ? warning.message : undefined, msg.agent?.name),
    };
    let sent;
    try {
      sent = await this.d.notifier.sendPrivate(owner, card, result.obligation.team);
    } catch {
      // A real DM couldn't be opened (e.g. the installed token lacks mpim:write, so
      // conversations.open throws). Fall back to an ephemeral card visible ONLY to the owner in the
      // origin channel — audience-safe (no one else sees it) and needs only chat:write — so the
      // Gate-1 confirm still reaches them. The owner defaults to the sender, who is in-channel.
      sent = await this.d.notifier.postEphemeral(msg.channel, owner, card, result.obligation.team);
    }
    return { kind: "confirm_card_sent", obligationId: result.obligation.id, owner, sent };
  }

  /**
   * A thread reply on an existing CUSTOMER_NOTIFIED / CLOSED obligation is a customer RESPONSE, not
   * a new commitment. Matched by THREAD and scoped to the sender's team (invariant #4 — a customer
   * in one workspace can never close/reopen another workspace's obligation), so it needs no LLM
   * call. A success phrase → recordCustomerConfirmation (→ CLOSED); a "still fails" phrase → reopen.
   * NEVER posts a customer-facing message (invariant #3 — no auto-notify); it only changes state.
   * Returns the updated obligation, or null when this isn't a confirm/deny on a tracked thread (so
   * normal new-commitment detection then runs).
   */
  private async tryCustomerReply(msg: SlackMessage): Promise<Obligation | null> {
    if (!msg.threadTs || msg.threadTs === msg.ts) return null; // only thread REPLIES, not the root message
    const all = await this.d.service.listObligations(msg.team, this.now()); // W1 — same-tenant only
    const o = all.find(
      (x) =>
        x.entity_refs?.slack?.thread_ts === msg.threadTs &&
        x.entity_refs?.slack?.channel === msg.channel &&
        (x.state === "CUSTOMER_NOTIFIED" || x.state === "CLOSED"),
    );
    if (!o) return null;
    if (/\b(still|again)\b.*(fail|broke|broken|not working|does ?n'?t work)/i.test(msg.text)) {
      const reopened = await this.reopen(o.id, "customer reports it still fails");
      if (reopened) await this.notifyOwnerOfReply(reopened, `:warning: *${reopened.customer}* says "${reopened.outcome}" still isn't working — I reopened it.`);
      return reopened;
    }
    if (/\b(works|working|resolved|fixed|confirmed|looks good|all good)\b/i.test(msg.text)) {
      const closed = await this.recordCustomerConfirmation(o.id);
      if (closed) await this.notifyOwnerOfReply(closed, `:white_check_mark: *${closed.customer}* confirmed "${closed.outcome}" is working — closed. Nice work.`);
      return closed;
    }
    return null; // matched the thread but not a clear confirm/deny → let normal handling proceed
  }

  /**
   * Private, owner-only notice that a customer replied (confirmed → closed, or reopened). Internal
   * feedback so the loop doesn't close silently — NEVER the customer channel (invariant #3), and
   * best-effort (a failed DM must not undo the state change).
   */
  private async notifyOwnerOfReply(o: Obligation, text: string): Promise<void> {
    const owner = this.owner(o, EMPTY_RTS);
    if (!/^[UW][A-Z0-9]{2,}$/.test(owner)) return; // no valid owner to DM
    try {
      await this.d.notifier.sendPrivate(owner, { text }, o.team);
    } catch {
      /* best-effort feedback */
    }
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
      // No tracker connected → track the promise WITHOUT a linked ticket (never fabricate a ref).
      if (this.d.workItems.enabled === false) return null;
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
      // Surface the Evidence Packet as soon as we're in POSSIBLE_FULFILLMENT — whether the verdict
      // is "available" (Gate 2 may proceed) or "blocked" (e.g. a production flag still OFF). The
      // owner must SEE the blocked packet; the card renders the verdict, and the engine still guards
      // the Verify click (INSUFFICIENT_EVIDENCE) so a blocked packet can never be verified.
      await this.d.notifier.sendPrivate(this.owner(updated, EMPTY_RTS), {
        text: assessment.sufficientForVerification
          ? `Possible fulfillment — verify ${updated.customer} / ${updated.outcome}?`
          : `Proof-of-Done blocked — ${updated.customer} / ${updated.outcome} not verifiably available`,
        blocks: possibleFulfillmentCard(updated, assessment),
      }, updated.team);
      verifyCardSent = assessment.sufficientForVerification;
    }
    return { kind: "recorded", obligation: updated, verifyCardSent };
  }

  /**
   * Option A — the owner manually attests the work is delivered, for teams that haven't connected
   * an automated proof source. Records a first-class `manual_delivery` signal → POSSIBLE_FULFILLMENT
   * → Evidence Packet. Still runs the proof collector, so a connected source that says NOT-live
   * blocks the close (assessFulfillment decides). The human only proposes; code + Gate 2 decide.
   */
  async markDelivered(obligationId: ObligationId, byUserId: string, actingTeam?: string): Promise<{ obligation: Obligation | null; verifyCardSent: boolean }> {
    const o = await this.loadForWrite(obligationId, actingTeam);
    if (!o) throw new Error(`unknown obligation ${obligationId}`);
    const at = new Date(this.now()).toISOString();
    const evidence: Evidence = {
      id: `owner:${o.id}:${at}`,
      source: "owner",
      kind: "manual_delivery",
      ref: `manual@${at}`,
      at,
      accessible_to_user: true,
      data: { by: byUserId },
      proves: "owner attested the work is delivered",
    };
    const r = await this.d.service.dispatch(
      { kind: "RECORD_FULFILLMENT_SIGNAL", evidence },
      this.ctx(o.id, `${o.id}:manual:${o.state_version}`, byUserId, byUserId),
    );
    const updated = await this.collectProof(r.obligation ?? (await this.d.service.getObligation(o.id))!);
    let verifyCardSent = false;
    if (updated.state === "POSSIBLE_FULFILLMENT") {
      const assessment = assessFulfillment(updated.evidence);
      await this.d.notifier.sendPrivate(this.owner(updated, EMPTY_RTS), {
        text: assessment.sufficientForVerification
          ? `Ready to verify — ${updated.customer} / ${updated.outcome}`
          : `Marked delivered, but blocked — ${updated.customer} / ${updated.outcome}`,
        blocks: possibleFulfillmentCard(updated, assessment),
      }, updated.team);
      verifyCardSent = assessment.sufficientForVerification;
    }
    return { obligation: updated, verifyCardSent };
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
    if (!this.d.proofCollectorFor || o.state !== "POSSIBLE_FULFILLMENT") return o;
    const collector = await this.d.proofCollectorFor(o.team); // invariant #4 — the acting team's own config
    if (!collector) return o;
    let proposed: Evidence[];
    try {
      proposed = await collector.collect(o);
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

  // --- Demo Controls (judge-operable hero flow) ----------------------------
  // These drive the SAME orchestrator methods a real event would; they exist so a judge in
  // the designated demo workspace can run the whole loop from Slack buttons. Every one is
  // team-scoped (invariant #4) — the Slack layer only ever calls them for `deps.demoTeam`,
  // and none of them ever posts to the customer (invariant #3): "still fails" reopens via the
  // engine, and the closure still requires the judge's explicit Approve & send.

  /**
   * Seed + confirm a fresh OPEN demo promise ("Ship the SSO fix for Acme"), OWNED BY the
   * acting judge so the evidence-packet / Verify / closure DMs all come to them. Deterministic
   * (no LLM): detect → Gate-1 confirm → one linked work item. When `channel`+`threadTs` are given
   * the closure will post into that demo-channel thread; otherwise the loop completes DM-only.
   */
  async seedDemo(team: string, ownerUserId: string, channel?: string, threadTs?: string): Promise<Obligation | null> {
    const now = this.now();
    const at = new Date(now).toISOString();
    // Upcoming Friday (≥1 day out) so the promise reads "by Friday" and isn't already overdue.
    const day = new Date(now).getUTCDay();
    const due = new Date(now + ((((5 - day) + 7) % 7) || 7) * 86_400_000).toISOString().slice(0, 10);
    const detected = await this.d.service.detectRequest({
      team,
      direction: "TEAM_OWES_CUSTOMER",
      signal: "CONFIRMED_COMMITMENT",
      customer: "Acme",
      subject_canonical: "SSO_LOGIN_BUG",
      outcome: "Ship the SSO fix for Acme",
      due,
      owner: ownerUserId,
      conditions: [],
      slack: channel && threadTs ? { channel, thread_ts: threadTs } : undefined,
      actor: userActor(ownerUserId),
      source: { system: "slack", ref: null, accessible_to_user: true },
      idempotencyKey: `demo-seed:${team}:${now}`,
      at,
      now,
    });
    if (detected.status === "deduped") return detected.obligation;
    if (detected.status !== "created") return null;
    const { obligation } = await this.confirmCommitment(detected.obligation.id, ownerUserId, undefined, team);
    return obligation;
  }

  /**
   * "Mark work shipped": record Jira Done + PR merged + prod deploy as fulfillment signals for
   * the demo obligation (reusing the eval evidence builders). This drives it to
   * POSSIBLE_FULFILLMENT and — because the demo tenant's proof collector reads the controllable
   * flag, which starts OFF — assembles a BLOCKED evidence packet DM'd to the owner. The judge is
   * the owner, so the existing Verify button on that packet routes to them and refuses (flag OFF).
   */
  async markDemoShipped(team: string, obligationId: ObligationId): Promise<Obligation | null> {
    const o = await this.obligation(obligationId, team); // tenant-scoped read (throws on cross-tenant)
    if (!o?.work_item) return null;
    const ref = o.work_item.ref;
    const refs: ResolutionCandidate["refs"] =
      o.work_item.system === "jira" ? { jira: ref } : { linear: ref };
    await this.recordFulfillmentSignal({ teamId: team, refs, evidence: ticketDone(`demo-ticket:${obligationId}`, ref), idempotencyKey: `demo:${obligationId}:ticket` });
    await this.recordFulfillmentSignal({ teamId: team, refs, evidence: prMerged(`demo-pr:${obligationId}`, `pr:${obligationId}`), idempotencyKey: `demo:${obligationId}:pr` });
    const last = await this.recordFulfillmentSignal({ teamId: team, refs, evidence: prodDeploy(`demo-deploy:${obligationId}`, `release:${obligationId}`), idempotencyKey: `demo:${obligationId}:deploy` });
    return last.kind === "recorded" ? last.obligation : this.obligation(obligationId, team);
  }

  /** "↺ Reset demo": irreversibly wipe the demo tenant's ledger (team-scoped) so a fresh promise can be seeded. */
  async resetDemo(team: string): Promise<void> {
    await this.d.service.purgeTeam(team);
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

  /**
   * A single obligation projection (for opening a modal). Tenant-scoped like the write
   * path (invariant #4): when an `actingTeam` is supplied (the clicking user's workspace)
   * it MUST equal the obligation's owning team, else the read is blocked. Omitting it
   * preserves internal/demo/eval callers (no cross-tenant check).
   */
  async obligation(id: ObligationId, actingTeam?: string): Promise<Obligation | null> {
    const o = await this.d.service.getObligation(id, this.now());
    if (o && actingTeam && o.team !== actingTeam) throw new CrossTenantWriteError(actingTeam, o.team, id);
    return o;
  }

  /** The auto-generated sanitized closure text (to prefill the edit-reply modal). Tenant-scoped. */
  async closureDraftText(id: ObligationId, actingTeam?: string): Promise<string | null> {
    const o = await this.obligation(id, actingTeam);
    return o ? buildClosureDraft(o).text : null;
  }

  /** The full audit log for an obligation (for the history modal). Tenant-scoped (invariant #4). */
  async auditFor(obligationId: ObligationId, actingTeam?: string): Promise<{ obligation: Obligation; events: import("../domain/events.js").ObligationEvent[] } | null> {
    const events = await this.d.service.getEvents(obligationId);
    if (events.length === 0) return null;
    const obligation = project(events, { now: this.now() });
    if (actingTeam && obligation.team !== actingTeam) throw new CrossTenantWriteError(actingTeam, obligation.team, obligationId);
    return { obligation, events };
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
