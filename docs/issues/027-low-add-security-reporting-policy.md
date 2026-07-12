# 027 - Add Security Reporting Policy

Severity: Low.
Status: Blocked on human-approved reporting route.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Security reporting policy, supported versions, vulnerability scope, and response expectations.
Dependencies: A human-approved private reporting route.
Conflicts and serialization notes: Use one C2 owner after a human approves the reporting route, and serialize any shared supported-version documentation file with issues 017 and 020.

## Problem

The repository has no security reporting policy or private vulnerability contact path.
Researchers and operators have no documented way to report sensitive findings without opening a public issue.

## Repository Evidence

No `SECURITY.md` file exists at the repository root or under `.github/`.
`README.md:112-126` describes the security boundary but provides no reporting route.
`package.json:1-37` provides no repository, bugs, or security contact metadata.

## Failure Sequence Or User Impact

A researcher discovers a validation escape, Git integrity flaw, secret exposure, or package compromise.
The repository offers only public collaboration channels or no channel at all.
The researcher either discloses sensitive details publicly or abandons the report, delaying containment.

## Acceptance Criteria

- [ ] Add `SECURITY.md` with a human-approved private reporting route that is actively monitored.
- [ ] State supported versions or branches and how unsupported versions are handled.
- [ ] Define in-scope security boundaries, including execution containment, repository escapes, Git integrity, secret exposure, journal integrity, package supply chain, and dependency vulnerabilities.
- [ ] Set acknowledgement, triage, status-update, remediation, and coordinated-disclosure expectations without making unrealistic guarantees.
- [ ] Explain what information reporters should include and what sensitive information must not be posted publicly.

## Required Tests

- [ ] Validate every reporting URL or address and confirm the private route can receive a test report.
- [ ] Verify the policy is included in the selected repository and release surfaces.
- [ ] Review supported-version and platform statements against issues 017 and 020.

## Final Verification

Obtain human approval for the contact route and response expectations.
Send a harmless test report through the private channel and confirm receipt by the intended maintainers.
Run link and Markdown checks and inspect the packed or release documentation surface where applicable.

## Non-Goals

This issue does not promise bug bounties or fixed remediation deadlines without an approved program.
This issue does not disclose active vulnerabilities publicly.
This issue does not replace incident-response or release-signing procedures.
