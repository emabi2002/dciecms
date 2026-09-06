BEGIN;

-- DCIECMS Supabase test-environment translation of repository migrations 0001-0010.
-- All DCIECMS application objects are physically isolated inside dciecms_test.
-- Existing NJSS objects in public/auth/storage are intentionally untouched.

CREATE SCHEMA IF NOT EXISTS dciecms_test;

REVOKE ALL ON SCHEMA dciecms_test FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS dciecms_test.migration_source_manifest (
  source_file text PRIMARY KEY,
  source_sha char(40) NOT NULL,
  source_branch text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.config_courts (
  court_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_code varchar(30) NOT NULL UNIQUE,
  court_name varchar(200) NOT NULL,
  court_type varchar(50) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.iam_users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider_subject varchar(255) UNIQUE,
  username varchar(150) UNIQUE,
  email varchar(254),
  user_type varchar(30) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.iam_roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code varchar(40) NOT NULL UNIQUE,
  role_name varchar(120) NOT NULL,
  is_privileged boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS dciecms_test.iam_permissions (
  permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code varchar(120) NOT NULL UNIQUE,
  resource_type varchar(80) NOT NULL,
  action varchar(80) NOT NULL,
  risk_level varchar(20) NOT NULL DEFAULT 'NORMAL'
);

CREATE TABLE IF NOT EXISTS dciecms_test.iam_user_role_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES dciecms_test.iam_users(user_id),
  role_id uuid NOT NULL REFERENCES dciecms_test.iam_roles(role_id),
  court_id uuid REFERENCES dciecms_test.config_courts(court_id),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  assigned_by uuid REFERENCES dciecms_test.iam_users(user_id),
  approval_reference varchar(120),
  UNIQUE (user_id, role_id, court_id, effective_from)
);

CREATE TABLE IF NOT EXISTS dciecms_test.case_parties (
  party_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  party_type varchar(20) NOT NULL,
  display_name varchar(220) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.registry_filings (
  filing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_reference varchar(80) NOT NULL UNIQUE,
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  case_type_code varchar(40) NOT NULL,
  filer_party_id uuid NOT NULL REFERENCES dciecms_test.case_parties(party_id),
  status varchar(40) NOT NULL DEFAULT 'DRAFT',
  created_by uuid REFERENCES dciecms_test.iam_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  validated_at timestamptz,
  validated_by_subject varchar(255),
  decision_reason text,
  decision_by_subject varchar(255),
  decision_at timestamptz,
  CONSTRAINT registry_filings_status_ck CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','RETURNED','VALIDATED','REJECTED','ACCEPTED'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.documents (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES dciecms_test.registry_filings(filing_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  file_name varchar(255) NOT NULL,
  mime_type varchar(120) NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  checksum_sha256 char(64) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'QUARANTINED',
  classification varchar(30) NOT NULL DEFAULT 'CONFIDENTIAL',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_checksum_ck CHECK (checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT documents_status_ck CHECK (status IN ('QUARANTINED','ACTIVE','ARCHIVED','SUPERSEDED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_time timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  effective_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  action varchar(120) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id text,
  court_id uuid,
  correlation_id varchar(120),
  reason text,
  approval_reference varchar(120),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS dciecms_test.config_case_types (
  case_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type_code varchar(40) NOT NULL UNIQUE,
  case_type_name varchar(160) NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  effective_from date,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_case_types_effective_dates_ck CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

INSERT INTO dciecms_test.config_case_types (case_type_code, case_type_name)
VALUES
  ('CIVIL', 'Civil'),
  ('CRIMINAL', 'Criminal'),
  ('TRAFFIC', 'Traffic'),
  ('FAMILY', 'Family'),
  ('JUVENILE', 'Juvenile'),
  ('ADMINISTRATIVE', 'Administrative')
ON CONFLICT (case_type_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS dciecms_test.workflow_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES dciecms_test.registry_filings(filing_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  task_type varchar(80) NOT NULL,
  assigned_role_code varchar(40) NOT NULL,
  priority varchar(20) NOT NULL DEFAULT 'NORMAL',
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by_subject varchar(255),
  CONSTRAINT workflow_tasks_status_ck CHECK (status IN ('PENDING','ASSIGNED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED','ESCALATED','OVERDUE'))
);

COMMENT ON COLUMN dciecms_test.workflow_tasks.task_type IS 'Business task code; R0/R1 begins with REGISTRY_VALIDATE_FILING.';

CREATE TABLE IF NOT EXISTS dciecms_test.finance_fee_assessments (
  assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES dciecms_test.registry_filings(filing_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'PGK',
  status varchar(30) NOT NULL DEFAULT 'ASSESSED',
  assessed_by_subject varchar(255) NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_fee_assessments_status_ck CHECK (status IN ('ASSESSED','VOID','PAID'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.finance_payments (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES dciecms_test.finance_fee_assessments(assessment_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  provider_reference varchar(160),
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by_subject varchar(255),
  CONSTRAINT finance_payments_status_ck CHECK (status IN ('PENDING','CONFIRMED','FAILED','CANCELLED','REFUNDED'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.finance_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number varchar(80) NOT NULL UNIQUE,
  payment_id uuid NOT NULL UNIQUE REFERENCES dciecms_test.finance_payments(payment_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'ISSUED',
  issued_by_subject varchar(255) NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_receipts_status_ck CHECK (status IN ('ISSUED','VOID'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.finance_reconciliations (
  reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES dciecms_test.finance_payments(payment_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  status varchar(30) NOT NULL DEFAULT 'PREPARED',
  prepared_by_subject varchar(255) NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  certified_by_subject varchar(255),
  certified_at timestamptz,
  CONSTRAINT finance_reconciliations_status_ck CHECK (status IN ('PREPARED','CERTIFIED','REJECTED')),
  CONSTRAINT finance_reconciliations_maker_checker_ck CHECK (certified_by_subject IS NULL OR certified_by_subject <> prepared_by_subject)
);

CREATE TABLE IF NOT EXISTS dciecms_test.case_number_sequences (
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  case_type_code varchar(40) NOT NULL,
  case_year integer NOT NULL CHECK (case_year >= 2000),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (court_id, case_type_code, case_year)
);

CREATE TABLE IF NOT EXISTS dciecms_test.cases (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number varchar(120) NOT NULL UNIQUE,
  filing_id uuid NOT NULL UNIQUE REFERENCES dciecms_test.registry_filings(filing_id),
  payment_id uuid NOT NULL REFERENCES dciecms_test.finance_payments(payment_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  case_type_code varchar(40) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'AWAITING_ASSIGNMENT',
  opened_by_subject varchar(255) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  assigned_to_subject varchar(255),
  assigned_by_subject varchar(255),
  assigned_at timestamptz,
  CONSTRAINT cases_status_ck CHECK (status IN ('AWAITING_ASSIGNMENT','ASSIGNED','HEARING_SCHEDULED','CLOSED'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.judicial_hearings (
  hearing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES dciecms_test.cases(case_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
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
  started_by_subject varchar(255),
  started_at timestamptz,
  completed_by_subject varchar(255),
  completed_at timestamptz,
  outcome_code varchar(60),
  CONSTRAINT judicial_hearings_schedule_ck CHECK (scheduled_end > scheduled_start),
  CONSTRAINT judicial_hearings_status_ck CHECK (status IN ('SCHEDULED','IN_PROGRESS','COMPLETED','ADJOURNED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS dciecms_test.judicial_hearing_adjournments (
  adjournment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES dciecms_test.judicial_hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES dciecms_test.cases(case_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  prior_scheduled_start timestamptz NOT NULL,
  prior_scheduled_end timestamptz NOT NULL,
  reason text NOT NULL,
  next_hearing_id uuid,
  next_scheduled_start timestamptz,
  next_scheduled_end timestamptz,
  adjourned_by_subject varchar(255) NOT NULL,
  adjourned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.judicial_hearing_appearances (
  appearance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES dciecms_test.judicial_hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES dciecms_test.cases(case_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  participant_name varchar(220) NOT NULL,
  participant_role varchar(60) NOT NULL,
  appearance_mode varchar(40) NOT NULL,
  recorded_by_subject varchar(255) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dciecms_test.judicial_proceeding_records (
  proceeding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hearing_id uuid NOT NULL REFERENCES dciecms_test.judicial_hearings(hearing_id),
  case_id uuid NOT NULL REFERENCES dciecms_test.cases(case_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  note text,
  record_reference varchar(255),
  recorded_by_subject varchar(255) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT judicial_proceeding_records_content_ck CHECK (note IS NOT NULL OR record_reference IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS dciecms_test.judicial_judgments (
  judgment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES dciecms_test.cases(case_id),
  hearing_id uuid NOT NULL REFERENCES dciecms_test.judicial_hearings(hearing_id),
  court_id uuid NOT NULL REFERENCES dciecms_test.config_courts(court_id),
  decision_type varchar(40) NOT NULL,
  title varchar(300) NOT NULL,
  content text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by_subject varchar(255),
  updated_at timestamptz,
  reviewed_by_subject varchar(255),
  reviewed_at timestamptz,
  signed_by_subject varchar(255),
  signed_at timestamptz,
  issued_by_subject varchar(255),
  issued_at timestamptz,
  CONSTRAINT judicial_judgments_status_ck CHECK (status IN ('DRAFT','FINAL','SIGNED','ISSUED'))
);

CREATE INDEX IF NOT EXISTS registry_filings_court_status_idx ON dciecms_test.registry_filings(court_id, status);
CREATE INDEX IF NOT EXISTS documents_filing_idx ON dciecms_test.documents(filing_id);
CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON dciecms_test.audit_events(resource_type, resource_id, event_time);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON dciecms_test.audit_events(actor_user_id, event_time);
CREATE INDEX IF NOT EXISTS registry_filings_decision_status_idx ON dciecms_test.registry_filings(court_id, status, decision_at);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_active_registry_validation_task_idx
  ON dciecms_test.workflow_tasks(filing_id, task_type)
  WHERE task_type = 'REGISTRY_VALIDATE_FILING'
    AND status IN ('PENDING','ASSIGNED','IN_PROGRESS','BLOCKED','ESCALATED','OVERDUE');
CREATE INDEX IF NOT EXISTS workflow_tasks_court_status_idx ON dciecms_test.workflow_tasks(court_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS finance_one_active_assessment_per_filing_idx ON dciecms_test.finance_fee_assessments(filing_id) WHERE status = 'ASSESSED';
CREATE UNIQUE INDEX IF NOT EXISTS finance_provider_reference_uq ON dciecms_test.finance_payments(provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_payments_court_status_idx ON dciecms_test.finance_payments(court_id, status, created_at);
CREATE INDEX IF NOT EXISTS finance_reconciliation_court_status_idx ON dciecms_test.finance_reconciliations(court_id, status, prepared_at);
CREATE INDEX IF NOT EXISTS cases_court_status_idx ON dciecms_test.cases(court_id, status, opened_at);
CREATE INDEX IF NOT EXISTS cases_assigned_subject_idx ON dciecms_test.cases(court_id, assigned_to_subject, status, assigned_at) WHERE assigned_to_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS judicial_hearings_court_start_idx ON dciecms_test.judicial_hearings(court_id, scheduled_start);
CREATE INDEX IF NOT EXISTS judicial_hearings_case_idx ON dciecms_test.judicial_hearings(case_id, scheduled_start);
CREATE INDEX IF NOT EXISTS judicial_hearing_adjournments_hearing_idx ON dciecms_test.judicial_hearing_adjournments(hearing_id, adjourned_at);
CREATE INDEX IF NOT EXISTS judicial_hearing_appearances_hearing_idx ON dciecms_test.judicial_hearing_appearances(hearing_id, recorded_at);
CREATE INDEX IF NOT EXISTS judicial_proceeding_records_hearing_idx ON dciecms_test.judicial_proceeding_records(hearing_id, recorded_at);
CREATE INDEX IF NOT EXISTS judicial_judgments_case_idx ON dciecms_test.judicial_judgments(case_id, created_at);
CREATE INDEX IF NOT EXISTS judicial_judgments_hearing_idx ON dciecms_test.judicial_judgments(hearing_id, created_at);

CREATE OR REPLACE FUNCTION dciecms_test.enforce_judgment_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, dciecms_test
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Judgments cannot be deleted';
  END IF;

  IF OLD.status IN ('FINAL','SIGNED','ISSUED') AND
     (NEW.title IS DISTINCT FROM OLD.title OR
      NEW.content IS DISTINCT FROM OLD.content OR
      NEW.decision_type IS DISTINCT FROM OLD.decision_type OR
      NEW.case_id IS DISTINCT FROM OLD.case_id OR
      NEW.hearing_id IS DISTINCT FROM OLD.hearing_id OR
      NEW.court_id IS DISTINCT FROM OLD.court_id) THEN
    RAISE EXCEPTION 'Finalized judgment content is immutable';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT','FINAL') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'FINAL' AND NEW.status NOT IN ('FINAL','SIGNED') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'SIGNED' AND NEW.status NOT IN ('SIGNED','ISSUED') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'ISSUED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Issued judgment is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS judicial_judgments_immutability_trg ON dciecms_test.judicial_judgments;
CREATE TRIGGER judicial_judgments_immutability_trg
BEFORE UPDATE OR DELETE ON dciecms_test.judicial_judgments
FOR EACH ROW EXECUTE FUNCTION dciecms_test.enforce_judgment_immutability();

INSERT INTO dciecms_test.migration_source_manifest (source_file, source_sha, source_branch)
VALUES
  ('db/migrations/0001_baseline.sql', '018f6aba1cd6cc341b4b7303fff953a56b24f3d0', 'feat/r2-judicial-operations'),
  ('db/migrations/0002_config_workflow.sql', '5003596713e2a4afa3131a1fecbe3404a15ecfef', 'feat/r2-judicial-operations'),
  ('db/migrations/0003_registry_decisions.sql', '6927caf44bb0f2d606ffcaae27e1d2034f27af98', 'feat/r2-judicial-operations'),
  ('db/migrations/0004_finance.sql', '68c8c04e7a0209325fbcc226c760a0d4ee78b52a', 'feat/r2-judicial-operations'),
  ('db/migrations/0005_finance_controls.sql', 'e9c10bc638f2269081fb60b7ca61c8686d25f6bf', 'feat/r2-judicial-operations'),
  ('db/migrations/0006_case_opening.sql', '956d40dfd5cf0431ac291ae0b7990867d77e60f1', 'feat/r2-judicial-operations'),
  ('db/migrations/0007_judicial_assignment.sql', 'b902768a90df452277798ece078d7481be61d514', 'feat/r2-judicial-operations'),
  ('db/migrations/0008_hearings.sql', 'd11fd22945cce09171a76a1b8cc24a923a851771', 'feat/r2-judicial-operations'),
  ('db/migrations/0009_hearing_mode.sql', '6bda8798921e302af0e5be82df19d6d3acc8304e', 'feat/r2-judicial-operations'),
  ('db/migrations/0010_judgments.sql', 'a7620bffe61de059f56ea7982db531aad603b31f', 'feat/r2-judicial-operations')
ON CONFLICT (source_file) DO UPDATE
SET source_sha = EXCLUDED.source_sha,
    source_branch = EXCLUDED.source_branch,
    recorded_at = now();

REVOKE ALL ON ALL TABLES IN SCHEMA dciecms_test FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dciecms_test FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dciecms_test FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA dciecms_test REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA dciecms_test REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA dciecms_test REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

COMMIT;
