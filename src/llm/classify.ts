import type { LlmProvider } from "./provider.js";
import { ClassificationSchema, type Classification } from "./schemas.js";

const CLASSIFY_SYSTEM = `You are Kept, an obligation-tracking agent for shared customer Slack channels.
Classify a single message into exactly one typed obligation SIGNAL. Be precise — these are NOT equivalent:
- CUSTOMER_REQUEST: the customer asks for something; no commitment from the team yet.
- INTERNAL_ACKNOWLEDGEMENT: a teammate says "I'll check" / "let me look" — NOT a promise.
- TENTATIVE_COMMITMENT: "we should be able to do Friday" — hedged.
- CONFIRMED_COMMITMENT: "yes, we'll have it fixed by Friday" — firm promise.
- SCOPE_CHANGE: changes the date/scope of an existing obligation.
- FULFILLMENT_SIGNAL: a deploy / "Done" / release indicating work may be complete.
- CUSTOMER_CONFIRMATION: the customer says it works.
- CANCELLATION: the request/commitment is withdrawn.
- NON_ACTIONABLE: smalltalk, thanks, unrelated.
direction = TEAM_OWES_CUSTOMER for asks/promises the team must fulfill; CUSTOMER_OWES_TEAM if the customer is the one who must act.
Return calibrated confidence. Do not quote the message back.`;

export async function classifyMessage(
  provider: LlmProvider,
  input: { messageText: string; threadContext?: string },
): Promise<Classification> {
  const user = [
    input.threadContext ? `Thread context:\n${input.threadContext}\n` : "",
    `Message to classify:\n${input.messageText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { value } = await provider.generateStructured({
    system: CLASSIFY_SYSTEM,
    user,
    schema: ClassificationSchema,
    schemaName: "classify_obligation_signal",
    schemaDescription: "Classify the message into a typed obligation signal with direction and confidence.",
  });
  return value;
}
