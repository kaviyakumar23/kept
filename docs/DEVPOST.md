# Kept

> **Elevator pitch:** Kept is a Slack-native, human-verified obligation ledger for shared customer channels that never treats a ticket status or a merged PR as truth — it **verifies reality** from proof it gathers itself, and closes the loop back in the original thread only after a human signs.

**Submission track: Slack Agent for _Organizations_ · Slack Marketplace.**
**App ID:** `<APP_ID_TBD>` · **Judge sandbox:** invited `slackhack@salesforce.com` + `testing@devpost.com` (see *Try it out*).

---

## The 15-second version (why this isn't another ticketer)

A Jira ticket flips to **Done**. Pylon, Thena, and ClearFeed would now surface it as fixed and let someone tell the customer.

Kept doesn't. It queries the **LaunchDarkly feature flag over MCP** — the flag gating that fix is **OFF in production**. The deploy never shipped. So Kept **blocks the close**, and shows the owner an **Evidence Packet**: ticket Done ✓, PR merged ✓, prod deploy ✓ — **feature flag OFF ✗ → not verifiably available**.

That single beat is the whole thesis. **Your ticketer tracks status. Kept verifies reality.** It's the exact failure mode — "false done" — that burns customer trust, and it's the one thing a status-tracking tool structurally cannot catch.

## The concept exists. Here's how Kept improves on it.

The Organizations judging question is *"does this already exist, and how much does this improve on it?"* — so we'll answer it head-on.

| | Pylon / Thena / ClearFeed | **Kept** |
|---|---|---|
| Unit of work | a ticket / conversation | a **first-class obligation** with its own lifecycle |
| "Done" means | a status field flipped | **proof reconciled** — flag ON + PR merged + prod deploy (or a customer confirmation) |
| Who acts | agent routes / auto-replies | **agent assembles proof; a human signs the verdict** |
| Customer safety | manual care | **audience sanitizer + leak detector on every customer-facing word, by construction** |
| Multi-tenant | product feature | **tenant isolation as a P0 invariant** — a cross-tenant read is a security bug the tests hunt for |

The improvement isn't a nicer inbox. It's a **different definition of "done"** — one that can't be faked by a stale ticket — enforced by code, not by a prompt.

## What it does

Kept maintains a human-verified, **event-sourced obligation ledger** for shared customer channels — capturing what your company owes each customer and the commitments your team makes back. One obligation's journey:

1. **Capture.** A customer message lands in a shared channel. Kept's LLM layer classifies and *proposes* a candidate obligation. Nothing is committed — it enters as `CANDIDATE`.
2. **Gate 1 — Confirm (human).** The owner gets a private card: what we think you committed to, prior commitments to this customer (pulled from the ledger), and a roadmap-conflict warning if the promised date beats the roadmap. Only on **Confirm** does it become `OPEN` — and *only then* does Kept create the work item over MCP (a Linear/Jira tool call that *code*, not the model, decides to make).
3. **Track & collect proof.** Ticket status, PR merges, and deploys arrive as webhooks. Then the agent **autonomously assembles Proof-of-Done** — it queries a feature flag's production state, a CI run's conclusion, a status page's health — over MCP, and proposes each as evidence.
4. **Reconcile — Proof-of-Done.** Ticket-Done alone is *never* enough. `assessFulfillment` resolves to exactly two sufficiency lanes: a merged PR **and** a production deploy, or a direct customer confirmation — and it refuses forged or non-production evidence. **The flag-OFF case blocks here.**
5. **Gate 2 — Verify (human).** When proof is sufficient, the owner gets a **verify card listing the Evidence Packet**. The agent did 95%; the human signs. Evidence opens the gate — it does not walk through it.
6. **Close the loop.** Kept drafts a **sanitized, leak-checked, customer-safe** closure, the owner approves (or edits) it, and it posts back into the **original thread**. The customer finally hears it's done.
7. **Outlive the ticket.** If the customer replies "still failing," the obligation `REOPENED`s — even if the ticket stays Done forever.

Ten lifecycle states, two mandatory human gates, one source of truth that lives in Slack.

**Reframing human-in-the-loop.** This isn't approval fatigue. The agent does the work — gathering, reconciling, drafting, sanitizing; the human only **signs the verdict** at two gates. *The agent does 95%; you sign.*

## Two more reasons to keep it (the wow features)

- **Promise-drift radar.** "Next Tuesday" becomes "soon" becomes silence. Kept quantifies that decay — every live commitment gets a **drift score** (language softened, date slipped, scope moved, gone quiet, disputed) and surfaces the drifting ones in the App Home band and the Assistant's *"what's slipping?"* answer. Pure, deterministic, derived from the same event log; nothing is persisted.
- **Per-account customer trust page.** A private, audience-safe web page per customer — **Kept / in progress / verifying / at-risk** — that a CSM can share as a retention weapon. It runs through the **same D1 audience sanitizer** as the channel: a leaky commitment label collapses to "Commitment #N," and no ticket, PR, or flag ever appears. Mint it with `/kept trust <customer>`, revoke it with `/kept untrust`.

## The three qualifying technologies (all genuine)

1. **Slack AI Assistant.** A conversational Assistant pane over the ledger (*"what's overdue?", "what did we promise Acme this week?"*). The LLM only **routes the question into a fixed intent grammar**; deterministic code runs the read — the same LLM-proposes/code-decides discipline as the rest of Kept.
2. **Model Context Protocol (MCP).** Kept is a **deterministic MCP client** used two ways: to *create* work items (Linear / Atlassian), and to *gather proof* (feature-flag state, CI conclusion, status-page health). The model never selects a tool — **code picks the tool and arguments**; the model interprets language only. The demo + tests run a real MCP client↔server round-trip against an in-process server; hosted Linear/Atlassian MCP plug in with a token.
3. **Real-Time Search API.** Cross-channel context on a new message via `assistant.search.context`, using a **bot token + the event's `action_token`** and **granular scopes** (`search:read.public/.files/.users`) — never the blanket `search:read`, which is **banned in the Marketplace**. Results are ephemeral (a "related discussion lives in #…" note; the raw content is never read into the log). *Honest note:* the Real-Time Search API is allowlisted/gated, so the retriever is **fault-isolated** — a `LedgerRtsRetriever` sources prior commitments from the ledger Kept already owns, and the app works with or without RTS enabled.

## Built for organizations (Marketplace shape)

- **Multi-workspace OAuth, HTTP mode.** Production runs **HTTP mode (no Socket Mode)** with `@slack/bolt` OAuth and a `PostgresInstallationStore` — per-tenant bot tokens fetched per event and for out-of-band sends (reminders, webhook-driven closures).
- **Tenant isolation is a P0 invariant.** Every read is scoped by `team_id` through two choke points; a fail-**closed** resolver refuses to derive a tenant from a malformed payload; a cross-tenant write throws `CrossTenantWriteError` before any side effect. There are dedicated tenant-isolation and write-isolation test suites — a cross-tenant read is treated as a security bug, not a bug report.
- **Minimal, granular scopes; no banned scopes.** The manifest declares exactly what the code uses, and every scope is granular.

## How we built it

Kept is TypeScript (ESM, Node 20+), four deterministic layers around a pure engine with a strict seam between language and state. The keystone: **the LLM proposes; code decides.**

**LLM-proposes / engine-decides.** An inbound message goes to `proposeFromMessage`, which classifies and extracts via **forced tool-use with Zod validation at the boundary** (default `claude-opus-4-8`). The model returns a *Proposal* — a candidate `Command` — and nothing else. It never writes an event or mutates state. Offline, a `MockLlmProvider` runs a heuristic against the same schemas, fully deterministic. The deterministic heart is `decide()`: a pure `(events, command, ctx) → Decision` with no I/O — envelope validation → idempotency → command-boundary leak/consistency checks → project state → zero-copy `assertNoRawContent` → reconciliation gate → `canApply`.

**Event sourcing.** State is never a mutable row — the ledger is an append-only log, and an obligation is a *pure fold* of it. A logic change is a *replay, not a migration*, and `projectAt` gives free time-travel for the audit view.

**Proof-of-Done reconciliation.** `assessFulfillment` first drops forged or mislabeled evidence (a `customer_reply` claiming to be from GitHub is rejected), then resolves to two sufficiency lanes. A staging deploy can't masquerade as production; a self-declared `customer_scoped` flag on a non-prod deploy is ignored; a customer denial blocks verification. **The feature-flag-OFF observation is what holds a "ticket Done" obligation out of the gate.**

**Zero-copy persistence.** No raw Slack body, prompt, model response, or retrieved text is ever persisted. `assertNoRawContent` runs name- and value-based scans before every append — forbidden keys, oversized strings, and *any* Unicode line terminator. Payloads carry IDs, permalinks, and short derived fields only.

**Gate-before-side-effect ordering.** The orchestrator dispatches the gate command *first* and only creates a work item or posts to the customer thread `if (status === "applied")`. A deduped race returns `suppressed`, not `applied`, so two concurrent Confirm clicks can never create two tickets — no locks.

**Substrate that upgrades by environment.** Set `DATABASE_URL` and the in-memory store becomes a real `PostgresEventStore` (transactional `ON CONFLICT DO NOTHING`); `REDIS_URL` moves reminders to BullMQ; `ANTHROPIC_API_KEY` switches to real Claude; `LINEAR_MCP_TOKEN` / `ATLASSIAN_MCP_TOKEN` route work items to the hosted MCP servers.

**Honesty framing (a credibility beat, invariant #7).** **Slack is the real, live surface.** **GitHub Actions is a genuine live proof source** (a real workflow-run `conclusion` fetched from the GitHub REST API). Work items (Linear/Jira) and the other proof sources (**LaunchDarkly** flags, **Atlassian Statuspage**) are **simulated over an in-process MCP server with real API skeletons** — a token swaps in the live one. Postgres + Redis/BullMQ are real and exercised by the live integration suite. We never imply a certified live integration for a simulated one — the honesty *is* the credibility.

## Challenges we ran into

- **Keeping the LLM out of the decision path without making it useless.** The model returns a Zod-validated `Command`; a pure `decide()` is the only thing that can emit an event. Every new "agentic" feature — proof collection, the Assistant, drift — obeys the same seam.
- **Defining "done" without lying to the customer.** A merged PR *feels* like done. It isn't. Reconciliation became a small set of explicit, testable sufficiency lanes plus an explicit refusal to honor a `customer_scoped` flag on a non-production deploy — and the flag-OFF proof source that catches the false "done."
- **Multi-tenant safety as a property, not a hope.** Every read had to carry the acting `team_id`; we made the tenant resolver fail *closed* and turned a cross-tenant write into a thrown error checked before any side effect — then wrote suites that try to break it.
- **Zero-copy is sneakier than it looks.** Raw content leaks in through oversized strings and exotic Unicode line terminators; we scan names and values, cap lengths, and flag *every* Unicode line break — including on the new proof, trust-page, and RTS surfaces.

## Accomplishments that we're proud of

- A genuinely **pure decision core** — `decide()` and `canApply()` do no I/O — which makes the guarantees testable and the engine replayable.
- **179 hermetic tests + a live integration suite.** The engine, the Slack AI Assistant router, a real MCP client↔server round-trip, the Proof-of-Done gate, tenant isolation, and the trust page all run in-memory and deterministic; the integration suite verifies real Postgres + Redis/BullMQ (self-skipping when a service env is absent).
- **8 adversarial verification rounds**, where we attacked our own guarantees and turned every finding into a permanent regression test — command-path leak checks and forged-evidence rejection, the all-Unicode zero-copy fix, retry-stable idempotency keys, an MCP-path self-heal for a confirmed-but-orphaned obligation, the Assistant/analytics hardening sweep, and a Round-8 pass over the new Proof-of-Done, trust-page, and tenancy surfaces.
- **Proof-of-Done that actually blocks.** The flag-OFF case isn't a slide — `npm run demo` shows the engine refusing to verify with ticket Done + merge + deploy in hand, then flipping to green the instant the flag goes ON.
- **A clean transport-agnostic core and a polished Slack-native UX** — confirm/verify/closure cards, edit modals that re-run the leak check on submit, an App Home dashboard with the drift band, a slash-command ledger, and the customer trust page — every guarantee mapping to a specific guard in a specific file.

## What we learned

**Trust is an architecture, not a feature.** The most valuable thing an agent can do in a customer channel is *refuse to act* until the right conditions hold — and prove why.

- **Make the safety property structural, not procedural.** A guard table that *cannot* emit an event without `approved_by`, and a reconciler that *cannot* verify without reconciled proof, did more for trust than any accuracy number.
- **"Evidence, not truth" is the right default** — and Proof-of-Done is what makes it real. Treating ticket status as a signal to reconcile against *reality* (a flag, a deploy, a customer's own confirmation) is the difference between an autonomous agent that's safe in a customer channel and one that isn't.
- **Human-in-the-loop is a feature, not a tax — if the agent does the assembling.** "The agent does 95%; you sign" reframes approval from friction into a signature on work already done.
- **Adversarial self-review beats more feature work.** Every round against our own guarantees surfaced bugs no happy-path test would.

## What's next for Kept

- Complete OAuth for the hosted Linear/Atlassian **MCP** servers (the streamable-HTTP client is wired; live use needs credentials) and swap the simulated LaunchDarkly/Statuspage adapters for live tokens behind the same `query()` contract.
- Per-source webhook HMAC verification, replacing the shared-secret stand-in.
- Richer reconciliation lanes (CRM account context, changelog/status-page evidence) behind the same consistency checks, with per-team sufficiency policy.
- Enterprise Grid org-wide install, broader proactive drift nudges, and ledger analytics (time-to-fulfillment, at-risk forecasting) — all derivable from the existing event log.

<!-- ─────────────────────────────────────────────────────────────────────────
     CRIB SHEET — maps to the OTHER Devpost form fields (not part of the story).
     This whole block is an HTML comment; it won't render in the submission.
     ───────────────────────────────────────────────────────────────────── -->
<!--
ELEVATOR PITCH (Devpost's short pitch field, ~200 char max — pick one):
  • Your ticketer tracks status. Kept verifies reality — it blocks a "done" the deploy never shipped, and closes the loop only after a human signs.
  • A Slack-native obligation ledger that never treats a ticket status or a merged PR as truth. The agent assembles the proof; you sign the verdict.
  • Kept remembers what your company owes every customer — and makes sure the customer hears when it's ACTUALLY done, verified from proof, in the original thread.

BUILT WITH (Devpost tags field): TypeScript, Node.js, Slack Bolt, Slack OAuth, Block Kit, Slack Events API,
  Slack AI Assistant, App Home, Real-Time Search API (assistant.search.context), Model Context Protocol (MCP),
  PostgreSQL, Redis, BullMQ, Anthropic Claude, claude-opus-4-8, Zod, Linear, Atlassian/Jira, LaunchDarkly,
  Atlassian Statuspage, GitHub Actions, event sourcing, finite-state-machine, Vitest

TRY IT OUT (Devpost links field):
  • GitHub repo:   https://github.com/kaviyakumar23/kept
  • Landing page:  https://kept-iota.vercel.app   (live on Vercel)
  • Run it:        npm install → npm test (179 hermetic tests) → npm run demo (full-lifecycle storyboard incl. the flag-OFF block) → npm start (Bolt OAuth app + webhook server)
                   Each external dependency upgrades from its simulated adapter to the real one when its env var is set: DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, LINEAR_MCP_TOKEN / ATLASSIAN_MCP_TOKEN, GITHUB_TOKEN.

SUBMISSION TRACK: Slack Agent for Organizations

REQUIRED TECH STATED IN DESCRIPTION (need ≥1 of the three; Kept has all three):
  • Slack AI Assistant  • Model Context Protocol (MCP)  • Real-Time Search API (assistant.search.context)

GALLERY: upload docs/architecture.png (architecture diagram) + the Evidence Packet card, the trust page,
  and the App Home drift band (docs/slack-cards.png + real Slack screenshots once recorded).

STILL TO FILL BEFORE SUBMITTING:
  • Slack App ID              — Basic Information → App ID → replace <APP_ID_TBD> above
  • Demo video URL (≤ 3 min)  — opens on the flag-OFF block (see docs/VIDEO-SCRIPT.md); also replace <your-demo-url> in docs/index.html
  • Judge sandbox access      — invite slackhack@salesforce.com + testing@devpost.com to the workspace + demo channel (see docs/SETUP.md §8)
  • Landing-page URL          — https://kept-iota.vercel.app (live)
-->
