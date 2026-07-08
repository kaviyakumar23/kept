import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

/**
 * Hermetic tests for the OpenAI provider + selection precedence. The OpenAI SDK is
 * mocked at the module boundary — NO real network. We assert that a canned Structured
 * Outputs response is parsed/validated into the correct object (same return shape as
 * every other provider), that refusals/empty output throw, and that provider selection
 * follows OPENAI_API_KEY → ANTHROPIC_API_KEY → mock (with KEPT_LLM_PROVIDER override).
 */

// Hoisted mock of the official `openai` SDK's default export.
const parseMock = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    beta = { chat: { completions: { parse: parseMock } } };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts?: unknown) {}
  },
}));

import { OpenAiProvider } from "../src/llm/openai.js";
import { LlmRefusalError } from "../src/llm/anthropic.js";
import { selectLlm } from "../src/llm/select.js";
import { loadConfig } from "../src/config.js";

const sampleSchema = z.object({ label: z.string(), score: z.number() });

function cannedCompletion(message: unknown, finishReason = "stop") {
  return {
    choices: [{ finish_reason: finishReason, message }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  };
}

describe("OpenAiProvider.generateStructured", () => {
  beforeEach(() => parseMock.mockReset());

  it("parses a canned structured response into the validated object", async () => {
    parseMock.mockResolvedValue(
      cannedCompletion({ refusal: null, parsed: { label: "SSO_LOGIN_BUG", score: 0.92 } }),
    );

    const provider = new OpenAiProvider({ apiKey: "test-key", model: "gpt-4o" });
    const res = await provider.generateStructured({
      system: "system prompt",
      user: "user message",
      schema: sampleSchema,
      schemaName: "sample_schema",
      schemaDescription: "a sample schema",
    });

    expect(provider.name).toBe("openai");
    expect(res.value).toEqual({ label: "SSO_LOGIN_BUG", score: 0.92 });
    expect(res.refusal).toBe(false);
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });

    // Sent the right model, both messages, and a Structured-Outputs response_format.
    const args = parseMock.mock.calls[0][0] as any;
    expect(args.model).toBe("gpt-4o");
    expect(args.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user message" },
    ]);
    expect(args.response_format.json_schema.name).toBe("sample_schema");
  });

  it("re-validates against the Zod schema (rejects a bad canned value)", async () => {
    parseMock.mockResolvedValue(
      cannedCompletion({ refusal: null, parsed: { label: "x", score: "not-a-number" } }),
    );
    const provider = new OpenAiProvider({ apiKey: "test-key" });
    await expect(
      provider.generateStructured({
        system: "s",
        user: "u",
        schema: sampleSchema,
        schemaName: "sample_schema",
        schemaDescription: "d",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("throws LlmRefusalError on a safety refusal", async () => {
    parseMock.mockResolvedValue(
      cannedCompletion({ refusal: "I can't help with that.", parsed: null }),
    );
    const provider = new OpenAiProvider({ apiKey: "test-key" });
    await expect(
      provider.generateStructured({
        system: "s",
        user: "u",
        schema: sampleSchema,
        schemaName: "sample_schema",
        schemaDescription: "d",
      }),
    ).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("throws on empty/unparseable output (e.g. length-truncated)", async () => {
    parseMock.mockResolvedValue(
      cannedCompletion({ refusal: null, parsed: null }, "length"),
    );
    const provider = new OpenAiProvider({ apiKey: "test-key" });
    await expect(
      provider.generateStructured({
        system: "s",
        user: "u",
        schema: sampleSchema,
        schemaName: "sample_schema",
        schemaDescription: "d",
      }),
    ).rejects.toThrow(/length/);
  });
});

describe("selectLlm precedence", () => {
  const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "KEPT_LLM_PROVIDER", "OPENAI_MODEL", "KEPT_LLM_MODEL"] as const;
  const saved: Record<string, string | undefined> = {};
  const noop = () => ({});

  beforeEach(() => {
    for (const k of LLM_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of LLM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses OpenAI when OPENAI_API_KEY is set (even if ANTHROPIC_API_KEY is also set)", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    const { provider, label } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("openai");
    expect(label).toBe("openai(gpt-4o)");
  });

  it("uses a custom OPENAI_MODEL in the label", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.OPENAI_MODEL = "gpt-4o-mini";
    const { provider, label } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("openai");
    expect(label).toBe("openai(gpt-4o-mini)");
  });

  it("falls back to Anthropic when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    const { provider, label } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("anthropic");
    expect(label).toBe("anthropic(claude-opus-4-8)");
  });

  it("falls back to the mock when no key is set", () => {
    const { provider, label } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("mock");
    expect(label).toBe("mock");
  });

  it("KEPT_LLM_PROVIDER forces Anthropic even when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.KEPT_LLM_PROVIDER = "anthropic";
    const { provider } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("anthropic");
  });

  it("KEPT_LLM_PROVIDER=mock forces the mock even when keys are present", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.KEPT_LLM_PROVIDER = "mock";
    const { provider } = selectLlm(loadConfig(), noop);
    expect(provider.name).toBe("mock");
  });
});
