# Security assessment checklist

✅ implemented and tested here · 🟡 implemented, needs independent verification · ⬜ not yet done (required before production)

## Application
- ✅ Strict JSON schema validation on every endpoint; unknown fields rejected
- ✅ Parameterised SQL only (node-postgres placeholders); no string-built queries with user input
- ✅ XSS: Svelte escapes output; strict Content-Security-Policy (`script-src 'self'`) verified to block inline scripts
- ✅ CSRF not applicable: bearer tokens in memory, no cookies (`credentials: 'omit'`)
- ✅ Security headers: HSTS preload, nosniff, frame-ancestors none, no-referrer, COOP, Permissions-Policy
- ✅ Sessions HMAC-signed, short-lived (OTP stage 5 min, voter 30 min, official 2 h), tamper and expiry tested
- ✅ Replay: one token per voter, one ballot per token (database keys), idempotent retries
- 🟡 Credential stuffing: per-IP and per-ID rate limits, account lockout, OTP second factor. Limits are per process: move them to Valkey for multi-instance
- 🟡 Bot protection: rate limits only. Evaluate a privacy-preserving challenge (e.g. Privacy Pass) with the EBC
- ⬜ Passkeys (WebAuthn) for voters and officials via Keycloak
- ⬜ SMS OTP gateway integration and SIM-swap checks with mobile operators

## Cryptography
- ✅ Only standardised primitives: RFC 9474, RFC 9180, Shamir (audited library), Ed25519, SHA-256, AES-256-GCM, scrypt
- ✅ Election private key never stored; split 3-of-5; reconstruction verified against a published commitment
- 🟡 Blind-signing keys wrapped with a KEK from the environment. Production: HSM or OpenBao transit
- ⬜ Replace decrypt-and-shuffle tally with Belenios / ElectionGuard (verifiable)
- ⬜ Independent cryptographic review of the protocol and its implementation
- ⬜ Distributed key generation, so no machine ever holds the whole election key

## Data and privacy
- ✅ Separate schemas and DB roles; cross-access denied (tested)
- ✅ No IP addresses in application logs; HAProxy silences `/api/cast` logs
- ✅ Timestamps on ballots and token issuance rounded to the minute; random client delay before casting
- ✅ Fixed-length ballot plaintexts (no size leakage)
- ⬜ Privacy impact assessment under Eswatini data-protection law
- ⬜ Run the identity and cast services under different operators or organisations

## Integrity and audit
- ✅ Ballots, board and audit log immutable via triggers; status machine and ballot lock enforced in the DB
- ✅ Hash-chained audit log, with tamper detection tested
- ✅ Public bulletin board hash chain; public reconciliation
- 🟡 Observers must mirror the board and audit head hashes in real time (tooling to be provided)
- ⬜ Periodic publication of board head hashes to an external, independent medium

## Infrastructure and supply chain
- ✅ Lockfile; CI with tests, bundle budget, `npm audit`, Trivy, SBOM
- ✅ Non-root, read-only containers; network policies (default deny); segmented database network
- 🟡 Signed images (cosign) and reproducible builds configured but not exercised here
- ⬜ Penetration test (web, API, infrastructure) by an independent firm
- ⬜ DDoS protection contract and live test
- ⬜ Hardening review of hosts, Kubernetes and PostgreSQL (CIS benchmarks)
