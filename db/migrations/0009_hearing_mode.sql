BEGIN;

ALTER TABLE judicial.hearings
  ADD COLUMN IF NOT EXISTS started_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_code varchar(60);

CREATE TABLE IF NOT EXISTS judicial.hearing_appearances (
  appearance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES judicial.hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  participant_name varchar(220) NOT NULL,
  participant_role varchar(60) NOT NULL,
  appearance_mode varchar(40) NOT NULL,
  recorded_by_subject varchar(255) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS judicial.proceeding_records (
  proceeding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES judicial.hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  note text,
  record_reference varchar(255),
  recorded_by_subject varchar(255) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proceeding_content_ck CHECK (note IS NOT NULL OR record_reference IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS hearing_appearances_hearing_idx ON judicial.hearing_appearances(hearing_id, recorded_at);
CREATE INDEX IF NOT EXISTS proceeding_records_hearing_idx ON judicial.proceeding_records(hearing_id, recorded_at);

REVOKE UPDATE, DELETE ON judicial.hearing_appearances FROM PUBLIC;
REVOKE UPDATE, DELETE ON judicial.proceeding_records FROM PUBLIC;

COMMIT;
