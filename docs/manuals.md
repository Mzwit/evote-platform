# Manuals

## 1. Voter guide (plain language; for translation into siSwati)

**Before election day:** register at a registration centre with your national ID. You choose a password there, and your mobile number is recorded for the voting code.

**To vote:**
1. Open the official voting address on your phone, tablet or computer. Check the address is exactly the one the Elections and Boundaries Commission announced.
2. Choose **Vote**. Enter your national ID number and password.
3. Enter the 6-digit code sent to your phone by SMS. Never tell anyone this code.
4. Choose **Start voting**. Each screen shows one contest. Tap the candidate you want, or choose "I do not want to choose in this contest".
5. Check your choices. You can change them until you press **Cast my vote**.
6. Press **Cast my vote** and wait. If many people are voting, you will see a waiting message: keep the page open and it will continue by itself.
7. Write down your **tracking code**. You can use it later under **Check my receipt** to see that your ballot was recorded.

**Remember:** the tracking code does not show how you voted, and nobody can use it to find out. If anyone asks to see your vote or offers you anything for it, report them. If something goes wrong, call the help desk or vote at your polling station.

## 2. Administrator manual

**Roles.** SUPER_ADMIN manages accounts only. NATIONAL_ADMIN configures elections and approves state changes. REGISTRATION_OFFICER registers voters (a second officer approves). AUDITOR verifies results and the audit log. SECURITY_OFFICER can co-approve suspensions. OBSERVER has read-only access. TRUSTEE takes part in the key ceremony. No account may hold SUPER_ADMIN together with an election role.

**Setting up an election.**
1. Officials → Elections → Create election (name, opening and closing time).
2. Add each inkhundla (code, name, region), then contests (e.g. Member of Parliament, Indvuna yeNkhundla, Bucopho), then candidates per inkhundla and contest.
3. Check the ballot carefully. **After publication nothing on the ballot can be changed**; the database refuses it.
4. Publish: two National Admins approve, each giving a reason. Publication freezes the voter roll and generates the keys. The **trustee shares are shown once**. Hand one to each trustee in person, on paper or a hardware token, in front of observers. Then press "I have distributed them".
5. Open: two National Admins approve at the official opening time.

**During voting.** Watch turnout and reconciliation on the election page and in Grafana. Record any incident under Incidents. To suspend, a National Admin or Security Officer requests it and a second one approves.

**Closing and counting.**
1. Close: two National Admins approve. Voters already mid-ballot get a short grace period (default 120 s).
2. After the grace period the trustees meet. The recommended method is the offline CLI on an air-gapped machine: `node server/src/ceremony.ts --election <id>`. In the web console, trustees can instead enter shares under Trustee ceremony, but the admin service must then run as a single instance.
3. Results appear as **PRELIMINARY**. The auditor recounts from the published decrypted ballots and checks reconciliation, then the auditor and a National Admin approve **verify**. Two National Admins approve **declare**.

**Voter registration.** Officer 1 registers the voter, and the system warns about possible duplicates (same name and date of birth). Officer 2 checks the documents and approves. Status changes (suspend, remove) need a reason and are audit-logged.

## 3. Election-day operations runbook

| Time | Task | Owner |
| --- | --- | --- |
| D-7 | Full rehearsal: mock election, load test at planned peak, failover drill, backup restore | Operations, auditor |
| D-1 | Freeze changes (no deployments). Verify backups. Confirm the DDoS provider is on alert. Check SMS gateway capacity | Operations lead |
| 06:00 | All dashboards green. Synthetic voter journeys pass from inside Eswatini. Help desk staffed | Operations |
| 07:00 | Two officials **open** the election. Announce on official channels | National Admins |
| Hourly | Publish board head hash and turnout. Observers compare their mirrored board | Operations, observers |
| Continuous | Alerts: cast errors, cast p95 > 500 ms, waiting room > 1,000, board lag. Act per the incident table in `backup-recovery.md` | Security officer |
| 18:00 | Two officials **close**. Grace period. Final board head hash published | National Admins |
| 18:30 | Trustee ceremony (recorded, observers present). Preliminary results | Trustees, auditor |
| D+1 | Independent recount from published data. Verify, then declare | Auditor, National Admins |
| D+7 | Incident review; data-retention actions per law | EBC |

**Paper fallback:** every polling station keeps paper ballots. If remote voting is suspended for more than a period set by the EBC, voters are directed to polling stations. Anyone who received a token but whose cast did not complete may cast a provisional paper ballot, handled under the EBC's procedure.

## 4. Deployment and maintenance guide

- **Pilot (one machine):** copy `.env.example` to `.env`, fill in every secret (`openssl rand -base64 32`), add a TLS certificate to `infra/haproxy/certs/site.pem`, then run `docker compose up -d --build`. Create the first SUPER_ADMIN with a one-off SQL insert by the DBA, recorded in the audit file.
- **National:** two K3s clusters (sites A and B), Patroni PostgreSQL (`infra/postgres/patroni.yml`), pgBackRest with object-locked storage, OpenBao for secrets, an HAProxy ingress behind the DDoS provider, and Prometheus/Grafana with `infra/monitoring/alerts.yml`. Apply `infra/k8s/evote.yaml` after pinning image digests.
- **Updates:** only between elections. Every change goes through CI (tests, bundle budget, audit, Trivy, SBOM) and a signed image. Database changes are new numbered migrations, never edits to old ones.
- **Secrets rotation:** session secret and OTP pepper rotate between elections. Signing keys are per election by design.
- **Data retention:** follow the law. Ballots and the board are retained for the legal challenge period, then archived or destroyed under the auditor's supervision. Identity-side issuance logs follow the same schedule.
