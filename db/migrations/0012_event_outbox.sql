BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.outbox_events (
  outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type varchar(120) NOT NULL,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id text NOT NULL,
  court_id uuid,
  actor_subject text,
  correlation_id varchar(120),
  deduplication_key varchar(240) NOT NULL,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by varchar(160),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT outbox_event_deduplication_key UNIQUE (event_type, deduplication_key),
  CONSTRAINT outbox_event_status_ck CHECK (status IN ('PENDING','PROCESSING','DELIVERED','DEAD_LETTER')),
  CONSTRAINT outbox_event_attempt_count_ck CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_due_idx
  ON integration.outbox_events(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON integration.outbox_events(aggregate_type, aggregate_id, created_at);

REVOKE DELETE ON integration.outbox_events FROM PUBLIC;

COMMIT;
