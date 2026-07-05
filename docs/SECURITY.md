# Kept — Security & Compliance Questionnaire (draft)

_Last reviewed: 2026-07-05. This is a draft for the Slack Marketplace Security & Compliance
review; every claim is traceable to a file cited inline. Items marked `<TODO: confirm>` are
open questions for the operator — do not submit them as answered._

Kept is a Slack-native, human-verified, event-sourced **obligation ledger** for shared
customer channels. It captures commitments made in Slack, tracks them through a two-gate
lifecycle, assembles proof-of-completion, and posts a customer-facing closure only after a
human signs off.

---

## 1. Data handling — what Kept does and does not store

**Zero-copy is the core data-handling guarantee.** Kept persists only *derived, structured,
human-confirmed facts and references* — never raw Slack message bodies, prompts, or model
output.

- Enforced in code by `assertNoRawContent()` in `src/domain/zeroCopy.ts`, called before
  **every** append to the event log. It rejects an event if it contains:
  - a forbidden field name (`body`, `raw`, `text_body`, `message_text`, `blocks`, `prompt`,
    `completion`, `model_response`, `rts_result`, `transcript`, `quote`, `retrieved_text`, …);
  - any string value **> 1000 chars** (a pasted body signal);
  - any **line break** of any Unicode kind in a persisted field;
  - a value over the per-field cap (`customer`/`subject_canonical` ≤ 160, `outcome` ≤ 400).
- A violation throws `GuardViolation("RAW_CONTENT_PERSISTED")` and the append is refused.
- Consequence: Kept **does not export or back up message data**, which is also a Slack
  Marketplace eligibility gate (apps that "export or backup message data" are rejected).

### What IS persisted (from `src/store/schema.sql`)

| Table | Contents | Sensitive? |
| ----- | -------- | ---------- |
| `obligation_events` | Append-only event log: `obligation_id`, `team_id`, `event_type`, `idempotency_key`, and a `payload` JSONB of **derived** fields (customer, normalized outcome, owner id, due date) + Slack object IDs / permalinks. Guarded by `assertNoRawContent`. | Structured facts + refs only |
| `roadmap` | Approved target dates per `(team_id, customer, subject_canonical)` — used for the Gate-1 contradiction check. No message content. | Low |
| `slack_installations` | One row per installed workspace/org: the **normalized OAuth installation JSON, including the per-tenant bot token**. This is the one table that legitimately holds a secret. Not subject to the zero-copy guard by design (`src/store/installationStore.ts`). | **Secret (bot token)** |
| `trust_links` | Opaque, revocable capability tokens mapping a token → exactly one `(team_id, customer)` for the customer trust page. Stores no message content. | Capability token |
| `reminders` | Pending AT_RISK / OVERDUE reminder jobs (`obligation_id`, `kind`, `fire_at`). No message content. | Low |

**Not stored anywhere:** raw message text, prompts sent to the LLM, LLM responses, or RTS
retrieval text. The LLM sees message text transiently at inference time to *propose* a
structured command; only the human-confirmed derived fields are ever written.

---

## 2. Data retention & deletion

- **Retention:** the event log is append-only. There is currently **no automated
  time-based purge / TTL** in the code. `<TODO: confirm>` a retention policy (e.g. purge
  obligation data N days after a workspace uninstalls, or on a rolling window) and, if
  required, implement it.
- **Deletion on uninstall — IMPLEMENTED (automatic):**
  - The Slack `app_uninstalled` and `tokens_revoked` bot events are subscribed in
    `slack-manifest.yaml`. A Bolt handler in `src/server/slackApp.ts` (OAuth branch)
    resolves the acting team (Bolt skips authorization for these events and still supplies
    `context.teamId`) and, on uninstall, calls **both**
    `installationStore.deleteInstallation()` (drops the stored bot token) **and**
    `EventStore.purgeTeam(teamId)` (purges the tenant's ledger + derived rows). The handler
    is idempotent and fail-safe — it logs and continues on any error, never crashing the app,
    and a re-delivered event re-runs a no-op purge. `tokens_revoked` triggers the purge only
    when the **bot** token is among those revoked (a user-token-only revoke leaves the app
    installed, so the ledger is preserved).
  - `EventStore.purgeTeam(teamId)` (`src/store/eventStore.ts`) deletes **every** tenant-scoped
    row for the team. In Postgres it runs one transaction of `DELETE ... WHERE team_id = $1`
    across `obligation_events`, `trust_links`, and `roadmap`, plus `reminders` (which inherit
    the team via their `obligation_id`) — all-or-nothing. It is strictly team-scoped: purging
    team A leaves team B's data intact (verified in `tests/dataDeletion.test.ts`), and returns
    per-table counts logged to the uninstall audit trail. `slack_installations` is dropped
    separately by `deleteInstallation` (it is keyed by installation id and holds the bot token).
  - Ad-hoc deletion / data-access requests remain available via `docs/SUPPORT.md` (operator
    runs the same team-scoped purge on demand).
- **Data-access / export requests:** handled manually by the operator against the RDS
  instance, scoped by `team_id`. See `docs/SUPPORT.md` and `docs/PRIVACY.md`.

---

## 3. Tenant isolation (multi-tenant separation)

Kept is multi-tenant on a single Postgres instance; isolation is by `team_id`, enforced in
code (CLAUDE.md invariant #4 — a cross-tenant read is a P0 bug).

- Every `obligation_events` row carries a `team_id` (schema partition key,
  `idx_obligation_events_team`).
- The **only** read choke points are `EventStore.getAllObligationIds(teamId)` and
  `ObligationService.listObligations(teamId, now)` — both take `teamId`; there is no
  unscoped variant to call.
- App Home, `/kept`, the AI Assistant, reminders, webhook-driven sends, and the trust page
  each carry the acting workspace's `team_id`.
- **Fail-closed:** a Slack message that arrives with no resolvable team is dropped rather
  than attributed to a synthetic tenant (`src/server/slackApp.ts` message handler).
- Cross-tenant **writes** are rejected in the orchestrator (`CrossTenantWriteError`) before
  any side effect on confirm/verify/dismiss/approve-send.
- The customer **trust page** is authorized by an opaque per-`(team, customer)` capability
  token; the resolved `team_id` is the only tenant the page may read (`src/server/trustPage.ts`).
- **Roadmap read scoping — CLOSED:** the roadmap read path is now team-scoped.
  `RoadmapSource.list(teamId)` takes the acting workspace, the orchestrator passes
  `result.obligation.team`, and `PostgresRoadmapSource.list(teamId)` filters
  `WHERE team_id = $1` (`src/integrations/roadmapPostgres.ts`). Roadmap holds only target
  dates (no message content), so this is defense-in-depth rather than a leak fix, but the
  cross-tenant read is now closed at the query.

---

## 4. Audience / data-leak policy (customer-facing surfaces)

Internal evidence (Linear/Jira/GitHub/CRM/feature flags/CI/status page) must never reach a
shared customer channel or the customer trust page (CLAUDE.md invariant #5).

- Every customer-facing draft passes through `sanitizeForAudience(evidence,
  "SHARED_CUSTOMER_CHANNEL")` + `detectLeaks()` (`src/policy/audience.ts`).
- `INTERNAL_ONLY_SOURCES` (`src/domain/evidence.ts`) — `linear`, `jira`, `github`, `crm`,
  `feature_flag`, `ci`, `status_page` — are dropped for a customer audience.
- `detectLeaks` catches ticket keys, PR numbers, tool names, and common obfuscations
  (zero-width chars, Unicode dashes, dotted/spaced refs) before send. It is defense-in-depth,
  not DLP — the **mandatory human approval before any customer send** is the real backstop.
- Permission parity: evidence the acting user could not access is dropped first.

---

## 5. Authentication & authorization

- **Per-tenant OAuth (HTTP mode, no Socket Mode in production).** Kept boots in OAuth HTTP
  mode when `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_STATE_SECRET` are all set
  (`src/config.ts` `isOAuthMode`). Each workspace installs via `GET /slack/install` →
  `GET /slack/oauth_redirect`; Bolt persists the install via `PostgresInstallationStore`
  and authorizes each inbound event to the correct workspace's bot token. `GET /slack/install`
  is configured with `installerOptions.directInstall: true` (`src/server/slackApp.ts`), so it
  HTTP-302s straight to `slack.com/oauth/v2/authorize` (the Marketplace Direct Install
  requirement) rather than rendering an intermediate button page.
- **Signed requests:** Slack request signatures are verified by Bolt using
  `SLACK_SIGNING_SECRET`.
- **Provider webhooks** (`/webhooks/{linear,jira,github,deploy}`) are guarded by an optional
  shared secret (`KEPT_WEBHOOK_SECRET`) and route to a tenant by `x-kept-team` /
  payload resolution. `<TODO: confirm>` `KEPT_WEBHOOK_SECRET` is set in production.
- **Least privilege:** minimal granular bot scopes only — see `docs/SCOPES.md`.

---

## 6. Encryption

- **In transit:**
  - Slack ⇆ Kept: HTTPS/TLS terminated at AWS App Runner (managed certificate; App Runner
    serves HTTPS by default).
  - Kept ⇆ RDS Postgres: TLS enforced via `?sslmode=require` in `DATABASE_URL`
    (`docs/DEPLOY-AWS.md` step 3).
  - Kept ⇆ Slack API / Anthropic API / GitHub API: HTTPS.
- **At rest:**
  - RDS storage encryption (KMS) — **enabled.** The `aws rds create-db-instance` command in
    `docs/DEPLOY-AWS.md` now passes `--storage-encrypted`, which encrypts storage, automated
    backups, replicas, and snapshots using the account's default AWS-managed KMS key for RDS
    (`aws/rds`) unless a customer-managed `--kms-key-id` is supplied. Answer: **yes**.
  - Secrets (DB URL, Slack client secret/signing secret/state secret, GitHub token,
    optional Anthropic key) are stored in **AWS Secrets Manager** and injected as runtime
    secrets into App Runner (`docs/DEPLOY-AWS.md` step 4) — never baked into the image or the
    repo.

---

## 7. Sub-processors

| Sub-processor | Purpose | Data it receives |
| ------------- | ------- | ---------------- |
| **Amazon Web Services** (App Runner, RDS Postgres, Secrets Manager) | Application hosting, database, secrets storage | All persisted data (derived facts + refs + bot tokens); transient request payloads |
| **Anthropic** (Claude API) | LLM that *proposes* structured commands (classification/extraction/NL query routing). Optional — if `ANTHROPIC_API_KEY` is unset, Kept falls back to a local heuristic responder (`src/config.ts`). | Transient message text at inference time. **Nothing from the model is persisted** (zero-copy). |
| **Slack** | The platform Kept runs on | N/A (Slack is the source, not a downstream processor) |
| **GitHub** (GitHub Actions / API) | Live proof source for completion evidence (invariant #7) | Repo/workflow queries via `GITHUB_TOKEN` |

Linear, Jira, LaunchDarkly, and Atlassian Statuspage are **simulated via an in-process MCP
server** for the current build (real API skeletons exist but are not live) — they are **not**
live sub-processors today. Do not represent them as certified live integrations
(invariant #7).

---

## 8. Availability, logging, incident response

- **Health check:** `GET /healthz` (App Runner-monitored).
- **Logging:** application logs to stdout (App Runner → CloudWatch). Logs record structured
  events/ids, not raw message bodies. `<TODO: confirm>` log retention window in CloudWatch.
- **Backups:** RDS automated backups, `--backup-retention-period 7` (7 days) per
  `docs/DEPLOY-AWS.md`.
- **Incident response / disclosure contact:** see `docs/SUPPORT.md`. `<TODO: confirm>` a
  security-contact address and an SLA for responding to reports.

---

## Open items summary

Resolved in this hardening pass:

1. ~~Wire `app_uninstalled` / `tokens_revoked` → `deleteInstallation` **and** a per-tenant
   data purge~~ — **done** (Section 2): manifest subscription + Bolt handler +
   `EventStore.purgeTeam`, regression-tested in `tests/dataDeletion.test.ts`.
2. ~~Enable RDS `--storage-encrypted`~~ — **done** (Section 6).
3. ~~Team-scope the roadmap read path~~ — **done** (Section 3).
4. ~~Direct Install must HTTP-302~~ — **done** (`installerOptions.directInstall`, Section 5).

Still open for the operator:

5. Define & (if required) implement a data-**retention** policy (time-based purge/TTL is
   still absent; deletion-on-uninstall is now automatic — Section 2).
6. Confirm `KEPT_WEBHOOK_SECRET`, `KEPT_RTS`, CloudWatch log retention, and a security
   contact (Sections 3/5/8).
