import type { z } from "zod";

/**
 * Provider-agnostic structured-generation interface.
 *
 * The LLM is used for classification, extraction, and drafting ONLY — never to
 * decide a transition (that's the deterministic engine). Every call is forced to
 * return data matching a Zod schema, validated at this boundary so callers always
 * receive typed, validated values.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Tool / schema name surfaced to the model (snake_case). */
  schemaName: string;
  schemaDescription: string;
  model?: string;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  /** True if the model declined for safety reasons (value will be a fallback). */
  refusal: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly name: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
