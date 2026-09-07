BEGIN;

-- Payment Integration Hardening: provider-neutral payment binding and verified event inbox.
-- Repository-delivered only. Applying this migration to a live database is a separate production gate.

ALTER TABLE finance.payments
  ADD COLUMN IF NOT EXISTS provider_code varchar(64),
  ADD COLUMN IF NOT EXISTS provider_payment_reference varchar(255),
  ADD COLUMN IF NOT EXISTS provider_status varchar(60),
  ADD COLUMN IF NOT EXISTS session_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_code varchar(80),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

ALTER TABLE finance.payments
  ADD CONSTRAINT payment_provider_binding_pair_ck CHECK (
    (provider_code IS NULL AND provider_payment_reference IS NULL)
    OR (provider_code IS NOT NULL AND provider_payment_reference IS NOT NULL)
  ),
  ADD CONSTRAINT payment_provider_code_ck CHECK (
    provider_code IS NULL OR provider_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  );

CREATE OR REPLACE FUNCTION finance.enforce_payment_provider_binding_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.provider_code IS NOT NULL AND NEW.provider_code IS DISTINCT FROM OLD.provider_code)
     OR (OLD.provider_payment_reference IS NOT NULL AND NEW.provider_payment_reference IS DISTINCT FROM OLD.provider_payment_reference)
  THEN
    RAISE EXCEPTION 'Payment provider binding is immutable once established'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_provider_binding_immutable_trg ON finance.payments;
CREATE TRIGGER payment_provider_binding_immutable_trg
BEFORE UPDATE ON finance.payments
FOR EACH ROW
EXECUTE FUNCTION finance.enforce_payment_provider_binding_immutability();

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_uq
  ON finance.payments(provider_code, provider_payment_reference)
  WHERE provider_code IS NOT NULL AND provider_payment_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_provider_reference_idx
  ON finance.payments(provider_code, provider_payment_reference)
  WHERE provider_code IS NOT NULL AND provider_payment_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance.payment_provider_events (
  payment_provider_event_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(64) NOT NULL,
  provider_event_id varchar(255) NOT NULL,
  provider_payment_reference varchar(255) NOT NULL,
  payment_id uuid,
  normalized_event_type varchar(40) NOT NULL,
  amount_minor bigint,
  currency char(3),
  processing_status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  result_code varchar(80),
  received_at timestamptz NOT NULL DEFAULT now(),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_events_identity_uq UNIQUE(provider_code, provider_event_id),
  CONSTRAINT payment_provider_events_provider_code_ck CHECK (
    provider_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT payment_provider_events_type_ck CHECK (
    normalized_event_type IN (
      'PAYMENT_SUCCEEDED',
      'PAYMENT_FAILED',
      'PAYMENT_CANCELLED',
      'PAYMENT_REFUNDED',
      'PAYMENT_REVERSED'
    )
  ),
  CONSTRAINT payment_provider_events_status_ck CHECK (
    processing_status IN ('RECEIVED','PROCESSING','PROCESSED','REJECTED','DEAD_LETTER')
  ),
  CONSTRAINT payment_provider_events_amount_ck CHECK (
    amount_minor IS NULL OR amount_minor > 0
  ),
  CONSTRAINT payment_provider_events_currency_ck CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT payment_provider_events_attempt_count_ck CHECK (attempt_count >= 0),
  CONSTRAINT payment_provider_events_max_attempts_ck CHECK (max_attempts >= 1)
);

CREATE INDEX IF NOT EXISTS payment_provider_events_due_idx
  ON finance.payment_provider_events(processing_status, next_attempt_at, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS payment_provider_events_payment_idx
  ON finance.payment_provider_events(payment_id, provider_code, provider_payment_reference);

REVOKE DELETE ON finance.payment_provider_events FROM PUBLIC;

COMMIT;
