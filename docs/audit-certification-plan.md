# Independent audit and certification plan (Phase 14)

The system is a **prototype**. It may be described as "certified" or "election-ready" only after every gate below is passed and signed off by the named independent party.

| # | Gate | Independent party | Evidence required |
| --- | --- | --- | --- |
| 1 | Legal authorisation of the voting mode (A pilot, B supervised, C remote) | EBC legal counsel; Attorney General's office | Written legal opinion; regulations if needed |
| 2 | Privacy impact assessment | Data-protection authority or qualified assessor | PIA report; data-residency decision |
| 3 | Verifiable tally integration (Belenios / ElectionGuard) | Election-technology team, then reviewers in gate 4 | Working integration; independent verifier recounts a test election |
| 4 | Cryptographic review | Academic cryptographers with no stake in the project | Review report; all high findings fixed |
| 5 | Source-code security review and penetration test | Accredited security firm | Report; retest showing fixes |
| 6 | Load and resilience demonstration (10k → 500k, failover, spike) | Independent test lab or auditor observing | k6 reports, failover drill logs, reconciliation evidence |
| 7 | Accessibility audit (WCAG 2.2 AA) with disabled users | Accessibility organisation | Audit report; usability sessions in English and siSwati |
| 8 | siSwati translation approval | Qualified translator approved by EBC | Signed translation |
| 9 | Operational readiness | EBC operations + auditor | Rehearsed runbooks, trained staff, help desk, paper fallback |
| 10 | Public mock election | Observers, civil society, media | Published results, board, recount by an independent party |
| 11 | Certification decision | Legally competent authority | Formal certification |

**Ongoing during every real election:** observers mirror the bulletin board; the auditor holds a verify vote; there is a post-election independent recount from published data; incidents are disclosed.
