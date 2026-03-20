# APEX Protocol Technical Advisory Committee Charter

**Version:** 1.0  
**Status:** Draft  
**Date:** 2026-03-10

---

## 1. Purpose

The APEX Protocol Technical Advisory Committee (APEX TAC) governs the evolution of the APEX Protocol open specification. It exists to ensure the spec serves the entire ecosystem — brokers, agent developers, and end clients — and is not captured by any single participant's interests.

The APEX Standard founding team retains operational control during the founding period. The spec itself is governed by the APEX TAC.

---

## 2. Separation of Concerns

| Asset | Governed by | Notes |
|-------|-------------|-------|
| APEX Protocol Specification | APEX TAC | Open source, CC-BY 4.0 |
| Reference Implementation | APEX TAC | Apache 2.0 |
| Conformance Test Suite | APEX TAC | Apache 2.0 |

---

## 3. APEX TAC Composition

### Founding Period (v0.x)

During the founding period, the APEX TAC consists of the founding team members plus up to three external advisors from broker or agent developer participants.

This lighter structure reflects the early-stage nature of the spec and the need for rapid iteration.

### Post-Launch (v1.0+)

Following the v1.0 release and at least five active broker implementations, the APEX TAC expands to:

- **2 seats** — APEX Standard founding team (permanent, non-voting on spec disputes)
- **3 seats** — Broker participants (elected by broker member organisations annually)
- **2 seats** — Agent developer community (elected annually)
- **1 seat** — Independent technical expert (appointed by consensus)

Total voting members: 6 (founding team seats are non-voting on spec disputes to prevent capture).

---

## 4. Decision Making

### Consensus Process

All spec changes are proposed as RFCs (Requests for Comment) in the public GitHub repository. The comment period is a minimum of 14 days for minor changes and 30 days for major changes.

APEX TAC members vote: **Approve / Reject / Abstain**. A change is accepted with 4+ approvals and no more than 1 rejection.

### Fast Track

Security fixes and editorial corrections may be fast-tracked with 3 APEX TAC approvals and a 48-hour comment window.

### Veto

Any APEX TAC member may invoke a veto on a change they believe would harm ecosystem integrity. A vetoed change requires a full APEX TAC re-vote with 5+ approvals to override.

---

## 5. RFC Process

1. **Draft** — Author opens a GitHub issue with label `rfc-draft` and a proposal document
2. **Discussion** — Community comment period (14-30 days)
3. **APEX TAC Review** — APEX TAC formally reviews and votes
4. **Accepted / Rejected** — Decision recorded in the RFC document
5. **Implementation** — Accepted RFCs are assigned to a release milestone
6. **Published** — Included in next spec release

RFC documents live in `governance/rfcs/` and are never deleted (rejected RFCs are marked rejected and retained for historical record).

---

## 6. Versioning Policy

APEX Protocol uses semantic versioning: `MAJOR.MINOR.PATCH`

- **PATCH** — Clarifications, editorial corrections, non-normative changes. APEX TAC fast-track.
- **MINOR** — New optional capabilities, new profiles, additive extensions. Full RFC process.
- **MAJOR** — Breaking changes to core. Full RFC process + extended 60-day comment period.

Brokers are given a minimum 12-month deprecation window for any breaking change.

### Compatibility Promise

> A broker implementation conforming to APEX Protocol `1.x.x` will interoperate with any agent implementation conforming to APEX Protocol `1.x.x`, regardless of MINOR version differences.

---

## 7. Intellectual Property

Contributions to the APEX Protocol specification are licensed under Creative Commons Attribution 4.0 (CC-BY 4.0).

Contributors must sign a Contributor License Agreement (CLA) confirming they have the right to contribute the submitted material and grant the necessary licenses.

The APEX Standard project does not assert patent rights over spec-compliant implementations.

---

## 8. Code of Conduct

APEX TAC members and community contributors are expected to engage constructively and in good faith. The APEX TAC may remove members who repeatedly act contrary to the ecosystem's interests.

---

## 9. Amendments

Amendments to this charter require a unanimous APEX TAC vote.
