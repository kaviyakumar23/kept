import { readFile } from "node:fs/promises";
import type { Obligation } from "../domain/obligation.js";

/**
 * Secondary beat (spec E2): a commitment whose due date conflicts with the
 * approved roadmap should produce a PRIVATE warning to the internal owner —
 * never the customer. This is a pure contradiction check; surfacing it is an
 * internal-only notification (audience = INTERNAL).
 *
 * The roadmap is the team's source of truth for when work can realistically land
 * (e.g. a per-(customer, subject) committed/target date). If the obligation's due
 * date is earlier than the roadmap target, the promise contradicts the plan.
 */
export interface RoadmapEntry {
  customer: string;
  subject_canonical: string;
  /** ISO date the team can realistically deliver by, per the approved roadmap. */
  targetDate: string;
}

export interface RoadmapWarning {
  conflict: boolean;
  obligationId: string;
  due: string | null;
  roadmapTarget: string | null;
  /** Internal-only message for the owner — never customer-facing. */
  message: string;
  audience: "INTERNAL";
}

const norm = (s: string): string => s.trim().toUpperCase();

export function findRoadmapEntry(obligation: Obligation, roadmap: RoadmapEntry[]): RoadmapEntry | null {
  return (
    roadmap.find(
      (r) => norm(r.customer) === norm(obligation.customer) && norm(r.subject_canonical) === norm(obligation.subject_canonical),
    ) ?? null
  );
}

/**
 * Returns a private warning iff the obligation's due date is earlier than the
 * roadmap target for the same (customer, subject). No conflict → conflict:false.
 */
export function checkRoadmapConflict(obligation: Obligation, roadmap: RoadmapEntry[]): RoadmapWarning {
  const entry = findRoadmapEntry(obligation, roadmap);
  const base = { obligationId: obligation.id, due: obligation.due, audience: "INTERNAL" as const };

  if (!entry || !obligation.due) {
    return { ...base, conflict: false, roadmapTarget: entry?.targetDate ?? null, message: "" };
  }

  const dueMs = Date.parse(obligation.due);
  const targetMs = Date.parse(entry.targetDate);
  const conflict = !Number.isNaN(dueMs) && !Number.isNaN(targetMs) && dueMs < targetMs;

  return {
    ...base,
    conflict,
    roadmapTarget: entry.targetDate,
    message: conflict
      ? `Heads up: the committed date (${obligation.due}) for "${obligation.outcome}" is earlier than the roadmap target (${entry.targetDate}). Confirm before promising the customer.`
      : "",
  };
}

/**
 * A pluggable source for the approved roadmap. Implementations: static (config),
 * file-backed (JSON), or Postgres-backed (integrations/roadmapPostgres.ts).
 *
 * W1 / invariant #4 — `list(teamId)` is tenant-scoped: the caller passes the acting
 * workspace so a multi-tenant source (Postgres) returns only that team's targets. The
 * single-tenant sources (static config, JSON file) hold one team's roadmap and ignore it.
 */
export interface RoadmapSource {
  list(teamId?: string): Promise<RoadmapEntry[]>;
}

export class StaticRoadmapSource implements RoadmapSource {
  constructor(private readonly entries: RoadmapEntry[]) {}
  async list(_teamId?: string): Promise<RoadmapEntry[]> {
    return this.entries;
  }
}

function isRoadmapEntry(e: unknown): e is RoadmapEntry {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as RoadmapEntry).customer === "string" &&
    typeof (e as RoadmapEntry).subject_canonical === "string" &&
    typeof (e as RoadmapEntry).targetDate === "string"
  );
}

/** Reads the roadmap from a JSON file: an array of {customer, subject_canonical, targetDate}. */
export class FileRoadmapSource implements RoadmapSource {
  constructor(private readonly path: string) {}
  async list(_teamId?: string): Promise<RoadmapEntry[]> {
    const raw = await readFile(this.path, "utf8");
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(isRoadmapEntry) : [];
  }
}
