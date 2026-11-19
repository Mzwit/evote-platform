-- =====================================================================
-- Least-privilege database roles (Phase 4 / Phase 8)
--   evote_identity : login, eligibility, token issuance. Cannot read ballots.
--   evote_ballot   : anonymous casting. Cannot read identity data.
--   evote_admin    : configuration, approvals, tally. Cannot read voter-to-token data.
-- Passwords here are development defaults; production sets them from the
-- secrets manager (OpenBao) and they are never committed.
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evote_identity') THEN
    CREATE ROLE evote_identity LOGIN PASSWORD 'dev-identity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evote_ballot') THEN
    CREATE ROLE evote_ballot LOGIN PASSWORD 'dev-ballot'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evote_admin') THEN
    CREATE ROLE evote_admin LOGIN PASSWORD 'dev-admin'; END IF;
END $$;

GRANT USAGE ON SCHEMA cfg TO evote_identity, evote_ballot, evote_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA cfg TO evote_identity, evote_ballot;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cfg TO evote_admin;

-- identity service
GRANT USAGE ON SCHEMA identity TO evote_identity;
GRANT SELECT, INSERT, UPDATE ON identity.voters, identity.otp_challenges TO evote_identity;
GRANT SELECT, INSERT ON identity.token_issuance TO evote_identity;
GRANT SELECT ON identity.roll TO evote_identity;

-- ballot service: insert ballots, read its own board. No identity access.
GRANT USAGE ON SCHEMA ballot TO evote_ballot;
GRANT SELECT, INSERT ON ballot.ballots, ballot.board TO evote_ballot;
GRANT SELECT ON ballot.decrypted TO evote_ballot;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ballot TO evote_ballot;

-- admin service: voter registration, roll freezing, counts (not issuance rows), ballots for tally.
GRANT USAGE ON SCHEMA identity, ballot, adm TO evote_admin;
GRANT SELECT, INSERT, UPDATE ON identity.voters TO evote_admin;
GRANT SELECT, INSERT ON identity.roll TO evote_admin;
GRANT SELECT ON identity.issuance_counts, identity.roll_counts TO evote_admin;
GRANT SELECT ON ballot.ballots, ballot.board TO evote_admin;
GRANT SELECT, INSERT ON ballot.decrypted TO evote_admin;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA adm TO evote_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA adm TO evote_admin;
REVOKE UPDATE, DELETE ON adm.audit_log FROM evote_admin;
