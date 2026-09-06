BEGIN;

CREATE TABLE IF NOT EXISTS judicial.judgments (
  judgment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES case_mgmt.cases(case_id),
  hearing_id uuid NOT NULL REFERENCES judicial.hearings(hearing_id),
  court_id uuid NOT NULL REFERENCES config.courts(court_id),
  decision_type varchar(40) NOT NULL,
  title varchar(300) NOT NULL,
  content text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_subject varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by_subject varchar(255),
  updated_at timestamptz,
  reviewed_by_subject varchar(255),
  reviewed_at timestamptz,
  signed_by_subject varchar(255),
  signed_at timestamptz,
  issued_by_subject varchar(255),
  issued_at timestamptz,
  CONSTRAINT judgment_status_ck CHECK (status IN ('DRAFT','FINAL','SIGNED','ISSUED'))
);

CREATE INDEX IF NOT EXISTS judgments_case_idx ON judicial.judgments(case_id, created_at);
CREATE INDEX IF NOT EXISTS judgments_hearing_idx ON judicial.judgments(hearing_id, created_at);

CREATE OR REPLACE FUNCTION judicial.enforce_judgment_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Judgments cannot be deleted';
  END IF;

  IF OLD.status IN ('FINAL','SIGNED','ISSUED') AND
     (NEW.title IS DISTINCT FROM OLD.title OR
      NEW.content IS DISTINCT FROM OLD.content OR
      NEW.decision_type IS DISTINCT FROM OLD.decision_type OR
      NEW.case_id IS DISTINCT FROM OLD.case_id OR
      NEW.hearing_id IS DISTINCT FROM OLD.hearing_id OR
      NEW.court_id IS DISTINCT FROM OLD.court_id) THEN
    RAISE EXCEPTION 'Finalized judgment content is immutable';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT','FINAL') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'FINAL' AND NEW.status NOT IN ('FINAL','SIGNED') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'SIGNED' AND NEW.status NOT IN ('SIGNED','ISSUED') THEN
    RAISE EXCEPTION 'Invalid judgment transition';
  ELSIF OLD.status = 'ISSUED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Issued judgment is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS judgments_immutability_trg ON judicial.judgments;
CREATE TRIGGER judgments_immutability_trg
BEFORE UPDATE OR DELETE ON judicial.judgments
FOR EACH ROW EXECUTE FUNCTION judicial.enforce_judgment_immutability();

COMMIT;
