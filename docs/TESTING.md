# Kept — end-to-end test script

Run this in the **operator workspace** (`T09L1PSMV2R`) — it has the live integrations. Each step has a **Do** and an **✅ Expect**.
For the **judge sandbox** (a fresh install), do "Setup" + "Test A" (Option A) out of the box; do Test B only after connecting a proof source (see **Connecting proof sources**).

---

## Connecting proof sources (LaunchDarkly / Jira / GitHub) — read this first

A workspace only reads a proof source (like a LaunchDarkly flag) if **two things** are true:
**(1)** the source's credentials are available, and **(2)** the *customer* is mapped to a specific flag.
There are two ways this happens:

### A) Operator env — your workspace only
`T09L1PSMV2R` is the `KEPT_OPERATOR_TEAM`, so it reads LaunchDarkly / Jira / GitHub from the **server's env credentials**, and `proof-targets.json` pre-maps **`Acme` → flag `sso-login-fix`**. So in *your* workspace, a promise for **customer Acme** already reads that flag — nothing to connect in the UI.

> ⚠️ **Expected gotcha:** App Home → 🔌 **Connections will show LaunchDarkly / Jira / GitHub as "Not connected"** in your workspace. That panel reflects *per-tenant* connections only — it does **not** know about the operator env. The sources still work (the `npm run smoke` check proves it). Don't let "Not connected" mislead you.

### B) Per-tenant Connections — every other workspace + the sandbox
A fresh install reads **no** proof source until it connects its own. In **App Home → Connections**:
1. **LaunchDarkly → Connect** → *API access token* + *Project key* + *Environment* = `production` → **Save**.
2. **Jira → Connect** → *Base URL* + *Email* + *API token* (+ *Cloud ID*) → **Save**.
3. **GitHub → Connect** → *Personal access token* → **Save**.
4. **Add mapping** (this is the step people miss) → *Customer or subject key* = `Acme` → *LaunchDarkly flag key* = `sso-login-fix` → *Environment* = `production` → **Save mapping**.

**Without step 4 (a mapping), no flag is ever read** — so the promise verifies on the manual attestation alone. That is almost certainly why your Test B "just verified": either the customer wasn't mapped to a flag, or the flag wasn't OFF in *production* at read time.

---

## Setup (once)
1. **Add Kept to a channel.** In a channel (e.g. `#acme`): `/invite @Kept`  ✅ Kept joins (it only sees channels it's in).
2. **Pin the customer to Acme.** `/kept customer Acme`  ✅ *"📍 This channel is now bound to Acme…"* — every promise here is now customer **Acme** (which is the one mapped to the flag). This is required for Test B.

---

## Test A — Full loop, NO integrations (Option A) — what a judge sees
3. **Capture.** Post: `We'll ship the CSV export by Friday.`
   ✅ DM: confirm card **Acme — CSV export** · *Confirm · Edit · Not a request*. No fake work-item line.
4. **Gate 1.** Click **Confirm**.  ✅ Card **locks** → *"✅ Confirmed — now tracked."*
5. **Mark delivered.** App Home → the promise → **Mark delivered**.
   ✅ DM: a thin **Review & verify** nudge. Click it (or the promise's **Verify** on Home) → the **Proof-of-Done** modal opens: **✍️ Marked delivered by the owner ✓ · attested** → **✅ Ready to close** (no proof source → attestation is enough).
6. **Gate 2.** In the modal, click **Verify it's available** (the submit *is* your signature).  ✅ Modal closes → a **Review & send** nudge lands in your DM.
7. **Approve.** Open that nudge (or the promise's **Send** on Home) → the closure-draft modal → **Approve & send**.  ✅ Sanitized closure **posts in the channel thread** (no internal refs).
8. **Customer reply.** In that **same thread** (Reply in thread), reply: `works now`
   ✅ DM: *"✅ Acme confirmed 'CSV export' is working — closed."* Promise is now **✅ Kept**.

> ⚠️ Step 8 must be a **threaded reply on the original message**, not a new channel message, and the promise must already be at *closing* (after Approve). A reply on any other thread does nothing.

---

## Test B — The differentiator: a live LaunchDarkly flag blocks the close

This is the money moment: even when the owner *attests* delivery, a production flag that's **OFF** stops the close.
It only works when **(a)** the customer is **Acme** (mapped to `sso-login-fix`), **(b)** a fresh promise (not a re-post that merges into a closed one), and **(c)** the flag is **OFF in the `production` environment** *at the moment Kept reads it* (on Mark delivered and again on Verify).

### Step 0 — turn the flag OFF **in production**, and *prove* it
- In LaunchDarkly, use the **environment switcher** (top-left) and select **Production** — **not** "Test". Kept reads **production** only.
- Open flag **`sso-login-fix`** → toggle targeting **OFF** → **Review and save** (LaunchDarkly doesn't apply the toggle until you save).
- **Verify from the server before continuing** (this is the check that ends the guesswork):
  ```
  flyctl ssh console -a kept-slack-agent -C "sh -lc 'cd /app && SMOKE_FLAG_KEY=sso-login-fix npm run smoke'"
  ```
  ✅ It must print **`LaunchDarkly · get_flag_state(sso-login-fix, production)  flag is OFF ⛔ in production`**. Only proceed when you see **OFF**.

### Step 1 — capture (use a **new subject** so it doesn't merge into a closed promise)
- In the Acme-bound channel, post a promise with a subject you haven't used before, e.g.:
  `We'll ship the reporting dashboard by Friday.`
  ✅ DM: confirm card **Acme — reporting dashboard**. *(Reusing "SSO fix" would merge into the earlier, already-closed Acme obligation — always use a fresh subject for a fresh Test B.)*

### Step 2 — Gate 1
- Click **Confirm**.  ✅ Card locks → *"✅ Confirmed."*

### Step 3 — Mark delivered → open the packet → **the block**
- App Home → the promise → **Mark delivered**. You get a **Review & verify** nudge in DM.
- Open it (or click **Verify** on the Home row). *(At this instant Kept reads the live Acme flag.)*
  ✅ **Proof-of-Done modal** shows **✍️ Marked delivered by the owner ✓** **and** **🚩 Production flag OFF ✗ · read live** → verdict **⛔ Not ready to close.**
  ❗ **If it says "Ready to close" instead:** the flag wasn't OFF in **production** at read time, **or** the customer isn't mapped (see Troubleshooting). Re-do Step 0.

### Step 4 — try to Verify anyway → **refused, in place**
- In the modal, click **Verify it's available**.
  ✅ The engine returns `INSUFFICIENT_EVIDENCE` and the **modal re-renders still showing ⛔ Production flag OFF** — you cannot sign a close the evidence won't support.

### Step 5 — flip the flag ON → Verify → **passes**
- In LaunchDarkly (**Production**), toggle `sso-login-fix` **ON** → **Review and save**. *(Optionally re-run the smoke check → should say ON.)*
- Re-open the packet (**Verify** on Home) → click **Verify it's available** again. *(Verify re-reads the live flag.)*
  ✅ Modal closes → you get a **Review & send** nudge. Same promise, opposite outcome — driven only by the real flag.

### Step 6 — close the loop
- Open the send nudge (or **Send** on Home) → **Approve & send** → the sanitized closure posts in the thread → reply `works now` in-thread → **✅ Kept**.

### Troubleshooting — "it said Verified with the flag OFF"
| Cause | How to confirm | Fix |
|--|--|--|
| Flag was OFF in **Test**, not **Production** | `npm run smoke` says `flag is ON` | Flip the **Production** environment; re-run smoke until it says OFF |
| Customer isn't mapped to the flag | promise's customer ≠ `Acme` | `/kept customer Acme` in the channel; use that channel |
| Promise merged into a closed obligation | Receipts show an old, already-closed timeline | Use a **fresh subject** each run |
| Other workspace / sandbox with no LaunchDarkly connected | Connections shows "Not connected" **and** no mapping added | Connect LaunchDarkly + **Add mapping** (Connections section, B) |

---

## Test C — Surfaces
15. **App Home (the cockpit):** compact counts strip · ⚡ *Needs you now* pointer · 📋 ledger grouped by customer, each open promise carrying its own action (**Confirm / Mark delivered / Verify / Send**) + **Receipts**; closed promises collapse to a *Kept:* line. Plain-language status (no raw enum names).
16. **Receipts** on any promise → modal timeline: *Promise captured → Confirmed → Verified → Closure posted → Customer confirmed*, timestamped.
17. `/kept` → ephemeral ledger for Acme.

---

## Where things appear
| Surface | Where |
|--|--|
| Confirm card, then thin **Review & verify / Review & send** nudges | **Your DM** from Kept |
| Proof-of-Done packet + closure draft | **Modals** — opened from a DM nudge *or* the Home row |
| Sanitized closure | **In the channel thread** |
| Drive the whole lifecycle (Confirm/Verify/Send/Mark delivered), ledger, Receipts, Connections | **App Home → Home tab** |
| `/kept customer`, `/kept` | **Slash commands** |

## Reset for a clean re-run
Use a **fresh subject** each run (a promise with a new subject = a new obligation; a repeated subject merges into the last one). Or use a different channel.
