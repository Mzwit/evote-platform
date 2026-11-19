-- =====================================================================
-- E-Voting Platform - initial schema (Phase 4)
-- Identity data and ballots live in SEPARATE schemas, accessed by
-- SEPARATE database roles. No role used by the application can join a
-- voter's identity to a ballot.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS cfg;       -- election configuration (public data)
CREATE SCHEMA IF NOT EXISTS identity;  -- voters, credentials, token issuance log
CREATE SCHEMA IF NOT EXISTS ballot;    -- anonymous encrypted ballots, bulletin board
CREATE SCHEMA IF NOT EXISTS adm;       -- officials, approvals, audit log, results

-- ---------------------------------------------------------------------
-- Election configuration
-- ---------------------------------------------------------------------
CREATE TABLE cfg.elections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(name) BETWEEN 3 AND 200),
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                    ('DRAFT','PUBLISHED','OPEN','SUSPENDED','CLOSED','TALLIED','VERIFIED','DECLARED')),
  opens_at          timestamptz NOT NULL,
  closes_at         timestamptz NOT NULL,
  close_grace_s     integer NOT NULL DEFAULT 120 CHECK (close_grace_s BETWEEN 0 AND 3600),
  parties_enabled   boolean NOT NULL DEFAULT false,   -- false for Eswatini (individual merit)
  trustee_count     integer NOT NULL DEFAULT 5 CHECK (trustee_count BETWEEN 1 AND 15),
  trustee_threshold integer NOT NULL DEFAULT 3,
  hpke_public_key   bytea,                -- election encryption public key (X25519)
  hpke_sk_commit    bytea,                -- sha256(private key) to verify reconstruction
  receipt_public_key bytea,               -- Ed25519 SPKI used to sign voter receipts
  receipt_private_enc bytea,              -- AES-GCM encrypted under the KEK
  roll_frozen_at    timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at),
  CHECK (trustee_threshold BETWEEN 1 AND trustee_count)
);

CREATE TABLE cfg.constituencies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES cfg.elections(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  region       text NOT NULL,
  UNIQUE (election_id, code)
);

CREATE TABLE cfg.contests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES cfg.elections(id) ON DELETE CASCADE,
  name         text NOT NULL,
  max_choices  integer NOT NULL DEFAULT 1 CHECK (max_choices BETWEEN 1 AND 50),
  sort         integer NOT NULL DEFAULT 0
);

CREATE TABLE cfg.candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id      uuid NOT NULL REFERENCES cfg.contests(id) ON DELETE CASCADE,
  constituency_id uuid NOT NULL REFERENCES cfg.constituencies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  party           text,                 -- only shown when parties_enabled
  bio             text NOT NULL DEFAULT '',
  photo_url       text,
  sort            integer NOT NULL DEFAULT 0
);
CREATE INDEX ON cfg.candidates (contest_id, constituency_id);

-- One blind-signing key per constituency per election. The token proves
-- "an eligible voter of this constituency" and nothing else.
CREATE TABLE cfg.signing_keys (
  election_id     uuid NOT NULL REFERENCES cfg.elections(id) ON DELETE CASCADE,
  constituency_id uuid NOT NULL REFERENCES cfg.constituencies(id) ON DELETE CASCADE,
  public_spki     bytea NOT NULL,
  private_enc     bytea NOT NULL,       -- AES-256-GCM under KEK (production: HSM/OpenBao)
  PRIMARY KEY (election_id, constituency_id)
);

-- ---------------------------------------------------------------------
-- Identity side
-- ---------------------------------------------------------------------
CREATE TABLE identity.voters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  national_id        text NOT NULL UNIQUE CHECK (national_id ~ '^[0-9]{6,20}$'),
  full_name          text NOT NULL,
  date_of_birth      date NOT NULL,
  constituency_code  text NOT NULL,
  phone              text,
  password_hash      text,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','REMOVED')),
  registered_by      uuid,
  approved_by        uuid,
  failed_logins      integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM registered_by)
);
-- Duplicate-detection helper (same name + date of birth)
CREATE INDEX ON identity.voters (lower(full_name), date_of_birth);

CREATE TABLE identity.otp_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_id    uuid NOT NULL REFERENCES identity.voters(id) ON DELETE CASCADE,
  code_hash   bytea NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  used        boolean NOT NULL DEFAULT false
);
CREATE INDEX ON identity.otp_challenges (voter_id, expires_at);

-- Election-specific voter roll, frozen at publication.
CREATE TABLE identity.roll (
  election_id     uuid NOT NULL,
  voter_id        uuid NOT NULL REFERENCES identity.voters(id),
  constituency_id uuid NOT NULL,
  PRIMARY KEY (election_id, voter_id)
);
CREATE INDEX ON identity.roll (election_id, constituency_id);

-- EXACTLY ONE anonymous token per voter per election (primary key).
-- Holds the BLINDED message only; the token itself never touches this table.
CREATE TABLE identity.token_issuance (
  election_id     uuid NOT NULL,
  voter_id        uuid NOT NULL REFERENCES identity.voters(id),
  constituency_id uuid NOT NULL,
  blinded_hash    bytea NOT NULL,
  blind_sig       bytea NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  PRIMARY KEY (election_id, voter_id)
);

-- Aggregate view the reconciliation process may read (no voter ids).
CREATE VIEW identity.issuance_counts AS
  SELECT election_id, constituency_id, count(*)::bigint AS issued
  FROM identity.token_issuance GROUP BY election_id, constituency_id;

CREATE VIEW identity.roll_counts AS
  SELECT election_id, constituency_id, count(*)::bigint AS eligible
  FROM identity.roll GROUP BY election_id, constituency_id;

-- ---------------------------------------------------------------------
-- Ballot side (anonymous)
-- ---------------------------------------------------------------------
CREATE TABLE ballot.ballots (
  seq             bigserial PRIMARY KEY,
  election_id     uuid NOT NULL,
  constituency_id uuid NOT NULL,
  token           bytea NOT NULL,          -- prepared token message (random, unlinkable)
  token_sig       bytea NOT NULL,          -- RFC 9474 signature, publicly verifiable
  token_hash      bytea NOT NULL,
  enc             bytea NOT NULL,          -- HPKE encapsulated key
  ct              bytea NOT NULL,          -- HPKE ciphertext
  tracker         text NOT NULL,
  received_minute timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  -- EXACTLY ONE ballot per token:
  UNIQUE (election_id, token_hash)
);
CREATE INDEX ON ballot.ballots (election_id, seq);
CREATE UNIQUE INDEX ON ballot.ballots (election_id, tracker);

-- Accepted ballots can never be updated or deleted by the application.
CREATE FUNCTION ballot.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'accepted ballots are immutable'; END $$;
CREATE TRIGGER ballots_immutable BEFORE UPDATE OR DELETE ON ballot.ballots
  FOR EACH ROW EXECUTE FUNCTION ballot.forbid_change();

-- Public bulletin board: hash chain over accepted ballots in seq order.
CREATE TABLE ballot.board (
  election_id  uuid NOT NULL,
  position     bigint NOT NULL,
  ballot_seq   bigint NOT NULL UNIQUE REFERENCES ballot.ballots(seq),
  tracker      text NOT NULL,
  prev_hash    bytea NOT NULL,
  entry_hash   bytea NOT NULL,
  sealed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (election_id, position)
);
CREATE TRIGGER board_immutable BEFORE UPDATE OR DELETE ON ballot.board
  FOR EACH ROW EXECUTE FUNCTION ballot.forbid_change();

-- Decrypted ballots, published in shuffled order (no link to trackers).
CREATE TABLE ballot.decrypted (
  election_id     uuid NOT NULL,
  position        integer NOT NULL,
  constituency_id uuid NOT NULL,
  selections      jsonb,
  valid           boolean NOT NULL,
  reason          text,
  PRIMARY KEY (election_id, position)
);

-- ---------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------
CREATE TABLE adm.officials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  totp_secret   bytea NOT NULL,
  roles         text[] NOT NULL CHECK (roles <@ ARRAY['SUPER_ADMIN','NATIONAL_ADMIN','REGIONAL_OFFICER',
                 'CONSTITUENCY_OFFICER','REGISTRATION_OFFICER','AUDITOR','OBSERVER','SECURITY_OFFICER','TRUSTEE']::text[]),
  active        boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE adm.approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id  uuid NOT NULL REFERENCES cfg.elections(id),
  action       text NOT NULL,
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTED','REJECTED','FAILED')),
  requested_by uuid NOT NULL REFERENCES adm.officials(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz,
  result       jsonb
);
-- Only one open request per action per election.
CREATE UNIQUE INDEX ON adm.approvals (election_id, action) WHERE status = 'PENDING';

CREATE TABLE adm.approval_votes (
  approval_id  uuid NOT NULL REFERENCES adm.approvals(id),
  official_id  uuid NOT NULL REFERENCES adm.officials(id),
  role_used    text NOT NULL,
  voted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, official_id)
);

-- Tamper-evident audit log: each record hashes the previous one.
CREATE TABLE adm.audit_log (
  seq        bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}',
  prev_hash  bytea NOT NULL,
  hash       bytea NOT NULL
);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON adm.audit_log
  FOR EACH ROW EXECUTE FUNCTION ballot.forbid_change();

CREATE TABLE adm.results (
  election_id     uuid NOT NULL,
  contest_id      uuid NOT NULL,
  constituency_id uuid NOT NULL,
  candidate_id    uuid NOT NULL,
  votes           bigint NOT NULL,
  PRIMARY KEY (election_id, contest_id, constituency_id, candidate_id)
);

CREATE TABLE adm.tally_runs (
  election_id   uuid PRIMARY KEY,
  finished_at   timestamptz NOT NULL DEFAULT now(),
  ballots_total bigint NOT NULL,
  valid         bigint NOT NULL,
  invalid       bigint NOT NULL,
  board_head    bytea NOT NULL,
  decrypted_hash bytea NOT NULL
);

CREATE TABLE adm.incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id uuid REFERENCES cfg.elections(id),
  severity    text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title       text NOT NULL,
  details     text NOT NULL DEFAULT '',
  reported_by uuid REFERENCES adm.officials(id),
  reported_at timestamptz NOT NULL DEFAULT now()
);
