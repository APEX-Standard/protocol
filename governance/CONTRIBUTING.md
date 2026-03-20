# Contributing to APEX Protocol

Thank you for your interest in contributing to APEX Protocol. This document covers how to propose changes, report issues, and participate in the RFC process.

---

## Types of Contribution

### Bug Reports & Clarifications

If you find an error, ambiguity, or inconsistency in the spec, open a GitHub issue with label `spec-clarification`. These are addressed via fast-track PATCH releases.

### New Capabilities or Profiles

If you want to propose a new tool, extend an existing profile, or introduce a new asset class profile, follow the RFC process below.

### Reference Implementation

Code contributions to the reference implementation follow standard GitHub pull request workflow. All PRs require one APEX TAC member review.

### Conformance Tests

New conformance test cases are always welcome. Open a PR against the `conformance/` directory.

---

## RFC Process

### Step 1: Check Existing Proposals

Before drafting an RFC, search existing issues and the `governance/rfcs/` directory for related proposals. It's better to comment on an existing RFC than to create a duplicate.

### Step 2: Open a Draft Issue

Open a GitHub issue with:
- Label: `rfc-draft`
- Title: `RFC: [Short description of proposal]`
- Body: Brief description of the problem being solved and proposed approach

This invites early feedback before you invest time in a full document.

### Step 3: Write the RFC Document

Create a file in `governance/rfcs/` named `RFC-{number}-{short-title}.md` using the template below.

### Step 4: Submit Pull Request

Open a PR with your RFC document. Label it `rfc`. This starts the formal comment period.

### Step 5: Comment Period

- **Minor changes** (new optional tool, profile extension): 14 days
- **Major changes** (new core tool, breaking change): 30 days

Engage with feedback. Revise your RFC as needed.

### Step 6: APEX TAC Vote

After the comment period, the APEX TAC votes. You will be notified of the decision in the PR.

### Step 7: Implementation

Accepted RFCs are assigned to a milestone. You are welcome to implement your own RFC — this is encouraged.

---

## RFC Template

```markdown
# RFC-{number}: {Title}

**Status:** Draft | Under Review | Accepted | Rejected  
**Author(s):** {names or GitHub handles}  
**Created:** {date}  
**Target Version:** {e.g. 0.2.0}

---

## Summary

One paragraph description of what this RFC proposes.

## Motivation

What problem does this solve? Who benefits? What is the cost of not doing this?

## Proposal

Detailed description of the change. Include:
- New/modified tool definitions with full input/output schemas
- Impact on existing implementations
- Migration path for breaking changes

## Alternatives Considered

What other approaches were evaluated and why were they rejected?

## Open Questions

List any unresolved questions that need community input.

## References

Links to related issues, prior art, or external standards.
```

---

## Contributor License Agreement

All contributors must sign the APEX Protocol CLA before their contributions can be merged. The CLA is lightweight — it confirms you have the right to contribute the submitted material.

CLA signing is handled via GitHub (automated bot on first PR).

---

## Questions?

Open a GitHub Discussion or reach out to the APEX TAC via the mailing list published in the repository.
