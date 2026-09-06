BEGIN;

ALTER TABLE case_mgmt.cases
  ADD COLUMN IF NOT EXISTS assigned_to_subject varchar(255),
  ADD COLUMN IF NOT EXISTS assigned_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

CREATE INDEX IF NOT EXISTS cases_assigned_subject_idx
  ON case_mgmt.cases(court_id, assigned_to_subject, status, assigned_at)
  WHERE assigned_to_subject IS NOT NULL;

COMMIT;
