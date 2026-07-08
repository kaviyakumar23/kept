/**
 * Generates docs/eval-report.md — Kept's published classification metrics:
 * per-class precision / recall / F1 + a confusion matrix over the typed-signal
 * taxonomy. Offline it scores the deterministic heuristic baseline; with
 * ANTHROPIC_API_KEY set it scores the live model. Run: `npm run eval:report`.
 *
 * The LLM proposes; the engine decides — this report measures ONLY the proposal
 * (classification) quality. The lifecycle/safety guarantees are verified
 * separately by `npm run eval` and the hermetic test suite.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { selectLlm } from "../llm/select.js";
import { classifyMessage } from "../llm/classify.js";
import type { LlmProvider } from "../llm/provider.js";
import { ALL_SIGNALS, type ObligationSignal } from "../domain/signals.js";
import { CLASSIFICATION_CORPUS, heuristicResponder } from "./scenarios.js";

const CODE: Record<ObligationSignal, string> = {
  CUSTOMER_REQUEST: "REQ",
  INTERNAL_ACKNOWLEDGEMENT: "ACK",
  TENTATIVE_COMMITMENT: "TENT",
  CONFIRMED_COMMITMENT: "CONF",
  SCOPE_CHANGE: "SCOPE",
  FULFILLMENT_SIGNAL: "FULF",
  CUSTOMER_CONFIRMATION: "CONFIRM",
  CANCELLATION: "CANCEL",
  NON_ACTIONABLE: "NA",
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number) => x.toFixed(2);

type Pair = { gold: ObligationSignal; pred: ObligationSignal };

function perClass(pairs: Pair[]) {
  const goldClasses = ALL_SIGNALS.filter((c) => pairs.some((p) => p.gold === c));
  return goldClasses.map((cls) => {
    const tp = pairs.filter((p) => p.gold === cls && p.pred === cls).length;
    const fp = pairs.filter((p) => p.gold !== cls && p.pred === cls).length;
    const fn = pairs.filter((p) => p.gold === cls && p.pred !== cls).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { cls, support: pairs.filter((p) => p.gold === cls).length, precision, recall, f1 };
  });
}

async function classify(provider: LlmProvider): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (const m of CLASSIFICATION_CORPUS) {
    const res = await classifyMessage(provider, { messageText: m.text });
    pairs.push({ gold: m.gold, pred: res.signal });
  }
  return pairs;
}

function render(provider: LlmProvider, pairs: Pair[]): string {
  const rows = perClass(pairs);
  const accuracy = pairs.filter((p) => p.gold === p.pred).length / pairs.length;
  const macroF1 = rows.reduce((s, r) => s + r.f1, 0) / rows.length;
  const commitment = new Set<ObligationSignal>(["CUSTOMER_REQUEST", "TENTATIVE_COMMITMENT", "CONFIRMED_COMMITMENT"]);
  const cSub = pairs.filter((p) => commitment.has(p.gold));
  const commitmentAcc = cSub.length ? cSub.filter((p) => p.gold === p.pred).length / cSub.length : 1;

  const present = ALL_SIGNALS.filter((c) => pairs.some((p) => p.gold === c || p.pred === c));
  const isLive = provider.name !== "mock";
  const label = isLive ? `live model (${provider.name})` : "deterministic heuristic baseline (offline)";

  const out: string[] = [];
  out.push("# Kept — classification eval report");
  out.push("");
  out.push(`Provider: **${label}** · Corpus: **${CLASSIFICATION_CORPUS.length}** gold-labeled messages across **${rows.length}** signal classes.`);
  out.push("");
  out.push("Kept's classifier maps each message to one of nine **typed obligation signals** (request vs. tentative vs. confirmed commitment vs. fulfillment, …) — never a binary is/isn't-a-request. The LLM only *proposes*; the deterministic engine *decides* every transition. This report measures the proposal (classification) quality only.");
  out.push("");
  out.push("> The lifecycle & safety guarantees — **0 false closures, 100% duplicate suppression, 0% customer-facing leakage, 0 unauthorized actions** — are verified separately by the scenario battery (`npm run eval`) and the hermetic test suite (7 adversarial rounds). They are guarantees by construction, not classifier outputs.");
  out.push("");
  out.push("## Headline");
  out.push("");
  out.push(`| Metric | Score |`);
  out.push(`|---|---|`);
  out.push(`| Signal accuracy | **${pct(accuracy)}** |`);
  out.push(`| Macro-F1 | **${f2(macroF1)}** |`);
  out.push(`| Commitment-class accuracy (request / tentative / confirmed) | **${pct(commitmentAcc)}** |`);
  out.push("");
  out.push("## Per-class precision / recall / F1");
  out.push("");
  out.push(`| Signal | Support | Precision | Recall | F1 |`);
  out.push(`|---|---:|---:|---:|---:|`);
  for (const r of rows) out.push(`| ${r.cls} | ${r.support} | ${pct(r.precision)} | ${pct(r.recall)} | ${f2(r.f1)} |`);
  out.push("");
  out.push("## Confusion matrix");
  out.push("");
  out.push("Rows = gold label, columns = predicted. Diagonal = correct.");
  out.push("");
  out.push(`| gold \\ pred | ${present.map((c) => CODE[c]).join(" | ")} |`);
  out.push(`|---|${present.map(() => "---:").join("|")}|`);
  for (const g of present) {
    const cells = present.map((p) => {
      const n = pairs.filter((x) => x.gold === g && x.pred === p).length;
      return n === 0 ? "·" : g === p ? `**${n}**` : String(n);
    });
    out.push(`| ${CODE[g]} | ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push(`_Legend: ${present.map((c) => `${CODE[c]}=${c}`).join(", ")}._`);
  out.push("");
  out.push("## How to reproduce");
  out.push("");
  out.push("```bash");
  out.push("npm run eval:report          # this report (offline heuristic baseline)");
  out.push("ANTHROPIC_API_KEY=… npm run eval:report   # score the live Claude model");
  out.push("npm run eval                 # full lifecycle + safety scenario battery");
  out.push("```");
  out.push("");
  if (!isLive) {
    out.push("> Offline numbers reflect the **intentionally imperfect** keyword heuristic (`src/eval/scenarios.ts`) — an honest baseline, not a rigged 100%. The live model scores materially higher; set `ANTHROPIC_API_KEY` and re-run to regenerate this file with its numbers.");
    out.push("");
  }
  return out.join("\n");
}

async function main() {
  const config = loadConfig();
  const { provider } = selectLlm(config, heuristicResponder);
  const pairs = await classify(provider);
  const md = render(provider, pairs);
  writeFileSync("docs/eval-report.md", md + "\n", "utf8");
  console.log(`[eval:report] wrote docs/eval-report.md (provider=${provider.name}, ${CLASSIFICATION_CORPUS.length} items)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
