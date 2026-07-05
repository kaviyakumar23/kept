# Kept — Privacy Policy

_Effective date: 2026-07-05 · Last updated: 2026-07-05_

This policy explains what data the Kept Slack app processes, why, how long it is kept, and how
to request access or deletion. It is written to be hosted publicly (e.g. on the Kept landing
site) and linked from the Slack Marketplace listing.

> Plain-language summary: **Kept does not store your Slack messages.** It reads messages in the
> channels it is added to only to detect a commitment, and it stores only short, derived facts
> about that commitment (who owes what, to which customer, by when) plus links back to the
> original Slack messages — never the message text itself.

## Who we are

Kept ("we", "the app") is a Slack application that tracks commitments made in shared customer
Slack channels and helps teams close the loop with verified proof. Contact:
`<TODO: confirm public privacy contact email — suggested: indrapranesh2111@gmail.com>`.

## What data we process, and why

**1. Slack message content (transient, not stored).**
When Kept is a member of a channel, Slack delivers new messages to the app. Kept analyzes the
message text at that moment to *detect and classify* a possible commitment. This text is
processed transiently and is **not written to our database**. A machine-learning model
(see "Sub-processors") may see the text at inference time to propose a structured summary; the
model's input and output are **not stored**.

**2. Derived obligation facts (stored).**
For each confirmed commitment, we store only short, structured, human-confirmed fields:
the customer name, a normalized description of what was promised ("outcome"), the owner's
Slack user ID, the due date, the workspace ID (`team_id`), Slack object IDs, and permalinks
back to the original messages. These fields are size- and format-capped and are validated to
ensure no raw message body, prompt, or model output is ever persisted. We call this
**zero-copy**.

**3. Installation & authentication data (stored).**
When you install Kept, Slack provides an OAuth installation record including a **bot token**
scoped to your workspace. We store this so the app can act in your workspace. It is kept in a
dedicated table and used only to authenticate Kept's own API calls.

**4. Operational data (stored).**
Approved roadmap target dates (for a due-date sanity check), reminder schedules, and opaque
capability tokens that authorize the per-customer "trust page." None of these contain message
content.

We do **not** sell personal data, and we do **not** export or back up your Slack message data.

## How your data is separated (tenant isolation)

Every stored record is tagged with your workspace ID (`team_id`), and every read is scoped to
that ID. One workspace can never read another workspace's data. Messages that cannot be
attributed to a workspace are dropped rather than stored.

## Customer-facing safety

When Kept drafts a message to post back into a shared customer channel, it strips all internal
context (engineering tickets, PRs, CRM, deployment/feature-flag/status details) and scans the
draft for leaks before a human approves it. Nothing is ever sent to a customer channel
automatically — a person on your team must approve every customer-facing message.

## Sub-processors

We rely on the following third parties to run the service:

- **Amazon Web Services (AWS)** — application hosting (App Runner), database (RDS Postgres),
  and secrets storage (Secrets Manager). AWS stores the data described above.
- **Anthropic (Claude API)** — the language model that proposes structured summaries of
  commitments. It receives message text transiently at inference time; its input/output are
  not stored by Kept. This provider is optional and can be disabled by the operator, in which
  case a local heuristic is used instead.
- **Slack** — the platform the app runs on.
- **GitHub** — used as a live source of completion proof (e.g. workflow run results).

Simulated integrations (Linear, Jira, LaunchDarkly, Statuspage) do not receive your data in
the current build.

## Data retention

- **Derived obligation facts, roadmap, reminders, trust-link tokens** are retained for as long
  as the app is installed, so the ledger stays complete.
  `<TODO: confirm>` a fixed retention window (e.g. deletion N days after uninstall) once the
  purge automation lands.
- **Installation / bot-token data** is retained until the app is uninstalled or you request
  deletion.
- RDS automated backups are retained for 7 days.

## How to access or delete your data

- **Uninstall:** removing Kept from your Slack workspace stops all processing.
  _Note: automatic deletion of stored data on uninstall is being finalized; until then, use
  the request path below to have your data purged._ See `docs/SUPPORT.md`.
- **Access / deletion request:** a Workspace Owner or Admin can email the contact above from a
  verifiable workspace domain to request an export or deletion of all data associated with
  your `team_id`. We action these manually and scope every operation to your workspace ID.

## Security

Data is encrypted in transit (TLS) between Slack, Kept, the database, and third-party APIs.
Secrets are held in AWS Secrets Manager. See `docs/SECURITY.md` for details, including the
status of at-rest encryption.

## Changes to this policy

We will update the "Last updated" date above when this policy changes and, for material
changes, note them on the landing page.

## Contact

Privacy questions or data requests:
`<TODO: confirm public privacy contact email — suggested: indrapranesh2111@gmail.com>`.
