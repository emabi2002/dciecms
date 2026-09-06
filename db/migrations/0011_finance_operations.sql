BEGIN;

CREATE TABLE IF NOT EXISTS finance.payment_exceptions (
  exception_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  reason_code varchar(50) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by_subject varchar(255),
  resolved_at timestamptz,
  resolution_note text,
  CONSTRAINT payment_exception_reason_ck CHECK (reason_code IN ('DUPLICATE_PROVIDER_REFERENCE','AMOUNT_MISMATCH','CURRENCY_MISMATCH')),
  CONSTRAINT payment_exception_status_ck CHECK (status IN ('OPEN','RESOLVED')),
  CONSTRAINT payment_exception_resolution_evidence_ck CHECK (
    (status='OPEN' AND resolved_by_subject IS NULL AND resolved_at IS NULL AND resolution_note IS NULL)
    OR
    (status='RESOLVED' AND resolved_by_subject IS NOT NULL AND resolved_at IS NOT NULL AND length(btrim(resolution_note)) > 0)
  ),
  CONSTRAINT payment_exception_maker_checker_ck CHECK (resolved_by_subject IS NULL OR resolved_by_subject <> created_by_subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_one_open_exception_reason_per_payment_idx
  ON finance.payment_exceptions(payment_id, reason_code)
  WHERE status='OPEN';

CREATE INDEX IF NOT EXISTS finance_payment_exceptions_court_status_idx
  ON finance.payment_exceptions(court_id, status, created_at);

REVOKE DELETE ON finance.payment_exceptions FROM PUBLIC;

COMMIT;
