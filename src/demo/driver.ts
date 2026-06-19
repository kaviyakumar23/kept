/**
 * Kept demo driver — fires the external "fulfillment" signals on cue so you can
 * record the LIVE Slack flow in one take. You type the customer message in Slack
 * and click the cards; between acts you press Enter here to deliver the next
 * signal (Linear status → PR merge → prod deploy) to the running webhook server.
 *
 * Prereqs:
 *   1. `npm start` is running (Slack app + webhook server on :3001).
 *   2. In Slack you've sent the customer message and clicked Confirm, so a work
 *      item exists — note its ref from the confirm result (e.g. PROJ-119).
 *
 * Run:   npm run demo:drive -- --ref=PROJ-119
 *   env: WEBHOOK_BASE (default http://localhost:3001), KEPT_WEBHOOK_SECRET (if set on the server)
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const BASE = process.env.WEBHOOK_BASE ?? "http://localhost:3001";
const SECRET = process.env.KEPT_WEBHOOK_SECRET;

function argRef(): string | undefined {
  const a = process.argv.find((x) => x.startsWith("--ref="));
  return a ? a.slice("--ref=".length) : process.env.DEMO_REF;
}

async function fire(path: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(SECRET ? { "x-kept-secret": SECRET } : {}) },
      body: JSON.stringify(body),
    });
    console.log(`   → POST ${path}  [${res.status}]  ${(await res.text()).trim()}`);
  } catch (err) {
    console.error(`   ✗ POST ${path} failed: ${err instanceof Error ? err.message : err}`);
    console.error(`     Is the app running? (npm start) — webhook base is ${BASE}`);
  }
}

async function main() {
  const rl = createInterface({ input, output });
  let ref = argRef();
  if (!ref) ref = (await rl.question("Linear issue ref from the confirm card (e.g. PROJ-119): ")).trim();

  const step = async (n: number, title: string, note: string, path: string, body: unknown) => {
    await rl.question(`\n▶ Step ${n} — ${title}\n   ${note}\n   (press Enter to fire) `);
    await fire(path, body);
  };

  console.log(`\nDriving demo signals for ${ref} → ${BASE}${SECRET ? " (x-kept-secret set)" : ""}`);

  // Reuse one In-Progress payload so Step 2 is a TRUE duplicate (same idempotency key).
  const inProgress = { type: "Issue", action: "update", data: { identifier: ref, state: { name: "In Progress" }, updatedAt: new Date().toISOString() } };

  await step(1, "Linear → In Progress", "Ledger advances to IN_PROGRESS.", "/webhooks/linear", inProgress);
  await step(2, "Linear → In Progress (duplicate)", "Identical event again — idempotent no-op (suppressed).", "/webhooks/linear", inProgress);
  await step(3, "GitHub → PR merged", "A merged PR ALONE is not enough — no verify card should appear yet.", "/webhooks/github",
    { action: "closed", pull_request: { number: 449, merged: true, merged_at: new Date().toISOString(), html_url: "https://github.com/acme/app/pull/449" }, relatesTo: { linear: ref } });
  await step(4, "Deploy → production", "Merge + production deploy = available → Gate-2 verify card to the owner.", "/webhooks/deploy",
    { release: "2026.06.19", environment: "production", customer_scoped: true, relatesTo: { linear: ref } });

  console.log("\n✓ Signals delivered. Now in Slack:");
  console.log("   • Click Verify (Gate 2) → review the sanitized draft → Approve & send.");
  console.log("   • The closure posts in the ORIGINAL customer thread.");
  console.log("   • Optional finale: open App Home and run /kept Acme to show the ledger + audit trail.\n");
  rl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
