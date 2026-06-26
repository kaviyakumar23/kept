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
          { title: "What did we promise Acme this week?", message: "What did we promise Acme this week?" },
          { title: "Anything waiting on me to verify?", message: "Anything waiting on me to verify?" },
        ],
      });
    },
    userMessage: async ({ message, say, setStatus }: any) => {
      const text: string = message?.text ?? "";
      const viewerId: string | undefined = message?.user;
      await setStatus("Reading the ledger…");
      const intent = await classifyLedgerQuery(deps.llm, text);
      const obligations = await deps.orch.allObligations();
      const answer = answerLedgerQuery(intent, obligations, now(), viewerId);
      await say({ text: answer.text, blocks: answer.blocks as any });
    },
  });
}
