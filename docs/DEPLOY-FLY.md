# Deploying Kept to Fly.io + Neon Postgres

Kept runs as a **single always-on Node process** (tsx) on one port, serving Slack events, the
OAuth install flow, provider webhooks, the customer trust page, and `/healthz`. Fly.io gives a
managed **HTTPS URL** (`https://<app>.fly.dev`) with a valid cert — **no domain needed**. The
database is **Neon** (serverless Postgres; free tier covers hackathon scale). No Redis — the app
uses the Postgres-backed scheduler, and Fly runs a persistent process so the poll loop works.

> Replaces `docs/DEPLOY-AWS.md` — AWS is deprecated here (the account had **all** compute frozen
> at the account level: Fargate vCPU quota 0, EC2 vCPU quota 0, Lambda AccessDenied).

## 0. Prerequisites (human)
- Fly account + `flyctl` (`brew install flyctl`), then **`flyctl auth login`**.
- A **Neon** project (neon.tech) → copy its pooled `DATABASE_URL` (ends `?sslmode=require`).
  Pick region **AWS ap-south-1 (Mumbai)** to sit near Fly `bom`.
- Your Slack app's **Client ID / Client Secret / Signing Secret** (Basic Information).

## 1. Launch (creates the app + a globally-unique name; no deploy yet)
```bash
flyctl launch --no-deploy --copy-config --name <your-unique-name> --region bom
```
(Detects the repo `Dockerfile` + this `fly.toml`. Note the app name → `KEPT_PUBLIC_URL` below.)

## 2. Set secrets (never commit these; Fly stores them encrypted)
```bash
flyctl secrets set \
  DATABASE_URL="postgres://…neon…/kept?sslmode=require" \
  SLACK_CLIENT_ID="…" SLACK_CLIENT_SECRET="…" SLACK_SIGNING_SECRET="…" \
  SLACK_STATE_SECRET="$(openssl rand -hex 32)" \
  KEPT_PUBLIC_URL="https://<your-app>.fly.dev"
# optional — flip proof sources from simulated fallback to live (see docs/INTEGRATIONS.md):
flyctl secrets set GITHUB_TOKEN=… \
  LAUNCHDARKLY_API_TOKEN=… LAUNCHDARKLY_PROJECT_KEY=… \
  STATUSPAGE_API_KEY=… STATUSPAGE_PAGE_ID=… \
  ATLASSIAN_MCP_TOKEN=… ATLASSIAN_MCP_URL=… JIRA_CLOUD_ID=… \
  LINEAR_MCP_TOKEN=… LINEAR_MCP_URL=…
```

## 3. Deploy + smoke test
```bash
flyctl deploy
curl https://<your-app>.fly.dev/healthz            # -> {"status":"ok"}
```
Then open `https://<your-app>.fly.dev/slack/install` → **Add to Slack** on a test workspace.

## 4. Point the Slack manifest at the Fly host
In `slack-manifest.yaml`, set the host in `event_subscriptions.request_url` +
`interactivity.request_url` (`/slack/events`) and `oauth_config.redirect_urls`
(`/slack/oauth_redirect`) to `https://<your-app>.fly.dev`, then re-import the manifest.

## Notes
- **Sub-processors are now Fly.io (compute) + Neon (database)** — update `docs/SECURITY.md`
  and `docs/PRIVACY.md` accordingly before the Marketplace submission.
- Scale up: `flyctl scale vm shared-cpu-1x --memory 1024` if 512 MB is tight.
- Logs: `flyctl logs`. The boot log prints `proof=live(...)|simulated|off` so you can confirm
  which integrations are connected.
