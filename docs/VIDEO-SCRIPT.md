# Kept — demo video script (Slack Agent for _Organizations_)

**Target 2:45 · hard ceiling 3:00 · 1080p · public YouTube.** Judges mostly watch the first 30–60s and often
watch **muted** — so: face-first hook, big kinetic captions, put the strongest beat first.

## Non-negotiable rules (read before recording)
- **No third-party trademarks / UIs on screen.** Do **not** screen-record Jira, GitHub, or LaunchDarkly.
  Drive **everything** through Kept's own **Demo Controls** panel and cards, so every signal appears as **text
  inside Kept** ("Ticket Done ✓", "Production flag OFF ✗"). This is how the app is built — and it's the safe path.
- **Real human voiceover**, not TTS. Short sentences, confident verbs. No "we tried to…".
- **Burn in captions** (judges skim muted). 1080p. **Pre-warm the LLM** with a throwaway message before takes.
- **Royalty-free music only** — save the license file. One negative sound cue on the block (below); silence elsewhere there.
- Four moments, nothing more: **the block → capture/Gate 1 → sign & close → the customer loop-close**.
  Drift radar + trust page get a 1-second flash. Feature tours are how strong projects bore judges.

VO = voiceover. `[SCREEN]` = what's shown. `[CAPTION]` = burned-in lower-third.

---

## 0:00 – 0:12 · COLD OPEN — the face, not the feature
`[SCREEN]` You, to camera. Plain background. No logo, no intro.
**VO (you, direct):** "The ticket said **Done**. The feature was **never live**. And the customer found out **before you did**."
Beat. "That's the most expensive lie in B2B software. This is the tool that catches it."
`[CAPTION]` **The ticket said Done. The feature was never live.**

## 0:12 – 0:30 · The block (pattern-match killer by 0:30)
`[SCREEN]` Cut to Kept's **Proof-of-Done** card in a DM. Rows animate in as text: **🎫 Ticket Done ✓ · 🔀 Code merged ✓ · 🚀 Prod deploy ✓** … then **🚩 Production flag OFF ✗ · read live**.
**VO:** "This is **not** another follow-up bot. Watch what happens when someone says 'Done' — and it isn't."
`[SCREEN]` The verdict stamps red: **⛔ Not ready to close.** Owner clicks **Verify it's available** →
**⟵ SLOW DOWN. Hold 1.5s of silence. One low negative sound cue.** Red inline: *"Not verifiable — INSUFFICIENT_EVIDENCE."*
`[CAPTION]` **Jira said Done. The live flag said no. Kept blocked the close.**
**VO:** "Every other tool would've told the customer it's fixed. Kept refuses — and shows you exactly why."

## 0:30 – 1:00 · MOMENT 1 — capture → Gate 1 (the discipline)
`[SCREEN]` A shared customer channel. Message: **"We'll ship the SSO fix for Acme by Friday."**
**VO:** "Start where the promise is made. Kept's model **reads** the message and **proposes** an obligation — it never commits anything itself."
`[CAPTION]` **The LLM proposes. Code decides. Humans sign.**
`[SCREEN]` The owner's private DM: a confirm card — outcome, due date, owner. A single click: **Confirm**. Card locks to *"✅ Confirmed."*
**VO:** "The owner confirms — one private click. **Gate one.** That's the only way anything enters the ledger."

## 1:00 – 1:40 · MOMENT 2 — resolve the block, sign, close
`[SCREEN]` Kept's **Demo Controls** panel. Click **Toggle production flag → ON**. (Text flips: *Production flag: ON ✅*. No third-party UI.)
**VO:** "Now the fix actually ships — the flag goes on. Kept **re-reads the live flag**, and the packet turns green."
`[SCREEN]` The evidence packet re-renders: **🚩 Production flag ON ✓ · read live**. Owner clicks **Verify it's available** → *"☑️ Verified."*
**VO:** "The agent did ninety-five percent — gathering, reconciling. The human does the last five: **Gate two — they sign.**"
`[SCREEN]` **The audience-firewall beat.** Split: on the left, Kept's internal note — *"🛡️ 4 internal details kept out of the reply."* On the right, the **sanitized** message posting into the customer thread: *"the SSO fix is now available on your side — could you confirm?"* No ticket, no PR, no flag.
`[CAPTION]` **The customer never sees a ticket number. By construction.**

## 1:40 – 2:05 · MOMENT 3 — the customer closes the loop + the number
`[SCREEN]` The customer replies in-thread: **"works now"**. Kept DMs the owner: *"✅ Acme confirmed — closed."* Promise flips to **✅ Kept**.
**VO:** "The customer confirms, in their own words, in the original thread. **Only now** is it closed."
`[SCREEN]` **Full-screen stat card. White text, black screen, 2 seconds:**
> **Closes blocked before reaching a customer: 3**
**VO:** "Three times in this demo, Kept stopped a 'done' that wasn't. That's three conversations you never have to un-have."

## 2:05 – 2:20 · The 1-second flashes (drift + trust page + receipts)
`[SCREEN]` Quick cuts, ~1s each: the **drift radar** band (*"Acme — softening"*), the **customer trust page** (Kept / In progress / Verifying), the **🧾 Receipts** timeline scrolling (every state, signed).
**VO:** "It scores promise **drift** before things go quiet, gives each account a private **trust page**, and every step is a signed, replayable **receipt**."

## 2:20 – 2:35 · The three techs + honesty + architecture flash
`[SCREEN]` The **architecture diagram** flashes up; three badges pulse.
**VO:** "Three qualifying technologies, all real: the **Slack AI Assistant**, **MCP** for proof and work items, and the **Real-Time Search API**."
**VO (honesty beat — say it plainly):** "And we're honest about the seams. Slack is live. **LaunchDarkly, Jira, and GitHub Actions are live** — the flag read is a real MCP call. Where a tenant hasn't connected a source, Kept says so and lets a human attest instead. It never fakes a connection."
`[CAPTION]` **Slack AI · MCP · Real-Time Search — live proof, tenant-isolated, zero-copy, two human gates.**

## 2:35 – 2:45 · THE META-MOVE close (this is the whole argument)
`[SCREEN]` Back to your face. Then an end card.
**VO:** "Kept's entire thesis is: **don't take anyone's word for it. Demand proof.** So don't take *this video's* word for it either. Kept wouldn't."
Beat. "Open the sandbox. Press **Verify**. And get **blocked yourself.**"
`[END CARD]` **Kept — verify reality, then close the loop.** · Slack Agent for Organizations · Marketplace App `A0BBEJQ2CMC` · kept-iota.vercel.app

---

## Timing
| Beat | Length | Ends |
|---|---:|---:|
| Cold open — the face + the line | 0:12 | 0:12 |
| The block (+ silence beat) | 0:18 | 0:30 |
| M1 · capture → Gate 1 | 0:30 | 1:00 |
| M2 · flag ON → sign → sanitized close | 0:40 | 1:40 |
| M3 · customer loop-close + stat card | 0:25 | 2:05 |
| Flashes · drift / trust / receipts | 0:15 | 2:20 |
| Three techs + honesty + architecture | 0:15 | 2:35 |
| Meta-move close | 0:10 | 2:45 |

**Spine (if you cut):** face+line → the block (silence) → confirm → flip ON → sign → sanitized close → "works now" →
**stat card** → 1s flashes → three techs + honesty → *"press Verify and get blocked yourself."*
**Never cut:** the cold-open line, the silence on the block, the stat card, or the meta-move close.

## Muted-first checklist
- Every VO line also exists as a caption. The block, the stat card, and the close read with **sound off**.
- Tight crops; zoom into the **one row that matters** (the red flag-OFF line).
- Watch the final cut **on a phone** — if the red ✗ is legible there, it's legible everywhere.
