# Kept

> **Elevator pitch:** Kept remembers what your company owes every customer — and makes sure the customer hears when it's actually done. A Slack-native, human-verified obligation ledger that never treats a single message, ticket status, or merged PR as truth.

---

## Inspiration

Shared Slack channels are where modern B2B relationships live. They're also where promises quietly die. A customer asks for something in a thread. Someone on the team says "yep, we'll get that out this week." Then the real work scatters: a Linear ticket, a GitHub PR, a deploy, three other threads. Weeks later nobody can say whether the thing actually shipped — and the customer, the one person who should hear "it's done," is the last to find out.

Two failure modes erode trust fastest, and every tool we looked at walks straight into them:

- **False "done."** A ticket flips to Done, so someone tells the customer it's fixed. But Done is an internal status, not proof the customer can use the feature. The customer tries it, it still fails, and now you've burned credibility.
- **Leaked internal chatter.** In the rush to close the loop, internal context — ticket keys, PR numbers, "security vuln," roadmap dates — gets pasted straight into the customer channel.

We also didn't trust the obvious AI approach. A model that reads a channel and *decides* to mark obligations done, create tickets, or message customers is exactly the kind of agent that confidently does the wrong thing. We wanted an agent a skeptical staff engineer would actually deploy in a shared customer channel: one where the model never controls state, every consequential action passes a deterministic guard, and a human approves before anything reaches the customer.

So we built the opposite of an inbound ticketer. Kept treats every promise as a first-class **obligation with a life of its own** — and the north star, written into the code rather than the pitch, is *never treat a single message, ticket status, or merged PR as truth.*

## What it does

Kept maintains a human-verified, event-sourced **obligation ledger** for shared customer channels — capturing both what your company owes each customer and the commitments your team makes back. Watch one obligation move through it:

1. **Capture.** A customer message lands in a shared channel. Kept's LLM layer classifies and extracts a candidate obligation and *proposes* it. Nothing is committed yet — it enters as a `CANDIDATE`.
2. **Gate 1 — Confirm (human).** The owner gets a private card: here's what we think you committed to, here are prior commitments to this customer (pulled from the ledger), and a roadmap-conflict warning if the promised date is earlier than the roadmap. Only when the human clicks **Confirm** does the obligation become `OPEN` — and *only then* does Kept create the work-item issue (over MCP — a Linear/Jira tool call that *code*, not the model, decides to make). No accidental commitments, no premature side effects.
3. **Track.** Linear status changes, GitHub merges, and deploy events arrive as webhooks and attach as *evidence* — moving the obligation through `IN_PROGRESS` and into `POSSIBLE_FULFILLMENT`. Note the name: *possible*, not done.
4. **Reconcile.** Kept fuses multiple evidence sources. Ticket-Done alone is never enough. A merged PR **plus** a production deploy is sufficient; a direct customer confirmation is the strongest closure of all; a customer denial blocks closure entirely.
5. **Gate 2 — Verify (human).** When evidence opens the gate, the owner gets a verify card listing the contributing evidence. *Evidence opens the gate; it does not walk through it* — a human still approves, moving the obligation to `VERIFIED`.
6. **Close the loop.** Kept drafts a **sanitized, leak-checked, customer-safe** closure message, the owner approves (or edits) it, and Kept posts it back into the **original thread** — the customer finally hears that it's done.
7. **Outlive the ticket.** If the customer replies "still failing," the obligation `REOPENED`s — even if the ticket stays Done forever.

Ten lifecycle states (`CANDIDATE → OPEN → IN_PROGRESS → POSSIBLE_FULFILLMENT → VERIFIED → CUSTOMER_NOTIFIED → CLOSED`, plus `DISMISSED`, `CANCELLED`, `REOPENED`), two mandatory human gates, one source of truth that lives in Slack.

The whole experience lives in Slack: a private confirm card, a verify card listing contributing evidence, a closure-draft card with a leak-safety indicator and editable modal, an **App Home** tab grouping every obligation by customer, audit-history modals, a `/kept <customer>` ledger view, and private at-risk/overdue reminders to owners — never to the customer channel.

## How we built it

Kept is TypeScript (ESM, Node 20+), structured as four deterministic layers around a pure engine with a strict seam between language and state. The keystone: **the LLM proposes; code decides.** *(See the architecture diagram in the gallery for the full message-to-closure flow.)*

**LLM-proposes / engine-decides.** An inbound message goes to `proposeFromMessage` (`src/llm/propose.ts`), which classifies and extracts fields using **forced tool-use with Zod validation at the boundary** (`src/llm/anthropic.ts`, default `claude-opus-4-8`): the Zod schema becomes the tool's `input_schema`, `tool_choice` pins that tool, and the returned input is `schema.parse()`d at the boundary. The model returns a *Proposal* — a candidate `Command` — and nothing else. It never writes an event or mutates state. When there's no API key, a `MockLlmProvider` runs a heuristic responder against the same schemas, fully offline and deterministic. The deterministic heart is `decide()` in `src/engine/commandHandler.ts`: a pure `(events, command, ctx) → Decision` function that performs no I/O. Its pipeline runs in order — **envelope validation → idempotency → command-boundary checks (leak + evidence-consistency) → project current state → zero-copy `assertNoRawContent` → reconciliation gate → `canApply`**. As the state-machine header puts it: *"The LLM proposes; THIS decides. No transition happens without passing here."*

**Event sourcing.** State is never a mutable row. The ledger is an append-only log of typed events (16 event kinds), and an obligation is a *pure fold* of that log (`project()` in `src/domain/projection.ts`). Because state is derived in code, a logic change is a *replay, not a migration* — and time-travel (`projectAt`) is free, which is exactly what powers the audit view.

**Guarded finite state machine with two human gates.** Every legal transition lives in one `TRANSITIONS` table (`src/domain/stateMachine.ts`), each row carrying `requiresApproval`, `requiresEvidence`, and `changesState`. The single `canApply` guard runs ordered checks — legal transition, approval present, evidence present, evidence *sufficient* — returning typed codes (`ILLEGAL_TRANSITION`, `APPROVAL_REQUIRED`, `EVIDENCE_REQUIRED`, `INSUFFICIENT_EVIDENCE`). Two transitions are the human gates: **Gate 1** — `COMMITMENT_CONFIRMED` (CANDIDATE → OPEN), enforced by the `requiresApproval && !event.approved_by` branch in `canApply`; and **Gate 2** — `INTERNALLY_VERIFIED` (POSSIBLE_FULFILLMENT → VERIFIED), which requires *both* a human approval *and* sufficient reconciled evidence.

**Multi-source reconciliation.** `assessFulfillment()` (`src/engine/reconciliation.ts`) first drops forged or mislabeled evidence — a `customer_reply` claiming to come from GitHub is rejected by `isConsistentEvidence` — then resolves to **exactly two sufficiency lanes**: (a) a positive customer confirmation, or (b) a merged PR **and** a production deploy. A staging deploy can't masquerade as production (a self-declared `customer_scoped` flag on a non-prod deploy is ignored); a customer denial blocks verification outright. As the engine comment says: *"evidence opens the gate; it does not walk through it."*

**Zero-copy persistence.** No raw Slack message body, prompt, model response, or retrieved text is ever persisted. `assertNoRawContent()` (`src/domain/zeroCopy.ts`) runs **name-based and value-based scans** before every append and throws on any hit — flagging forbidden keys, oversized strings, and *any* Unicode line terminator (U+2028/U+2029/NEL/VT/FF, not just `\n`). Payloads carry IDs, permalinks, and short derived fields only.

**Gate-before-side-effect ordering.** The transport-agnostic orchestrator (`src/app/orchestrator.ts`) dispatches the gate command *first* and only creates a Linear issue or posts to the customer thread `if (status === "applied")`. Because `dispatch` returns `suppressed` (not `applied`) for an idempotent race loser, two concurrent Confirm clicks can never create two tickets — no locks required.

**Slack is the real, live surface.** A Slack Bolt app (`@slack/bolt`, Socket Mode) handles the Events API, Block Kit confirm/verify/closure cards, edit modals, the App Home tab, and the `/kept` slash command. The Bolt layer is deliberately thin — all real logic (gates, sanitization, reconciliation) lives in the engine and the orchestrator; the Slack layer only translates the wire. The same orchestrator methods are driven by the Bolt app, the webhook server, and the demo.

**MCP as a governed action transport.** Kept satisfies MCP server integration as a *deterministic MCP client*: after Gate 1 passes, the orchestrator calls a specific MCP tool (`create_issue`) with computed arguments — the model never selects the tool. `src/integrations/mcp.ts` is a streamable-HTTP MCP client for Linear (`https://mcp.linear.app/mcp`) and Atlassian/Jira (`https://mcp.atlassian.com/v1/mcp`) behind the same `WorkItemAdapter`, plus an in-process **simulated MCP server** so the demo and the hermetic tests exercise a real MCP client↔server round-trip (`listTools` + `callTool`) with no network or OAuth. This is the keystone applied to actions: the model interprets language; code — not the model — decides which MCP tool to call. (Tool resolution, argument building, and result parsing are configurable, since the hosted servers' schemas evolve.)

**Substrate that upgrades by environment.** The engine is hermetic and adapter-driven. Set `DATABASE_URL` and the in-memory store upgrades to a real `PostgresEventStore` (transactional `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`). Set `REDIS_URL` and reminders move to a real `BullmqScheduler`. Set `ANTHROPIC_API_KEY` for real Claude. Set `LINEAR_MCP_TOKEN` or `ATLASSIAN_MCP_TOKEN` and work items flow to the hosted Linear/Atlassian MCP servers instead of the in-process simulated one. *(Honest framing: Slack is the real, live integration; work items are created over MCP, where the demo + tests use an in-process simulated MCP server and the hosted Linear/Atlassian MCP servers plug in with a token; Postgres + Redis/BullMQ are real and exercised by the live integration suite; the LLM only proposes — the deterministic engine decides every transition, and code, not the model, chooses every MCP tool call.)*

**The six guarantees** — each an invariant the engine will not break, enforced by a specific mechanism, not a convention:

1. **No accidental commitment** — `OPEN` is reachable only via Gate 1, where `canApply` rejects `COMMITMENT_CONFIRMED` unless a human's `approved_by` is set.
2. **No false fulfillment** — ticket-Done / merged PR is evidence, not truth; `VERIFIED` requires `assessFulfillment` to be *sufficient* (a customer confirmation, or merged PR + production deploy) **and** a human at Gate 2.
3. **No duplicated side effects** — deterministic idempotency keys plus a storage-layer `ON CONFLICT DO NOTHING` make repeated webhooks and double-clicks no-ops; a deduped race returns `suppressed`, not `applied`, and side effects fire only on `applied`.
4. **No confidential leakage** — `sanitizeForAudience` drops internal-only sources, the engine re-runs `detectLeaks` on the `NOTIFY_CUSTOMER` *command* and rejects a leaky draft, and a human still approves before anything reaches `postInThread`.
5. **Complete auditability** — every transition envelope records source, evidence, actor, timestamp, prior/new state, approval, and idempotency key in the append-only log; state is derived, never overwritten, and `projectAt` reconstructs any point in time.
6. **The obligation outlives the ticket** — a customer dispute fires `REOPENED` even from `CLOSED`/`VERIFIED`/`CUSTOMER_NOTIFIED`, so a stale "Done" ticket can never silence a real failure.

## Challenges we ran into

- **Keeping the LLM out of the decision path without making it useless.** The hardest discipline was keeping the model strictly on the language side. We solved it structurally: the model returns a Zod-validated `Command`, and a pure, I/O-free `decide()` is the only thing that can produce an event. Resisting the temptation to let the model "just handle the edge case" was the core design tension.
- **Defining "done" without lying to the customer.** A merged PR feels like done. It isn't. Reconciliation went through several iterations before we settled on exactly two sufficiency lanes and explicitly refused to honor a self-declared `customer_scoped` flag on a non-production deploy — building it as a small set of explicit, testable lanes rather than a confidence score.
- **Zero-copy is sneakier than it looks.** Raw content tries to leak in through oversized strings and exotic Unicode line terminators. We ended up scanning both field names and values, capping lengths, normalizing Unicode, folding lookalike dashes, stripping zero-width characters, and flagging *every* Unicode line break.
- **Concurrency at the gates.** Two owners clicking Confirm at the same instant must not create two issues. The fix was making `dispatch` return `suppressed` for the idempotent loser and ordering the orchestrator so persistence precedes every side effect — race safety without locks or a DB constraint alone.

## Accomplishments that we're proud of

- A genuinely **pure decision core**: `decide()` and `canApply()` perform no I/O, which makes the guarantees testable and the whole engine replayable.
- **140 hermetic tests + 5 live integration tests.** The engine and unit suite run fully in-memory and deterministic — including a real MCP client↔server round-trip over an in-memory transport and the Slack AI Assistant's query router; the integration suite verifies the real Postgres event store and Redis/BullMQ scheduler against live services (and each integration test self-skips when its service env is absent).
- **7 adversarial verification rounds**, where we attacked our own guarantees and turned every finding into a permanent regression test — the command-path leak check plus forged-evidence rejection (Round 1), the all-Unicode line-break zero-copy fix (Round 3), the retry-stable Jira idempotency key (Round 5), a Round-6 sweep of the MCP path that fixed a confirmed-but-orphaned obligation on a work-item failure (a retry now self-heals behind a per-obligation lock) plus parser hardening, and a Round-7 sweep of the new Assistant + analytics surfaces (the architecture held — the model only routes into a fixed intent enum, the read is pure — while we hardened escaping, list caps, and a large-ledger crash). Each hole became a permanent test, not a patch note.
- **Provider parity demonstrated in code.** The full obligation lifecycle runs end-to-end on the simulated Jira adapter too — same guarantees, different provider — proving the `WorkItemAdapter` abstraction holds (both providers behind one interface; the demo runs on Linear).
- **A clean transport-agnostic core** and a **polished Slack-native UX**: confirm/verify/closure cards, edit modals that re-run the leak check on submit, an App Home dashboard grouped by customer, and a slash-command ledger — all dependency-light, plain-object Block Kit. And a correctness story we can defend line by line: every guarantee maps to a specific guard in a specific file.

## What we learned

**Trust is an architecture, not a feature.** The most valuable thing an agent can do in a customer channel is *refuse to act* until the right conditions hold — and prove why. A few things crystallized for us:

- **Make the safety property structural, not procedural.** "Remember to check approval" is a bug waiting to happen; a guard table that *cannot* emit an event without `approved_by` is a guarantee. "The model never decides a transition" did more to make the system trustworthy than any accuracy number could.
- **Event sourcing is the perfect substrate for an agent.** It makes "what did the agent know, and when" answerable by replay, lets us evolve logic without migrating data, and gave us free time-travel for audits. Reworking how an obligation is derived was a replay, not a migration.
- **"Evidence, not truth" is the right default.** Treating ticket status and merged PRs as signals to reconcile — rather than facts to act on — is what makes an autonomous-feeling agent safe in a customer channel.
- **Adversarial self-review beats more feature work.** Every round we ran against our own six guarantees surfaced bugs no happy-path test would have, and each one hardened into a regression that makes the next round harder to break.

Separating "the model interprets language" from "code controls state and actions" gave us both the fluency of an LLM and a predictability customers can actually rely on.

## What's next for Kept

- Complete the OAuth flow for the hosted Linear and Atlassian **MCP** servers (the streamable-HTTP MCP client is wired and the demo + tests run against an in-process MCP server; live use just needs token/OAuth credentials). The legacy direct-API adapters remain as fallbacks.
- Per-source webhook HMAC verification, replacing the current shared-secret stand-in.
- Richer account context (CRM) and changelog/status-page evidence as additional reconciliation lanes, behind the same consistency checks, with configurable per-team sufficiency policy.
- Expand the opt-in cross-channel RTS retriever, which already runs permission-safe under the triggering user's token and keeps results ephemeral.
- Analytics on the ledger — time-to-fulfillment, at-risk forecasting, SLA reporting — all derivable from the existing event log, plus broader proactive at-risk/overdue nudges to owners.

<!-- ─────────────────────────────────────────────────────────────────────────
     CRIB SHEET — maps to the OTHER Devpost form fields (not part of the story).
     This whole block is an HTML comment; it won't render in the submission.
     ───────────────────────────────────────────────────────────────────── -->
<!--
ELEVATOR PITCH (Devpost's short pitch field, ~200 char max — pick one):
  • Kept remembers what your company owes every customer — and makes sure the customer hears when it's actually done.
  • A Slack-native obligation ledger that never treats a single message, ticket status, or merged PR as truth.
  • The LLM interprets the language. Code controls the state. A human approves before the customer ever hears a word.
  • Promises are made in chat; fulfillment lives everywhere else. Kept closes the loop — in the original thread, only after a human verifies it's real.

BUILT WITH (Devpost tags field): TypeScript, Node.js, Slack Bolt, Block Kit, Slack Events API, Socket Mode,
  App Home, Model Context Protocol (MCP), PostgreSQL, Redis, BullMQ, Anthropic Claude, claude-opus-4-8, Zod,
  Linear, Jira, GitHub webhooks, event sourcing, finite-state-machine, Vitest

TRY IT OUT (Devpost links field):
  • GitHub repo:   https://github.com/kaviyakumar23/kept
  • Landing page:  https://kept-iota.vercel.app   (live on Vercel)
  • Run it:        npm install  →  npm test (140 hermetic tests)  →  npm run demo (full-lifecycle storyboard)  →  npm start (Bolt app + webhook server)
                   Each external dependency upgrades from its simulated adapter to the real one when its env var is set: DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, LINEAR_* / JIRA_*.

SUBMISSION TRACK: New Slack Agent

GALLERY: upload docs/architecture.png (the architecture diagram) + screenshots of the Slack cards / App Home.

STILL TO FILL BEFORE SUBMITTING:
  • Demo video URL (≤ 3 min)  — also replace <your-demo-url> in docs/index.html
  • Landing-page URL          — once GitHub Pages is live
  • Test access for judges    — slackhack@salesforce.com + testing@devpost.com
-->
