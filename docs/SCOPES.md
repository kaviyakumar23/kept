# Kept — OAuth Scope-Minimization Audit

_Last reviewed: 2026-07-05 · Source of truth: `src/config.ts` (`SLACK_BOT_SCOPES`) and `slack-manifest.yaml` (`oauth_config.scopes.bot`)._

Kept requests **bot-token scopes only** (no user-token scopes). The list below is
transcribed verbatim from the code and must stay identical in both files — CI/review
should treat any drift between `src/config.ts` and `slack-manifest.yaml` as a bug.

Marketplace constraint (CLAUDE.md invariant #6): **granular scopes only. No blanket
`search:read`, `read`, `post`, or `client`; no `admin.*` or `identity.*`.**

## The exact scopes requested (12)

| # | Scope | Why Kept needs it (code path) | Read/Write |
| - | ----- | ----------------------------- | ---------- |
| 1 | `chat:write` | Post the Gate-1 confirm card, the Gate-2 verify card, the owner DM, and the in-thread customer closure reply (`src/slack/notifier.ts`, `src/slack/blocks.ts`). | write |
| 2 | `im:write` | Open a DM with the obligation owner for private cards (`conversations.open`) before posting. | write |
| 3 | `im:history` | Read the acting user's messages **in the AI Assistant thread** (`message.im` event → `src/server/assistant.ts`). Scoped to the DM with the bot. | read |
| 4 | `assistant:write` | Drive the AI Assistant pane: `assistant.threads.setStatus` / `setSuggestedPrompts` / `say` (`app.assistant(...)` in `src/server/slackApp.ts`). | write |
| 5 | `commands` | Serve the `/kept` slash command (the App Home / ledger entry point). | — |
| 6 | `channels:history` | Read new messages in **public** channels Kept is a member of, to detect a commitment (`message.channels` event → `orch.ingestMessage`). | read |
| 7 | `groups:history` | Same detection path for **private / Slack Connect shared** channels (`message.groups` event). This is the core "shared customer channel" surface. | read |
| 8 | `channels:read` | Public channel metadata (name/membership) used when routing cards and rendering the ledger. | read |
| 9 | `groups:read` | Private / shared channel metadata for the same purpose. | read |
| 10 | `search:read.public` | **Real-Time Search** (`assistant.search.context`) — cross-channel context from public channels the bot can see. Gated at runtime by `KEPT_RTS=1` (W3). | read |
| 11 | `search:read.files` | File results inside the RTS response. Gated by `KEPT_RTS=1`. | read |
| 12 | `search:read.users` | User results inside the RTS response. Gated by `KEPT_RTS=1`. | read |

## Banned / blanket scopes — explicitly NOT requested

These do not appear anywhere in `SLACK_BOT_SCOPES` or the manifest, by design:

- `search:read` (blanket) — **superseded** by the three granular `search:read.*` scopes
  above. The manifest carries a comment recording that the legacy classic
  `search.messages` path (which needed blanket user `search:read`) was **removed**.
- `read`, `post`, `client` — legacy catch-all scopes; never requested.
- `admin.*`, `identity.*` — Slack rejects Marketplace apps that use these; not requested.
- No **user-token** scopes at all — Kept authorizes every call with the per-tenant
  **bot** token resolved from the `InstallationStore`.

## Scope-minimization notes / flags for the human

1. **RTS scopes are runtime-gated, not install-gated.** Scopes 10–12
   (`search:read.public/.files/.users`) are only exercised when `KEPT_RTS=1`
   (see the gating comment in `src/config.ts`). If the production deploy ships with
   RTS **off**, these three scopes are requested at install but never used.
   `<TODO: confirm>` whether the launch deploy enables `KEPT_RTS`. If RTS is not in
   the launch scope, consider removing these three from the manifest to keep the
   install consent screen truly minimal, and re-add them when RTS ships — a reviewer
   may ask "what uses `search:read.*`?" and the honest answer must be "the live RTS
   feature," not "nothing yet."
2. **No `files:read`.** Kept surfaces file *refs* from RTS results but never downloads
   file bodies (zero-copy), so `files:read` is intentionally absent. `search:read.files`
   only returns result metadata in the search response.
3. **Every other scope maps 1:1 to a live code path** listed above — none is speculative.

## Verify the two lists match

```bash
# Should print the same 12 scopes from both sources.
grep -oE '"(chat:write|im:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read|search:read\.[a-z]+)"' src/config.ts | tr -d '"' | sort
grep -oE '\b(chat:write|im:write|im:history|assistant:write|commands|channels:history|groups:history|channels:read|groups:read|search:read\.[a-z]+)\b' slack-manifest.yaml | sort -u
```
