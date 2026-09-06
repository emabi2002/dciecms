BEGIN;

CREATE SCHEMA IF NOT EXISTS judicial;

CREATE TABLE IF NOT EXISTS judicial.hearings (
  hearing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  hearing_type varchar(40) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'SCHEDULED',
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  courtroom varchar(120),
  scheduled_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  adjourned_by_subject varchar(255),
  adjourned_at timestamptz,
  adjournment_reason text,
  CONSTRAINT hearing_schedule_ck CHECK (scheduled_end > scheduled_start),
  CONSTRAINT hearing_status_ck CHECK (status IN ('SCHEDULED','IN_PROGRESS','COMPLETED','ADJOURNED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS judicial.hearing_adjournments (
  adjournment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES judicial.hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  prior_scheduled_start timestamptz NOT NULL,
  prior_scheduled_end timestamptz NOT NULL,
  reason text NOT NULL,
  next_hearing_id uuid,
  next_scheduled_start timestamptz,
  next_scheduled_end timestamptz,
  adjourned_by_subject varchar(255) NOT NULL,
  adjourned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hearings_court_start_idx ON judicial.hearings(court_id, scheduled_start);
CREATE INDEX IF NOT EXISTS hearings_case_idx ON judicial.hearings(case_id, scheduled_start);
CREATE INDEX IF NOT EXISTS hearing_adjournments_hearing_idx ON judicial.hearing_adjournments(hearing_id, adjourned_at);

REVOKE UPDATE, DELETE ON judicial.hearing_adjournments FROM PUBLIC;

COMMIT;
