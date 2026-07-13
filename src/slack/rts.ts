/**
 * RTS — targeted retrieval (Part B). On a new message, Kept pulls related context
 * the *triggering user* can access (prior commitments to this customer, the area
 * owner). RTS is retrieval, not a monitor; it is permission-safe via the user's
 * token, and its results are EPHEMERAL — used to inform the private card, never
 * persisted to the event log (zero-copy, correction #3).
 */
export interface RtsQuery {
  /** W1 — the acting workspace; ledger-backed retrieval is scoped to this team's obligations. */
  team: string;
  customer: string;
  subject_canonical: string;
  channel: string;
  /** The triggering user — retrieval runs with their permissions. */
  userId: string;
  /** User token for permission-scoped Slack search (legacy/dev adapter). */
  userToken?: string;
  /**
   * W3 — the Real-Time Search `action_token`, present on assistant/message events.
   * Required by `assistant.search.context` when calling with a BOT token (the
   * Marketplace-legal path). Absent → the assistant-search retriever no-ops.
   */
  actionToken?: string;
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
      /** The team-scoped obligation ledger (e.g. (teamId) => service.listObligations(teamId)). */
      listObligations: (teamId: string) => Promise<import("../domain/obligation.js").Obligation[]>;
      /** subject_canonical → area owner (Slack user id). */
      areaOwners?: Record<string, string>;
      maxPrior?: number;
    },
  ) {}

  async retrieve(query: RtsQuery): Promise<RtsContext> {
    const norm = (s: string) => s.trim().toUpperCase();
    const all = await this.opts.listObligations(query.team); // W1 — same-tenant priors only
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
 * @deprecated W3 — the classic `search.messages` needs the BLANKET `search:read`
 * scope, which is BANNED in the Slack Marketplace (invariant #6). Superseded by
 * `SlackAssistantSearchRetriever` (`assistant.search.context`, granular scopes).
 * Retained only for the local/dev `KEPT_SLACK_USER_SEARCH` path — never wired in a
 * Marketplace build. Prefer `SlackAssistantSearchRetriever`.
 *
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
 * Structural view of one `assistant.search.context` result. Kept reads only the
 * *location* fields (channel_id/name, team_id) — never `content` (the raw message
 * body), which stays out of every note and out of the log (zero-copy, invariant #2).
 */
export interface AssistantSearchResult {
  content?: string;
  author_user_id?: string;
  team_id?: string;
  channel_id?: string;
  channel_name?: string;
  permalink?: string;
}
/**
 * Structural view of the Real-Time Search surface (satisfied by a `WebClient` holding
 * a bot token). Response results live under `results.messages` per the API.
 */
export interface AssistantSearchClient {
  assistant: {
    search: {
      context(args: {
        query: string;
        action_token?: string;
        channel_types?: string[];
        content_types?: string[];
        limit?: number;
      }): Promise<{ results?: { messages?: AssistantSearchResult[] } }>;
    };
  };
}

/**
 * W3 — Marketplace-legal RTS via the Real-Time Search API (`assistant.search.context`).
 * Unlike the classic `search.messages` (blanket `search:read`, BANNED), this uses a
 * BOT token plus the event's `action_token` and the granular scopes
 * `search:read.public` / `search:read.files` / `search:read.users`.
 *
 * Discipline is unchanged from the rest of Kept:
 *  • EPHEMERAL — results map to short "where related discussion lives" notes; the raw
 *    `content` is NEVER read into a note or the log (zero-copy, invariant #2).
 *  • Tenant-scoped — only results whose `team_id` matches the acting team are surfaced
 *    (invariant #4; the retriever is already handed a per-team bot client).
 *  • Rate-guarded — exactly ONE API call per inquiry (well under the API's ~10/inquiry
 *    ceiling); `limit` caps the result count.
 *  • Fault-isolated — any error (including a not-allowlisted / paid-plan API) yields
 *    EMPTY, so the pipeline never blocks and `LedgerRtsRetriever` still answers.
 *
 * `clientFor(teamId)` resolves the acting team's bot-token client.
 */
export class SlackAssistantSearchRetriever implements RtsRetriever {
  constructor(
    private readonly opts: {
      clientFor: (teamId: string) => AssistantSearchClient | Promise<AssistantSearchClient>;
      /** Result cap per call (default 5 — headroom under the API's ~10/inquiry limit). */
      limit?: number;
      /** Max notes surfaced on the card (default = limit). */
      maxNotes?: number;
    },
  ) {}

  async retrieve(query: RtsQuery): Promise<RtsContext> {
    // Bot-token calls REQUIRE an action_token (present on assistant/message events);
    // without one there is no legal call to make.
    if (!query.actionToken) return EMPTY_RTS;
    const limit = this.opts.limit ?? 5;
    const maxNotes = this.opts.maxNotes ?? limit;
    let results: AssistantSearchResult[] = [];
    try {
      const client = await this.opts.clientFor(query.team);
      const subject = query.subject_canonical.replace(/_/g, " ").toLowerCase();
      const res = await client.assistant.search.context({
        query: `${query.customer} ${subject}`,
        action_token: query.actionToken,
        channel_types: ["public_channel", "private_channel"],
        content_types: ["messages"],
        limit,
      });
      results = res.results?.messages ?? [];
      console.log(`[kept] RTS assistant.search.context ok — ${results.length} result(s) for "${query.customer}"`);
    } catch (err) {
      // Fault-isolated: a search failure / not-allowlisted API must never block the pipeline. Log the
      // Slack-side reason (e.g. missing_scope, not_allowed_token_type, method_deprecated) for observability.
      const reason = (err as { data?: { error?: string }; message?: string })?.data?.error ?? (err as Error)?.message ?? String(err);
      console.warn(`[kept] RTS assistant.search.context failed: ${reason}`);
      return EMPTY_RTS; // search failure / not-allowlisted must never block the pipeline
    }
    // Tenant isolation: only same-team results (defense-in-depth atop the per-team client).
    // Notes reference WHERE related discussion is — never the message `content`.
    const notes = results
      .filter((m) => !m.team_id || m.team_id === query.team)
      .slice(0, maxNotes)
      .map((m) => `related discussion in #${m.channel_name ?? m.channel_id ?? "?"}`);
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
