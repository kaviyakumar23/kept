import type { EventStore } from "../store/eventStore.js";
import type { Command, CommandContext } from "../domain/commands.js";
import type { ObligationEvent, Actor, EventSource } from "../domain/events.js";
import type { Obligation } from "../domain/obligation.js";
import type { ObligationId, UserId } from "../domain/ids.js";
import { newObligationId } from "../domain/ids.js";
import type { Direction, ObligationSignal } from "../domain/signals.js";
import { project } from "../domain/projection.js";
import { decide } from "./commandHandler.js";
import { resolve } from "./entityGraph.js";
import { ConcurrencyError } from "../store/errors.js";

export interface DetectInput {
  /** W1 — the owning Slack workspace (team id); persisted on REQUEST_DETECTED and used to scope every read. */
  team: string;
  direction: Direction;
  signal: ObligationSignal;
  customer: string;
  subject_canonical: string;
  outcome: string;
  due: string | null;
  owner: UserId | null;
  conditions: string[];
  refs?: { linear?: string; jira?: string; github?: string; release?: string };
  slack?: { channel: string; thread_ts: string; permalink?: string };
  actor: Actor;
  source: EventSource;
  idempotencyKey: string;
  at: string;
  now?: number;
}

export type DetectResult =
  | { status: "created"; obligation: Obligation; events: ObligationEvent[] }
  | { status: "deduped"; obligation: Obligation; reason: string }
  | { status: "suppressed"; reason: string }
  | { status: "rejected"; code: string; reason: string };

export interface DispatchResult {
  status: "applied" | "suppressed" | "rejected" | "conflict";
  obligation?: Obligation;
  events?: ObligationEvent[];
  reason?: string;
  code?: string;
}

/** Max optimistic-concurrency retries before surfacing a conflict. */
const MAX_DISPATCH_ATTEMPTS = 4;

/**
 * The seam every adapter (Slack events, Linear/GitHub/deploy webhooks, the eval
 * runner) uses. It wires the append-only store, entity resolution, and the pure
 * decision engine into: propose command → engine decides → events appended →
 * fresh projection returned.
 */
export class ObligationService {
  constructor(
    private readonly store: EventStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async getObligation(id: ObligationId, now?: number): Promise<Obligation | null> {
    const events = await this.store.getEvents(id);
    if (events.length === 0) return null;
    return project(events, { now: now ?? this.clock() });
  }

  async getEvents(id: ObligationId): Promise<ObligationEvent[]> {
    return this.store.getEvents(id);
  }

  /** W1 — tenant-scoped ledger read. `teamId` is mandatory; there is no unscoped listing. */
  async listObligations(teamId: string, now?: number): Promise<Obligation[]> {
    const ref = now ?? this.clock();
    const ids = await this.store.getAllObligationIds(teamId);
    const out: Obligation[] = [];
    for (const id of ids) {
      const events = await this.store.getEvents(id);
      if (events.length > 0) out.push(project(events, { now: ref }));
    }
    return out;
  }

  /** Detect a customer request / commitment, with entity-graph dedupe (C4/C6). */
  async detectRequest(input: DetectInput): Promise<DetectResult> {
    const now = input.now ?? this.clock();

    // Cross-obligation idempotency (duplicate Slack event).
    if (await this.store.hasIdempotencyKey(input.idempotencyKey)) {
      return { status: "suppressed", reason: `duplicate event: ${input.idempotencyKey}` };
    }

    // Semantic dedupe: attach to an existing obligation instead of creating one.
    // Scoped to the same team — dedupe must never resolve across tenants.
    const existing = await this.listObligations(input.team, now);
    const match = resolve(
      { customer: input.customer, subject_canonical: input.subject_canonical, direction: input.direction, refs: input.refs },
      existing,
    );
    if (match) {
      return { status: "deduped", obligation: match, reason: `attached to ${match.id} via entity graph` };
    }

    const obligationId = newObligationId();
    const ctx: CommandContext = {
      obligationId,
      actor: input.actor,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      at: input.at,
      now,
    };
    const command: Command = {
      kind: "DETECT_REQUEST",
      team: input.team,
      direction: input.direction,
      signal: input.signal,
      customer: input.customer,
      subject_canonical: input.subject_canonical,
      outcome: input.outcome,
      due: input.due,
      owner: input.owner,
      conditions: input.conditions,
      refs: input.refs,
      slack: input.slack,
    };

    const decision = decide([], command, ctx);
    if (decision.outcome === "suppressed") return { status: "suppressed", reason: decision.reason };
    if (decision.outcome === "rejected") return { status: "rejected", code: decision.code, reason: decision.reason };

    const persisted = await this.store.append(decision.events);
    // The pre-check and append are not atomic; if a concurrent caller won the race
    // the store deduped our event. Report that truthfully so adapters don't double-fire.
    if (persisted.length === 0) return { status: "suppressed", reason: "idempotent: request already applied" };
    const obligation = project(await this.store.getEvents(obligationId), { now });
    return { status: "created", obligation, events: persisted };
  }

  /**
   * Apply a proposed command: idempotency → guard → compare-and-append → re-project.
   * Optimistic concurrency: the append is version-checked; if a *different* command
   * advanced the obligation between our read and our write, we re-read, re-decide, and
   * retry (so concurrent writers serialize by causality instead of clobbering state).
   */
  async dispatch(command: Command, ctx: CommandContext): Promise<DispatchResult> {
    const now = ctx.now ?? this.clock();

    if (await this.store.hasIdempotencyKey(ctx.idempotencyKey)) {
      return { status: "suppressed", reason: `idempotency key already applied: ${ctx.idempotencyKey}` };
    }

    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const events = await this.store.getEvents(ctx.obligationId);
      const decision = decide(events, command, { ...ctx, now });

      if (decision.outcome === "suppressed") return { status: "suppressed", reason: decision.reason };
      if (decision.outcome === "rejected") return { status: "rejected", code: decision.code, reason: decision.reason };

      try {
        const persisted = await this.store.append(decision.events, { expectedVersion: events.length });
        // A concurrent caller with the same key won the race → the store deduped ours.
        // Surfacing 'suppressed' (not 'applied') prevents adapters from double-firing side effects.
        if (persisted.length === 0) return { status: "suppressed", reason: "idempotent: event already applied" };
        const obligation = project(await this.store.getEvents(ctx.obligationId), { now });
        return { status: "applied", obligation, events: persisted };
      } catch (err) {
        if (err instanceof ConcurrencyError) continue; // a different writer advanced us → re-read + re-decide
        throw err;
      }
    }
    return { status: "conflict", reason: `concurrent modification of ${ctx.obligationId} (after ${MAX_DISPATCH_ATTEMPTS} attempts)` };
  }
}
