import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./provider.js";

export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`LLM refused the request (category: ${category ?? "unknown"})`);
    this.name = "LlmRefusalError";
  }
}

/**
 * Anthropic Claude provider. Structured output is obtained via FORCED tool use
 * (works across SDK versions and is the most portable structured-output path):
 * a single tool whose input_schema is the Zod schema, with tool_choice pinned to
 * it. The tool's input is then validated by Zod at this boundary.
 *
 * Default model: claude-opus-4-8 (override via KEPT_LLM_MODEL). The model only
 * ever classifies / extracts / drafts — it never decides a transition.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.KEPT_LLM_MODEL ?? "claude-opus-4-8";
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const jsonSchema = zodToJsonSchema(req.schema, { $refStrategy: "none" }) as Record<string, unknown>;
    delete jsonSchema.$schema;

    const response = await this.client.messages.create({
      model: req.model ?? this.model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: req.schemaName,
          description: req.schemaDescription,
          // SDK input-schema typing differs across versions; the JSON Schema is correct.
          input_schema: jsonSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: req.schemaName },
    });

    if ((response.stop_reason as string) === "refusal") {
      const details = (response as { stop_details?: { category?: string } }).stop_details;
      throw new LlmRefusalError(details?.category ?? null);
    }

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error(`expected a tool_use block for ${req.schemaName}, got ${response.stop_reason}`);
    }

    const value = req.schema.parse(block.input);
    return {
      value,
      refusal: false,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
