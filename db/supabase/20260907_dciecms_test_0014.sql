BEGIN;

-- Isolated Supabase test-profile translation of logical migration 0014.
-- This operates only on dciecms_test and does not touch public/auth/storage or live DCIECMS schemas.

CREATE TABLE IF NOT EXISTS dciecms_test.finance_payment_gateway_callbacks (
  callback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(80) NOT NULL,
  provider_event_id varchar(180) NOT NULL,
  event_type varchar(40) NOT NULL,
  payment_reference varchar(120) NOT NULL,
  provider_payment_reference varchar(180) NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  occurred_at timestamptz NOT NULL,
  processing_status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  outcome_code varchar(80),
  payment_id uuid REFERENCES dciecms_test.finance_payments(payment_id),
  payload_digest_sha256 char(64) NOT NULL,
  failure_code varchar(80),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_payment_gateway_callbacks_provider_event_uq UNIQUE(provider, provider_event_id),
  CONSTRAINT finance_payment_gateway_callbacks_amount_ck CHECK (amount_minor >= 0),
  CONSTRAINT finance_payment_gateway_callbacks_currency_ck CHECK (currency = upper(currency)),
  CONSTRAINT finance_payment_gateway_callbacks_event_type_ck CHECK (
    event_type IN ('PAYMENT_SUCCEEDED','PAYMENT_FAILED')
  ),
  CONSTRAINT finance_payment_gateway_callbacks_status_ck CHECK (
    processing_status IN ('RECEIVED','PROCESSING','APPLIED','IGNORED','REJECTED')
  ),
  CONSTRAINT finance_payment_gateway_callbacks_digest_ck CHECK (
    payload_digest_sha256 ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS finance_payment_gateway_callbacks_reference_idx
  ON dciecms_test.finance_payment_gateway_callbacks(payment_reference, received_at DESC);

CREATE INDEX IF NOT EXISTS finance_payment_gateway_callbacks_payment_id_idx
  ON dciecms_test.finance_payment_gateway_callbacks(payment_id, received_at DESC)
  WHERE payment_id IS NOT NULL;

REVOKE DELETE ON dciecms_test.finance_payment_gateway_callbacks FROM PUBLIC;

COMMIT;
