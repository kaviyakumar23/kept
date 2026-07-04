-- Kept event store (production substrate).
-- Append-only. The obligation projection is derived in application code (projection.ts).
-- Zero-copy (correction #3): payload holds derived, human-confirmed structured fields
-- and refs/permalinks only — never raw Slack message bodies. Enforced in code before insert.

CREATE TABLE IF NOT EXISTS obligation_events (
  seq             BIGSERIAL PRIMARY KEY,
  obligation_id   TEXT NOT NULL,
  -- W1 (invariant #4): tenant partition key — the owning Slack workspace. Every read
  -- is scoped by team_id; a cross-tenant read is a P0 bug. Carried on every row so the
  -- partition holds for future per-tenant queries/exports/deletes, not just the head.
  team_id         TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  -- Idempotency (C6): the safety net that makes duplicate Slack events / webhooks
  -- a no-op at the storage layer.
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obligation_events_obligation
  ON obligation_events (obligation_id, seq);

-- W1 — the tenant choke point: getAllObligationIds(teamId) filters on team_id.
CREATE INDEX IF NOT EXISTS idx_obligation_events_team
  ON obligation_events (team_id, obligation_id);

-- Approved roadmap (system of record for the contradiction check). A committed due
-- date earlier than target_date raises a private warning at Gate 1.
-- W1 — roadmap is also tenant-partitioned by team_id. NOTE: the read path
-- (PostgresRoadmapSource.list) is not yet team-scoped — TODO(W2): per-tenant roadmap.
CREATE TABLE IF NOT EXISTS roadmap (
  team_id           TEXT NOT NULL,
  customer          TEXT NOT NULL,
  subject_canonical TEXT NOT NULL,
  target_date       DATE NOT NULL,
  PRIMARY KEY (team_id, customer, subject_canonical)
);

-- W2 (invariant #6): multi-workspace OAuth installs. One row per installed workspace
-- (id = team.id) or org (id = enterprise.id), holding the normalized installation JSON
-- returned by Slack — including the per-tenant bot token used to authorize each event.
-- This is NOT an obligation event log; it legitimately stores OAuth secrets and is not
-- subject to the zero-copy guard.
CREATE TABLE IF NOT EXISTS slack_installations (
  id            TEXT PRIMARY KEY,
  team_id       TEXT,
  enterprise_id TEXT,
  installation  JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slack_installations_team ON slack_installations (team_id);

-- W2: reminder queue for the PostgresScheduler (so the hosted path needs no Redis).
-- Pending AT_RISK / OVERDUE jobs; the poll loop claims due rows atomically
-- (UPDATE ... RETURNING) so multiple instances never double-fire. Deterministic id
-- (`${obligation_id}:${kind}`) makes re-scheduling replace rather than duplicate.
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL,
  kind          TEXT NOT NULL,
  fire_at       TIMESTAMPTZ NOT NULL,
  fired_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (fire_at) WHERE fired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_obligation ON reminders (obligation_id);
