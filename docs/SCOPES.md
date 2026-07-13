# Kept — OAuth Scope-Minimization Audit & per-scope justification

_Last reviewed: 2026-07-13 · Source of truth: `src/config.ts` (`SLACK_BOT_SCOPES`) and `slack-manifest.yaml` (`oauth_config.scopes.bot`)._

Kept requests **bot-token scopes only** (no user-token scopes). The list below is transcribed
verbatim from the code and must stay identical in both files. Paste the "Why" column straight into
the Marketplace submission's per-scope justification field.

Marketplace constraint (CLAUDE.md invariant #6): **granular scopes only. No blanket `search:read`,
`read`, `post`, or `client`; no `admin.*` or `identity.*`.**

## The exact scopes requested (13)

| # | Scope | Why Kept needs it (code path) | Read/Write |
| - | ----- | ----------------------------- | ---------- |
| 1 | `chat:write` | Post the Gate-1 confirm card, the owner nudges, and the in-thread customer closure reply (`src/slack/notifier.ts`, `src/slack/blocks.ts`). | write |
| 2 | `im:write` | Open a DM with the obligation owner for private cards/nudges (`conversations.open`) before posting. | write |
| 3 | `mpim:write` | Under granular scopes, `conversations.open({users})` requires `mpim:write` in addition to `im:write`; Kept uses it to open the owner DM for private cards. | write |
| 4 | `im:history` | Read the acting user's messages **in the AI Assistant thread** (`message.im` event → `src/server/assistant.ts`). Scoped to the DM with the bot. | read |
| 5 | `assistant:write` | Drive the AI Assistant pane: `assistant.threads.setStatus` / `setSuggestedPrompts` / `say` (`app.assistant(...)`). | write |
| 6 | `commands` | Serve the `/kept` slash command (ledger, channel binding, trust links, notification prefs). | — |
| 7 | `channels:history` | Read new messages in **public** channels Kept is a member of, to detect a customer commitment (`message.channels` event → `orch.ingestMessage`). | read |
| 8 | `groups:history` | Same detection path for **private / Slack Connect shared** channels (`message.groups` event) — the core "shared customer channel" surface. | read |
| 9 | `channels:read` | Public channel metadata (name/membership) used when routing cards and rendering the ledger. | read |
| 10 | `groups:read` | Private / shared channel metadata for the same purpose. | read |
| 11 | `search:read.public` | **Real-Time Search** (`assistant.search.context`) — cross-channel context from public channels the bot can see. Runtime-gated by `KEPT_RTS=1`. | read |
| 12 | `search:read.files` | File results inside the RTS response. Runtime-gated by `KEPT_RTS=1`. | read |
| 13 | `search:read.users` | User results inside the RTS response. Runtime-gated by `KEPT_RTS=1`. | read |

## ⚠️ Decision before submission — the three `search:read.*` scopes (11–13)

**`KEPT_RTS` is NOT set in the production deploy (confirmed 2026-07-13), so the Real-Time Search
feature is OFF and scopes 11–13 are requested at install but never exercised.** Slack's guideline
is explicit: *don't request scopes for unimplemented/unused functionality*, and a reviewer will ask
"what uses `search:read.*`?" Two honest options — pick one before submitting:

- **(A) Remove scopes 11–13** from `slack-manifest.yaml` + `src/config.ts` until RTS ships. This is
  the least-privilege default and removes the objection; the install consent screen gets smaller.
  Re-add them when RTS is enabled. (Nothing in production breaks — RTS is already off.)
- **(B) Enable `KEPT_RTS=1`** in production so the scopes are genuinely used. Verify RTS works live
  first (`assistant.search.context` needs the event `action_token`; confirm it's available on your
  plan) — riskier to flip untested at submission time.

Recommendation: **(A) remove them for the first submission**, re-add with RTS in a later version.

## Banned / blanket scopes — explicitly NOT requested

- `search:read` (blanket) — **superseded** by the three granular `search:read.*` scopes. The legacy
  classic `search.messages` path (which needed blanket user `search:read`) was **removed**.
- `read`, `post`, `client` — legacy catch-all scopes; never requested.
- `admin.*`, `identity.*` — Slack rejects Marketplace apps that use these; not requested.
- No **user-token** scopes at all — every call is authorized with the per-tenant **bot** token
  resolved from the `InstallationStore`.

## Enhanced-review note

`channels:history`, `groups:history`, and `im:history` are `*:history` scopes, which put the
submission into Slack's **enhanced review** (expected for any app that reads channel messages). The
clear use case is Kept's core function — detecting customer commitments in the channels it's invited
to — and it never downloads file bodies (no `files:read`; Kept is zero-copy). Rows 7–8 above are the
justification to give.

## Verify the two lists match

```bash
# Should print the same 13 scopes from both sources.
grep -oE '"(chat:write|im:write|mpim:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read|search:read\.[a-z]+)"' src/config.ts | tr -d '"' | sort -u
grep -oE '\b(chat:write|im:write|mpim:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read|search:read\.[a-z]+)\b' slack-manifest.yaml | sort -u
```
