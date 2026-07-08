import type { KeptConfig } from "../config.js";
import type { LlmProvider, StructuredRequest } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";
import { MockLlmProvider } from "./mock.js";

export interface SelectedLlm {
  provider: LlmProvider;
  /** Boot-log label: "openai(<model>)" / "anthropic(<model>)" / "mock". */
  label: string;
}

/**
 * Provider selection + precedence. The provider ONLY classifies / extracts / routes /
 * proposes structured output — it never emits events or takes actions (invariant #1);
 * this just picks which implementation of the same interface to use.
 *
 * Precedence, high → low:
 *   1. KEPT_LLM_PROVIDER forces a specific provider ("openai" | "anthropic" | "mock").
 *   2. OPENAI_API_KEY present    → OpenAiProvider.
 *   3. ANTHROPIC_API_KEY present → AnthropicProvider.
 *   4. otherwise the deterministic mock/heuristic (offline demo + hermetic tests).
 */
export function selectLlm(
  cfg: KeptConfig,
  mockResponder: (req: StructuredRequest<unknown>) => unknown,
): SelectedLlm {
  const forced = cfg.llmProvider;
  const useOpenAi = forced === "openai" || (!forced && Boolean(cfg.openaiApiKey));
  const useAnthropic = forced === "anthropic" || (!forced && Boolean(cfg.anthropicApiKey));

  if (useOpenAi) {
    return {
      provider: new OpenAiProvider({ apiKey: cfg.openaiApiKey, model: cfg.openaiModel }),
      label: `openai(${cfg.openaiModel})`,
    };
  }
  if (useAnthropic) {
    return {
      provider: new AnthropicProvider({ apiKey: cfg.anthropicApiKey, model: cfg.llmModel }),
      label: `anthropic(${cfg.llmModel})`,
    };
  }
  return { provider: new MockLlmProvider(mockResponder), label: "mock" };
}
