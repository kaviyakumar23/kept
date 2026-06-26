# Kept — classification eval report

Provider: **deterministic heuristic baseline (offline)** · Corpus: **20** gold-labeled messages across **9** signal classes.

Kept's classifier maps each message to one of nine **typed obligation signals** (request vs. tentative vs. confirmed commitment vs. fulfillment, …) — never a binary is/isn't-a-request. The LLM only *proposes*; the deterministic engine *decides* every transition. This report measures the proposal (classification) quality only.

> The lifecycle & safety guarantees — **0 false closures, 100% duplicate suppression, 0% customer-facing leakage, 0 unauthorized actions** — are verified separately by the scenario battery (`npm run eval`) and the hermetic test suite (6 adversarial rounds). They are guarantees by construction, not classifier outputs.

## Headline

| Metric | Score |
|---|---|
| Signal accuracy | **90%** |
| Macro-F1 | **0.90** |
| Commitment-class accuracy (request / tentative / confirmed) | **78%** |

## Per-class precision / recall / F1

| Signal | Support | Precision | Recall | F1 |
|---|---:|---:|---:|---:|
| CUSTOMER_REQUEST | 4 | 100% | 100% | 1.00 |
| INTERNAL_ACKNOWLEDGEMENT | 2 | 100% | 100% | 1.00 |
| TENTATIVE_COMMITMENT | 3 | 100% | 33% | 0.50 |
| CONFIRMED_COMMITMENT | 2 | 67% | 100% | 0.80 |
| SCOPE_CHANGE | 1 | 100% | 100% | 1.00 |
| FULFILLMENT_SIGNAL | 3 | 100% | 100% | 1.00 |
| CUSTOMER_CONFIRMATION | 2 | 67% | 100% | 0.80 |
| CANCELLATION | 1 | 100% | 100% | 1.00 |
| NON_ACTIONABLE | 2 | 100% | 100% | 1.00 |

## Confusion matrix

Rows = gold label, columns = predicted. Diagonal = correct.

| gold \ pred | REQ | ACK | TENT | CONF | SCOPE | FULF | CONFIRM | CANCEL | NA |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| REQ | **4** | · | · | · | · | · | · | · | · |
| ACK | · | **2** | · | · | · | · | · | · | · |
| TENT | · | · | **1** | 1 | · | · | 1 | · | · |
| CONF | · | · | · | **2** | · | · | · | · | · |
| SCOPE | · | · | · | · | **1** | · | · | · | · |
| FULF | · | · | · | · | · | **3** | · | · | · |
| CONFIRM | · | · | · | · | · | · | **2** | · | · |
| CANCEL | · | · | · | · | · | · | · | **1** | · |
| NA | · | · | · | · | · | · | · | · | **2** |

_Legend: REQ=CUSTOMER_REQUEST, ACK=INTERNAL_ACKNOWLEDGEMENT, TENT=TENTATIVE_COMMITMENT, CONF=CONFIRMED_COMMITMENT, SCOPE=SCOPE_CHANGE, FULF=FULFILLMENT_SIGNAL, CONFIRM=CUSTOMER_CONFIRMATION, CANCEL=CANCELLATION, NA=NON_ACTIONABLE._

## How to reproduce

```bash
npm run eval:report          # this report (offline heuristic baseline)
ANTHROPIC_API_KEY=… npm run eval:report   # score the live Claude model
npm run eval                 # full lifecycle + safety scenario battery
```

> Offline numbers reflect the **intentionally imperfect** keyword heuristic (`src/eval/scenarios.ts`) — an honest baseline, not a rigged 100%. The live model scores materially higher; set `ANTHROPIC_API_KEY` and re-run to regenerate this file with its numbers.

