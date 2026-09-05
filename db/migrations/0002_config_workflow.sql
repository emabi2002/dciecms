BEGIN;

CREATE TABLE IF NOT EXISTS config.case_types (
  case_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type_code varchar(40) NOT NULL UNIQUE,
  case_type_name varchar(160) NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  effective_from date,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_type_effective_dates_ck CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

INSERT INTO config.case_types (case_type_code, case_type_name)
VALUES
  ('CIVIL', 'Civil'),
  ('CRIMINAL', 'Criminal'),
  ('TRAFFIC', 'Traffic'),
  ('FAMILY', 'Family'),
  ('JUVENILE', 'Juvenile'),
  ('ADMINISTRATIVE', 'Administrative')
ON CONFLICT (case_type_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS workflow.workflow_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id uuid NOT NULL REFERENCES registry.filings(filing_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  task_type varchar(80) NOT NULL,
  assigned_role_code varchar(40) NOT NULL,
  priority varchar(20) NOT NULL DEFAULT 'NORMAL',
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by_subject varchar(255),
  CONSTRAINT workflow_task_status_ck CHECK (status IN ('PENDING','ASSIGNED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED','ESCALATED','OVERDUE'))
);

COMMENT ON COLUMN workflow.workflow_tasks.task_type IS 'Business task code; R0/R1 begins with REGISTRY_VALIDATE_FILING.';

CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_active_registry_validation_task_idx
  ON workflow.workflow_tasks(filing_id, task_type)
  WHERE task_type = 'REGISTRY_VALIDATE_FILING'
    AND status IN ('PENDING','ASSIGNED','IN_PROGRESS','BLOCKED','ESCALATED','OVERDUE');

CREATE INDEX IF NOT EXISTS workflow_tasks_court_status_idx
  ON workflow.workflow_tasks(court_id, status, created_at);

COMMIT;
