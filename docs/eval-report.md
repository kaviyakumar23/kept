# Kept — classification eval report

Provider: **deterministic heuristic baseline (offline)** · Corpus: **52** gold-labeled messages across **9** signal classes.

Kept's classifier maps each message to one of nine **typed obligation signals** (request vs. tentative vs. confirmed commitment vs. fulfillment, …) — never a binary is/isn't-a-request. The LLM only *proposes*; the deterministic engine *decides* every transition. This report measures the proposal (classification) quality only.

> The lifecycle & safety guarantees — **0 false closures, 100% duplicate suppression, 0% customer-facing leakage, 0 unauthorized actions** — are verified separately by the scenario battery (`npm run eval`) and the hermetic test suite (7 adversarial rounds). They are guarantees by construction, not classifier outputs.

## Headline

| Metric | Score |
|---|---|
| Signal accuracy | **69%** |
| Macro-F1 | **0.69** |
| Commitment-class accuracy (request / tentative / confirmed) | **64%** |

## Per-class precision / recall / F1

| Signal | Support | Precision | Recall | F1 |
|---|---:|---:|---:|---:|
| CUSTOMER_REQUEST | 10 | 90% | 90% | 0.90 |
| INTERNAL_ACKNOWLEDGEMENT | 5 | 100% | 40% | 0.57 |
| TENTATIVE_COMMITMENT | 7 | 100% | 29% | 0.44 |
| CONFIRMED_COMMITMENT | 5 | 60% | 60% | 0.60 |
| SCOPE_CHANGE | 4 | 100% | 100% | 1.00 |
| FULFILLMENT_SIGNAL | 6 | 83% | 83% | 0.83 |
| CUSTOMER_CONFIRMATION | 5 | 67% | 80% | 0.73 |
| CANCELLATION | 4 | 100% | 50% | 0.67 |
| NON_ACTIONABLE | 6 | 33% | 83% | 0.48 |

## Confusion matrix

Rows = gold label, columns = predicted. Diagonal = correct.

| gold \ pred | REQ | ACK | TENT | CONF | SCOPE | FULF | CONFIRM | CANCEL | NA |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| REQ | **9** | · | · | · | · | · | 1 | · | · |
| ACK | · | **2** | · | · | · | · | · | · | 3 |
| TENT | · | · | **2** | 2 | · | · | 1 | · | 2 |
| CONF | · | · | · | **3** | · | 1 | · | · | 1 |
| SCOPE | · | · | · | · | **4** | · | · | · | · |
| FULF | · | · | · | · | · | **5** | · | · | 1 |
| CONFIRM | · | · | · | · | · | · | **4** | · | 1 |
| CANCEL | · | · | · | · | · | · | · | **2** | 2 |
| NA | 1 | · | · | · | · | · | · | · | **5** |

_Legend: REQ=CUSTOMER_REQUEST, ACK=INTERNAL_ACKNOWLEDGEMENT, TENT=TENTATIVE_COMMITMENT, CONF=CONFIRMED_COMMITMENT, SCOPE=SCOPE_CHANGE, FULF=FULFILLMENT_SIGNAL, CONFIRM=CUSTOMER_CONFIRMATION, CANCEL=CANCELLATION, NA=NON_ACTIONABLE._

## How to reproduce

```bash
npm run eval:report          # this report (offline heuristic baseline)
ANTHROPIC_API_KEY=… npm run eval:report   # score the live Claude model
npm run eval                 # full lifecycle + safety scenario battery
```

> Offline numbers reflect the **intentionally imperfect** keyword heuristic (`src/eval/scenarios.ts`) — an honest baseline, not a rigged 100%. The live model scores materially higher; set `ANTHROPIC_API_KEY` and re-run to regenerate this file with its numbers.

