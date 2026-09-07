BEGIN;

CREATE TABLE IF NOT EXISTS finance.fee_schedules (
  fee_schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid REFERENCES config.courts(court_id),
  case_type_code varchar(40) NOT NULL,
  fee_code varchar(80) NOT NULL,
  description varchar(255) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'PGK',
  effective_from date NOT NULL,
  effective_to date,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_by_subject varchar(255),
  activated_at timestamptz,
  retired_by_subject varchar(255),
  retired_at timestamptz,
  CONSTRAINT fee_schedule_status_ck CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  CONSTRAINT fee_schedule_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT fee_schedule_effective_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS finance_fee_schedule_lookup_idx
  ON finance.fee_schedules(court_id,case_type_code,fee_code,status,effective_from,effective_to);

ALTER TABLE finance.fee_assessments
  ADD COLUMN IF NOT EXISTS fee_schedule_id uuid REFERENCES finance.fee_schedules(fee_schedule_id);

CREATE TABLE IF NOT EXISTS finance.payment_adjustments (
  adjustment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES finance.fee_assessments(assessment_id),
  payment_id uuid REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  adjustment_type varchar(30) NOT NULL,
  original_amount_minor bigint NOT NULL CHECK (original_amount_minor >= 0),
  amount_delta_minor bigint NOT NULL CHECK (amount_delta_minor <> 0),
  resulting_amount_minor bigint NOT NULL CHECK (resulting_amount_minor >= 0),
  currency char(3) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'REQUESTED',
  reason text NOT NULL,
  requested_by_subject varchar(255) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_subject varchar(255),
  decided_at timestamptz,
  decision_reason text,
  applied_at timestamptz,
  CONSTRAINT payment_adjustment_type_ck CHECK (adjustment_type IN ('WAIVER','EXEMPTION','CORRECTION','OTHER_ADJUSTMENT')),
  CONSTRAINT payment_adjustment_status_ck CHECK (status IN ('REQUESTED','APPROVED','REJECTED','APPLIED','CANCELLED')),
  CONSTRAINT payment_adjustment_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_adjustment_maker_checker_ck CHECK (decided_by_subject IS NULL OR decided_by_subject <> requested_by_subject)
);

CREATE INDEX IF NOT EXISTS finance_adjustment_assessment_status_idx
  ON finance.payment_adjustments(assessment_id,status,requested_at);
CREATE INDEX IF NOT EXISTS finance_adjustment_payment_status_idx
  ON finance.payment_adjustments(payment_id,status,requested_at)
  WHERE payment_id IS NOT NULL;

ALTER TABLE finance.payments
  ADD COLUMN IF NOT EXISTS refunded_amount_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_amount_minor >= 0);

CREATE TABLE IF NOT EXISTS finance.refund_requests (
  refund_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  reason text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'REQUESTED',
  requested_by_subject varchar(255) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by_subject varchar(255),
  decided_at timestamptz,
  decision_reason text,
  provider_refund_reference varchar(200),
  completed_by_subject varchar(255),
  completed_at timestamptz,
  CONSTRAINT refund_request_status_ck CHECK (status IN ('REQUESTED','APPROVED','REJECTED','COMPLETED','CANCELLED')),
  CONSTRAINT refund_request_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT refund_request_maker_checker_ck CHECK (decided_by_subject IS NULL OR decided_by_subject <> requested_by_subject),
  CONSTRAINT refund_request_completion_ck CHECK (
    (status='COMPLETED' AND provider_refund_reference IS NOT NULL AND completed_by_subject IS NOT NULL AND completed_at IS NOT NULL)
    OR status <> 'COMPLETED'
  )
);

CREATE INDEX IF NOT EXISTS finance_refund_payment_status_idx
  ON finance.refund_requests(payment_id,status,requested_at);
CREATE INDEX IF NOT EXISTS finance_refund_court_status_idx
  ON finance.refund_requests(court_id,status,requested_at);

ALTER TABLE finance.reconciliations
  ADD COLUMN IF NOT EXISTS exception_code varchar(60),
  ADD COLUMN IF NOT EXISTS exception_note text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_by_subject varchar(255),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

CREATE INDEX IF NOT EXISTS finance_reconciliation_exception_idx
  ON finance.reconciliations(court_id,status,prepared_at)
  WHERE status='REJECTED' OR exception_code IS NOT NULL;

CREATE OR REPLACE FUNCTION finance.prevent_issued_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status='ISSUED' THEN
    RAISE EXCEPTION 'Issued receipt evidence is immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS finance_receipt_issued_immutable_trg ON finance.receipts;
CREATE TRIGGER finance_receipt_issued_immutable_trg
BEFORE UPDATE OR DELETE ON finance.receipts
FOR EACH ROW EXECUTE FUNCTION finance.prevent_issued_receipt_mutation();

CREATE OR REPLACE FUNCTION finance.prevent_finalized_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('CERTIFIED','REJECTED') THEN
    RAISE EXCEPTION 'Finalized reconciliation evidence is immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS finance_reconciliation_finalized_immutable_trg ON finance.reconciliations;
CREATE TRIGGER finance_reconciliation_finalized_immutable_trg
BEFORE UPDATE OR DELETE ON finance.reconciliations
FOR EACH ROW EXECUTE FUNCTION finance.prevent_finalized_reconciliation_mutation();

REVOKE DELETE ON finance.fee_schedules FROM PUBLIC;
REVOKE DELETE ON finance.payment_adjustments FROM PUBLIC;
REVOKE DELETE ON finance.refund_requests FROM PUBLIC;
REVOKE DELETE ON finance.receipts FROM PUBLIC;
REVOKE DELETE ON finance.reconciliations FROM PUBLIC;

COMMIT;
