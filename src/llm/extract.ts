import type { LlmProvider } from "./provider.js";
import { ExtractionSchema, type Extraction } from "./schemas.js";

const EXTRACT_SYSTEM = `You are Kept, extracting structured obligation fields from a shared customer Slack message.
Output only DERIVED, normalized fields — never copy the raw message text.
- customer: the customer/account name.
- subject_canonical: a stable UPPER_SNAKE_CASE key for the underlying problem so the same issue
  ("SSO bug", "login issue", "SAML failure") always maps to the same key, e.g. SSO_LOGIN_BUG.
- outcome: a short normalized description of what is owed, e.g. "SSO login fix".
- due: an ISO date (YYYY-MM-DD) if a deadline is stated or clearly implied, else null. Resolve
  relative dates (e.g. "Friday") against the provided current date.
- owner: a suggested internal owner's Slack user id if identifiable, else null.
- conditions: any caveats/prerequisites stated (e.g. "if QA passes").
Return calibrated confidence.`;

export async function extractObligation(
  provider: LlmProvider,
  input: { messageText: string; threadContext?: string; currentDate?: string },
): Promise<Extraction> {
  const user = [
    input.currentDate ? `Current date: ${input.currentDate}` : "",
    input.threadContext ? `Thread context:\n${input.threadContext}\n` : "",
    `Message:\n${input.messageText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await provider.generateStructured({
    system: EXTRACT_SYSTEM,
    user,
    schema: ExtractionSchema,
    schemaName: "extract_obligation_fields",
    schemaDescription: "Extract normalized, derived obligation fields (no raw message text).",
  });
  return value;
}
