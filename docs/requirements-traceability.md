# Requirements traceability (master prompt → implementation)

Status: **Done** = built and tested here · **Partial** = built, with a stated gap · **Planned** = designed and documented, not built · **External** = needs a party outside the project

| § | Requirement | Status | Where |
| --- | --- | --- | --- |
| 2 | 500,000 concurrent users | **Not demonstrated** | Architecture, admission control and the k6 plan exist; measured only on 2 vCPU (`test-report.md`) |
| 2/7 | Exactly one accepted ballot per voter | Done | `identity.token_issuance` PK, `ballot.ballots` unique token; concurrency tests |
| 3 | All devices, PWA, low bandwidth, accessible | Done | `web/`; Moto G4 + slow 3G test; 49.6 KB JS; axe 0 violations |
| 3 | No ballot in browser storage; no silent duplicates | Done | Ballot and token in memory only; idempotent retry with the same token |
| 4 | Load balancing, scaling, replication, segmentation, monitoring | Partial | `infra/` configs written; not deployed here |
| 4 | Architecture diagrams | Done | Phase 1–3 report, Section 5 |
| 5 | Registration, duplicate detection, two-officer approval, audit | Done | `/api/admin/voters*`, DB check constraint |
| 5 | Password + OTP; passkeys; official ID integration | Partial | Password + SMS OTP done; passkeys and ID integration planned |
| 5 | Identity separated from ballot choices | Done | Blind tokens, separate schemas and roles (tested) |
| 6 | Election management (dates, constituencies, contests, candidates, publish, monitor, suspend, close) | Done | `/api/admin/elections*`, console |
| 6 | Political parties | Done (configurable) | `parties_enabled`, off for Eswatini |
| 6 | Candidate photographs upload | Partial | `photo_url` field; upload storage and resizing pipeline planned |
| 6 | Observer management | Partial | OBSERVER role and read access; observer onboarding workflow planned |
| 7 | Voting flow 1–10, review, confirm, durable acceptance, receipt | Done | `Vote.svelte`, `/api/cast` |
| 7 | Prevent alteration, deletion, substitution, post-close changes | Done | DB triggers; tests |
| 8 | TLS, headers, validation, SQLi/XSS/CSRF, rate limits, sessions | Done | `app.ts`, schemas, CSP |
| 8 | HSM key management, secrets manager | Planned | OpenBao/HSM documented; KEK from env in prototype |
| 8 | End-to-end verifiable protocol | Partial | Individual verifiability done; verifiable tally needs Belenios/ElectionGuard |
| 9 | Tamper-evident records, reconciliation, recount, incident reporting, chain of custody | Done / Partial | Board, audit chain, published decrypted ballots, incidents; chain-of-custody forms planned |
| 9 | No AI in vote handling; no blockchain without need | Done | None used |
| 10 | Admission control, pooling, idempotent retries, backpressure, health checks | Done | `admission.ts`, pg pools, `/readyz` |
| 10 | Circuit breakers | Partial | Waiting room and timeouts; explicit breaker on SMS gateway planned |
| 11 | HA, failover, encrypted immutable backups, DR, RPO/RTO | Partial | Configs and procedures; drills not run here |
| 12 | Roles, least privilege, multi-person authorisation | Done | 9 roles; approval slots; DB roles |
| 13 | Public results, turnout, preliminary/verified/declared | Done | `Results.svelte`, `/api/public/*` |
| 14 | Free and open-source stack with licences | Done | Report Section 8; `package.json` |
| 14 | Infrastructure cost calculation | Partial | Sizing method and measured bottleneck; prices need quotes |
| 15 | Test programme (unit → chaos, 10k→500k) | Partial | 20 automated + browser + load runs; large-scale and chaos runs planned |
| 16 | WCAG 2.2 AA, siSwati, low literacy | Partial | Automated checks pass; siSwati draft; manual audit needed |
| 17 | Legal and governance gates | External | `audit-certification-plan.md` |
| 18 | Phased delivery with gates | Done | Report Section 11; this file |
