import { z } from "zod";
import type { Obligation } from "../domain/obligation.js";
import type { LlmProvider } from "../llm/provider.js";
import { analytics, awaitingVerifyFor, isOpen } from "./analytics.js";
import { ledgerView, type SlackBlock } from "../slack/blocks.js";

/**
 * Natural-language ledger queries for the Slack AI Assistant. The keystone holds
 * on this surface too: the LLM ONLY routes the question into a fixed intent
 * grammar — deterministic code runs the read over the event-sourced ledger and
 * renders the answer. The model never invents status.
 */

export const QueryIntentSchema = z.object({
  intent: z.enum(["overdue", "at_risk", "awaiting_verify", "by_customer", "mine", "promised_this_week", "summary", "help"]),
  /** A named customer, when the question is about one. */
  customer: z.string().nullish(),
  /** True when the user asks about THEIR OWN items ("waiting on me", "mine", "for me"). */
  mine: z.boolean().optional(),
});
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

const QUERY_SYSTEM = `You route a user's natural-language question about the Kept obligation ledger into ONE intent. You do NOT answer or invent data — deterministic code runs the read. Intents:
- overdue: what's overdue / past due / late.
- at_risk: what's at risk / slipping / due soon and not done.
- awaiting_verify: obligations with evidence in, waiting for a human to verify (Gate 2). Set mine=true if the user asks about THEIR items ("waiting on me", "for me").
- by_customer: status for a NAMED customer — put the name in "customer".
- mine: the asker's own open obligations ("what's on my plate").
- promised_this_week: commitments due in the next 7 days.
- summary: overall counts / how are we doing.
- help: what can you do.
Pick the closest single intent. If a customer is named, set "customer". Default mine=false.`;

export async function classifyLedgerQuery(provider: LlmProvider, text: string): Promise<QueryIntent> {
  const { value } = await provider.generateStructured({
    system: QUERY_SYSTEM,
    user: `Question:\n${text}`,
    schema: QueryIntentSchema,
    schemaName: "route_ledger_query",
    schemaDescription: "Route the user's ledger question into one intent (+ optional customer / mine).",
  });
  return value;
}

// --- rendering (pure) ------------------------------------------------------
const section = (text: string): SlackBlock => ({ type: "section", text: { type: "mrkdwn", text } });
const header = (text: string): SlackBlock => ({ type: "header", text: { type: "plain_text", text, emoji: true } });
const context = (text: string): SlackBlock => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const line = (o: Obligation): string =>
  `• *${esc(o.outcome)}* — ${esc(o.customer)} · ${o.state}${o.due ? `, due ${esc(o.due)}` : ""}${o.work_item ? ` · ${esc(o.work_item.ref)}` : ""}`;
/** Cap rendered rows so one big result set can't blow Slack's 3000-char / 50-block limits. */
const MAX_ROWS = 25;
const listOr = (obls: Obligation[], empty: string): string => {
  if (!obls.length) return `_${empty}_`;
  const shown = obls.slice(0, MAX_ROWS);
  const more = obls.length - shown.length;
  return shown.map(line).join("\n") + (more > 0 ? `\n_…and ${more} more._` : "");
};

const footer = (): SlackBlock =>
  context("Answered from the event-sourced ledger — the model only routed your question; the engine ran the read.");

export interface QueryAnswer {
  text: string;
  blocks: SlackBlock[];
}

const wrap = (title: string, body: string): QueryAnswer => ({ text: title, blocks: [header(title), section(body), footer()] });

/** Run the routed query over the ledger projections. Pure: (intent, obligations, now, viewer) → answer. */
export function answerLedgerQuery(intent: QueryIntent, obligations: Obligation[], now: number, viewerId?: string): QueryAnswer {
  const a = analytics(obligations, now);
  switch (intent.intent) {
    case "overdue":
      return wrap("Overdue", listOr(a.overdue, "Nothing overdue — you're clear."));
    case "at_risk":
      return wrap("At risk", listOr(a.atRisk, "Nothing at risk right now."));
    case "awaiting_verify": {
      const items = intent.mine && viewerId ? awaitingVerifyFor(a, viewerId) : a.awaitingVerify;
      return wrap(intent.mine ? "Waiting on you to verify" : "Awaiting verification", listOr(items, "Nothing is waiting on a verify."));
    }
    case "promised_this_week":
      return wrap("Promised this week", listOr(a.promisedThisWeek, "Nothing due in the next 7 days."));
    case "mine": {
      const mine = obligations.filter((o) => isOpen(o) && viewerId != null && o.owner === viewerId);
      return wrap("On your plate", listOr(mine, "You have no open obligations."));
    }
    case "by_customer": {
      const customer = intent.customer;
      if (!customer) return wrap("Which customer?", 'Tell me a customer name — e.g. _"what do we owe Acme?"_');
      const obls = obligations.filter((o) => o.customer.toLowerCase() === customer.toLowerCase());
      return { text: `Ledger for ${customer}`, blocks: [...ledgerView(customer, obls), footer()] };
    }
    case "summary": {
      const counts = `*Open:* ${a.counts.open}   ·   :red_circle: *Overdue:* ${a.overdue.length}   ·   :large_yellow_circle: *At risk:* ${a.atRisk.length}   ·   :eyes: *Awaiting verify:* ${a.awaitingVerify.length}`;
      const top = a.byCustomer.slice(0, 5).map((c) => `• ${esc(c.customer)} — ${c.open} open${c.overdue ? `, ${c.overdue} overdue` : ""}`).join("\n") || "_No open obligations._";
      return { text: "Ledger summary", blocks: [header("Ledger summary"), section(counts), section(`*By customer*\n${top}`), footer()] };
    }
    case "help":
    default:
      return {
        text: "What I can answer",
        blocks: [
          header("Ask the Kept ledger"),
          section("I answer from the human-verified obligation ledger. Try:\n• *What's overdue?*\n• *What did we promise Acme this week?*\n• *Anything waiting on me to verify?*\n• *Give me a summary*"),
          footer(),
        ],
      };
  }
}
