# CLAUDE.md — Kept (Slack Agent for Organizations)

Kept is a Slack-native, human-verified, **event-sourced obligation ledger** for shared customer channels, submitted to the **Slack Agent for _Organizations_** track (Slack Marketplace submission committed). It captures every promise, tracks it through a guarded lifecycle, **verifies real availability from proof it gathers via MCP (Proof-of-Done)**, and closes the loop back in the original thread only after a human signs.

Full delivery plan: `~/.claude/plans/lucky-coalescing-panda.md`.

## Non-negotiable invariants — every change MUST honor these
1. **The LLM proposes; code decides.** `decide()` in `src/engine/commandHandler.ts` is pure and is the *only* thing that emits events. The model classifies / extracts / routes queries / gathers proof and *proposes a Command* — it never emits an event, mutates state, chooses an MCP tool, or takes an action. Every new "agentic" feature (proof collection, Assistant, drift) obeys this.
2. **Zero-copy.** Only derived structured facts + refs are persisted; `assertNoRawContent` (`src/domain/zeroCopy.ts`) guards every append. New persisted fields must be **single-line, ≤1000 chars**, and must not use a forbidden name (`body/raw/text/blocks/message_text/…`). Never persist a raw message body, prompt, model response, or RTS result text.
3. **Two human gates; the agent assembles proof, the human signs.** Gate 1 = confirm commitment; Gate 2 = verify fulfillment. The agent autonomously assembles the **Evidence Packet**; a human signs the verdict. Never auto-verify or auto-notify.
4. **Tenant isolation is MANDATORY (P0).** Every read is scoped by `team_id`. A cross-tenant read is a P0 security bug. The choke points are `EventStore.getAllObligationIds(teamId)` and `ObligationService.listObligations(teamId, now)` — never call an unscoped variant. App Home, `/kept`, the Assistant, reminders, webhook-driven sends, and the trust page must all carry the acting workspace's team id.
5. **Audience policy on every customer-facing surface.** Closure drafts *and* the customer trust page pass through `sanitizeForAudience(evidence, "SHARED_CUSTOMER_CHANNEL")` + `detectLeaks` (`src/policy/audience.ts`). Internal-only sources (`linear/jira/github/crm/feature_flag/ci/status_page`) never leak to a customer.
6. **Marketplace constraints.** Production runs **HTTP mode (no Socket Mode)**; per-tenant bot tokens via a `PostgresInstallationStore` (`@slack/oauth`); **minimal scopes**; **no banned scopes** — use granular `search:read.public/.files/.users`, never blanket `search:read`, `read`, `post`, or `client`.
7. **Honesty framing.** Slack is the real, live surface, and **GitHub Actions is a genuine live proof source.** Jira, Linear, LaunchDarkly, and Statuspage have **real adapters** (Jira/Linear via hosted MCP; LaunchDarkly/Statuspage via REST) that activate when a tenant's credentials are configured, and otherwise fall back to an in-process **simulated** MCP proof server for the offline demo + hermetic tests (`buildProofCollector` in `src/integrations/proofSources.ts` does the real-vs-simulated routing). Never present the simulated fallback as a live connection, and never imply a specific tenant is connected when it isn't — the honesty is a credibility beat.

## Architecture (layers → key files)
- **Domain (pure):** `src/domain/*` — events, projection, `stateMachine` (2 gates), signals, `evidence` (+ `KIND_SOURCES`, `INTERNAL_ONLY_SOURCES`), `zeroCopy`, obligation.
- **Engine:** `src/engine/*` — `decide()` (commandHandler), `obligationService` (dispatch + optimistic concurrency), `reconciliation` (`assessFulfillment` — the Proof-of-Done gate), entityGraph, idempotency.
- **Store:** `src/store/*` — `EventStore` iface, memoryStore, postgresStore (events + InstallationStore + `PostgresScheduler`), `errors.ts` (ConcurrencyError), `schema.sql`.
- **Policy:** `src/policy/*` — `audience` (D1 sanitizer), actionTiers, roadmap.
- **Integrations:** `src/integrations/*` — `mcp` (work items + generic `query()` + simulated servers), linear/jira, proof adapters (github/launchdarkly/statuspage/jira/linear — **real, credential-activated with simulated fallback**), `proofSources` (`buildProofCollector` factory), roadmapPostgres.
- **Slack surface:** `src/slack/*` (blocks, rts, notifier) · `src/server/*` (`slackApp` Bolt OAuth, `assistant`, `index` boot, customRoutes: `/webhooks/*` + `/trust/:token` + `/healthz`).
- **App (transport-agnostic):** `src/app/*` — orchestrator, analytics, assistantQuery, drift.

## Build & verify
`npm run typecheck` · `npm test` (hermetic, no network) · `npm run test:integration` (needs `DATABASE_URL`) · `npm run eval` · `npm run demo` (offline storyboard) · `npm run demo:drive` (one-take webhook driver).

**Definition of Done for any change:** typecheck clean · full suite green · if a guarantee is touched (a gate, zero-copy, tenant isolation, audience, idempotency) add a regression test · run the `verify` skill (drive the flow end-to-end), not just tests.

## Workstreams → subagent ownership
`W1 tenancy → tenancy-guard` · `W2 OAuth/hosting → oauth-platform` · `W3 RTS + W5 drift → rts-migrator` · `W4 Proof-of-Done → evidence-engineer` · `W6 trust page → trust-page` · `W7 Marketplace → marketplace-captain` · adversarial verification → `adversary` · `W8 demo/Devpost → demo-director`.

## Conventions
- TypeScript ESM, `moduleResolution: Bundler`, Node 20+. Match surrounding style; keep files dependency-light.
- Commits: short, imperative, **no Claude attribution** (omit any Co-Authored-By trailer); git identity `kaviyakumar23`. Commit/push at green milestones or when asked.
- Docs in `docs/` (`DEVPOST.md`, `SETUP.md`, `eval-report.md`). Marketing landing on Vercel (`kept-iota.vercel.app`); the app + trust page are hosted on AWS App Runner.
