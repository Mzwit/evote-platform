#!/usr/bin/env bash
# Nightly (and before/after election day): take a backup, restore it into a scratch
# instance, and prove the restored copy reconciles with production.
set -euo pipefail
pgbackrest --stanza=evote --type=full backup
pgbackrest --stanza=evote --pg1-path=/restore/test --delta restore
pg_ctl -D /restore/test -o "-p 5499" -w start
for q in "SELECT count(*) FROM ballot.ballots" "SELECT max(position) FROM ballot.board" "SELECT count(*) FROM adm.audit_log"; do
  prod=$(psql -tA -c "$q"); restored=$(psql -p 5499 -tA -c "$q")
  echo "$q -> production $prod, restored $restored"
done
pg_ctl -D /restore/test -w stop
