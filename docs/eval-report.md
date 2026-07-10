# Kept — classification eval report

Provider: **live model (openai · gpt-5.4-mini)** · Corpus: **52** gold-labeled messages across **9** signal classes.

Kept's classifier maps each message to one of nine **typed obligation signals** (request vs. tentative vs. confirmed commitment vs. fulfillment, …) — never a binary is/isn't-a-request. The LLM only *proposes*; the deterministic engine *decides* every transition. This report measures the proposal (classification) quality only.

> The lifecycle & safety guarantees — **0 false closures, 100% duplicate suppression, 0% customer-facing leakage, 0 unauthorized actions** — are verified separately by the scenario battery (`npm run eval`) and the hermetic test suite (adversarial rounds). They are guarantees by construction, not classifier outputs.

## Headline

| Metric | Score |
|---|---|
| Signal accuracy | **96%** |
| Macro-F1 | **0.97** |
| Commitment-class accuracy (request / tentative / confirmed) | **95%** |

**Won't it spam owners with confirm cards?** No. `NON_ACTIONABLE` messages classify at **100% precision / 100% recall**, and the confusion matrix shows **zero** non-promises misrouted into any commitment class — so ordinary channel chatter never triggers a card. The only 2 misses in 52 are between *adjacent commitment types* (e.g. tentative↔request), and every one of those still dies privately at **Gate 1** — one owner click, never a customer-facing action.

## Per-class precision / recall / F1

| Signal | Support | Precision | Recall | F1 |
|---|---:|---:|---:|---:|
| CUSTOMER_REQUEST | 10 | 91% | 100% | 0.95 |
| INTERNAL_ACKNOWLEDGEMENT | 5 | 100% | 100% | 1.00 |
| TENTATIVE_COMMITMENT | 7 | 100% | 86% | 0.92 |
| CONFIRMED_COMMITMENT | 5 | 100% | 100% | 1.00 |
| SCOPE_CHANGE | 4 | 100% | 100% | 1.00 |
| FULFILLMENT_SIGNAL | 6 | 86% | 100% | 0.92 |
| CUSTOMER_CONFIRMATION | 5 | 100% | 80% | 0.89 |
| CANCELLATION | 4 | 100% | 100% | 1.00 |
| NON_ACTIONABLE | 6 | 100% | 100% | 1.00 |

## Confusion matrix

Rows = gold label, columns = predicted. Diagonal = correct.

| gold \ pred | REQ | ACK | TENT | CONF | SCOPE | FULF | CONFIRM | CANCEL | NA |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| REQ | **10** | · | · | · | · | · | · | · | · |
| ACK | · | **5** | · | · | · | · | · | · | · |
| TENT | 1 | · | **6** | · | · | · | · | · | · |
| CONF | · | · | · | **5** | · | · | · | · | · |
| SCOPE | · | · | · | · | **4** | · | · | · | · |
| FULF | · | · | · | · | · | **6** | · | · | · |
| CONFIRM | · | · | · | · | · | 1 | **4** | · | · |
| CANCEL | · | · | · | · | · | · | · | **4** | · |
| NA | · | · | · | · | · | · | · | · | **6** |

_Legend: REQ=CUSTOMER_REQUEST, ACK=INTERNAL_ACKNOWLEDGEMENT, TENT=TENTATIVE_COMMITMENT, CONF=CONFIRMED_COMMITMENT, SCOPE=SCOPE_CHANGE, FULF=FULFILLMENT_SIGNAL, CONFIRM=CUSTOMER_CONFIRMATION, CANCEL=CANCELLATION, NA=NON_ACTIONABLE._

## How to reproduce

```bash
OPENAI_API_KEY=… npm run eval:report    # score the live OpenAI model (this report)
ANTHROPIC_API_KEY=… npm run eval:report  # score the live Claude model
npm run eval:report                      # offline deterministic heuristic baseline (no key)
npm run eval                             # full lifecycle + safety scenario battery
```
