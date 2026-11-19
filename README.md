# EVote: secure, verifiable electronic voting platform (reference implementation)

> **Status: PROTOTYPE, NOT CERTIFIED.** It is built for evaluation, pilots in low-stakes elections (student union, SACCO, associations) and as a basis for independent review. It must not be used for a binding public election until the legally competent election authority approves it and the independent security, cryptographic and audit reviews in `docs/audit-certification-plan.md` are complete.

## What it does

- **Every device, nothing to install.** A Progressive Web App works on Android, iPhone/iPad, Windows, macOS and Linux, and is about 50 KB of compressed JavaScript.
- **Secret ballot by design.** Voter identity and ballots live in separate database schemas with separate least-privilege roles. The link between the two is broken cryptographically with RFC 9474 blind signatures.
- **Ballots encrypted on the voter's device** with RFC 9180 HPKE. The decryption key is split 3-of-5 among trustees (Shamir) and never stored.
- **Exactly one ballot per voter.** One token per voter and one ballot per token, enforced by database primary/unique keys. This is proven under concurrent attack in the tests.
- **Nothing acknowledged before it is durable.** "Accepted" is returned only after the PostgreSQL commit. In production, synchronous replication puts it on two servers first.
- **Verifiable.** Voters get a tracking code. A public hash-chained bulletin board lists every ballot. Decrypted ballots are published (shuffled) so anyone can recount. Reconciliation checks run publicly.
- **No single-person control.** Publish, open, suspend, close, verify and declare each need distinct officials. The database itself refuses illegal status changes, edits to the ballot after publication, and any change to accepted ballots.
- **Overload means a wait, not an error.** A waiting room (admission control) holds excess requests, the app retries automatically, and every retry is idempotent.

## Quick start (development)

Requirements: Node.js 22.18 or later, PostgreSQL 16.

```bash
npm ci
createdb evote                                # owner role "evote" with CREATEROLE (dev only)
npm run migrate
node server/src/seed.ts --voters 2000 --open  # demo election, fictional data; credentials in seed-output/demo.json
npm run build                                 # builds the PWA into web/dist
npm start                                     # http://localhost:8080
npm test                                      # 20 unit + integration tests against PostgreSQL
```

Demo voters sign in with the national ID numbers in `seed-output/demo.json` and the password `Demo-Voter-2026`. In development the SMS code is pre-filled. Officials: `admin1`, `admin2`, `auditor`, `trustee1`–`5` and others, with password `Demo-Official-2026!`. Each needs a TOTP code; the secrets are in `seed-output/demo.json` and can be added to any authenticator app.

## Repository map

| Path | Contents |
| --- | --- |
| `db/migrations/` | Schema (Phase 4), least-privilege roles, integrity triggers |
| `shared/protocol.ts` | Ballot protocol shared by browser and server (blind tokens, HPKE, trackers, board hash chain) |
| `server/src/` | Fastify API: identity/login, anonymous casting, public results, administration, tally, sealer, offline trustee ceremony |
| `web/` | Svelte 5 PWA: voter, receipt check, results, officials' console. English + draft siSwati |
| `tests/` | Unit/integration tests, Playwright browser + WCAG tests, k6 distributed load test |
| `scripts/` | Load tester with real voter journeys, close-and-tally, bundle budget check |
| `infra/` | HAProxy, K3s manifests, Patroni, pgBackRest, Prometheus alerts, backup verification |
| `docs/` | Test report, manuals, runbooks, security checklist, audit and certification plan, traceability |

## Honest limits

1. **Tally verifiability.** The prototype tally decrypts and shuffles. Anyone can recount the published ballots, but nobody can yet *prove* the decryption and shuffle were honest. The production gate is to replace this step with Belenios or ElectionGuard.
2. **Remote-voting risks** (malware on voters' phones, coercion) cannot be solved by software alone. See the threat model in the Phase 1–3 report.
3. **Scale is not demonstrated.** Measured results come from a 2-vCPU workspace (`docs/test-report.md`). Supporting 500,000 concurrent users must be shown with the k6 plan on production-like infrastructure before anyone claims it.
4. **siSwati text is a draft** and needs a qualified translator.

Licence: Apache-2.0 (change if the election authority requires otherwise).
