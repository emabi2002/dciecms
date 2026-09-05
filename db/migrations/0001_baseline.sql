BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS config;
CREATE SCHEMA IF NOT EXISTS iam;
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS case_mgmt;
CREATE SCHEMA IF NOT EXISTS documents;
CREATE SCHEMA IF NOT EXISTS workflow;

CREATE TABLE IF NOT EXISTS config.courts (
  court_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_code varchar(30) NOT NULL UNIQUE,
  court_name varchar(200) NOT NULL,
  court_type varchar(50) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam.users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_provider_subject varchar(255) UNIQUE,
  username varchar(150) UNIQUE,
  email varchar(254),
  user_type varchar(30) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam.roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code varchar(40) NOT NULL UNIQUE,
  role_name varchar(120) NOT NULL,
  is_privileged boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS iam.permissions (
  permission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code varchar(120) NOT NULL UNIQUE,
  resource_type varchar(80) NOT NULL,
  action varchar(80) NOT NULL,
  risk_level varchar(20) NOT NULL DEFAULT 'NORMAL'
);

CREATE TABLE IF NOT EXISTS iam.user_role_assignments (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES iam.users(user_id),
  role_id uuid NOT NULL REFERENCES iam.roles(role_id),
  court_id uuid REFERENCES config.courts(court_id),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE',
  assigned_by uuid REFERENCES iam.users(user_id),
  approval_reference varchar(120),
  UNIQUE (user_id, role_id, court_id, effective_from)
);

CREATE TABLE IF NOT EXISTS case_mgmt.parties (
  party_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  party_type varchar(20) NOT NULL,
  display_name varchar(220) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry.filings (
  filing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_reference varchar(80) NOT NULL UNIQUE,
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  case_type_code varchar(40) NOT NULL,
  filer_party_id uuid NOT NULL REFERENCES case_mgmt.parties(party_id),
  status varchar(40) NOT NULL DEFAULT 'DRAFT',
  created_by uuid REFERENCES iam.users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CONSTRAINT filing_status_ck CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','RETURNED','VALIDATED','REJECTED','ACCEPTED'))
);

CREATE TABLE IF NOT EXISTS documents.documents (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES registry.filings(filing_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  file_name varchar(255) NOT NULL,
  mime_type varchar(120) NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  checksum_sha256 char(64) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'QUARANTINED',
  classification varchar(30) NOT NULL DEFAULT 'CONFIDENTIAL',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_checksum_ck CHECK (checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT document_status_ck CHECK (status IN ('QUARANTINED','ACTIVE','ARCHIVED','SUPERSEDED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS audit.audit_events (
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

CREATE INDEX IF NOT EXISTS filings_court_status_idx ON registry.filings(court_id, status);
CREATE INDEX IF NOT EXISTS documents_filing_idx ON documents.documents(filing_id);
CREATE INDEX IF NOT EXISTS audit_resource_idx ON audit.audit_events(resource_type, resource_id, event_time);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit.audit_events(actor_user_id, event_time);

REVOKE UPDATE, DELETE ON audit.audit_events FROM PUBLIC;

COMMIT;
