# Test report (Phase 13), 19 November 2026

**Environment:** one cloud VM with **2 vCPUs** (Intel Xeon 2.1 GHz) and 7 GB RAM. The PostgreSQL 16 server, the application (8 Node.js worker processes) and the load generator all shared those 2 vCPUs. These are **development-workspace measurements**. They show correctness under concurrency and where the bottlenecks are. They do **not** show national-scale capacity.

## 1. Functional, integrity and privacy tests: 20 of 20 pass

`npm test` runs against a real PostgreSQL database and a real HTTP server.

| Test | Result |
| --- | --- |
| Full voter journey; receipt does not reveal the choice; tracker appears on the board | Pass |
| Retry of the same ballot returns the original receipt; same token with a different ballot is refused (409) | Pass |
| A voter cannot obtain a second token | Pass |
| **50 simultaneous token requests from one voter: exactly 1 succeeds** | Pass |
| **50 simultaneous different ballots with one token: exactly 1 accepted** | Pass |
| Forged token (403), malformed ballot (400), unexpected fields (400) refused | Pass |
| Wrong password, wrong OTP, OTP-stage session and no session refused | Pass |
| **Privacy:** ballot role cannot read identity tables; identity role cannot read ballots; admin role cannot read token issuance | Pass |
| **Integrity:** even the database owner cannot update or delete ballots, edit candidates after publication, or skip status steps | Pass |
| Close needs 2 distinct officials; the same official twice is refused; an auditor cannot close | Pass |
| Casting refused after the closing grace period (election closure during active sessions) | Pass |
| Results hidden before tally; trustee ceremony: 2 shares insufficient, 3rd triggers tally | Pass |
| Reconciliation: tokens ≥ ballots = board = counted; tallied counts include every recorded choice | Pass |
| Verify needs AUDITOR + NATIONAL_ADMIN; declare needs 2 NATIONAL_ADMINs; labels preliminary → verified → declared | Pass |
| Audit hash chain intact; tampering with a record (trigger disabled by owner) is detected | Pass |
| TOTP RFC 6238 test vectors; password hashing; session tamper/expiry; key wrapping tamper detection | Pass |
| Approval-slot logic; voting windows; fixed-length ballot padding; rate limiter | Pass |
| Server tracker derivation matches the browser derivation | Pass |

## 2. Browser end-to-end and accessibility (Playwright + axe-core)

The real PWA in Chrome went through sign-in, OTP, three contests, review, cast, receipt and the bulletin-board check.

| Device profile | Result | First screen | Cast (incl. on-device crypto and a deliberate 0.3–1.5 s privacy delay) |
| --- | --- | --- | --- |
| Moto G4 emulation, **slow 3G** (300 ms latency, 750 kbit/s), **CPU throttled 4×** | Pass | 2.6 s | 2.1 s |
| iPad (gen 7) | Pass | 0.13 s | 0.88 s |
| Desktop 1280×800 | Pass | 0.13 s | 0.90 s |

The automated WCAG 2.0/2.1/2.2 A and AA checks (axe-core) found **0 violations** on every screen tested. Automated checks catch only part of WCAG, so a manual audit with screen-reader users is still required. The voter JavaScript bundle is **49.6 KB gzip**, against a 150 KB budget enforced in CI. The Content-Security-Policy was confirmed to block injected inline scripts. Screenshots are in `docs/screenshots/`.

## 3. Load tests with realistic voter journeys

Each virtual voter performs login (scrypt password check) → OTP → ballot → blind-token issuance → anonymous cast. In the runs below the device-side crypto was pre-computed, so the timed phase measures the server.

| Run | Voters | Concurrent | Completed | Errors | Throughput | Cast p50 / p95 / p99 | Login p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Moderate load | 1,000 | 30 | 1,000 | 0 | 31 journeys/s | 37 / 108 / 236 ms | 758 / 1,110 ms |
| Saturated (10× the machine's capacity) | 3,000 | 300 | 3,000 | 0 | 31 journeys/s | 75 / 289 / 69,368 ms | 6,560 / 9,469 ms |
| Before the WebCrypto fix | 3,000 | 300 | 3,000 | 0 | 31 journeys/s | 4,787 / 8,214 ms | 3,670 / 6,418 ms |

**Reconciliation after every run:** journeys reported accepted = new ballots in the database = new bulletin-board entries. No ballot was lost or duplicated, and no request failed, even at 10× saturation.

**Tally:** 10,911 ballots were decrypted, validated and counted in **11.6 s** on the 2 vCPUs, with 10,911 valid. Tokens issued were 11,021. The 110 tokens issued but never cast came from a load run killed mid-flight, which is the "device lost between token and cast" case.

## 4. What the numbers mean

- **The bottleneck is login, as designed.** One scrypt password check costs about 40 ms of CPU. This workspace manages about 51 checks per second on 2 vCPUs, which caps it at about 31 journeys/s.
- **Extrapolation, still to be verified:** the worst case in the report (830 logins/s) needs about 35–40 vCPUs for password hashing alone, plus headroom, so roughly 50–60 vCPUs in the identity tier. The cast path was never saturated here, so its capacity must be measured on staging hardware.
- **A real bug was found and fixed.** Server-side ballot verification used WebCrypto, which shares Node's thread pool with password hashing, so casts queued behind logins. Moving to synchronous OpenSSL calls cut cast p50 from 4.8 s to 75 ms under the same load.
- **A second real bug was found and fixed.** The web trustee ceremony keeps shares in one process's memory, so it fails if requests land on different replicas. An offline ceremony CLI (`server/src/ceremony.ts`) is now the recommended route.
- **The saturated run's p99 tail (69 s)** is CPU starvation on 2 shared cores. Nothing failed, but it shows why production must separate the generator, the app tiers and the database, and why admission limits must be tuned to measured per-node capacity.

## 5. Not yet tested (required before any capacity claim)

| Scenario from the master prompt | Status |
| --- | --- |
| 10k / 50k / 100k / 250k / 500k concurrent users | Script ready (`tests/load/k6-voter-journey.js`). Needs distributed generators and staging infrastructure |
| Spike beyond peak | In the k6 stages (2× peak). Not run |
| Server failure and database failover during peak | Needs a Patroni cluster. Drill described in `docs/backup-recovery.md` |
| Network interruption during voting | Client retry logic implemented and unit-tested. Not chaos-tested |
| DDoS / malicious traffic | Needs a provider-level test with the DDoS vendor's permission |
| Penetration test, cryptographic review | Must be independent (`docs/audit-certification-plan.md`) |
| Soak test (12+ hours) | Not run |
