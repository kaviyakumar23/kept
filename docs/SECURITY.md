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
- **Deletion on uninstall — KNOWN GAP (must fix before/at launch):**
  - `PostgresInstallationStore.deleteInstallation()` exists and deletes the
    `slack_installations` row for a team/enterprise (`src/store/installationStore.ts`).
  - **However**, `<TODO: fix>` there is currently **no Slack `app_uninstalled` /
    `tokens_revoked` event subscription** in `slack-manifest.yaml` and **no handler** wired
    to call `deleteInstallation`. As shipped, an uninstall does not automatically purge even
    the stored bot token.
  - Even once wired, `deleteInstallation` only removes the **token row**. It does **not**
    purge that team's `obligation_events`, `roadmap`, `trust_links`, or `reminders`. A full
    per-tenant purge helper does not yet exist. `<TODO: implement>` an
    `EventStore.purgeTeam(teamId)` (delete all rows WHERE `team_id = $1` across the four
    tenant-scoped tables) and invoke it from the uninstall handler.
  - **Interim answer for the questionnaire:** deletion is available on request via the
    contact in `docs/SUPPORT.md`; the operator runs the scoped `DELETE`s manually. This must
    become automatic before we can honestly answer "data is deleted on uninstall."
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
- **Known limitation:** `src/store/schema.sql` notes that the roadmap read path
  (`PostgresRoadmapSource.list`) is **not yet team-scoped** (`TODO(W2)`). Roadmap holds only
  target dates (no message content), but this should be closed for defense-in-depth.
  `<TODO: fix>` per-tenant roadmap reads.

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
  and authorizes each inbound event to the correct workspace's bot token.
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
  - RDS storage encryption (KMS) — `<TODO: fix>` the documented `aws rds
    create-db-instance` in `docs/DEPLOY-AWS.md` does **not** pass `--storage-encrypted`, so
    at-rest encryption is **not guaranteed** by the current runbook. Enable
    `--storage-encrypted` (and choose a KMS key) before launch, then answer "yes" here.
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

## Open items summary (must resolve before "submittable")

1. Wire `app_uninstalled` / `tokens_revoked` → `deleteInstallation` **and** a per-tenant
   data purge (Section 2). Highest priority.
2. Enable RDS `--storage-encrypted` (Section 6).
3. Define & (if required) implement a data-retention policy (Section 2).
4. Team-scope the roadmap read path (Section 3).
5. Confirm `KEPT_WEBHOOK_SECRET`, `KEPT_RTS`, CloudWatch log retention, and a security
   contact (Sections 3/5/8).
