BEGIN;

CREATE SCHEMA IF NOT EXISTS finance;

CREATE TABLE IF NOT EXISTS finance.fee_assessments (
  assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES registry.filings(filing_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'PGK',
  status varchar(30) NOT NULL DEFAULT 'ASSESSED',
  assessed_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_assessment_status_ck CHECK (status IN ('ASSESSED','VOID','PAID'))
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_one_active_assessment_per_filing_idx
  ON finance.fee_assessments(filing_id)
  WHERE status = 'ASSESSED';

CREATE TABLE IF NOT EXISTS finance.payments (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES finance.fee_assessments(assessment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  provider_reference varchar(160),
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by_subject varchar(255),
  CONSTRAINT payment_status_ck CHECK (status IN ('PENDING','CONFIRMED','FAILED','CANCELLED','REFUNDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_provider_reference_uq
  ON finance.payments(provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_payments_court_status_idx
  ON finance.payments(court_id, status, created_at);

COMMIT;
