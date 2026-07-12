# Kept — end-to-end test script

Run this in the **operator workspace** (`T09L1PSMV2R`) — it has the live integrations, so you can test
both the no-integration path and the LaunchDarkly differentiator. Each step has a **Do** and an **✅ Expect**.

For the **judge sandbox**, only "Setup" + "Test A" apply (a fresh install has no integrations → Option A).

---

## Setup (once)
1. **Add Kept to a channel.** In a channel (e.g. `#acme`): `/invite @Kept`
   ✅ Kept joins. It only sees channels it's a member of.
2. **Pin the customer.** `/kept customer Acme`
   ✅ *"📍 This channel is now bound to Acme…"* Every promise here is now tracked for Acme regardless of wording.

---

## Test A — Full loop, NO integrations (Option A) — what a judge sees
3. **Capture.** Post: `We'll ship the CSV export by Friday.`
   ✅ Kept **DMs you** a confirm card: **Acme — CSV export** · *Confirm · Edit · Not a request*. No fake work-item line; customer = Acme (the binding).
4. **Gate 1.** Click **Confirm**.
   ✅ Card **locks** → *"✅ Confirmed — now tracked."*
5. **Mark delivered.** Open the Kept **App Home** → find the promise → **✅ Mark delivered**.
   ✅ DM: Proof-of-Done packet — **✍️ Marked delivered by the owner ✓ · attested** → **✅ Ready to close**.
6. **Gate 2.** Click **Verify it's available**.
   ✅ Packet **locks** → *"☑️ Verified"* + a **closure-draft DM**.
7. **Approve.** Click **Approve & send**.
   ✅ Draft **locks** → *"✅ Sent"* + the **sanitized closure is posted in the channel thread** (no internal refs).
8. **Customer reply.** In that **same thread** (Reply in thread), reply: `works now`
   ✅ DM: *"✅ Acme confirmed 'CSV export' is working — closed."* Promise is now **✅ Kept**.

> ⚠️ Step 8 must be a **threaded reply on the original message**, not a new channel message.

---

## Test B — The differentiator: live LaunchDarkly blocks the close
9. **Flag OFF.** In LaunchDarkly, turn `sso-login-fix` **OFF** in **production**.
10. **Promise.** Post: `We'll ship the SSO fix by Friday.` → **Confirm**.
11. **Mark delivered** (App Home).
    ✅ Packet shows **✍️ Marked delivered ✓** *and* **🚩 Production flag OFF ✗ · read live** → **⛔ Not ready to close.** The live flag overrides your attestation.
12. Click **Verify** anyway.
    ✅ **Refused** (ephemeral *"Not verifiable yet…"*). The engine won't allow a false close.
13. **Flag ON** → click **Verify** again.
    ✅ **Passes** → closure draft. Same promise, opposite outcome — driven by the real flag.
14. **Approve & send** → reply `works now` in the thread to close (steps 7–8).

---

## Test C — Surfaces
15. **App Home:** ⚡ Needs you band · Open/Overdue/At-risk/Awaiting-verify tiles · 📚 ledger by customer · 🧾 Receipts per promise. Plain-language status (no raw enum names).
16. **Receipts** on the closed promise → modal timeline: *Promise captured → Confirmed → Verified → Closure posted → Customer confirmed*, each timestamped.
17. `/kept` → ephemeral ledger for Acme.

---

## Where things appear
| Surface | Where |
|--|--|
| Confirm card, evidence packet, closure draft, owner notices | **Your DM** from Kept |
| Sanitized closure | **In the channel thread** |
| Mark delivered, tiles, ledger, Receipts | **App Home → Home tab** |
| `/kept customer`, `/kept` | **Slash commands** |

## Reset for a clean re-run
Post a new promise with a fresh subject/customer, or use a different channel. (Judge-facing Demo Controls,
if `KEPT_DEMO_TEAM` is set for the sandbox, drive a scripted loop from buttons.)
