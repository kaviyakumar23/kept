import type { ObligationEvent } from "./events.js";
import { GuardViolation } from "./errors.js";

/**
 * Correction #3 — Zero-copy boundary enforced by construction.
 *
 * The event store may persist human-confirmed, *derived* structured fields
 * (customer, normalized outcome, owner, due date) and Slack object IDs /
 * permalinks. It must NOT persist raw Slack message bodies, quotations, RTS
 * retrieval results, prompts, or model responses.
 *
 * This guard scans an event for field names that would indicate raw content
 * leaked into the durable log, and rejects it before it is appended.
 */
const FORBIDDEN_KEYS = [
  "message_text",
  "message_body",
  "body",
  "text_body",
  "raw",
  "raw_text",
  "transcript",
  "quote",
  "quotation",
  "prompt",
  "completion",
  "model_response",
  "rts_result",
  "retrieved_text",
  "blocks", // Slack message blocks
];

function scan(value: unknown, path: string, hits: string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${path}[${i}]`, hits));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      hits.push(`${path}.${key}`);
    }
    scan(v, `${path}.${key}`, hits);
  }
}

/** Catch-all: a string value this long is almost certainly a pasted raw body, not a derived field. */
const MAX_VALUE_LEN = 1000;
/**
 * ALL Unicode line terminators — LF, CR, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
 * SEPARATOR, U+0085 NEL, VT (U+000B), FF (U+000C). A line break in a persisted
 * field is a strong signal of a pasted raw body; `/\r\n/` alone misses the rest.
 */
const RAW_LINE_BREAKS = new RegExp("[\\r\\n\\u2028\\u2029\\u0085\\u000B\\u000C]");
/** Field-aware caps for the derived fields that should be short identifiers / summaries. */
const FIELD_CAPS: Record<string, number> = { customer: 160, subject_canonical: 160, outcome: 400 };

/**
 * Value-channel scan (complements the name scan): a raw message body can be stuffed
 * into a *legitimately-named* field (outcome, subject_canonical, customer). We reject
 * values that are implausibly long or that contain newlines in the short derived
 * fields — both strong signals of raw content rather than a normalized field.
 */
function scanValues(value: unknown, path: string, key: string | null, hits: string[]): void {
  if (typeof value === "string") {
    if (value.length > MAX_VALUE_LEN) hits.push(`${path} (oversized ${value.length} chars)`);
    // Persisted strings are normalized single-line fields / engine-generated reasons —
    // a line break of ANY kind is a strong signal of a pasted raw body. Applied globally.
    if (RAW_LINE_BREAKS.test(value)) hits.push(`${path} (line break in persisted field)`);
    if (key && key in FIELD_CAPS && value.length > FIELD_CAPS[key]) {
      hits.push(`${path} (field over cap ${FIELD_CAPS[key]})`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValues(v, `${path}[${i}]`, null, hits));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    scanValues(v, `${path}.${k}`, k, hits);
  }
}

/** Returns the list of forbidden field paths / suspicious values found (empty == clean). */
export function findRawContent(event: ObligationEvent): string[] {
  const hits: string[] = [];
  scan(event, event.type, hits);
  scanValues(event, event.type, null, hits);
  return hits;
}

/** Throws GuardViolation if the event would persist raw content. */
export function assertNoRawContent(event: ObligationEvent): void {
  const hits = findRawContent(event);
  if (hits.length > 0) {
    throw new GuardViolation(
      `zero-copy violation: raw content fields present at ${hits.join(", ")}`,
      "RAW_CONTENT_PERSISTED",
    );
  }
}
