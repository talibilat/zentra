# Security Policy

## Supported Versions

Only the current `main` branch is supported until an approved release channel exists.
Older commits, tags, forks, and unsupported platforms or runtimes receive no fixes, although reports are assessed against the current `main` branch.
The supported platform and runtime are Node.js `>=24 <27` on `darwin`/`arm64`.
See the [platform and runtime support policy](https://github.com/talibilat/zentra/blob/main/docs/release/support-policy.md) for details.

## Reporting A Vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/talibilat/zentra/security/advisories/new).
Do not disclose vulnerability details publicly in issues, discussions, pull requests, commits, or other public channels.
Include a description and potential impact, reproduction steps or a proof of concept, the affected commit and component, the platform and runtime, relevant redacted logs or evidence, and any known mitigations or fixes.
Do not submit live credentials, tokens, personal data, production secrets, or data belonging to other people.
Use synthetic or redacted evidence instead.

## Scope

Reports may cover:

- Execution containment failures or unintended process authority.
- Repository or worktree escapes.
- Git ref, hook, integration, or repository-integrity failures.
- Secret exposure through environments, logs, errors, artifacts, or journals.
- Event-journal tampering, corruption, or integrity failures.
- Package build, provenance, artifact, or supply-chain failures.
- Exploitable vulnerabilities in direct or transitive dependencies.

The Trusted-Project MVP is not a sandbox.
Hostile repositories or configuration, validation of hostile or untrusted projects, multi-user environments, and access by another operating-system user are unsupported unless the reported behavior exceeds the documented security boundary.

## Response And Disclosure

We target acknowledgement within 3 business days, initial triage within 10 business days, and an update every 10 business days while a report remains active.
These response targets are not guarantees.
Remediation timing depends on severity, exploitability, complexity, and release readiness.
We coordinate disclosure after a fix or mitigation is available, or on another date agreed with the reporter.
The project offers no bug bounty and promises no fixed remediation deadline.
