# Kept — OAuth Scope-Minimization Audit & per-scope justification

_Last reviewed: 2026-07-13 · Source of truth: `src/config.ts` (`SLACK_BOT_SCOPES`) and `slack-manifest.yaml` (`oauth_config.scopes.bot`)._

Kept requests **bot-token scopes only** (no user-token scopes). The list below is transcribed
verbatim from the code and must stay identical in both files. Paste the "Why" column straight into
the Marketplace submission's per-scope justification field.

Marketplace constraint (CLAUDE.md invariant #6): **granular scopes only. No blanket `search:read`,
`read`, `post`, or `client`; no `admin.*` or `identity.*`.**

## The exact scopes requested (10)

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

## `search:read.*` — removed for v1 (RTS gated off)

Kept ships a Real-Time Search retriever (`assistant.search.context`) gated by `KEPT_RTS=1`. That flag
is **off in production** (confirmed 2026-07-13), so the three granular `search:read.public/.files/.users`
scopes it needs were **removed** from `src/config.ts` + `slack-manifest.yaml` for the initial
submission — an unused scope is a least-privilege liability and a predictable reviewer objection.
Re-add all three (and set `KEPT_RTS=1`) when RTS is enabled in a later version. The blanket
`search:read` stays banned regardless.

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
# Should print the same 10 scopes from both sources.
grep -oE '"(chat:write|im:write|mpim:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read)"' src/config.ts | tr -d '"' | sort -u
grep -oE '\b(chat:write|im:write|mpim:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read)\b' slack-manifest.yaml | sort -u
```
