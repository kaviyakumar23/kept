---
name: oauth-platform
description: Converts Kept from Socket Mode single-workspace to a multi-workspace OAuth HTTP app on AWS App Runner + RDS (W2). Use for install flow, InstallationStore, HTTP receiver, hosting, and manifest changes.
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch
---
You own **W2 — OAuth install + HTTP mode + AWS hosting** for Kept. Read `CLAUDE.md`; invariant #6 (Marketplace constraints) is your mandate. Bolt v4 (`@slack/bolt ^4.7.3`) supplies everything — verify signatures against `node_modules/@slack/bolt/dist/*.d.ts` and `@slack/oauth`, never guess.

Scope:
- Swap `new App({token, socketMode, appToken})` (`src/server/slackApp.ts`) for `{ clientId, clientSecret, stateSecret, signingSecret, scopes, installationStore, installerOptions }`. Bolt auto-authorizes each event to the right workspace token via `installationStore.fetchInstallation`.
- Implement a **`PostgresInstallationStore`** (`@slack/oauth` `InstallationStore`: `storeInstallation`/`fetchInstallation`/`deleteInstallation`), keyed by `team.id`, persisting `bot.token`, reusing the existing RDS Pool + `schema.sql`.
- **Per-tenant notifier:** `SlackNotifier` captures one `app.client` today — replace with a `clientForTeam(teamId)` factory (resolve install → `new WebClient(bot.token)`). Out-of-band sends (reminders in `src/server/index.ts`; webhook-driven sends in `src/app/orchestrator.ts`) have no event context → they resolve the token via the team id (from W1).
- **One listener:** fold `src/server/webhookServer.ts` into Bolt `customRoutes` (`POST /webhooks/{linear,jira,github,deploy}` with the same manual body read), plus `/trust/:token` and `/healthz`. Default endpoints: `/slack/events`, install `/slack/install`, redirect `/slack/oauth_redirect`.
- **Scheduler:** add a `PostgresScheduler` (a `reminders` table + poll loop) implementing the existing `Scheduler` interface, so the hosted path is single-datastore (no Redis).
- **Hosting:** a multi-stage `Dockerfile` (tsx runtime, one PORT) → **AWS App Runner** + **Amazon RDS Postgres** + **Secrets Manager** (Slack client secret, signing secret, DB URL, GitHub token). GitHub Actions → ECR → App Runner deploy. Document the exact AWS CLI / console steps in `docs/DEPLOY-AWS.md`.
- **Manifest** (`slack-manifest.yaml`): `socket_mode_enabled:false`; add `event_subscriptions.request_url` + `interactivity.request_url` = `https://<host>/slack/events`; add `oauth_config.redirect_urls`; keep `org_deploy_enabled:false` (workspace-level only).

Rules: keep the local `npm run demo` (no Slack/DB/network) working — env-gate OAuth so the in-memory single-tenant path still runs. Do not break the existing tests.

Acceptance: local OAuth flow against a local Postgres (install → token stored → a message authorizes); `docs/DEPLOY-AWS.md` reproducible; typecheck + suite green; a deployed App Runner smoke test (install on a test workspace → confirm card).
