BEGIN;

CREATE TABLE IF NOT EXISTS case_mgmt.case_number_sequences (
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  case_type_code varchar(40) NOT NULL,
  case_year integer NOT NULL CHECK (case_year >= 2000),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (court_id, case_type_code, case_year)
);

CREATE TABLE IF NOT EXISTS case_mgmt.cases (
  case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number varchar(120) NOT NULL UNIQUE,
  filing_id uuid NOT NULL UNIQUE REFERENCES registry.filings(filing_id),
  payment_id uuid NOT NULL REFERENCES finance.payments(payment_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  case_type_code varchar(40) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'AWAITING_ASSIGNMENT',
  opened_by_subject varchar(255) NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_status_ck CHECK (status IN ('AWAITING_ASSIGNMENT','ASSIGNED','HEARING_SCHEDULED','CLOSED'))
);

CREATE INDEX IF NOT EXISTS cases_court_status_idx ON case_mgmt.cases(court_id,status,opened_at);

COMMIT;
