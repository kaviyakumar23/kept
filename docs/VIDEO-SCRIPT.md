# Kept — demo video script (Slack Agent for _Organizations_)

**Target length: 2:40 (hard ceiling 3:00).** Shot-by-shot. Open cold on the flag-OFF **block** — the one thing a ticket-tracker structurally cannot do — then show the agent assembling the Evidence Packet, the human signing, the drift radar, and the customer trust page. Caption every beat. State the honesty line once, plainly.

**Recording notes.** Everything here is real and runnable: `npm start` (Bolt OAuth app + webhook server) drives the live Slack cards; `npm run demo` prints the same end-to-end storyboard offline (a clean fallback if the workspace is flaky). Keep the customer channel `#acme-collab` and the owner's DM both on screen where noted. Captions are burned-in lower-thirds. VO = voiceover.

---

## Segment 1 — COLD OPEN: the block (0:00 – 0:18) · 18s

| | |
|---|---|
| **Screen** | The owner's DM. A card titled **"Kept · Proof-of-Done evidence packet — Acme · SSO login fix."** Rows animate in: *Ticket Done ✓ · Code merged ✓ · Prod deploy ✓ · **Feature flag OFF ✗.*** Verdict stamps red: **"blocked — not verifiably available."** |
| **VO** | "A Jira ticket just flipped to **Done**. Every other tool would tell the customer it's fixed. Watch what Kept does instead." |
| **Caption** | `Ticket says Done. Kept checked the feature flag — it's OFF in production.` |
| **Cut** | Owner clicks **Verify** → a red inline notice: *"blocked (INSUFFICIENT_EVIDENCE) — state still POSSIBLE_FULFILLMENT."* |
| **VO** | "The deploy never shipped. So Kept **blocks the close** — even though the ticket, the PR, and the deploy all say go." |
| **Caption** | `Your ticketer tracks status. Kept verifies reality.` |

## Segment 2 — Why this matters (0:18 – 0:33) · 15s

| | |
|---|---|
| **Screen** | Simple title card / competitor logos fade: Pylon · Thena · ClearFeed → struck through. Then the Kept wordmark. |
| **VO** | "Pylon, Thena, ClearFeed — they track ticket status. That's exactly how a customer gets told 'it's fixed' when it isn't. Kept treats every promise as a first-class **obligation**, and never treats a ticket or a merged PR as truth." |
| **Caption** | `False "done" is the trust-killer. Kept is built to catch it.` |

## Segment 3 — Capture → Gate 1 (0:33 – 0:58) · 25s

| | |
|---|---|
| **Screen** | `#acme-collab` (a shared customer channel). A customer message: **"Can you get the SSO bug fixed by Friday?"** |
| **VO** | "Start where the promise is made — a shared customer channel. Kept's model reads the message and **proposes** an obligation. It never commits anything on its own." |
| **Caption** | `The LLM proposes. Code decides. (No event without a human gate.)` |
| **Screen** | Cut to the owner's **private** DM: a confirm card — outcome, due date, **prior commitments to Acme** (pulled from the ledger via Real-Time Search), and a **⚠ roadmap-conflict** warning. |
| **VO** | "The owner gets a private card — with prior commitments to this account and a warning that Friday beats the roadmap. **Gate 1.** Click Confirm—" |
| **Screen** | Owner clicks **Confirm**. Toast: *"Created PROJ-119 via MCP."* |
| **VO** | "—and only now does Kept open a work item, over MCP. Code chose that tool call, not the model." |
| **Caption** | `Gate 1 = confirm. Only then does the work item get created (MCP).` |

## Segment 4 — The agent assembles proof (0:58 – 1:22) · 24s

| | |
|---|---|
| **Screen** | Fast montage of webhook events landing on the obligation: **Linear → Done**, **PR #449 merged**, **prod deploy**. Then a status line: *"Kept queried LaunchDarkly (get_flag_state) over MCP."* |
| **VO** | "Engineering ships. Ticket Done, PR merged, deployed to prod. A normal tool would call that finished. Kept goes one step further — it **gathers Proof-of-Done itself**: the flag state, the CI run, the status page." |
| **Screen** | Back to the **Evidence Packet** from the cold open — now we understand it. Flag OFF ✗ → **blocked**. |
| **VO** | "The flag is off. The capability isn't reachable. So the Evidence Packet reads blocked — and the verify card never even goes out." |
| **Caption** | `Proof-of-Done: flag / CI / deploy / status — reconciled, not trusted.` |

## Segment 5 — Flip ON → sign → close the loop (1:22 – 1:52) · 30s

| | |
|---|---|
| **Screen** | A LaunchDarkly toggle flips **ON** (or a caption: *"flag flipped ON in production"*). The Evidence Packet re-renders **green**: *Feature flag ON ✓ → available.* |
| **VO** | "Someone flips the flag on. Kept re-gathers the proof — now every source agrees. **The agent did ninety-five percent of the work.** The owner does the last five: **Gate 2 — they sign.**" |
| **Screen** | Owner clicks **Verify it's available**. Then a **closure-draft card** appears: a customer-safe reply with a badge *"4 internal items redacted (linear, feature_flag, github) · Leak-safe ✅."* |
| **VO** | "Kept drafts the reply, strips every internal reference — ticket keys, PR numbers, the flag — and checks it for leaks. The owner approves." |
| **Screen** | Cut to `#acme-collab`: the closure posts **in the original thread**. |
| **Caption** | `Gate 2 = a human signs. The customer hears it — in the original thread, sanitized.` |

## Segment 6 — Wow #2: promise-drift radar (1:52 – 2:12) · 20s

| | |
|---|---|
| **Screen** | Customer replies **"it still fails for one user."** The obligation flips **REOPENED** — ticket still shows Done. Cut to **App Home**: the **drift band** lights up — *Drifting: 1 · Softening: 1* — with the reading *"Acme — SSO login fix: softening (drift 0.30) — customer reopened — disputed."* |
| **VO** | "And it outlives the ticket. The customer says it still fails — Kept reopens the obligation even though the ticket's frozen at Done. Across every account, Kept scores **promise drift**: 'next Tuesday' becoming 'soon' becoming silence — quantified." |
| **Caption** | `Promise-drift radar: softened, slipped, disputed, gone quiet — measured.` |

## Segment 7 — Wow #3: the customer trust page (2:12 – 2:28) · 16s

| | |
|---|---|
| **Screen** | Terminal: `/kept trust Acme` → a URL. Open the **trust page** in a browser: buckets **Kept · In progress · Verifying · At-risk**, a footer *"4 internal details withheld · noindex, no-store."* |
| **VO** | "Every account gets a private trust page — what you've kept, what's in flight — through the **same sanitizer** as the channel. No ticket, no PR, no flag ever shows. A retention weapon a CSM can just send." |
| **Caption** | `Per-account trust page — audience-safe by construction.` |

## Segment 8 — The engineering + honesty close (2:28 – 2:40) · 12s

| | |
|---|---|
| **Screen** | Three quiet title cards, then the Marketplace/Organizations frame. |
| **VO** | "Three qualifying technologies, all real: the **Slack AI Assistant**, **MCP** for work items and proof, and the **Real-Time Search API**. Multi-tenant OAuth, tenant isolation as a P0 invariant, zero-copy storage, two human gates. And we're honest about the seams:" |
| **Caption** | `Slack AI Assistant · MCP · Real-Time Search API — multi-tenant, zero-copy, two gates.` |
| **VO (honesty beat)** | "Slack is live. GitHub Actions is a **genuine live** proof source. Linear, Jira, LaunchDarkly, and Statuspage are **simulated over an in-process MCP server** with real API skeletons — a token swaps in the real thing." |
| **Caption** | `Honest by design: Slack + GitHub Actions live; Linear/Jira/LaunchDarkly/Statuspage simulated via MCP.` |
| **End card** | **Kept — verify reality, then close the loop.** Slack Agent for Organizations · Marketplace · App ID `<APP_ID_TBD>` · github.com/kaviyakumar23/kept |

---

## Timing summary

| Segment | Beat | Length | Ends |
|---|---|---:|---:|
| 1 | Cold open — the flag-OFF block | 0:18 | 0:18 |
| 2 | Why it matters (vs Pylon/Thena/ClearFeed) | 0:15 | 0:33 |
| 3 | Capture → Gate 1 confirm → work item (MCP) | 0:25 | 0:58 |
| 4 | Agent assembles Proof-of-Done | 0:24 | 1:22 |
| 5 | Flag ON → Gate 2 sign → sanitized closure | 0:30 | 1:52 |
| 6 | Wow #2 — reopen + promise-drift radar | 0:20 | 2:12 |
| 7 | Wow #3 — customer trust page | 0:16 | 2:28 |
| 8 | Three techs + engineering + honesty close | 0:12 | 2:40 |

**One-line spine (if you cut for time):** *Ticket says Done → flag is OFF → Kept blocks it → agent assembles proof → flag flips ON → human signs → sanitized close in-thread → drift radar → trust page.* Segments 3 and 4 are the ones to trim first; never cut Segment 1 or the Segment 8 honesty beat.
