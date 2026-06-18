import { z } from "zod";

/**
 * C1 — classification output. The model emits a typed signal + direction, never a
 * binary is/isn't-a-request.
 */
export const ClassificationSchema = z.object({
  signal: z.enum([
    "CUSTOMER_REQUEST",
    "INTERNAL_ACKNOWLEDGEMENT",
    "TENTATIVE_COMMITMENT",
    "CONFIRMED_COMMITMENT",
    "SCOPE_CHANGE",
    "FULFILLMENT_SIGNAL",
    "CUSTOMER_CONFIRMATION",
    "CANCELLATION",
    "NON_ACTIONABLE",
  ]),
  direction: z.enum(["TEAM_OWES_CUSTOMER", "CUSTOMER_OWES_TEAM"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * Structured extraction of obligation fields. These DERIVED fields are what the
 * durable log persists (zero-copy) — never the raw message.
 */
export const ExtractionSchema = z.object({
  customer: z.string(),
  /** Canonical subject for entity resolution, e.g. "SSO_LOGIN_BUG". */
  subject_canonical: z.string(),
  /** Normalized outcome, e.g. "SSO login fix". */
  outcome: z.string(),
  /** ISO date (YYYY-MM-DD) or null if none stated. */
  due: z.string().nullable(),
  /** Suggested internal owner (Slack user id) or null. */
  owner: z.string().nullable(),
  conditions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
