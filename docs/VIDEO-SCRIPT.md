# Kept — demo video script (≤3 min · New Slack Agent track — built with Slack AI + MCP)

**Target 2:40 · hard ceiling 3:00 · 1080p · public YouTube.** No on-camera face — **screen recording + AI voiceover + burned-in captions** throughout. Judges often watch the first 30–60s **muted**, so every beat must read with sound off.

## Non-negotiable rules (read before recording)
- **No face, no webcam.** Open and close on **screen + title cards**, not a person. The hook lands as an AI-voiced line over a title card, then cuts straight to the product.
- **AI voiceover — but it must sound human, not narrated.** The goal is a real person talking to a colleague. How to get there:
  - **Voice + engine:** use a top-tier neural TTS (ElevenLabs Multilingual v2 is the safe pick; Cartesia / PlayHT also good). Choose a **conversational** voice — *not* a "documentary/announcer" one. Settings: **Stability ~40–50%** (lower = more natural variation), **Similarity/Clarity high**, a little **Style** if offered. The first take is rarely best — **re-roll any clip that sounds flat or rushed.**
  - **Write like you talk:** keep the contractions ("it's", "you'd", "we're"), vary sentence length, let lines breathe. Say each line out loud yourself first — if you wouldn't phrase it that way, rewrite it.
  - **Punctuate for breath, not grammar:** a comma is a micro-pause, `…` is a real beat, a period is a full stop, `?` lifts the tone. Split long lines into two. This is what kills the robotic monotone.
  - **Slightly slower than feels right.** Rushed TTS sounds synthetic; a calm, unhurried pace reads as human and confident.
  - **Kill the TTS tells:** never feed numbers, symbols, or version strings — spell them ("Gate one", "ninety-five percent", "the model"). Phonetically respell any word it fumbles. `SSO`, `CI`, `MCP` read fine as letters.
  - **Generate line-by-line**, keep the best take of each, then space them in the edit with natural gaps — real people pause between sentences. Lay a **soft music bed** underneath so it isn't sterile.
  - The **silence beat** on the block is an **edit gap** — TTS won't pause on its own. Hold 1.5s with one low sound cue.
- **No third-party UIs on screen.** Do **not** screen-record Jira, GitHub, or LaunchDarkly. Drive **everything** through Kept's own **Demo Controls** panel + cards, so every signal shows as **text inside Kept** ("Production flag OFF ✗", "flag ON ✓").
- **Burn in captions for every line** (muted-first). 1080p. **Pre-warm the model** with a throwaway message before takes so first classification isn't slow.
- **Royalty-free music only** — keep the license file.
- Four moments, nothing more: **the block → capture/Gate one → sign & close → the customer loop-close.** Drift radar + trust page get a 1-second flash. Feature tours bore judges.

VO = the AI-voiced line. `[SCREEN]` = what's shown. `[CAPTION]` = burned-in lower-third.

---

## 0:00 – 0:10 · COLD OPEN — title card, no face
`[SCREEN]` Black card, Kept mark small. The hook text types/fades in, one line at a time.
**VO:** "The ticket said Done. The feature was never live. And the customer found out before you did."
`[CAPTION]` **The ticket said Done. The feature was never live.**
`[SCREEN]` Cut to the product. One more line over the first frame of the Proof-of-Done card.
**VO:** "This is the agent that catches it — inside Slack."

## 0:10 – 0:30 · The block (pattern-break by 0:30)
`[SCREEN]` Kept's **Proof-of-Done** card. Rows animate in as text: **🎫 Ticket Done ✓ · 🔀 Code merged ✓ · 🚀 Prod deploy ✓** … then **🚩 Production flag OFF ✗ · read live**.
**VO:** "This is not another follow-up bot. Watch what happens when someone says Done… and it isn't."
`[SCREEN]` The verdict stamps red: **⛔ Not ready to close.** Owner clicks **Verify it's available** →
**⟵ LEAVE 1.5s of silence in the edit. One low negative sound cue.** Red inline: *"Not verifiable — INSUFFICIENT_EVIDENCE."*
`[CAPTION]` **Jira said Done. The live flag said no. Kept blocked the close.**
**VO:** "Every other tool would have told the customer it's fixed. Kept refuses. And it shows you exactly why."

## 0:30 – 1:00 · MOMENT 1 — capture → Gate one
`[SCREEN]` A shared customer channel. Message: **"We'll ship the SSO fix for Acme by Friday."**
**VO:** "Start where the promise is made. The model reads the message and proposes an obligation. It never commits anything itself."
`[CAPTION]` **The model proposes. Code decides. Humans sign.**
`[SCREEN]` The owner's private confirm card — outcome, due date, owner. One click: **Confirm**. Card locks to *"✅ Confirmed."*
**VO:** "A human confirms — one private click. Gate one. That's the only way anything enters the ledger."

## 1:00 – 1:40 · MOMENT 2 — resolve the block, sign, close
`[SCREEN]` Kept's **Demo Controls** panel. Click **Toggle production flag → ON**. Text flips: *Production flag: ON ✅*. (No third-party UI.)
**VO:** "Now the fix actually ships. The flag goes on. Kept re-reads the live flag, and the evidence turns green."
`[SCREEN]` The packet re-renders: **🚩 Production flag ON ✓ · read live**. Owner clicks **Verify it's available** → *"☑️ Verified."*
**VO:** "The agent did ninety-five percent — gathering, reconciling. The human does the last five. Gate two. They sign."
`[SCREEN]` **The audience-firewall beat.** Split view: left, Kept's internal note *"🛡️ internal details kept out of the reply."* Right, the **sanitized** message posting into the customer thread: *"the SSO fix is now available on your side — could you confirm?"* No ticket, no PR, no flag.
`[CAPTION]` **The customer never sees a ticket number. By construction.**

## 1:40 – 2:05 · MOMENT 3 — the customer closes the loop + the number
`[SCREEN]` The customer replies in-thread: **"works now"**. Kept DMs the owner: *"✅ Acme confirmed — closed."* The promise flips to **✅ Kept**.
**VO:** "The customer confirms, in their own words, in the original thread. Only now is it closed."
`[SCREEN]` **Full-screen stat card. White text, dark screen, 2 seconds:**
> **Closes blocked before reaching a customer: 3**
**VO:** "Three times in this demo, Kept stopped a Done that wasn't. That's three conversations you never have to un-have."

## 2:05 – 2:20 · The 1-second flashes (drift + trust page + receipts)
`[SCREEN]` Quick cuts, ~1s each: the **drift radar** band (*"Acme — softening"*), the **customer trust page** (Kept / In progress / Verifying), the **🧾 Receipts** timeline scrolling (every state, signed).
**VO:** "It scores promise drift before things go quiet. It gives each account a private trust page. And every step is a signed, replayable receipt."

## 2:20 – 2:35 · The tech + honesty + architecture flash
`[SCREEN]` The **architecture diagram** flashes up; the Slack and MCP badges pulse.
**VO:** "Two live technologies. The Slack AI Assistant you just saw answer. And MCP — the proof collector that reads the systems that actually ship the work."
**VO (honesty beat — say it plainly):** "And we're honest about the seams. Slack is live. Jira, GitHub Actions, and LaunchDarkly are real integrations Kept reads live the moment a workspace connects its own. Where nothing's connected, Kept says so, and lets a human attest instead. It never fakes a connection."
`[CAPTION]` **Slack AI · MCP — live proof, tenant-isolated, zero-copy, two human gates.**
_(An RTS retriever exists in the codebase but is gated OFF in production, so it is deliberately not claimed.)_

## 2:35 – 2:45 · CLOSE — end card, no face
`[SCREEN]` Cut to a clean end card.
**VO:** "Kept's whole thesis is simple. Don't take anyone's word for it. Demand proof."
Beat. **VO:** "So don't take this video's word for it either. Open the sandbox. Press Verify. And get blocked yourself."
`[END CARD]` **Kept — verify reality, then close the loop.** · Built with Slack AI + MCP · kept-iota.vercel.app
_(If you submit to the **Organizations** track instead, swap the middle line for: "Slack Agent for Organizations · Marketplace App `A0BBEJQ2CMC`".)_

---

## Timing
| Beat | Length | Ends |
|---|---:|---:|
| Cold open — title card + hook (no face) | 0:10 | 0:10 |
| The block (+ silence beat) | 0:20 | 0:30 |
| M1 · capture → Gate one | 0:30 | 1:00 |
| M2 · flag ON → sign → sanitized close | 0:40 | 1:40 |
| M3 · customer loop-close + stat card | 0:25 | 2:05 |
| Flashes · drift / trust / receipts | 0:15 | 2:20 |
| Tech + honesty + architecture | 0:15 | 2:35 |
| Close — end card | 0:10 | 2:45 |

**Spine (if you cut):** hook card → the block (silence) → confirm → flip ON → sign → sanitized close → "works now" →
**stat card** → 1s flashes → Slack AI + MCP + honesty → *"press Verify and get blocked yourself."*
**Never cut:** the hook line, the silence on the block, the stat card, or the closing line.

## AI-voice + muted-first checklist
- **One voice, mid-pace, calm-confident.** Generate each VO line separately; nudge pacing with punctuation, not with the voice's "excitement."
- **Listen once at 1×, once at 1.25×** — if a line sounds rushed or a word is mispronounced, respell it phonetically in the TTS input (e.g., "Jira" → "Jeera" only if your voice needs it).
- **Every VO line also exists as a caption.** The block, the stat card, and the close must read with sound off.
- **The silence beat is an edit gap**, not a VO line — hold 1.5s with the red ✗ on screen + one sound cue.
- Tight crops; zoom into the **one row that matters** (the red flag-OFF line).
- Watch the final cut **on a phone** — if the red ✗ is legible there, it's legible everywhere.
