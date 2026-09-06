BEGIN;

CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE IF NOT EXISTS notifications.notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  channel varchar(10) NOT NULL,
  recipient text NOT NULL CHECK (length(btrim(recipient)) > 0),
  template_code varchar(100) NOT NULL CHECK (length(btrim(template_code)) > 0),
  event_type varchar(120) NOT NULL CHECK (length(btrim(event_type)) > 0),
  resource_id varchar(255) NOT NULL CHECK (length(btrim(resource_id)) > 0),
  idempotency_key varchar(64) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'QUEUED',
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  CONSTRAINT notification_channel_ck CHECK (channel IN ('EMAIL','SMS')),
  CONSTRAINT notification_status_ck CHECK (status IN ('QUEUED','SENDING','DELIVERED','FAILED')),
  CONSTRAINT notification_idempotency_key_ck CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT notification_delivery_time_ck CHECK (status <> 'DELIVERED' OR delivered_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS notifications_court_status_created_idx
  ON notifications.notifications(court_id, status, created_at);

CREATE TABLE IF NOT EXISTS notifications.delivery_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications.notifications(notification_id),
  outcome varchar(20) NOT NULL,
  provider_message_id varchar(255),
  error_code varchar(100),
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_attempt_outcome_ck CHECK (outcome IN ('DELIVERED','FAILED')),
  CONSTRAINT notification_attempt_evidence_ck CHECK (
    (outcome='DELIVERED' AND error_code IS NULL)
    OR outcome='FAILED'
  )
);

CREATE INDEX IF NOT EXISTS notification_attempts_notification_time_idx
  ON notifications.delivery_attempts(notification_id, attempted_at);

REVOKE UPDATE, DELETE ON notifications.delivery_attempts FROM PUBLIC;

COMMIT;
