# Backup, disaster recovery and incident response

**Rule zero:** no recovery procedure may discard, duplicate or modify an accepted ballot. Every recovery ends with the reconciliation check (`GET /api/public/elections/:id/reconciliation`) and a bulletin-board comparison against the copies held by observers.

## Recovery objectives (proposed; the election authority approves them)

| Failure | RPO (ballots lost) | RTO | Mechanism |
| --- | --- | --- | --- |
| One application server | 0 | Seconds | Stateless replicas; health checks remove the node |
| Primary database node | **0** | Under 60 s | Patroni automatic failover; `synchronous_mode_strict` means no ballot is acknowledged unless a replica has it |
| Whole data centre | **0** for acknowledged ballots | Under 15 min | Site B synchronous standby, promoted by a documented two-person procedure |
| Data corruption or operator error | Point in time before the event | Hours | pgBackRest point-in-time restore from immutable (object-locked) backups |
| Ransomware or full compromise | 0 for ballots published to observers' board copies | Hours to days | Clean rebuild from signed images plus backups. Observers' board copies prove completeness |

## Backups

- Continuous WAL archiving plus a nightly full backup (`infra/postgres/pgbackrest.conf`), AES-256 encrypted, to object storage with **Object Lock (WORM)** in a second location.
- `infra/scripts/backup-verify.sh` restores the latest backup into a scratch instance and compares ballot, board and audit counts with production. Run it nightly, and on election eve and the morning after.
- Encryption passphrases and key-encryption keys live in OpenBao and an offline sealed envelope held by two officials, never in the repository.

## Procedures

**Database failover drill (run during every load test in staging)**
1. Start a k6 cast storm.
2. Stop the primary node (`patronictl failover` or power off).
3. Expected: some requests get errors or waiting-room responses for under 60 s; clients retry with the same token, so there are no duplicates.
4. Afterwards, k6's accepted count must equal the database count must equal the board count.

**Election-state recovery after a crash.** Status lives in `cfg.elections` and is protected by the transition trigger. On restart nothing needs replaying: ballots are either committed or were never acknowledged. If the sealer was mid-batch, the transaction rolled back and the next run re-seals.

**Suspending voting.** Use the `suspend` action, which needs 2 approvers from NATIONAL_ADMIN or SECURITY_OFFICER. Casting stops immediately and tokens are no longer issued. Announce on the official channels and switch polling stations to the paper fallback. `resume` needs 2 approvals; extending hours is a legal decision for the EBC.

## Incident response (summary)

| Severity | Example | First action | Who decides |
| --- | --- | --- | --- |
| CRITICAL | Evidence of ballot tampering; key compromise | Suspend voting; preserve evidence (snapshots, logs); notify EBC chair and auditor | EBC chair + security officer |
| HIGH | Sustained DDoS; regional outage | Activate DDoS provider runbook; extend waiting room; polling-station fallback | Security officer |
| MEDIUM | SMS delays; elevated error rate | Scale identity tier; switch SMS route | Operations lead |
| LOW | Single node failure | Automatic; record the incident | Operations |

Every incident is recorded via `POST /api/admin/incidents` (which writes to the audit log) and reviewed by the independent auditor.
