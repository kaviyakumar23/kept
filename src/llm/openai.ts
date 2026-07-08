import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./provider.js";
import { LlmRefusalError } from "./anthropic.js";

/**
 * OpenAI provider — an alternative to {@link AnthropicProvider} selectable by config.
 * Structured output is obtained via OpenAI Structured Outputs: the request's Zod
 * schema is turned into a strict JSON-schema `response_format` with
 * `zodResponseFormat`, and `chat.completions.parse` returns a message whose
 * `.parsed` field already matches that schema. We re-validate with the SAME Zod
 * schema at this boundary so callers get identically typed, validated values —
 * exactly the shape the Anthropic path returns.
 *
 * Default model: gpt-4o (a broadly-available model that supports Structured
 * Outputs). Override with OPENAI_MODEL, or KEPT_LLM_MODEL. Like the Anthropic
 * provider, the model only ever classifies / extracts / drafts — it never decides
 * a transition and never emits an event (invariant #1).
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new OpenAI(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? process.env.KEPT_LLM_MODEL ?? "gpt-4o";
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const responseFormat = zodResponseFormat(req.schema, req.schemaName, {
      description: req.schemaDescription,
    });

    const completion = await this.client.beta.chat.completions.parse({
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 1024,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: responseFormat,
    });

    const message = completion.choices[0]?.message;

    // Safety refusal — mirror the Anthropic provider by throwing LlmRefusalError.
    if (message?.refusal) {
      throw new LlmRefusalError(message.refusal);
    }

    // Empty / unparseable structured output (e.g. length-truncated) is an error,
    // just like a missing tool_use block on the Anthropic path.
    const parsed = message?.parsed;
    if (parsed == null) {
      const reason = completion.choices[0]?.finish_reason ?? "unknown";
      throw new Error(`expected a parsed ${req.schemaName} object, got finish_reason=${reason}`);
    }

    // Re-validate at the boundary so the return type is identical to every other provider.
    const value = req.schema.parse(parsed);
    const usage = completion.usage;
    return {
      value,
      refusal: false,
      usage: usage
        ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        : undefined,
    };
  }
}
