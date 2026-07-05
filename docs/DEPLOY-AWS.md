# Deploying Kept to AWS (App Runner + RDS + Secrets Manager)

This is the exact runbook for the **W2 OAuth HTTP deploy**. Kept runs as a single Node
process (tsx) that serves, on one port, the Slack Events/Interactivity endpoint, the
multi-workspace OAuth install flow, the provider webhooks, and a health check:

| Path | Purpose |
| --- | --- |
| `POST /slack/events` | Slack events, actions (buttons/modals), and the `/kept` command (Bolt serves all three here) |
| `GET /slack/install` | OAuth install landing page |
| `GET /slack/oauth_redirect` | OAuth callback → `storeInstallation` persists the workspace bot token |
| `POST /webhooks/{linear,jira,github,deploy}` | Provider webhooks → evidence |
| `GET /healthz` | App Runner health check |
| `GET /trust/:token` | Customer trust page (reserved; owned by W6) |

The app boots in **OAuth HTTP mode** automatically when `SLACK_CLIENT_ID`,
`SLACK_CLIENT_SECRET`, and `SLACK_STATE_SECRET` are all set (see `src/config.ts`
`isOAuthMode`). Otherwise it keeps the single-token / Socket Mode path (local dev, demo).

> Everything below is run by a **human operator**. Replace `ACCOUNT_ID`, `REGION`
> (e.g. `us-east-1`), and `kept.example.com` (your App Runner host) as you go.

---

## 0. Prerequisites

- AWS CLI v2 configured (`aws configure`) with an admin-ish role.
- A Slack app created **from `slack-manifest.yaml`** (api.slack.com/apps → Create New App
  → From a manifest). After import, note the **Client ID**, **Client Secret**, and
  **Signing Secret** (Basic Information). You will fill the real host into the manifest
  URLs in step 6.
- Docker installed (to build/push the image), or rely on the GitHub Actions workflow in
  step 7.

---

## 1. Create the ECR repository

```bash
aws ecr create-repository --repository-name kept --region REGION
# Login for docker push:
aws ecr get-login-password --region REGION \
  | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com
```

## 2. Build and push the image

The `Dockerfile` is multi-stage (deps → runtime) and runs `npm start` (tsx) on `PORT`
(default 8080, which App Runner routes to).

```bash
docker build --platform linux/amd64 -t kept:latest .
docker tag kept:latest ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/kept:latest
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/kept:latest
```

## 3. Create the RDS Postgres instance

```bash
aws rds create-db-instance \
  --db-instance-identifier kept-db \
  --engine postgres --engine-version 16 \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 \
  --master-username kept \
  --master-user-password 'CHOOSE_A_STRONG_PASSWORD' \
  --db-name kept \
  --publicly-accessible \
  --backup-retention-period 7 \
  --storage-encrypted \
  --region REGION
```

> **Encryption at rest (required):** `--storage-encrypted` turns on RDS storage
> encryption. With no `--kms-key-id`, RDS uses the account's **default AWS-managed KMS
> key for RDS** (`aws/rds`) — sufficient for the questionnaire's "encrypted at rest =
> yes". Pass `--kms-key-id <arn>` to use a customer-managed key instead. This also
> encrypts automated backups, read replicas, and snapshots. Encryption can only be set
> at create time, so do not omit it and retrofit later.

- Wait until `available`:
  `aws rds describe-db-instances --db-instance-identifier kept-db --query 'DBInstances[0].DBInstanceStatus'`
- Grab the endpoint:
  `aws rds describe-db-instances --db-instance-identifier kept-db --query 'DBInstances[0].Endpoint.Address' --output text`
- Ensure the DB security group allows inbound `5432` from the App Runner VPC connector (or,
  for a quick start, from your IP + `0.0.0.0/0` on a throwaway DB — tighten later).
- The connection string is:
  `postgres://kept:PASSWORD@ENDPOINT:5432/kept?sslmode=require`
  (RDS requires TLS. If the cert chain isn't trusted in-container, use `?sslmode=no-verify`.)

**Schema:** the app creates every table on boot — `PostgresEventStore.init()` runs
`src/store/schema.sql` (which now includes `slack_installations` + `reminders`), and the
installation store / scheduler each `init()` their own table (idempotent `CREATE TABLE IF
NOT EXISTS`). No manual migration step.

## 4. Store secrets in Secrets Manager

```bash
aws secretsmanager create-secret --name kept/DATABASE_URL       --secret-string 'postgres://kept:PASSWORD@ENDPOINT:5432/kept?sslmode=require' --region REGION
aws secretsmanager create-secret --name kept/SLACK_CLIENT_ID     --secret-string 'xxxx:from-slack' --region REGION
aws secretsmanager create-secret --name kept/SLACK_CLIENT_SECRET --secret-string 'from-slack'      --region REGION
aws secretsmanager create-secret --name kept/SLACK_SIGNING_SECRET --secret-string 'from-slack'     --region REGION
aws secretsmanager create-secret --name kept/SLACK_STATE_SECRET  --secret-string "$(openssl rand -hex 32)" --region REGION
# Live proof source (GitHub Actions is a genuine live proof source, per invariant #7):
aws secretsmanager create-secret --name kept/GITHUB_TOKEN        --secret-string 'ghp_...'          --region REGION
# Optional: ANTHROPIC_API_KEY (else the app falls back to the heuristic responder).
aws secretsmanager create-secret --name kept/ANTHROPIC_API_KEY   --secret-string 'sk-ant-...'       --region REGION
```

Give the App Runner **instance role** `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/*`.

## 5. Create the App Runner service

Console path (Create service → Source: Container registry → Amazon ECR → the `kept:latest`
image), or via CLI. Key settings:

- **Port:** `8080` (matches the Dockerfile `EXPOSE 8080` / `ENV PORT=8080`).
- **Health check:** HTTP path `/healthz`.
- **Environment / secrets** (map each Secrets Manager entry to the matching env var):
  `DATABASE_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
  `SLACK_STATE_SECRET`, `GITHUB_TOKEN`, and optionally `ANTHROPIC_API_KEY`.
- **Plain env vars:** `KEPT_PUBLIC_URL=https://kept.example.com` (your App Runner host),
  and optionally `KEPT_WEBHOOK_SECRET` for the webhook guard.
- Do **not** set `REDIS_URL` — the hosted path uses the `PostgresScheduler` (no Redis).
  (Precedence in `index.ts`: Redis → Postgres → in-memory. Absent Redis + present DB →
  Postgres scheduler.)

Example (roughly) via CLI:

```bash
aws apprunner create-service \
  --service-name kept \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/kept:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "8080",
        "RuntimeEnvironmentVariables": { "KEPT_PUBLIC_URL": "https://kept.example.com" },
        "RuntimeEnvironmentSecrets": {
          "DATABASE_URL": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/DATABASE_URL",
          "SLACK_CLIENT_ID": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/SLACK_CLIENT_ID",
          "SLACK_CLIENT_SECRET": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/SLACK_CLIENT_SECRET",
          "SLACK_SIGNING_SECRET": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/SLACK_SIGNING_SECRET",
          "SLACK_STATE_SECRET": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/SLACK_STATE_SECRET",
          "GITHUB_TOKEN": "arn:aws:secretsmanager:REGION:ACCOUNT_ID:secret:kept/GITHUB_TOKEN"
        }
      }
    },
    "AutoDeploymentsEnabled": true
  }' \
  --health-check-configuration '{ "Protocol": "HTTP", "Path": "/healthz" }' \
  --instance-configuration '{ "InstanceRoleArn": "arn:aws:iam::ACCOUNT_ID:role/KeptAppRunnerInstanceRole" }' \
  --region REGION
```

After it reaches `RUNNING`, note the service URL (e.g. `https://xxxx.REGION.awsapprunner.com`).
Use that as `kept.example.com` everywhere (or put a custom domain in front).

> **Note on scaling:** the `PostgresScheduler` poll loop claims due reminders atomically
> (`UPDATE ... SET fired_at = now() ... RETURNING`), so it is safe to run multiple App
> Runner instances without double-firing reminders.

## 6. Point the Slack manifest at the live host

In `slack-manifest.yaml`, replace `kept.example.com` with your App Runner host in all
three places, then re-import (App → App Manifest → paste):

- `settings.event_subscriptions.request_url` → `https://HOST/slack/events`
- `settings.interactivity.request_url` → `https://HOST/slack/events`
- `oauth_config.redirect_urls` → `https://HOST/slack/oauth_redirect`

`socket_mode_enabled` is already `false` and `org_deploy_enabled` is `false` (workspace
installs only).

## 7. CI/CD: GitHub Actions → ECR → App Runner

Add a workflow (e.g. `.github/workflows/deploy.yml`) that, on push to `main`:

1. Configures AWS creds (OIDC role or access keys in repo secrets).
2. Logs in to ECR, `docker build --platform linux/amd64`, tags with the commit SHA +
   `latest`, and pushes.
3. With App Runner `AutoDeploymentsEnabled: true`, the push to `:latest` triggers a
   redeploy automatically. (Or call `aws apprunner start-deployment --service-arn ...`.)

```yaml
# sketch — fill in ACCOUNT_ID / REGION / role-to-assume
name: Deploy
on: { push: { branches: [main] } }
permissions: { id-token: write, contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: arn:aws:iam::ACCOUNT_ID:role/GitHubDeploy, aws-region: REGION }
      - uses: aws-actions/amazon-ecr-login@v2
      - run: |
          docker build --platform linux/amd64 -t $ECR/kept:$GITHUB_SHA -t $ECR/kept:latest .
          docker push $ECR/kept:$GITHUB_SHA
          docker push $ECR/kept:latest
        env: { ECR: ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com }
```

## 8. Smoke test

1. `curl https://HOST/healthz` → `{"status":"ok"}`.
2. Visit `https://HOST/slack/install`, click **Add to Slack**, approve on a test workspace.
   → the OAuth callback stores the install; check the DB:
   `SELECT id, team_id FROM slack_installations;`
3. In the test workspace, post a customer-style commitment in a channel Kept is in →
   a **Gate-1 confirm card** should DM the owner (this proves per-tenant token resolution).
4. Drive a webhook to advance the ledger (send `x-kept-team: <team id>`, or rely on
   payload routing across installed tenants):
   ```bash
   curl -X POST https://HOST/webhooks/linear \
     -H 'content-type: application/json' -H 'x-kept-team: T_XXXX' \
     ${KEPT_WEBHOOK_SECRET:+-H "x-kept-secret: $KEPT_WEBHOOK_SECRET"} \
     -d '{"type":"Issue","action":"update","data":{"identifier":"PROJ-1","state":{"name":"In Progress"},"updatedAt":"2026-07-04T00:00:00Z"}}'
   ```

## Local parity check (no AWS)

You can exercise the exact hosted adapters against a local Postgres:

```bash
docker compose up -d postgres            # or any local Postgres
export DATABASE_URL=postgres://kept:kept@localhost:5432/kept
npm run test:integration                 # runs the gated PostgresInstallationStore + PostgresScheduler tests
```
