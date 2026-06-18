/**
 * RTS — targeted retrieval (Part B). On a new message, Kept pulls related context
 * the *triggering user* can access (prior commitments to this customer, the area
 * owner). RTS is retrieval, not a monitor; it is permission-safe via the user's
 * token, and its results are EPHEMERAL — used to inform the private card, never
 * persisted to the event log (zero-copy, correction #3).
 */
export interface RtsQuery {
  customer: string;
  subject_canonical: string;
  channel: string;
  /** The triggering user — retrieval runs with their permissions. */
  userId: string;
  /** User token for permission-scoped Slack search (real adapter). */
  userToken?: string;
}

export interface RtsContext {
  /** Prior commitments to this customer (summaries only; not persisted). */
  priorCommitments: { outcome: string; state: string; due: string | null }[];
  /** Suggested internal owner / area owner inferred from workspace context. */
  suggestedOwner: string | null;
  areaOwner: string | null;
  /** Free-form ephemeral notes shown on the private card; never stored. */
  notes: string[];
}

export const EMPTY_RTS: RtsContext = { priorCommitments: [], suggestedOwner: null, areaOwner: null, notes: [] };

export interface RtsRetriever {
  retrieve(query: RtsQuery): Promise<RtsContext>;
}

/** Offline/test retriever — returns canned context (or empty). */
export class MockRtsRetriever implements RtsRetriever {
  constructor(private readonly fn: (q: RtsQuery) => RtsContext = () => EMPTY_RTS) {}
  async retrieve(query: RtsQuery): Promise<RtsContext> {
    return this.fn(query);
  }
}

/**
 * Ledger-backed RTS retriever — a REAL, runnable source of "prior commitments to
 * this customer" drawn from the obligation ledger itself, plus area-owner
 * resolution from a configurable map. Results are ephemeral (used to enrich the
 * private confirm card; never persisted). This is the retrieval that the spec's
 * RTS pillar describes, sourced from data Kept already owns.
 */
export class LedgerRtsRetriever implements RtsRetriever {
  constructor(
    private readonly opts: {
      /** The obligation ledger (e.g. () => service.listObligations()). */
      listObligations: () => Promise<import("../domain/obligation.js").Obligation[]>;
      /** subject_canonical → area owner (Slack user id). */
      areaOwners?: Record<string, string>;
      maxPrior?: number;
    },
  ) {}

  async retrieve(query: RtsQuery): Promise<RtsContext> {
    const norm = (s: string) => s.trim().toUpperCase();
    const all = await this.opts.listObligations();
    const priorCommitments = all
      .filter((o) => norm(o.customer) === norm(query.customer) && norm(o.subject_canonical) !== norm(query.subject_canonical))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, this.opts.maxPrior ?? 5)
      .map((o) => ({ outcome: o.outcome, state: o.state, due: o.due }));
    const areaOwner = this.opts.areaOwners?.[query.subject_canonical] ?? null;
    return { priorCommitments, suggestedOwner: areaOwner, areaOwner, notes: [] };
  }
}

/** Structural view of the Slack Web API search surface (satisfied by WebClient). */
export interface SlackSearchMatch {
  text?: string;
  permalink?: string;
  channel?: { id?: string; name?: string };
  username?: string;
}
export interface SlackSearchClient {
  search: {
    messages(args: { query: string; count?: number }): Promise<{ messages?: { matches?: SlackSearchMatch[]; total?: number } }>;
  };
}

/**
 * Cross-channel RTS via Slack search, run with the TRIGGERING USER's token so
 * results respect that user's permissions (permission parity, D3). It surfaces
 * EPHEMERAL context notes (which channels have related discussion) — never raw
 * message bodies into the log. With no user token it returns nothing (no
 * unscoped search). `clientFor(userToken)` builds a user-scoped client, e.g.
 * `(t) => new WebClient(t)`.
 */
export class SlackRtsRetriever implements RtsRetriever {
  constructor(private readonly opts: { clientFor: (userToken: string) => SlackSearchClient; maxMatches?: number }) {}

  async retrieve(query: RtsQuery): Promise<RtsContext> {
    if (!query.userToken) return EMPTY_RTS; // permission parity: no user token → no user-scoped search
    const max = this.opts.maxMatches ?? 5;
    let matches: SlackSearchMatch[] = [];
    try {
      const subject = query.subject_canonical.replace(/_/g, " ").toLowerCase();
      const res = await this.opts.clientFor(query.userToken).search.messages({ query: `${query.customer} ${subject}`, count: max });
      matches = res.messages?.matches ?? [];
    } catch {
      return EMPTY_RTS; // search failure must never block the pipeline
    }
    // Notes reference WHERE related discussion is — not the message text.
    const notes = matches
      .slice(0, max)
      .map((m) => `related discussion in #${m.channel?.name ?? m.channel?.id ?? "?"}`);
    return { priorCommitments: [], suggestedOwner: null, areaOwner: null, notes };
  }
}

/**
 * Merge several retrievers (e.g. ledger priors + Slack-search context). Each is
 * independently fault-isolated; a failing source contributes nothing.
 */
export class CompositeRtsRetriever implements RtsRetriever {
  constructor(private readonly retrievers: RtsRetriever[]) {}

  async retrieve(query: RtsQuery): Promise<RtsContext> {
    const results = await Promise.all(this.retrievers.map((r) => r.retrieve(query).catch(() => EMPTY_RTS)));
    return {
      priorCommitments: results.flatMap((r) => r.priorCommitments),
      suggestedOwner: results.map((r) => r.suggestedOwner).find((o): o is string => Boolean(o)) ?? null,
      areaOwner: results.map((r) => r.areaOwner).find((o): o is string => Boolean(o)) ?? null,
      notes: results.flatMap((r) => r.notes),
    };
  }
}
