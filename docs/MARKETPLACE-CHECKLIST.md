# Kept — Slack Marketplace Submission Runbook

_Last updated: 2026-07-05 · Track: **Slack Agent for Organizations**. Sources verified against
Slack's [Distributing your app](https://docs.slack.dev/slack-marketplace/distributing-your-app-in-the-slack-marketplace/)
and [app guidelines & requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/) docs._

This is the step-by-step checklist for the **human operator** to submit Kept to the Slack
Marketplace. Actions marked 🧑 require the Slack app-config console (only a human can do them);
actions marked 💻 are code/config in this repo. Only *submission* is required by the hackathon
deadline, but the app must be in a submittable state.

> **Legend:** `HOST` = your live App Runner host (the value of `KEPT_PUBLIC_URL`, e.g.
> `https://xxxx.us-east-1.awsapprunner.com`). Replace it everywhere.

---

## 0. Eligibility gate — read first ⚠️

Slack **blocks submission** for apps that (per the guidelines page):

- are installed on **fewer than 5 active workspaces**, where "active" = used in the past
  28 days and **not a sandbox**; **or**
- **export or backup message data** (Kept does not — zero-copy, see `docs/SECURITY.md`); or
- only use "Sign in with Slack"; or
- use legacy `admin.*` / `identity.*` scopes (Kept does not — see `docs/SCOPES.md`).

**The ≥5-active-workspace rule is the binding risk for this submission.** Per Slack's docs this
is a *submission blocker*, not merely a listing constraint: "Apps that do not meet this
requirement will be blocked from submitting." **Recruit workspaces starting Day 1** (see §9).
`<TODO: confirm>` the current exact enforcement wording at submit time, since Slack has changed
this threshold before (was 10, reduced to 5).

---

## 1. Finish the deploy blockers 💻🧑

These are open items from `docs/SECURITY.md` that a reviewer or the questionnaire will surface.
Close what you can before submitting:

- [ ] Wire `app_uninstalled` / `tokens_revoked` → `deleteInstallation` **+ per-tenant data
      purge** (currently a gap; see `docs/SECURITY.md` §2). Add the two bot events to
      `slack-manifest.yaml` and a handler.
- [ ] Enable RDS **at-rest encryption** (`--storage-encrypted`) — the current
      `docs/DEPLOY-AWS.md` command omits it.
- [ ] Confirm `KEPT_WEBHOOK_SECRET` is set in production and decide on `KEPT_RTS`.
- [ ] Decide a data-retention window (or document "retained while installed").

## 2. Deploy & smoke-test the live app 🧑

- [ ] App is `RUNNING` on App Runner; `curl https://HOST/healthz` → `{"status":"ok"}`.
- [ ] `slack-manifest.yaml` URLs point at `HOST` (events, interactivity, redirect) and
      `socket_mode_enabled: false` (already set). Re-import the manifest.
- [ ] Install on a test workspace via `https://HOST/slack/install`; confirm the row in
      `slack_installations` and that a Gate-1 card DMs the owner (proves per-tenant tokens).

## 3. Enable public distribution 🧑

- [ ] App config → **Manage Distribution** → complete the checklist → **Activate Public
      Distribution**. (Removes the "only your workspace can install" restriction.)

## 4. Configure the Direct Install URL 🧑💻

Slack requires the Direct Install URL to **HTTP 302-redirect to a fully qualified
`slack.com/oauth/v2/authorize` URL**.

- [ ] Set the Direct Install URL to **`${KEPT_PUBLIC_URL}/slack/install`**, i.e.
      `https://HOST/slack/install`.
- [ ] ⚠️ **Code nuance to verify:** Bolt's default install page at `/slack/install` renders an
      HTML "Add to Slack" **button page (HTTP 200)**, which does **not** satisfy the "must 302"
      requirement. To comply, either:
      - 💻 set Bolt `installerOptions.directInstall: true` so `/slack/install` immediately
        302-redirects to the authorize URL (recommended — one-line change in
        `src/server/slackApp.ts` where the OAuth `App` is constructed), **or**
      - 🧑 use the raw `https://slack.com/oauth/v2/authorize?client_id=…&scope=…` URL as the
        Direct Install URL instead.
      `<TODO: fix>` pick one and verify with `curl -I https://HOST/slack/install` → expect
      `302` to `slack.com/oauth/v2/authorize`.

## 5. Add the `slack-app-id` meta tag to the landing page 🧑💻

Slack uses this to suggest your app when someone shares a link to your domain.

- [ ] After the app exists you'll have an **App ID** (`A…`). Add to the `<head>` of
      **`docs/index.html`** (the Vercel landing, `kept-iota.vercel.app`):
      ```html
      <meta name="slack-app-id" content="A0XXXXXXXXX">
      ```
      _(This runbook does not edit `index.html` — add it by hand once the App ID is minted, then
      redeploy Vercel.)_

## 6. Prepare the listing copy & assets 🧑

**Category:** Productivity (primary). `<TODO: confirm>` — alternatively "Developer tools" or
"Customer support". Pick one primary category.

**Pricing:** Free.

**Support URL:** host `docs/SUPPORT.md` content at a public URL (e.g. `https://HOST/support` or a
Vercel page). **Privacy policy URL:** host `docs/PRIVACY.md` similarly. Both are required listing
fields.

**Gallery images:** at least one, **1600 × 1000 px (8:5)**, PNG/JPG. Adapt the existing assets in
`docs/` (`slack-cards.png`, `demo.png`, `architecture.png`) — resize/pad to exactly 1600×1000.
`<TODO>` produce final-sized images.

### Short description (draft — ~10 words, fits the card)

> Never drop a customer promise. Human-verified obligation ledger for Slack.

### Long description (draft)

> **Kept turns every promise made in a customer channel into a tracked, verified obligation —
> and closes the loop only when a human signs off.**
>
> Teams make commitments in shared Slack channels every day ("we'll ship SSO by Friday",
> "we'll get you that export"). They scroll away and get dropped. Kept watches the channels it's
> added to, detects each commitment, and tracks it through a guarded two-gate lifecycle:
>
> 1. **Confirm the commitment.** Kept DMs the owner a card to confirm what was promised, to
>    whom, and by when — nothing is tracked until a human confirms.
> 2. **Verify it's done.** Kept assembles a proof packet from connected sources (e.g. GitHub
>    Actions) and asks a human to verify. Only after that human sign-off does Kept post a
>    customer-safe closure back in the original thread.
>
> **Built for trust:**
> - **Zero-copy** — Kept stores only short derived facts and links, never your message text.
> - **Human-verified** — two human gates; Kept never auto-verifies or auto-messages a customer.
> - **Audience-safe** — internal details (tickets, PRs, deploys) are stripped from anything a
>   customer sees.
> - **Tenant-isolated** — every read is scoped to your workspace.
> - **Minimal, granular scopes** — no blanket `search:read`, no `admin.*`.
>
> Ask the built-in AI Assistant "What's overdue?" or "What did we promise Acme this week?" and
> get an answer straight from the ledger.
>
> _Honesty note: Slack is the live surface and GitHub Actions is a live proof source. Linear,
> Jira, LaunchDarkly, and Statuspage are simulated in this build with real API skeletons._

`<TODO: confirm>` trim/expand to Slack's current character limits for each field.

## 7. Answer the Security & Compliance questionnaire 🧑

- [ ] Use `docs/SECURITY.md` as the answer source. **Do not** answer "data deleted on
      uninstall = yes" until §1's deletion gap is fixed. Attach `docs/PRIVACY.md` +
      `docs/SUPPORT.md` URLs.

## 8. Add a collaborator 🧑

- [ ] App config → **Collaborators** → add a second person (required so the config isn't
      single-owner). `<TODO>` who is the second collaborator?

## 9. Recruit ≥5 active test workspaces (start Day 1) 🧑

Needed to clear the eligibility gate in §0. Each must be a **real, non-sandbox** workspace used
in the last 28 days, with Kept installed and exercised (post a commitment → confirm → verify).

- [ ] WS1: `<TODO>` &nbsp; [ ] WS2: `<TODO>` &nbsp; [ ] WS3: `<TODO>`
- [ ] WS4: `<TODO>` &nbsp; [ ] WS5: `<TODO>` &nbsp;(recruit a 6th as buffer)
- Give each a 3-line "how to try it" (invite Kept to a channel, post a promise, confirm the
  card). Reuse `docs/SETUP.md` / `docs/DEMO_SCRIPT.md`.

## 10. Submit for Review 🧑

- [ ] App config → **Review and Submit** → walk the flow → **Submit App for Review** → confirm
      in the preview modal.
- Expect: preliminary review (~10 business days, listing validation) then functional review
  (~10 weeks, install/UX testing). Only *submission* is required by the hackathon deadline.

## 11. Capture proof & grant judge access 🧑

- [ ] Record the **App ID** (`A…`, Basic Information) — the hackathon requires it as proof of
      submission. Paste it here: `App ID: <TODO>`.
- [ ] Screenshot the "Submitted for review" confirmation.
- [ ] Grant sandbox / test access to the judges: **`slackhack@salesforce.com`** and
      **`testing@devpost.com`** (add as collaborators or provide install access to a test
      workspace, per the hackathon instructions). `<TODO: confirm>` the exact access method the
      hackathon expects (collaborator vs. guest install).

---

## Quick status board

| Item | Status |
| ---- | ------ |
| Deploy blockers closed (§1) | ☐ |
| Live app + smoke test (§2) | ☐ |
| Public distribution enabled (§3) | ☐ |
| Direct Install URL 302-verified (§4) | ☐ |
| `slack-app-id` meta on landing (§5) | ☐ |
| Listing copy + 1600×1000 assets (§6) | ☐ |
| Privacy + Support URLs live (§6) | ☐ |
| Security questionnaire (§7) | ☐ |
| Collaborator added (§8) | ☐ |
| ≥5 active workspaces (§9) | ☐ |
| Submitted for review (§10) | ☐ |
| App ID captured + judge access (§11) | ☐ |

Sources: [Distributing your app in the Slack Marketplace](https://docs.slack.dev/slack-marketplace/distributing-your-app-in-the-slack-marketplace/) ·
[Slack Marketplace app guidelines & requirements](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/) ·
[Installation requirement changelog (5 active workspaces)](https://docs.slack.dev/changelog/2025/07/08/slack-marketplace/)
