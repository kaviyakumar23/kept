-- Kept event store (production substrate).
-- Append-only. The obligation projection is derived in application code (projection.ts).
-- Zero-copy (correction #3): payload holds derived, human-confirmed structured fields
-- and refs/permalinks only — never raw Slack message bodies. Enforced in code before insert.

CREATE TABLE IF NOT EXISTS obligation_events (
  seq             BIGSERIAL PRIMARY KEY,
  obligation_id   TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  -- Idempotency (C6): the safety net that makes duplicate Slack events / webhooks
  -- a no-op at the storage layer.
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obligation_events_obligation
  ON obligation_events (obligation_id, seq);

-- Approved roadmap (system of record for the contradiction check). A committed due
-- date earlier than target_date raises a private warning at Gate 1.
CREATE TABLE IF NOT EXISTS roadmap (
  customer          TEXT NOT NULL,
  subject_canonical TEXT NOT NULL,
  target_date       DATE NOT NULL,
  PRIMARY KEY (customer, subject_canonical)
);
