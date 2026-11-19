# API reference

All bodies are JSON and are validated against strict schemas: unknown fields are rejected. Errors return `{ "error": "<plain-language message>" }`. A `503` with `waitingRoom: true` and `Retry-After` means "wait and retry"; every write endpoint is safe to retry. Sessions are sent as `Authorization: Bearer <token>`; no cookies are used, which removes CSRF risk.

## Voter (identity service)

| Method and path | Body | Returns |
| --- | --- | --- |
| `POST /api/voter/login` | `nationalId`, `password` | `challengeId`, OTP-stage `session`, `phoneHint` (and `devOtp` in development only) |
| `POST /api/voter/otp` | `challengeId`, `code` | full `session` (30 min) |
| `GET /api/voter/me` | none | name and elections on the roll, each with `token_issued` |
| `GET /api/voter/elections/:id/ballot` | none | contests and candidates for the voter's inkhundla, `signingKey` (RSA SPKI), `electionKey` (X25519) |
| `POST /api/voter/elections/:id/token` | `blinded` (base64, 256 bytes) | `blindSig`. Exactly one per voter; the same `blinded` retried returns the same signature |

## Anonymous casting (cast service, no session)

`POST /api/cast` with body `electionId`, `constituencyId`, `token` (64 bytes), `sig` (256), `enc` (32), `ct` (2,064), all base64.
It returns `status: ACCEPTED`, `tracker`, `acceptedAt` (minute precision), and `statement` plus `receiptSignature` (Ed25519 under the election's receipt key). Error codes: `403` invalid token, `409 TOKEN_USED`, `409 CLOSED`, `400` malformed.

## Public (cacheable for 5 s)

`GET /api/public/elections` · `/elections/:id` (configuration, public keys) · `/elections/:id/board?after=&limit=` · `/elections/:id/board/:tracker` · `/elections/:id/ballots?after=` (encrypted ballots with tokens, for independent verification) · `/elections/:id/turnout` · `/elections/:id/reconciliation` · `/elections/:id/results` (only after tally, labelled PRELIMINARY / VERIFIED / OFFICIALLY DECLARED) · `/elections/:id/decrypted?after=` (shuffled decrypted ballots for recounts).

## Administration (official session; roles enforced per endpoint)

| Endpoint | Role |
| --- | --- |
| `POST /api/admin/login` (`username`, `password`, `totp`) | any official |
| `GET/POST /api/admin/officials`, `POST /api/admin/officials/:id/active` | SUPER_ADMIN (cannot hold election roles) |
| `GET/POST /api/admin/elections`, `GET /api/admin/elections/:id` | NATIONAL_ADMIN (read: any official) |
| `POST /api/admin/elections/:id/constituencies` · `/contests` · `/candidates`, `DELETE …/candidates/:cid` | NATIONAL_ADMIN, DRAFT only |
| `POST /api/admin/elections/:id/actions/{publish,open,suspend,resume,close,verify,declare}` (`reason`) | per transition; distinct approvers required |
| `GET /api/admin/approvals` | any official |
| `POST /api/admin/elections/:id/trustee-share` (`share`) | TRUSTEE |
| `POST /api/admin/voters`, `POST /api/admin/voters/:id/approve`, `POST /api/admin/voters/:id/status`, `GET /api/admin/voters?q=` | REGISTRATION_OFFICER (approval by a second officer) |
| `GET /api/admin/audit`, `GET /api/admin/audit/verify` | AUDITOR, SECURITY_OFFICER (log read also OBSERVER, NATIONAL_ADMIN) |
| `GET/POST /api/admin/incidents` | any official |

## Operations

`GET /healthz` (liveness) · `GET /readyz` (database reachable) · `GET /metrics` (Prometheus; restrict at the edge).
