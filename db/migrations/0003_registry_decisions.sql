BEGIN;

ALTER TABLE registry.filings
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS decision_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS decision_at timestamptz;

ALTER TABLE registry.filings
  DROP CONSTRAINT IF EXISTS filing_status_ck;

ALTER TABLE registry.filings
  ADD CONSTRAINT filing_status_ck CHECK (
    status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','RETURNED','VALIDATED','REJECTED','ACCEPTED')
  );

CREATE INDEX IF NOT EXISTS filings_decision_status_idx
  ON registry.filings(court_id, status, decision_at);

COMMIT;
