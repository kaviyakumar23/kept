# Kept — setup & submission runbook

Get the live Slack demo running (no public tunnel needed) and submit on Devpost. Budget ~30–45 min.

> The whole demo runs over **Socket Mode** (Slack) + a **local** webhook server, so you need **no public URL / tunnel**. The work-item side runs over an **in-process MCP server** by default — no Linear/Jira account required.

---

## 0. Prerequisites
- Node 20+, npm. Run `npm install` once.
- A Slack workspace you can install apps into (a free dev workspace is fine — create one at <https://slack.com/create>).

## 1. Create the Slack app from the manifest
1. <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Choose your workspace.
3. Paste the contents of [`slack-manifest.yaml`](../slack-manifest.yaml) → **Create**. (This declares the bot scopes, `message` + `app_home_opened` events, the `/kept` command, interactivity, App Home, and Socket Mode.)

## 2. Get the three tokens
1. **App-level token** (Socket Mode): *Basic Information → App-Level Tokens → Generate* → add scope `connections:write` → copy → `SLACK_APP_TOKEN` (starts `xapp-`).
2. **Install**: *Install App → Install to Workspace → Allow*.
3. **Bot token**: *OAuth & Permissions → Bot User OAuth Token* → copy → `SLACK_BOT_TOKEN` (starts `xoxb-`).
4. **Signing secret**: *Basic Information → App Credentials → Signing Secret* → copy → `SLACK_SIGNING_SECRET`.

## 3. Configure `.env`
`cp .env.example .env`, then set just these three:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
```
Everything else can stay blank for the demo (store = in-memory, work items = in-process simulated MCP, LLM = offline heuristic). Optional upgrades: `ANTHROPIC_API_KEY` (real classification), `DATABASE_URL` + `REDIS_URL` (real Postgres/BullMQ), `LINEAR_MCP_TOKEN` / `ATLASSIAN_MCP_TOKEN` (hosted MCP servers).

## 4. Invite the bot and run
1. In Slack, pick/create a channel (e.g. `#acme-collab`) → `/invite @Kept`.
2. `npm start` → expect:
   ```
   [kept] webhook server on :3001 (/webhooks/{linear,jira,github,deploy})
   [kept] Slack app on :3000
   [kept] store=memory · llm=… · workItems=mcp:simulated · reminders=in-memory · roadmap=… · rts=ledger
   ```

## 5. Run the demo (one take)
- **Terminal A:** `npm start` (leave running).
- **In Slack** `#acme-collab`: send the customer message, e.g. *"Can you get the SSO bug fixed by Friday?"* → a **confirm card** DMs you → click **Confirm** → note the issue ref (`PROJ-NNN`).
- **Terminal B:** `npm run demo:drive -- --ref=PROJ-NNN` → press **Enter** through the 4 signals (In Progress → duplicate → PR merged → prod deploy).
- **Back in Slack:** **Verify** → review the sanitized draft → **Approve & send** → the closure posts in the original thread.
- **Finale:** open the **App Home** tab; run `/kept Acme`.
- Follow [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) for the voiceover + shot timing.

## 6. (Optional) Real provider webhooks via a tunnel
You don't need this for the demo — the driver simulates Linear/GitHub/deploy locally. For real events: expose `:3001` (`cloudflared tunnel --url http://localhost:3001` or `ngrok http 3001`), point Linear/GitHub webhooks at `https://<tunnel>/webhooks/{linear,github}`, set `KEPT_WEBHOOK_SECRET`, and send it as the `x-kept-secret` header.

## 7. Enable GitHub Pages (landing page + OG image)
Repo → **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, Folder `/docs` → **Save**. Live at <https://kaviyakumar23.github.io/kept/> (the repo homepage already points there). Verify the link unfurls with the OG card by pasting it into a Slack message.

## 8. Deploy for judge access (judging window: Jul 14 – Aug 6)
Judges need to reach a *running* instance. Socket Mode needs only **outbound** network, so any always-on host works:
- Deploy the repo to Railway / Render / Fly, set the three `SLACK_*` env vars, run `npm start`.
- Invite `slackhack@salesforce.com` + `testing@devpost.com` to the workspace and the demo channel.
- Alternatively, run locally during the window and stay responsive.

---

## 9. Devpost submission checklist
- [ ] **Project name:** Kept
- [ ] **Elevator pitch** — from [`DEVPOST.md`](DEVPOST.md)
- [ ] **Story** — paste the 7 sections of `DEVPOST.md` (Inspiration … What's next for Kept)
- [ ] **Built with** — tags from the `DEVPOST.md` crib sheet (include **MCP**)
- [ ] **Track: New Slack Agent**
- [ ] **Demo video** (< 3:00) on YouTube/Vimeo → link added
- [ ] **Architecture diagram** — upload `docs/architecture.png`
- [ ] **Gallery** — upload `docs/slack-cards.png` (+ a couple of real Slack screenshots once recorded)
- [ ] **Try it out** — GitHub repo + landing-page (Pages) URL
- [ ] **Slack App ID** — *Basic Information → App ID*
- [ ] **Sandbox URL** + test access granted to `slackhack@salesforce.com` & `testing@devpost.com`
- [ ] **Required tech** stated in the description: **MCP** (one of the three) — and Kept uses it as a *deterministic* client

---

## Troubleshooting
| Symptom | Fix |
|---|---|
| `SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required` | Fill `.env` (step 3). |
| App starts but no confirm card | Ensure the bot is invited to the channel; check the terminal logs; the message must read like a request. |
| Socket Mode "not connected" | `SLACK_APP_TOKEN` missing, or its token lacks the `connections:write` scope. |
| `/kept` not found | Reinstall the app after creating it from the manifest (slash commands register on install). |
| Want real Claude classification | Set `ANTHROPIC_API_KEY` (otherwise an offline heuristic runs — still fully functional). |
| Driver can't reach the server | `npm start` must be running; the webhook server is on `:3001` (override with `WEBHOOK_BASE`). |
