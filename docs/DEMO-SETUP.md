# Kept — fresh-workspace setup + test (the real installer flow)

Follow top to bottom in a **new Slack workspace**. Exact names are in `code`. This is the same flow a judge/customer follows, so it also validates onboarding.

---

## Part 0 — Gather these first (from your LaunchDarkly account)
You'll paste two values when you connect LaunchDarkly. Get them now:

1. **LaunchDarkly API access token** (read access):
   LaunchDarkly → **Account settings → Authorizations → Access tokens → Create token**.
   - Name: `kept-demo`
   - Role: **Reader** (read-only is enough)
   - Copy the token (starts with `api-…`). *You only see it once.*
2. **LaunchDarkly project key**:
   LaunchDarkly → top-left **project switcher** (or Account settings → Projects). Note the project **Key** (often `default`) — it must be the project that contains the flag below.
3. **Confirm the flag exists**: in that project, the flag **`sso-login-fix`** must exist, and you can see its **Production** environment toggle. Leave it **ON** for now (we flip it during Test B).

> Use `production` as the environment everywhere below — Kept reads **production** only.

---

## Part 1 — Install Kept in the new workspace
1. In the new workspace, open this link (or click **Add to Slack** on kept-iota.vercel.app):
   **`https://kept-slack-agent.fly.dev/slack/install`**
2. Click **Allow** to authorize.  ✅ Kept is installed. Open **Kept** in the left sidebar → the **Home** tab (App Home).

---

## Part 2 — Connect LaunchDarkly
1. App Home → scroll to **🔌 Connections** → next to **LaunchDarkly** click **Connect**.
2. In the modal, enter **exactly**:
   | Field | Value |
   |--|--|
   | API access token | *(paste your `api-…` token from Part 0)* |
   | Project key | *(your project key, e.g. `default`)* |
   | Environment | `production` |
3. Click **Save**.  ✅ Connections now shows **LaunchDarkly — Connected ✓**.

*(Optional — Jira/GitHub: same idea via their Connect buttons. Not needed for the flag-OFF demo.)*

---

## Part 3 — Map the customer to the flag  ← the step people miss
Connecting LaunchDarkly isn't enough; Kept needs to know *which flag proves which customer's work*.
1. App Home → **🔌 Connections** → **Add mapping**.
2. Enter **exactly**:
   | Field | Value |
   |--|--|
   | Customer or subject key | `Acme` |
   | LaunchDarkly flag key | `sso-login-fix` |
   | Environment (default production) | `production` |
3. Click **Save mapping**.  ✅ **Proof-target mapping — Configured ✓.**

Now: any promise for **customer Acme** in this workspace will read the **`sso-login-fix`** flag in **production**.

---

## Part 4 — Set up a channel
1. Create/open a channel, e.g. `#acme`. Add Kept: `/invite @Kept`
2. Pin the customer so wording doesn't matter: `/kept customer Acme`
   ✅ *"📍 This channel is now bound to Acme…"*

---

## Part 5 — Test A (pure attestation, no flag — ~1 min)
Since **Acme** is mapped to the flag, use a **different, unmapped customer** here so no flag is read.
1. In a channel, run `/kept customer Globex` (Globex is **not** mapped to any flag).
2. Post: `We'll ship the CSV export by Friday.`  → confirm-card DM **Globex — CSV export** → **Confirm**.
3. App Home → **Mark delivered** → packet: **✍️ Marked delivered ✓ → ✅ Ready to close** *(no proof source for Globex → the attestation alone is enough — this is Option A)*.
4. Open the **Review & verify** nudge (or **Verify** on the Home row) → in the Proof-of-Done modal click **Verify it's available** → open the **Review & send** nudge → **Approve & send** → reply `works now` in-thread → **✅ Kept**.

*(Test A proves the no-integration path. Test B — with the mapped customer Acme — is the differentiator.)*

---

## Part 6 — Test B: the flag-OFF block (the money moment)

### Step 0 — turn the flag OFF **in Production**, and prove it
1. LaunchDarkly → **environment switcher = Production** (not Test) → flag **`sso-login-fix`** → toggle **OFF** → **Review and save**.
2. Prove it from the server before continuing:
   ```
   flyctl ssh console -a kept-slack-agent -C "sh -lc 'cd /app && SMOKE_FLAG_KEY=sso-login-fix npm run smoke'"
   ```
   ✅ Must print **`flag is OFF ⛔ in production`**. Only continue when you see OFF. *(This reads via the operator env; your per-tenant connection uses the same flag, same production env.)*

### Step 1 — a FRESH promise (new subject → new obligation)
- In the `#acme` channel post: `We'll ship the reporting dashboard by Friday.`
  ✅ confirm-card DM **Acme — reporting dashboard**. *(A repeated subject merges into an old, closed promise — always use a new subject.)*

### Step 2 — Confirm
- Click **Confirm** → card locks.

### Step 3 — Mark delivered → open the packet → **the block**
- App Home → the promise → **Mark delivered** → open the **Review & verify** nudge (or **Verify** on the Home row). *(Kept reads the live Acme flag now.)*
  ✅ The **Proof-of-Done modal** shows **✍️ Marked delivered ✓** **and** **🚩 Production flag OFF ✗ · read live** → **⛔ Not ready to close.**
  ❗ If it says "Ready to close": the flag wasn't OFF in production at read time, or LaunchDarkly/mapping isn't set in **this** workspace (see Troubleshooting).

### Step 4 — Verify → **refused, in place**
- In the modal, click **Verify it's available** → the engine returns `INSUFFICIENT_EVIDENCE` and the **modal re-renders still showing ⛔ flag OFF**. You can't sign a close the evidence won't support.

### Step 5 — flip ON → Verify → **passes**
- LaunchDarkly (Production) → `sso-login-fix` **ON** → Review and save. *(Re-run the smoke → should say ON.)*
- Re-open the packet → **Verify it's available** again → ✅ modal closes, a **Review & send** nudge lands. Same promise, opposite outcome.

### Step 6 — close the loop
- Open the send nudge (or **Send** on Home) → **Approve & send** → sanitized closure posts in the thread → reply `works now` in-thread → **✅ Kept**.

---

## Troubleshooting — "it just verified / no flag row"
| Symptom | Cause | Fix |
|--|--|--|
| packet says *"no automated proof source connected"* | LaunchDarkly **not connected in this workspace**, or **no mapping** | Redo Part 2 **and** Part 3 in *this* workspace |
| flag row shows ON when you set it OFF | you flipped the **Test** env, not Production | flip **Production**; run the smoke check until it says OFF |
| Verify passes with flag OFF | customer isn't `Acme`, or promise merged into a closed one | `/kept customer Acme`; use a **fresh subject** |
| Connect saved but still no flag | wrong **project key**, or token lacks read access | re-check the project key contains `sso-login-fix`; use a Reader token |

## For the judges
Do **Parts 1–4** in the **sandbox** workspace (connect LaunchDarkly + add the `Acme → sso-login-fix` mapping there), then hand them **Part 6**. That way the flag-OFF block works for them exactly as it does for you — and it shows off the real per-tenant onboarding.
