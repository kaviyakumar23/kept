import type { Obligation } from "../domain/obligation.js";
import type { Direction } from "../domain/signals.js";
import { TERMINAL_STATES } from "../domain/state.js";

/**
 * C4 / C6 — Entity resolution & semantic dedupe.
 *
 * A new message ("any update on that login issue?") or webhook (PROJ-118 → Done)
 * should ATTACH to the existing obligation rather than create a new one. We match
 * first on exact cross-system refs, then on (customer + canonical subject).
 */
export interface ResolutionCandidate {
  customer: string;
  subject_canonical: string;
  /** When set, semantic dedupe only merges obligations of the same direction. */
  direction?: Direction;
  refs?: {
    linear?: string;
    jira?: string;
    github?: string;
    release?: string;
  };
}

const norm = (s: string): string => s.trim().toUpperCase();

export function resolve(candidate: ResolutionCandidate, existing: Obligation[]): Obligation | null {
  // 1. Exact cross-system ref match (strongest).
  if (candidate.refs) {
    for (const o of existing) {
      const r = o.entity_refs;
      if (candidate.refs.linear && r.linear === candidate.refs.linear) return o;
      if (candidate.refs.jira && r.jira === candidate.refs.jira) return o;
      if (candidate.refs.github && r.github === candidate.refs.github) return o;
      if (candidate.refs.release && r.release === candidate.refs.release) return o;
    }
  }

  // 2. Semantic match: same customer + same canonical subject (+ same direction), still open.
  for (const o of existing) {
    if (
      norm(o.customer) === norm(candidate.customer) &&
      norm(o.subject_canonical) === norm(candidate.subject_canonical) &&
      (candidate.direction === undefined || o.direction === candidate.direction) &&
      !TERMINAL_STATES.has(o.state)
    ) {
      return o;
    }
  }

  return null;
}
