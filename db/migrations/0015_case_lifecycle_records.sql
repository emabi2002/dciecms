BEGIN;

-- Case lifecycle and records governance.
-- Additive repository migration only: applying it to a live database is a separate gate.

ALTER TABLE case_mgmt.cases
  ADD COLUMN IF NOT EXISTS disposition_code varchar(80),
  ADD COLUMN IF NOT EXISTS disposed_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS disposed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closure_code varchar(80),
  ADD COLUMN IF NOT EXISTS closed_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz;

ALTER TABLE case_mgmt.cases
  DROP CONSTRAINT IF EXISTS case_status_ck;

ALTER TABLE case_mgmt.cases
  ADD CONSTRAINT case_status_ck CHECK (
    status IN ('AWAITING_ASSIGNMENT','ASSIGNED','HEARING_SCHEDULED','DISPOSED','CLOSED')
  );

CREATE TABLE IF NOT EXISTS case_mgmt.case_lifecycle_events (
  lifecycle_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  event_type varchar(30) NOT NULL,
  event_code varchar(80),
  reason text NOT NULL,
  judgment_id uuid REFERENCES judicial.judgments(judgment_id),
  actor_subject varchar(255) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_lifecycle_event_type_ck CHECK (event_type IN ('DISPOSED','CLOSED','REOPENED'))
);

CREATE INDEX IF NOT EXISTS case_lifecycle_events_case_idx
  ON case_mgmt.case_lifecycle_events(case_id, occurred_at, lifecycle_event_id);

CREATE SCHEMA IF NOT EXISTS records;

CREATE TABLE IF NOT EXISTS records.case_record_controls (
  case_record_control_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  status varchar(30) NOT NULL DEFAULT 'ACTIVE',
  retention_class_code varchar(80),
  retention_trigger_at timestamptz,
  disposition_eligible_at timestamptz,
  archived_at timestamptz,
  archived_by_subject varchar(255),
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reference varchar(160),
  legal_hold_reason text,
  legal_hold_set_at timestamptz,
  legal_hold_set_by_subject varchar(255),
  legal_hold_released_at timestamptz,
  legal_hold_released_by_subject varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_record_status_ck CHECK (
    status IN ('ACTIVE','ARCHIVED','DISPOSAL_REQUESTED','DISPOSAL_APPROVED')
  ),
  CONSTRAINT case_record_retention_dates_ck CHECK (
    disposition_eligible_at IS NULL OR retention_trigger_at IS NULL OR disposition_eligible_at >= retention_trigger_at
  ),
  CONSTRAINT case_record_legal_hold_reference_ck CHECK (
    legal_hold = false OR legal_hold_reference IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS case_record_controls_retention_idx
  ON records.case_record_controls(legal_hold, disposition_eligible_at, status)
  WHERE disposition_eligible_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS records.disposal_requests (
  disposal_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_record_control_id uuid NOT NULL REFERENCES records.case_record_controls(case_record_control_id),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  status varchar(30) NOT NULL DEFAULT 'REQUESTED',
  reason text NOT NULL,
  requested_by_subject varchar(255) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_subject varchar(255),
  decided_at timestamptz,
  decision_reason text,
  CONSTRAINT disposal_request_status_ck CHECK (
    status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED')
  ),
  CONSTRAINT disposal_request_decision_ck CHECK (
    (status = 'REQUESTED' AND decided_by_subject IS NULL AND decided_at IS NULL)
    OR
    (status <> 'REQUESTED' AND decided_by_subject IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS disposal_requests_one_active_uq
  ON records.disposal_requests(case_record_control_id)
  WHERE status='REQUESTED';

CREATE INDEX IF NOT EXISTS disposal_requests_case_idx
  ON records.disposal_requests(case_id, requested_at, disposal_request_id);

-- Court record evidence is never physically deleted through ordinary database roles.
REVOKE UPDATE ON case_mgmt.case_lifecycle_events FROM PUBLIC;
REVOKE DELETE ON case_mgmt.case_lifecycle_events FROM PUBLIC;
REVOKE DELETE ON records.case_record_controls FROM PUBLIC;
REVOKE DELETE ON records.disposal_requests FROM PUBLIC;

COMMIT;
