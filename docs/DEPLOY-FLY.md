# Deploying Kept to Fly.io — all-in-one (app + self-hosted Postgres)

Kept runs as a **single always-on Node process** (tsx) on one port, serving Slack events, the
OAuth install flow, provider webhooks, the customer trust page, and `/healthz`. Fly.io gives a
managed **HTTPS URL** (`https://<app>.fly.dev`) with a valid cert — **no domain needed**. The
database is a **self-hosted Postgres on Fly** (Fly's *unmanaged* Postgres — a Machine + volume you
own). **Nothing external**; no Redis (the app uses the Postgres-backed scheduler, and Fly runs a
persistent process so the poll loop works).

> Replaces `docs/DEPLOY-AWS.md` (AWS had all compute frozen at the account level).
>
> **Durability note:** a single self-hosted Postgres Machine has **no managed backups / PITR** and
> is a single point of failure. Fly takes **daily volume snapshots (~5-day retention)** as a basic
> safety net. Fine for launch/pilot; for production customer data, move to a Fly Postgres **HA
> pair** (`--initial-cluster-size 2`) or a managed DB, and add periodic `pg_dump` off-site.
>
> This is Fly's **unmanaged** Postgres (~$3–5/mo), **not** "Managed Postgres (MPG)" — MPG is the
> pricier product. Use `fly postgres create` explicitly; if your CLI only offers MPG, use the
> hand-rolled fallback at the bottom.

## 0. Prerequisites (human)
- Fly account + `flyctl` (`brew install flyctl`), then **`flyctl auth login`**. That's it — no
  external DB account.
- Your Slack app's **Client ID / Client Secret / Signing Secret** (Basic Information).

## 1. Launch the app (creates a globally-unique name; no deploy yet)
```bash
flyctl launch --no-deploy --copy-config --name <your-unique-name> --region bom
```
Reads the repo `Dockerfile` + this `fly.toml`. Note the app name → `KEPT_PUBLIC_URL` below.

## 2. Create + attach a Postgres cluster on Fly (sets DATABASE_URL for you)
```bash
# smallest single node — unmanaged Postgres:
fly postgres create --name <your-name>-db --region bom \
  --vm-size shared-cpu-1x --volume-size 3 --initial-cluster-size 1
# wire it to the app — this SETS the DATABASE_URL secret on the app automatically:
fly postgres attach <your-name>-db --app <your-unique-name>
```
Kept auto-creates its schema on boot (`PostgresEventStore.init()` runs `schema.sql`). Internal
traffic uses Fly's private WireGuard network (`.flycast`/`.internal`), so `sslmode=disable` in the
attached URL is safe.

## 3. Set the remaining secrets (DATABASE_URL is already set by attach)
```bash
flyctl secrets set --app <your-unique-name> \
  SLACK_CLIENT_ID="…" SLACK_CLIENT_SECRET="…" SLACK_SIGNING_SECRET="…" \
  SLACK_STATE_SECRET="$(openssl rand -hex 32)" \
  KEPT_PUBLIC_URL="https://<your-app>.fly.dev"
# optional — flip proof sources from the simulated MCP fallback to live (docs/INTEGRATIONS.md):
#   GitHub Actions = live CI conclusions · Jira = work items + proof over the hosted Atlassian MCP
#   LaunchDarkly = live flag state over LaunchDarkly's hosted MCP (LAUNCHDARKLY_MCP_TOKEN is a
#   LaunchDarkly API access token used as the MCP Bearer; LAUNCHDARKLY_MCP_URL is optional and
#   defaults to https://mcp.launchdarkly.com/mcp/launchdarkly).
flyctl secrets set --app <your-unique-name> GITHUB_TOKEN=… \
  ATLASSIAN_MCP_TOKEN=… ATLASSIAN_MCP_URL=… JIRA_CLOUD_ID=… \
  LAUNCHDARKLY_MCP_TOKEN=… LAUNCHDARKLY_MCP_URL=…
```

## 4. Deploy + smoke test
```bash
flyctl deploy
curl https://<your-app>.fly.dev/healthz            # -> {"status":"ok"}
```
Then open `https://<your-app>.fly.dev/slack/install` → **Add to Slack** on a test workspace.

## 5. Point the Slack manifest at the Fly host
In `slack-manifest.yaml`, set the host in `event_subscriptions.request_url` +
`interactivity.request_url` (`/slack/events`) and `oauth_config.redirect_urls`
(`/slack/oauth_redirect`) to `https://<your-app>.fly.dev`, then re-import.

## Fallback — hand-rolled Postgres (if `fly postgres create` only offers MPG)
Run a dedicated Machine from the official image + a volume:
```bash
fly volumes create pgdata --region bom --size 3 --app <your-name>-db
```
Deploy a tiny `postgres:16` app (volume mounted at `/var/lib/postgresql/data`, `POSTGRES_USER=kept`,
`POSTGRES_DB=kept`, `POSTGRES_PASSWORD=<secret>`, internal port 5432), then on the main app set:
```
DATABASE_URL = postgres://kept:<secret>@<your-name>-db.flycast:5432/kept?sslmode=disable
```

## Notes
- **Sub-processor is now just Fly.io** (compute + database). Update `docs/SECURITY.md` +
  `docs/PRIVACY.md` before the Marketplace submission.
- Logs: `flyctl logs`. Boot log prints `proof=live(...)|simulated|off` so you can confirm which
  integrations are connected.
- Scale DB later: `fly postgres ... ` HA pair, or bigger `--vm-size`/volume.
