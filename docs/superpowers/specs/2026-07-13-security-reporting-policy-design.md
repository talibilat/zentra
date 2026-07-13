# Security Reporting Policy Design

## Decision

Zentra will publish one root-level `SECURITY.md` and include it in local package tarballs.
GitHub private vulnerability reporting will be the only approved reporting route.

## Supported Source

Only the current default branch is supported until Zentra has an approved release channel.
Older commits, tags, forks, and unsupported platforms or runtimes do not receive security fixes.
Reports affecting unsupported versions remain useful and will be assessed against the supported branch.

## Policy Content

The policy will direct reporters to GitHub's private advisory form and tell them not to disclose sensitive details in public issues, discussions, pull requests, or other public channels.
It will request reproduction steps, impact, affected components and versions, environment details, supporting evidence, and suggested mitigations while warning reporters not to submit live credentials, personal data, or unnecessary secrets.

The policy will cover execution containment, repository and worktree escapes, Git integrity, secret exposure, journal integrity, package supply chain, and dependency vulnerabilities.
It will distinguish vulnerabilities from behavior already excluded by the Trusted-Project MVP boundary.

## Response Expectations

Maintainers will aim to acknowledge reports within 3 business days, complete initial triage within 10 business days, and provide an update at least every 10 business days while a report remains active.
These are targets rather than guarantees.
Remediation timing will depend on severity, exploitability, complexity, and release readiness.
Maintainers and reporters will coordinate public disclosure after a fix or mitigation is ready, or agree on another disclosure date when appropriate.

## Repository And Package Surfaces

The root location allows GitHub to discover the policy and keeps it visible in source checkouts.
`package.json` and the deterministic package-content verifier will include `SECURITY.md` in `npm pack` output.
The policy will link to the existing platform and runtime support document rather than duplicate its details.

## Verification

Enable GitHub private vulnerability reporting and confirm the repository reports it as enabled.
Open the private advisory form and submit a harmless test report, then confirm the intended maintainer receives it.
Run the repository's package-content verification and inspect the packed file list for `SECURITY.md`.
Run available Markdown and link checks, or inspect the policy directly if the repository has no configured checker.
