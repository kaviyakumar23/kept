import { Assistant } from "@slack/bolt";
import type { KeptOrchestrator } from "../app/orchestrator.js";
import type { LlmProvider } from "../llm/provider.js";
import { classifyLedgerQuery, answerLedgerQuery } from "../app/assistantQuery.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Kept's Slack AI Assistant pane — a conversational surface over the obligation
 * ledger. This lights the "Slack AI capabilities" required technology (alongside
 * MCP) and serves the track verb literally: "surface intelligent insights inside
 * Slack". The discipline is unchanged from the rest of Kept: the LLM only routes
 * the question into a fixed intent grammar; deterministic code runs the read.
 */
export function buildKeptAssistant(deps: { orch: KeptOrchestrator; llm: LlmProvider; now?: () => number }): Assistant {
  const now = deps.now ?? (() => Date.now());
  return new Assistant({
    threadStarted: async ({ say, setSuggestedPrompts }: any) => {
      await say("Hi — I'm *Kept*. I track every promise your team makes to customers. Ask me what's overdue, what we owe a customer, or what's waiting on you to verify.");
      await setSuggestedPrompts({
        title: "Ask the ledger",
        prompts: [
          { title: "What's overdue?", message: "What's overdue?" },
          { title: "What's slipping?", message: "What's slipping?" },
          { title: "What did we promise Acme this week?", message: "What did we promise Acme this week?" },
          { title: "Anything waiting on me to verify?", message: "Anything waiting on me to verify?" },
        ],
      });
    },
    userMessage: async ({ message, say, setStatus, context }: any) => {
      const text: string = message?.text ?? "";
      const viewerId: string | undefined = message?.user;
      // W1 — the Assistant answers ONLY over the acting workspace's ledger.
      const teamId: string = context?.teamId ?? message?.team;
      // W3 — the Real-Time Search action_token rides on the message.im event that drives the pane.
      const actionToken: string | undefined = message?.action_token ?? context?.actionToken;
      try {
        await setStatus("Reading the ledger…");
        const intent = await classifyLedgerQuery(deps.llm, text);
        const obligations = await deps.orch.allObligations(teamId);
        const answer = answerLedgerQuery(intent, obligations, now(), viewerId);
        // W3 — enrich with related live Slack context via the Real-Time Search API
        // (assistant.search.context). Best-effort + fault-isolated: any failure just omits the line.
        let notes: string[] = [];
        try {
          notes = await deps.orch.searchSlackContext(teamId, text, actionToken);
        } catch (e) {
          console.warn("[kept] assistant RTS enrich failed:", e);
        }
        const blocks: any[] = Array.isArray(answer.blocks) ? [...answer.blocks] : [];
        if (notes.length) {
          blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Related discussion in Slack: ${notes.join(" · ")}` }] });
        }
        await say(blocks.length ? { text: answer.text, blocks } : { text: answer.text });
      } catch (err) {
        console.error("[kept] assistant query failed:", err);
        await say("Sorry — I couldn't read the ledger just now. Try a narrower question (e.g. a specific customer), or open the App Home tab.");
      }
    },
  });
}
