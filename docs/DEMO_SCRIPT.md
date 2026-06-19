# Kept — demo video script + shot list

**Target length:** 2:30 (hard cap 2:45; Devpost limit is < 3:00). · **Aspect:** 16:9, ≥1080p.
**Record:** Screen Studio (auto-zoom on each card). · **Voice:** ElevenLabs (one calm voice, ~150 wpm). · **Captions:** burn them in (judges often watch muted).

**Workflow:** lock this script → generate the VO in ElevenLabs → record the Slack flow *to* the VO (play it in one ear) → assemble + caption in CapCut → export.

**Prereqs for a clean take**
- `npm start` running (Slack app + webhook server on :3001). Work items go through MCP (simulated MCP server by default — no network needed).
- A second terminal ready with the **demo driver**: `npm run demo:drive -- --ref=PROJ-119` (fire each fulfillment signal with Enter, on cue). Use the ref shown on your Confirm.
- Slack staged: clean `#acme-collab` channel, friendly bot name, **Do Not Disturb on** (kills notification popups), Slack zoom bumped (⌘+) for legibility.

---

## The script (≈370 words)

| Time | Shot / on-screen action | Voiceover |
|---|---|---|
| **0:00–0:12** | A shared Slack channel `#acme-collab`. A customer message sits in the thread. | "This is a shared channel with your customer. Promises get made here every day — *we'll have that fixed by Friday* — and then the work scatters across tickets, pull requests, and deploys. The customer is usually the last to find out what actually shipped." |
| **0:12–0:22** | Overlay the Kept one-liner, or pan the App Home tab. | "Kept is a Slack-native agent that turns those promises into a verified obligation ledger. Its rule: the model reads the language, but *code* controls every action — and a human approves before the customer hears anything." |
| **0:22–0:45** | Type **"Can you get the SSO bug fixed by Friday?"** in the channel. Cut to the private **confirm card** (DM to the owner). Auto-zoom on the prior-commitment line + the roadmap-conflict warning. | "When a request lands, Kept proposes an obligation — privately, to the owner. Here's what it thinks we committed to, a prior promise to this same customer, and a warning that Friday is earlier than our roadmap. Nothing is real yet." |
| **0:45–1:00** | Click **Confirm**. Show the result: issue **PROJ-119** created (Linear). | "The owner confirms — that's gate one. Only *now* does Kept create the work item, by calling a Linear tool over **MCP**. The agent decided to act; the *code* chose the tool — not the model." |
| **1:00–1:18** | Switch to the driver terminal: **Enter** → Step 1 (In Progress), **Enter** → Step 2 (duplicate). Then in Slack type **"any update on that login issue?"** | "Work begins. Status updates flow in over webhooks — and duplicates are no-ops. A second nudge from the customer attaches to the *same* obligation instead of spawning a new one." |
| **1:18–1:40** | Driver: **Enter** → Step 3 (PR merged) — point out *no* card appears. Then **Enter** → Step 4 (prod deploy) — the **verify card** pops in the owner's DM. | "Engineering ships. A merged pull request alone is *not* enough — Kept treats it as evidence, not truth. Only when a production deploy lands does Kept open gate two, and it shows the owner the evidence behind it." |
| **1:40–2:02** | Click **Verify**. Show the **closure-draft card** with the leak-safety indicator (internal refs stripped). Click **Approve & send**. Cut to the closure posted in the **original customer thread**. | "The owner verifies. Kept drafts a customer-safe message — internal ticket numbers and roadmap dates stripped — and only after approval posts it back, in the original thread. The customer finally hears it's done." |
| **2:02–2:18** | In the thread, customer replies **"it still fails for one user."** Show the obligation flip to **REOPENED** while the ticket still reads Done. Quick pan: App Home ledger + an audit-history modal. | "If the customer says it's still broken, the obligation reopens — even though the ticket says Done. Every step is event-sourced and auditable, and the whole ledger lives right here in Slack." |
| **2:18–2:30** | Cut to the landing page / six-guarantees band / repo URL. | "Kept. Never treat one message, one ticket, or one merge as truth. Human-verified promises — kept." |

---

## Caption notes
- Keep caption lines short (≤ 6–7 words on screen at once).
- Hard-emphasize the three "money" lines on screen as text stings: **"code chose the tool, not the model" (MCP)**, **"evidence, not truth"**, **"posts only after a human approves."**

## If you can't get the live Slack app running in time (fallback)
Record `npm run demo` (the terminal storyboard) for the lifecycle beats and screen-record the **landing page** for polish; narrate the same script. It's less compelling than live Slack — use only as a backup. The live Block Kit cards are the whole point of the New Slack Agent track.

## Driver step → script beat map
| Driver step | Fires | Script beat |
|---|---|---|
| 1 | Linear → In Progress | 1:00–1:18 |
| 2 | Linear → In Progress (duplicate, suppressed) | 1:00–1:18 |
| 3 | GitHub → PR merged (not enough on its own) | 1:18–1:40 |
| 4 | Deploy → production (opens Gate 2) | 1:18–1:40 |
