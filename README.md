# Kept

[![CI](https://github.com/kaviyakumar23/kept/actions/workflows/ci.yml/badge.svg)](https://github.com/kaviyakumar23/kept/actions/workflows/ci.yml)

> Kept remembers what your company owes every customer — and makes sure the customer hears when it's done.

Kept is a Slack-native agent for shared customer channels. It maintains a **human-verified, event-sourced obligation ledger**: every request a customer makes and every promise your team makes is captured the moment it's said, tracked through its real lifecycle, reconciled against systems of record, and closed back in the original thread only after a human approves.

**North star:** Kept never treats a single message, ticket status, or merged PR as truth. It builds an auditable obligation state from multiple evidence signals over time, and requires human confirmation before any consequential transition.

> Positioning vs. inbound-only Slack ticketing (Pylon/Thena): Kept is **bidirectional** (tracks promises, not just asks), closes on **verified fulfillment** (real availability, human-confirmed — never a "Done" flag), and **closes the loop** back with the customer.

---

## For judges — 2-minute evaluation

No accounts, tokens, or services required:

```bash
npm install
npm test            # 119 hermetic tests (engine + adapters + MCP + adversarial regressions)
npm run demo        # the full obligation lifecycle, end to end, in your terminal
```

- **Required technology — MCP:** work items are created by calling an MCP tool. Kept is a *deterministic* MCP client — code picks the tool after a passed gate; the model never does. See [MCP integration](#mcp-integration-deterministic-client) and `src/integrations/mcp.ts` (`npm run demo` runs a real MCP client↔server round-trip in-process).
- **The thesis, in two files:** the guarded state machine + two human gates (`src/domain/stateMachine.ts`) and the pure, I/O-free `decide()` (`src/engine/commandHandler.ts`).
- **Artifacts:** architecture diagram → `docs/architecture.png` · write-up → `docs/DEVPOST.md` · landing page → `docs/index.html` · demo script → `docs/DEMO_SCRIPT.md` · eval report → `docs/eval-report.md`.
- **Honest framing:** Slack is the real, live surface; Postgres + Redis/BullMQ are real (exercised by the live integration suite). Linear/Jira run over MCP — the demo + tests use an in-process MCP server; the hosted Linear/Atlassian MCP servers plug in with a token. The LLM only proposes; a deterministic engine decides every transition.

---

## What's in this repo

The deterministic, event-sourced obligation **engine** (fully unit-tested + an independent eval harness) **and** the **Layer-4 adapters** on top of the `ObligationService` seam: a transport-agnostic orchestrator, the Slack surface (Bolt events + Block Kit confirm/verify/closure cards, App Home ledger dashboard, edit modals, audit history), webhook ingestion (Linear/GitHub/deploy), and work-item adapters (Linear + Jira) driven over **MCP** — Kept is a deterministic MCP client. `npm run demo` drives the whole loop with no external services (work items go through a real in-process MCP server).

```
Slack Events / webhooks ─► propose Command ─► decide() ─► EVENT STORE ─► projection
   (adapter)                  (LLM)            (engine)    (append-only)   (derived state)
                                                  │
                          guards · idempotency · reconciliation · audience policy
```

### The architecture (four deterministic layers)

| Layer | Responsibility | Code |
|---|---|---|
| **1. Signal interpretation** | LLM classifies (typed taxonomy) + extracts fields → **proposes a Command**. Never decides a transition. | `src/llm/*` |
| **2. Obligation domain** | Pure TypeScript: events, projection, guarded state machine, commands. | `src/domain/*` |
| **3. Engine infrastructure** | Append-only store, projections, idempotency, multi-source reconciliation, entity graph. | `src/engine/*`, `src/store/*` |
| **4. Integration & policy** | Audience-safe outputs, action tiers, reminders, roadmap check. | `src/policy/*`, `src/scheduler/*` |

On top of those four layers, the **adapter layer** translates the outside world onto the engine: `src/app/orchestrator.ts` (transport-agnostic — every Slack action and webhook flows through it), `src/slack/*` (Block Kit cards, notifier, RTS), `src/integrations/{linear,jira,mcp}.ts` (work items created over MCP — a deterministic MCP client, never the LLM), `src/webhooks/*` (Linear/GitHub/deploy ingestion), and `src/server/*` (the Bolt + HTTP transports). The orchestrator holds *no* business rules — it only sequences calls into the engine, so the gates, sanitization, and reconciliation are enforced in exactly one place.

**The keystone:** the LLM never writes an event like `CUSTOMER_NOTIFIED`. It proposes a `Command`; the deterministic engine (`decide()` in `src/engine/commandHandler.ts`) validates guards + evidence + approval and only then emits events. *The model interprets language; code controls state and actions.*

### The technical core (Part C)

- **C1 — Typed signal taxonomy** (`domain/signals.ts`): `CUSTOMER_REQUEST` vs `TENTATIVE_COMMITMENT` vs `CONFIRMED_COMMITMENT` … never binary.
- **C2 — Event sourcing** (`domain/events.ts`, `domain/projection.ts`): append-only log; current state is *derived*, never a mutable row. Replay-safe, fully auditable.
- **C3 — Temporal reasoning / supersession**: a later due date wins; history retained. Falls out of folding the ordered log.
- **C4 — Entity graph** (`engine/entityGraph.ts`): "SSO bug" / "login issue" / `PROJ-118` / `PR #449` / a release resolve to one obligation.
- **C5 — Multi-source reconciliation** (`engine/reconciliation.ts`): PR merged ≠ fulfilled; ticket Done ≠ notified; deploy ≠ confirmed; merge **+** customer-scoped deploy → available; customer reply → strong closure.
- **C6 — Idempotency** (`engine/idempotency.ts`): deterministic keys + semantic dedupe — duplicate Slack events / webhooks are no-ops.
- **C7 — Guarded FSM** (`domain/stateMachine.ts`): explicit guarded transitions with two mandatory human gates. Primary **states** + derived **flags** (`is_overdue`, `is_at_risk`, `has_scope_change`, `is_disputed`, `needs_clarification`) + **events** are cleanly separated.

### Safety (Part D)

- **D1 — Audience policy** (`policy/audience.ts`): customer-facing drafts are built only from shareable facts; internal evidence (Linear/Jira/GitHub/CRM) is redacted; a leak detector catches injected internal refs.
- **D2 — Action tiers** (`policy/actionTiers.ts`): automatic vs human-confirmation vs never-autonomous (kept in sync with the FSM guards — verified by test).
- **D3 — Invariants**: zero-copy (name **and** value channel), RTS permission parity, two human gates, no public noise, idempotent transitions + reopen, evidence-based transitions, fulfillment ≠ ticket status.
- **Roadmap contradiction check** (`policy/roadmap.ts`): a commitment whose due date is earlier than the approved roadmap target raises a private, internal-only warning (the spec's secondary beat).

### Lifecycle

```
CANDIDATE ─(Gate 1: confirm)─► OPEN ─► IN_PROGRESS ─► POSSIBLE_FULFILLMENT
   ─(Gate 2: verify, evidence+approval)─► VERIFIED ─► CUSTOMER_NOTIFIED ─► CLOSED
branches: DISMISSED · CANCELLED · REOPENED ─► IN_PROGRESS   (obligation outlives the ticket)
```

The two mandatory human gates:
- **Gate 1** `CANDIDATE → OPEN` (`COMMITMENT_CONFIRMED`, requires `approved_by`)
- **Gate 2** `POSSIBLE_FULFILLMENT → VERIFIED` (requires reconciled evidence **and** approval) and `VERIFIED → CUSTOMER_NOTIFIED` (requires approval)

---

## The six guarantees

1. **No accidental commitment** — `OPEN` only via an approved Gate 1.
2. **No false fulfillment** — a ticket status / merged PR is evidence, not truth; closure needs reconciliation + human verification.
3. **No duplicated side effects** — repeated events/webhooks are idempotent no-ops.
4. **No confidential leakage** — internal evidence never reaches the customer channel.
5. **Complete auditability** — every transition carries source, evidence, actor, timestamp, prior/new state, approval, idempotency key.
6. **The obligation outlives the ticket** — a customer dispute reopens it even if the ticket stays Done.

---

## Run it

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest — 119 tests (engine + adapters + MCP + adversarial-regression), fully hermetic
npm run demo          # the full E3 storyboard, end to end, no external services
npm run eval          # the evaluation harness (metrics)
npm start             # run the live app (Slack Events + webhook server) — needs tokens

# Live integration tests — exercise the REAL adapters against running services.
# Each test skips itself when its service env is unset, so this is always safe to run.
DATABASE_URL=postgres://localhost:5432/kept REDIS_URL=redis://localhost:6379 \
  npm run test:integration   # PostgresEventStore · BullmqScheduler · PostgresRoadmapSource
```

`npm run demo` prints the entire loop — the private confirm card, Linear issue, duplicate-webhook suppression, semantic dedupe, merge+deploy reconciliation, the Gate-2 verify card, the sanitized in-thread closure, the reopen, the two-sided ledger, and the full audit history — all driven through the **real** orchestrator + engine with recording/simulated adapters.

The live app (`npm start`) runs the real Slack surface (Events API + Block Kit) on top of the same orchestrator; Linear/Jira + deploy arrive as webhooks (`POST /webhooks/{linear,jira,github,deploy}`). Each external dependency upgrades from its simulated adapter to the real one when its env is set (`DATABASE_URL` → Postgres, `REDIS_URL` → BullMQ, `ANTHROPIC_API_KEY` → Claude, `LINEAR_MCP_TOKEN`/`ATLASSIAN_MCP_TOKEN` → the hosted Linear/Atlassian **MCP** servers; default is an in-process MCP server). See `.env.example`.

**Slack setup:** create the app at api.slack.com → *From a manifest* using [`slack-manifest.yaml`](slack-manifest.yaml) (it declares the scopes, events, `/kept` command, interactivity, App Home, and Socket Mode). Then generate an app-level token (`connections:write`) → `SLACK_APP_TOKEN`, install to the workspace → copy the bot token + signing secret, and invite the bot to your (Slack Connect) channel.

The engine and its tests are **hermetic** — no database or network needed (in-memory adapters). The production substrate is real:

```bash
docker compose up -d   # Postgres event store + Redis/BullMQ
# set DATABASE_URL / REDIS_URL / ANTHROPIC_API_KEY in .env (see .env.example)
```

`PostgresEventStore` and `BullmqScheduler` implement the same interfaces as the in-memory adapters, so the engine is unchanged.

### Evaluation (`npm run eval`) — example output

Lifecycle & safety metrics are guarantees by construction, demonstrated across the scenario battery; classification runs the configured LLM provider (offline = a heuristic baseline, or set `ANTHROPIC_API_KEY` for the real model's numbers). The full per-class precision/recall + confusion matrix is published in [`docs/eval-report.md`](docs/eval-report.md) (`npm run eval:report`).

```
correct-transition rate ........ 100%
duplicate-suppression rate ..... 100%
false-closure rate ............. 0   (across 12 adversarial closure checks, incl. forged evidence + customer denials)
customer-facing leakage rate ... 0%  (incl. command-path leak rejection)
unauthorized-action count ...... 0   (across gate checks)
signal-classification .......... 90% · macro-F1 0.90  (offline heuristic baseline — see docs/eval-report.md)
```

### Adversarial verification

The guarantees aren't just asserted — they were attacked across six rounds. A multi-agent workflow ran independent skeptics (one per guarantee) that tried to *break* each guarantee against the real code, plus a correctness reviewer and a completeness critic.

- **Round 1** found that several guarantees trusted proposer-supplied data: reconciliation ignored `evidence.source`; leak-safety was advisory (not on the command path); detect-time refs were dropped; zero-copy checked field *names* but not *values*. All fixed.
- **Round 2**, against the fixed code, found *same-class variants* the first fixes missed — a forgeable `slack`-sourced `customer_reply`, Unicode-dash/dotted-`PR` leak bypasses, and value-channel gaps in zero-copy. All fixed.
- **Round 3** (focused) exhaustively confirmed G2 holds (only the two intended sufficiency lanes exist) and closed one last zero-copy gap: the newline guard missed the other Unicode line terminators (U+2028/U+2029/NEL/VT/FF), through which a multi-line raw body could be smuggled. Fixed.
- **Round 4** audited the Layer-4 adapters: no gate is bypassable via the Slack/webhook path and nothing reaches the customer channel except an approved, sanitized closure (both confirmed). It found a real **concurrency** class of bugs — `dispatch` reported `"applied"` even when the store idempotently deduped, so two un-serialized gate clicks could double-post to the customer or mint two Linear issues. Fixed at the seam (dispatch now reports `"suppressed"` for a deduped append; `confirmCommitment` validates the gate before any side effect), with concurrency regression tests.
- **Round 5** audited the Jira work-item path for parity with Linear: the engine **guarantees hold identically** (a Jira "Done" alone is insufficient; no gate bypass), but two Jira-specific **webhook-robustness** gaps surfaced — the mapper crashed (HTTP 500) on Jira's non-status events (comments/deletes), and it read a frequently-absent timestamp, producing colliding idempotency keys. Both fixed (ignore status-less events; use the retry-stable top-level `timestamp`), with regression tests.
- **Round 6** attacked the new **MCP** work-item path. The gates hold over MCP, but a work-item create failing *after* Gate 1 left a confirmed-but-orphaned obligation that a retry couldn't heal (the consumed `:confirm` key suppressed it) — plus three result-parsing robustness gaps (a quadratic-backtracking `REF_RE`, unbounded `pickString` recursion, and an unescaped work-item ref rendered as Slack mrkdwn on the internal ledger). Fixed: create+link is now driven by obligation **state** behind a per-obligation lock (a retry self-heals; concurrent clicks still mint exactly one), the parser is length/depth-bounded, the Slack handlers surface the failure to the owner, and the ledger escapes adapter-supplied refs — with regression tests.

Every finding became a permanent regression test (`tests/hardening.test.ts`, `tests/orchestrator.test.ts`, `tests/webhooks.test.ts`, `tests/mcpHardening.test.ts`). This is the "evidence-based, human-verified" principle applied to the engine's own development — and a demonstration of why one round of "looks correct" isn't the same as verified.

**Accepted design boundaries** (documented, not open bugs): the engine trusts its own integration *adapters* to stamp `evidence.source` honestly (a deploy adapter reports the real environment; the customer-channel adapter sets `source: "customer"` only after verifying the external author), and per correction #3 the durable obligation's derived fields are human-confirmed at Gate 1. Leak detection is defense-in-depth against accidental/common-obfuscation leaks — the mandatory human approval before any customer send is the real backstop against deliberate exfiltration.

---

## Stack

Bolt + TypeScript · Slack Events API · RTS (targeted retrieval) · PostgreSQL (event store + projections) · Redis + BullMQ (reminders, retries) · **MCP** for work items (Model Context Protocol — a deterministic MCP client + an in-process simulated MCP server; hosted Linear/Atlassian MCP servers plug in with a token) · optional GitHub/deploy webhook · Zod (LLM structured-output validation) · explicit guarded-transition module · provider-agnostic LLM interface (default `claude-opus-4-8`) · Block Kit.

### MCP integration (deterministic client)

Kept satisfies the "MCP server integration" requirement *without* handing the model the controls. After the engine passes Gate 1, the orchestrator calls a specific MCP tool (`create_issue`) with computed arguments — the LLM never selects the tool. `src/integrations/mcp.ts` is a streamable-HTTP MCP client for Linear (`https://mcp.linear.app/mcp`) and Atlassian/Jira (`https://mcp.atlassian.com/v1/mcp`) behind the same `WorkItemAdapter` interface, plus an in-process **simulated MCP server** (`createSimulatedMcpWorkItems`) so the demo and the hermetic tests exercise a real MCP client↔server round-trip (`listTools` + `callTool`) with no network or OAuth. Tool resolution, argument building, and result parsing are configurable, since the hosted servers' schemas evolve.

> Structured LLM output uses **forced tool-use** + Zod validation (`src/llm/anthropic.ts`), the most portable structured-output path.

## Built & remaining

**Built:** the engine (Parts C/D) + the Layer-4 adapters — orchestrator, Slack surface (Bolt events, Block Kit confirm/verify/closure cards, `/kept` ledger), the **App Home dashboard** (live two-sided ledger grouped by customer, with a History drill-in modal), **Edit modals** (edit-and-confirm at Gate 1; edit-the-customer-reply at closure — the edited reply is re-leak-checked by the engine before it can send), RTS — both a **ledger-backed retriever** (prior commitments + area owner) and a **cross-channel Slack-search retriever** (`SlackRtsRetriever`, permission-safe via the user token, surfaces channel-scoped context not raw text) behind a `CompositeRtsRetriever`, the **roadmap-contradiction warning** with pluggable sources (static / **file** / **Postgres**), **Linear *and* Jira work-item adapters** behind one `WorkItemAdapter` interface, created over **MCP** (a deterministic MCP client; an in-process simulated MCP server exercises a real client↔server round-trip in the demo + tests, and the hosted Linear/Atlassian MCP servers plug in with a token), Linear/Jira/GitHub/deploy webhook ingestion, the live-app boot, and the reproducible demo. The real `PostgresEventStore`, `BullmqScheduler`, and `PostgresRoadmapSource` are **verified against live Postgres + Redis** by the integration suite.

**Remaining (production polish):** user-token OAuth storage so `SlackRtsRetriever` has per-user tokens to search with in production (the retriever + composite are built and unit-tested; live activation needs the token store); and a full end-to-end run against a real Slack Connect workspace (needs a bot token + tunnel). The hosted Linear + Atlassian **MCP** servers are wired via the streamable-HTTP MCP client (Bearer token); the demo + tests run against an in-process MCP server, so the live hosted servers just need OAuth/token credentials. The legacy direct-API `LinearApiAdapter` / `JiraApiAdapter` (GraphQL/REST) remain as fallbacks.

### Known hardening items (deferred, documented)

- **Optimistic concurrency on append.** `dispatch()` is read→decide→append; two *different* commands racing on one obligation could both apply (single-process demo is unaffected, and deterministic notify/transition idempotency keys mitigate the consequential cases). Production fix: an `expectedVersion` compare-and-append on `EventStore`.
- **Homoglyph-resistant leak detection.** `detectLeaks` normalizes zero-width/Unicode and is case/hyphen-insensitive; full homoglyph (e.g. Cyrillic look-alikes) coverage would need a confusables map.
