BEGIN;

CREATE TABLE IF NOT EXISTS dciecms_test.workflow_idempotency_records (
  idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_subject text NOT NULL,
  operation varchar(80) NOT NULL,
  resource_id text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_idempotency_records_scope_key UNIQUE (actor_subject, operation, resource_id, idempotency_key)
);

ALTER TABLE dciecms_test.audit_events
  ADD COLUMN IF NOT EXISTS actor_subject text;

REVOKE UPDATE, DELETE ON dciecms_test.workflow_idempotency_records FROM PUBLIC;
REVOKE UPDATE, DELETE ON dciecms_test.audit_events FROM PUBLIC;

COMMIT;
