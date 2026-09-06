BEGIN;

-- Secure Document Pipeline: additive document lifecycle, immutable object evidence,
-- retention controls and a dedicated durable malware scan queue.
-- This migration is repository-delivered only; applying it to a live database is a separate gate.

ALTER TABLE documents.documents
  ALTER COLUMN checksum_sha256 DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS storage_object_key text,
  ADD COLUMN IF NOT EXISTS version_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prior_document_id uuid REFERENCES documents.documents(document_id),
  ADD COLUMN IF NOT EXISTS superseded_by_document_id uuid REFERENCES documents.documents(document_id),
  ADD COLUMN IF NOT EXISTS expected_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS detected_mime_type varchar(120),
  ADD COLUMN IF NOT EXISTS created_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS file_policy_result varchar(30) NOT NULL DEFAULT 'NOT_CHECKED',
  ADD COLUMN IF NOT EXISTS file_policy_code varchar(80),
  ADD COLUMN IF NOT EXISTS scan_status varchar(30) NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN IF NOT EXISTS scan_result varchar(30),
  ADD COLUMN IF NOT EXISTS scanner_engine varchar(120),
  ADD COLUMN IF NOT EXISTS scanner_version varchar(120),
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawn_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS withdrawal_reason text,
  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legal_hold_reference varchar(160),
  ADD COLUMN IF NOT EXISTS disposition_eligible_at timestamptz;

ALTER TABLE documents.documents
  DROP CONSTRAINT IF EXISTS document_status_ck;

ALTER TABLE documents.documents
  ADD CONSTRAINT document_status_ck CHECK (
    status IN ('UPLOAD_PENDING','QUARANTINED','ACTIVE','REJECTED','ARCHIVED','SUPERSEDED','WITHDRAWN')
  );

ALTER TABLE documents.documents
  ADD CONSTRAINT document_version_number_ck CHECK (version_number >= 1),
  ADD CONSTRAINT document_expected_size_ck CHECK (expected_size_bytes IS NULL OR expected_size_bytes > 0),
  ADD CONSTRAINT document_file_policy_result_ck CHECK (file_policy_result IN ('NOT_CHECKED','PASSED','REJECTED')),
  ADD CONSTRAINT document_scan_status_ck CHECK (
    scan_status IN ('NOT_REQUESTED','PENDING','SCANNING','CLEAN','INFECTED','FAILED','DEAD_LETTER')
  ),
  ADD CONSTRAINT document_scan_result_ck CHECK (
    scan_result IS NULL OR scan_result IN ('CLEAN','INFECTED','UNSUPPORTED','ERROR_RETRYABLE','ERROR_PERMANENT')
  ),
  ADD CONSTRAINT document_prior_not_self_ck CHECK (
    prior_document_id IS NULL OR prior_document_id <> document_id
  ),
  ADD CONSTRAINT document_superseded_not_self_ck CHECK (
    superseded_by_document_id IS NULL OR superseded_by_document_id <> document_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS documents_storage_object_key_uq
  ON documents.documents(storage_object_key)
  WHERE storage_object_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_prior_document_idx
  ON documents.documents(prior_document_id)
  WHERE prior_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_retention_idx
  ON documents.documents(legal_hold, disposition_eligible_at)
  WHERE disposition_eligible_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS documents.scan_jobs (
  scan_job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents.documents(document_id),
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  scanner_engine varchar(120),
  scanner_version varchar(120),
  result_code varchar(80),
  last_error_code varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT document_scan_jobs_document_uq UNIQUE(document_id),
  CONSTRAINT document_scan_jobs_status_ck CHECK (
    status IN ('PENDING','LEASED','SUCCEEDED','FAILED_RETRYABLE','DEAD_LETTER')
  ),
  CONSTRAINT document_scan_jobs_attempt_count_ck CHECK (attempt_count >= 0),
  CONSTRAINT document_scan_jobs_max_attempts_ck CHECK (max_attempts >= 1)
);

CREATE INDEX IF NOT EXISTS scan_jobs_due_idx
  ON documents.scan_jobs(status, next_attempt_at, lease_expires_at, created_at);

REVOKE DELETE ON documents.documents FROM PUBLIC;
REVOKE DELETE ON documents.scan_jobs FROM PUBLIC;

COMMIT;
