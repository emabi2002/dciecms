BEGIN;

CREATE TABLE IF NOT EXISTS finance.receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number varchar(80) NOT NULL UNIQUE,
  payment_id uuid NOT NULL UNIQUE REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'ISSUED',
  issued_by_subject varchar(255) NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_status_ck CHECK (status IN ('ISSUED','VOID'))
);

CREATE TABLE IF NOT EXISTS finance.reconciliations (
  reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  status varchar(30) NOT NULL DEFAULT 'PREPARED',
  prepared_by_subject varchar(255) NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  certified_by_subject varchar(255),
  certified_at timestamptz,
  CONSTRAINT reconciliation_status_ck CHECK (status IN ('PREPARED','CERTIFIED','REJECTED')),
  CONSTRAINT reconciliation_maker_checker_ck CHECK (certified_by_subject IS NULL OR certified_by_subject <> prepared_by_subject)
);

CREATE INDEX IF NOT EXISTS finance_reconciliation_court_status_idx
  ON finance.reconciliations(court_id, status, prepared_at);

COMMIT;
