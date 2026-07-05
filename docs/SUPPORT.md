# Kept — Support

_Last updated: 2026-07-05_

This page explains how to get help with Kept, how to uninstall, and how to request your data.
It is written to be hosted publicly and linked from the Slack Marketplace listing (a support
URL is a listing requirement).

## Contact

- **Support / general questions:** `<TODO: confirm public support email — suggested: indrapranesh2111@gmail.com>`
- **Security reports:** `<TODO: confirm security-contact email>` (please use "SECURITY" in the
  subject; see `docs/SECURITY.md`).
- **Response target:** `<TODO: confirm SLA — e.g. best-effort within 2 business days>`.

## What Kept does (so you know what to ask about)

Kept watches the channels it is added to for commitments your team makes to customers, tracks
each one through a two-step human-approved lifecycle (confirm the commitment → verify it's
done with proof), and posts a closure back in the original thread only after a teammate signs
off. You interact with it via:

- the **`/kept`** slash command (show the ledger for a customer),
- the **App Home** tab (the full obligation ledger for your workspace),
- the **AI Assistant** pane ("What's overdue?", "What did we promise Acme this week?"), and
- the **confirm / verify / closure cards** it posts as buttons and modals.

## Common questions

**Kept isn't detecting commitments in a channel.**
Make sure Kept has been *added to that channel* (`/invite @Kept`). It only sees messages in
channels it is a member of. For private or Slack Connect channels, an admin may need to add it.

**Kept posted a card to the wrong person / I can't action a card.**
Cards are routed to the obligation owner. Actions are locked to the owning workspace — if you
see "that obligation belongs to another workspace," you're acting from a different workspace
than the one that owns the item.

**Nothing was sent to my customer.**
By design. Kept never messages a customer channel automatically. A teammate must approve every
customer-facing closure, and internal details are stripped before send.

**Does Kept store our Slack messages?**
No. Kept stores only short derived facts (who owes what, to which customer, by when) plus links
back to the original messages — never the message text. See `docs/PRIVACY.md`.

## Uninstalling

To remove Kept:

1. In Slack, go to **Settings & administration → Manage apps** (or your workspace's app
   management page).
2. Find **Kept** and choose **Remove**.
3. Removing the app revokes its access token and stops all processing immediately.

> **Data note:** automatic purge of stored data on uninstall is being finalized. Until that
> ships, uninstalling stops processing but may leave derived obligation data in our database.
> To have all of your workspace's data deleted, use the data-request path below.

## Data access & deletion requests

A **Workspace Owner or Admin** can request an export or full deletion of all data associated
with your workspace:

1. Email the support contact above from a verifiable workspace domain.
2. Include your workspace name and, if known, your Slack **team ID** (`T…`).
3. We action deletions manually, scoped to your workspace's `team_id`, across all tables
   (obligation events, roadmap, reminders, trust links, and the installation record).

See `docs/PRIVACY.md` for what data exists and `docs/SECURITY.md` for how it is protected.

## Status & known limitations

- Linear, Jira, LaunchDarkly, and Statuspage are **simulated** in the current build; GitHub
  Actions is a live proof source. See the honesty note in the listing and `docs/DEVPOST.md`.
- Automatic data deletion on uninstall and a fixed data-retention window are in progress
  (`docs/SECURITY.md`).
