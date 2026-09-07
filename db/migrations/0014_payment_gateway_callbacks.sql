BEGIN;

-- R6 Secure Payment Gateway Integration: durable, replay-safe callback inbox.
-- This migration is repository-delivered only. Applying it to a live database is a separate production gate.

CREATE TABLE IF NOT EXISTS finance.payment_gateway_callbacks (
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
  payment_id uuid REFERENCES finance.payments(payment_id),
  payload_digest_sha256 char(64) NOT NULL,
  failure_code varchar(80),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_gateway_callbacks_provider_event_uq UNIQUE(provider, provider_event_id),
  CONSTRAINT payment_gateway_callbacks_amount_ck CHECK (amount_minor >= 0),
  CONSTRAINT payment_gateway_callbacks_currency_ck CHECK (currency = upper(currency)),
  CONSTRAINT payment_gateway_callbacks_event_type_ck CHECK (
    event_type IN ('PAYMENT_SUCCEEDED','PAYMENT_FAILED')
  ),
  CONSTRAINT payment_gateway_callbacks_status_ck CHECK (
    processing_status IN ('RECEIVED','PROCESSING','APPLIED','IGNORED','REJECTED')
  ),
  CONSTRAINT payment_gateway_callbacks_digest_ck CHECK (
    payload_digest_sha256 ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS payment_gateway_callbacks_payment_reference_idx
  ON finance.payment_gateway_callbacks(payment_reference, received_at DESC);

CREATE INDEX IF NOT EXISTS payment_gateway_callbacks_payment_id_idx
  ON finance.payment_gateway_callbacks(payment_id, received_at DESC)
  WHERE payment_id IS NOT NULL;

REVOKE DELETE ON finance.payment_gateway_callbacks FROM PUBLIC;

COMMIT;
