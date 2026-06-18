import type { LlmProvider, StructuredRequest, StructuredResult } from "./provider.js";

/**
 * Deterministic mock provider for tests and offline eval. The responder receives
 * the request and returns a raw value, which is validated against the request's
 * Zod schema exactly like a real provider — so tests exercise the validation
 * boundary without any network call or nondeterminism.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = "mock";

  constructor(private readonly responder: (req: StructuredRequest<unknown>) => unknown) {}

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const raw = this.responder(req as StructuredRequest<unknown>);
    const value = req.schema.parse(raw);
    return { value, refusal: false };
  }
}
