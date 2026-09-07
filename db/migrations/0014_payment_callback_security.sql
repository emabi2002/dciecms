BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;

ALTER TABLE finance.payments
  ADD COLUMN IF NOT EXISTS provider_code varchar(64);

ALTER TABLE finance.payments
  DROP CONSTRAINT IF EXISTS finance_payments_provider_code_ck;

ALTER TABLE finance.payments
  ADD CONSTRAINT finance_payments_provider_code_ck CHECK (
    provider_code IS NULL OR provider_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  );

CREATE INDEX IF NOT EXISTS finance_payments_provider_code_idx
  ON finance.payments(provider_code, status, created_at)
  WHERE provider_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration.payment_callback_events (
  callback_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(64) NOT NULL,
  provider_event_id varchar(180) NOT NULL,
  payment_id uuid NOT NULL REFERENCES finance.payments(payment_id),
  body_sha256 char(64) NOT NULL,
  provider_reference varchar(160) NOT NULL,
  event_status varchar(30) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  CONSTRAINT payment_callback_provider_code_ck CHECK (
    provider_code ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  CONSTRAINT payment_callback_body_sha_ck CHECK (
    body_sha256 ~ '^[A-Fa-f0-9]{64}$'
  ),
  CONSTRAINT payment_callback_event_status_ck CHECK (event_status = 'CONFIRMED'),
  CONSTRAINT payment_callback_processing_status_ck CHECK (processing_status IN ('RECEIVED','PROCESSED')),
  CONSTRAINT payment_callback_provider_event_uq UNIQUE (provider_code, provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_callback_events_payment_received_idx
  ON integration.payment_callback_events(payment_id, received_at);

CREATE INDEX IF NOT EXISTS payment_callback_events_processing_received_idx
  ON integration.payment_callback_events(processing_status, received_at);

REVOKE DELETE ON integration.payment_callback_events FROM PUBLIC;

COMMIT;
