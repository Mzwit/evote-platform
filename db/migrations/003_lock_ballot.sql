-- Defence in depth: the database itself refuses any change to constituencies,
-- contests or candidates once an election has left DRAFT (no candidate substitution).
CREATE FUNCTION cfg.forbid_after_publish() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; st text;
BEGIN
  IF TG_TABLE_NAME = 'candidates' THEN
    SELECT t.election_id INTO eid FROM cfg.contests t WHERE t.id = COALESCE(NEW.contest_id, OLD.contest_id);
  ELSE
    eid := COALESCE(NEW.election_id, OLD.election_id);
  END IF;
  SELECT status INTO st FROM cfg.elections WHERE id = eid;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'ballot configuration is locked (election status %)', st;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER lock_constituencies BEFORE INSERT OR UPDATE OR DELETE ON cfg.constituencies FOR EACH ROW EXECUTE FUNCTION cfg.forbid_after_publish();
CREATE TRIGGER lock_contests BEFORE INSERT OR UPDATE OR DELETE ON cfg.contests FOR EACH ROW EXECUTE FUNCTION cfg.forbid_after_publish();
CREATE TRIGGER lock_candidates BEFORE INSERT OR UPDATE OR DELETE ON cfg.candidates FOR EACH ROW EXECUTE FUNCTION cfg.forbid_after_publish();

-- Status may only move along the approved state machine.
CREATE FUNCTION cfg.check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (('DRAFT','PUBLISHED'),('PUBLISHED','OPEN'),('OPEN','SUSPENDED'),('SUSPENDED','OPEN'),
       ('OPEN','CLOSED'),('SUSPENDED','CLOSED'),('CLOSED','TALLIED'),('TALLIED','VERIFIED'),('VERIFIED','DECLARED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal election status change % -> %', OLD.status, NEW.status;
END $$;
CREATE TRIGGER election_transition BEFORE UPDATE OF status ON cfg.elections FOR EACH ROW EXECUTE FUNCTION cfg.check_transition();

-- Published keys and the frozen roll cannot be replaced.
CREATE FUNCTION cfg.keys_write_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.hpke_public_key IS NOT NULL AND NEW.hpke_public_key IS DISTINCT FROM OLD.hpke_public_key)
     OR (OLD.receipt_public_key IS NOT NULL AND NEW.receipt_public_key IS DISTINCT FROM OLD.receipt_public_key) THEN
    RAISE EXCEPTION 'election keys are write-once';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.opens_at, NEW.closes_at, NEW.trustee_threshold) IS DISTINCT FROM (OLD.opens_at, OLD.closes_at, OLD.trustee_threshold) THEN
    RAISE EXCEPTION 'election parameters are locked after publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER election_keys BEFORE UPDATE ON cfg.elections FOR EACH ROW EXECUTE FUNCTION cfg.keys_write_once();
