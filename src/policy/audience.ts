import type { Evidence, EvidenceSource } from "../domain/evidence.js";
import { INTERNAL_ONLY_SOURCES } from "../domain/evidence.js";
import type { Obligation } from "../domain/obligation.js";

/**
 * D1 — Permission-safe outputs (audience policy).
 *
 * Internal evidence may inform what an internal user decides to say, but must
 * never leak into the shared customer channel. This layer is the explicit gate:
 * a customer-facing draft is built ONLY from approved, shareable facts. Leak
 * safety is additionally enforced on the command path (decide() rejects a leaky
 * NOTIFY_CUSTOMER draft), so "no internal detail reaches the channel" is
 * by-construction, not advisory.
 *
 * Note (defense-in-depth, not DLP): detectLeaks catches accidental leaks and the
 * common obfuscations (zero-width chars, Unicode dashes, casing, dotted/spaced
 * refs). A determined insider can still spell a ref out in prose; the mandatory
 * human approval before send is the real backstop for that case.
 */
export type Audience = "INTERNAL" | "SHARED_CUSTOMER_CHANNEL";

export interface SafeOutput {
  audience: Audience;
  shareableFacts: string[];
  redactedSources: EvidenceSource[];
  redactedCount: number;
}

/** Patterns that must never appear in a customer-facing message. */
const LEAK_PATTERNS: RegExp[] = [
  /\b[A-Za-z]{2,}-?\d{2,}\b/, // PROJ-118 / PROJ118 / proj-118 (ticket keys, any case, optional hyphen)
  /\bPR\s*#?\d+\b/i, // PR #449
  /\bp[.\s]*r[.\s]*#?\s*\d+/i, // P.R. #449 / P R 449 (dotted/spaced)
  /\blinear\b/i,
  /\bjira\b/i,
  /\bgithub\b/i,
  /\bmerged?\b/i,
  /\bdeploy(ed|ment)?\b/i,
  /\bcrm\b/i,
  /\broadmap\b/i,
  /\bsecurity\b/i,
  /\bvulnerab/i,
  /\binternal\b/i,
];

// U+200B..U+200D zero-width space/joiners, U+FEFF BOM, U+00AD soft hyphen.
const OBFUSCATION_CHARS = new RegExp("[\\u200B-\\u200D\\uFEFF\\u00AD]", "g");
// U+2010..U+2015 hyphen/dashes, U+2212 minus, U+FE58/U+FE63 small/fullwidth, U+FF0D fullwidth hyphen.
const UNICODE_DASHES = new RegExp("[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]", "g");

/** Strip obfuscation chars, fold Unicode dashes to ASCII '-', and NFKC-normalize. */
function normalizeForLeakScan(text: string): string {
  return text.normalize("NFKC").replace(OBFUSCATION_CHARS, "").replace(UNICODE_DASHES, "-");
}

/** Returns the leak patterns a string trips (empty == safe for the customer). */
export function detectLeaks(text: string): string[] {
  const normalized = normalizeForLeakScan(text);
  return LEAK_PATTERNS.filter((p) => p.test(normalized)).map((p) => p.source);
}

/**
 * Filter evidence to what a given audience may see, and surface shareable facts.
 *  - RTS permission parity (D3): evidence the acting user could not access is dropped first.
 *  - For the shared customer channel, internal-only sources (Linear/Jira/GitHub/CRM)
 *    are dropped, and any remaining fact that trips the leak detector is withheld.
 */
export function sanitizeForAudience(evidence: Evidence[], audience: Audience): SafeOutput {
  // Permission parity: never surface evidence the acting user wasn't allowed to see.
  const accessible = evidence.filter((e) => e.accessible_to_user !== false);

  if (audience === "INTERNAL") {
    return {
      audience,
      shareableFacts: accessible.map((e) => `${e.source}: ${e.proves}`),
      redactedSources: [],
      redactedCount: 0,
    };
  }

  const redacted = accessible.filter((e) => INTERNAL_ONLY_SOURCES.has(e.source));
  const shareable = accessible.filter((e) => !INTERNAL_ONLY_SOURCES.has(e.source));

  return {
    audience,
    shareableFacts: shareable
      .map((e) => e.proves)
      .filter((fact) => detectLeaks(fact).length === 0),
    redactedSources: [...new Set(redacted.map((e) => e.source))],
    redactedCount: redacted.length,
  };
}

export interface ClosureDraft {
  text: string;
  safe: SafeOutput;
  /** True if the generated draft is clean for the customer channel. */
  clean: boolean;
}

/**
 * Build the customer-facing closure draft posted back in the ORIGINAL thread.
 * It references only the (shareable) promise and asks the customer to confirm —
 * the proof that the promise was kept, with zero internal detail. The draft text
 * is leak-scanned here, and re-checked on the NOTIFY_CUSTOMER command path; a
 * human still approves the send (Gate 2 cluster).
 */
export function buildClosureDraft(obligation: Obligation): ClosureDraft {
  const safe = sanitizeForAudience(obligation.evidence, "SHARED_CUSTOMER_CHANNEL");
  // Built from the normalized, shareable outcome only — never from internal evidence.
  const text =
    `Hi — the ${obligation.outcome} is now available on your side. ` +
    `Could you confirm it's working as expected so we can close this out?`;
  return { text, safe, clean: detectLeaks(text).length === 0 };
}
