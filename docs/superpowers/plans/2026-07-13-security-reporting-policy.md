# Security Reporting Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and verify a private security-reporting policy for Zentra in the repository and local package artifact.

**Architecture:** A root `SECURITY.md` is the single policy source and GitHub private vulnerability reporting is the single private route. The existing explicit npm package allowlist and deterministic package-content verifier carry the same file into local tarballs.

**Tech Stack:** Markdown, npm package metadata, Node.js package verification, GitHub REST API through `gh`.

## Global Constraints

Only the current `main` branch is supported until Zentra has an approved release channel.
The approved private route is `https://github.com/talibilat/zentra/security/advisories/new`.
Response targets are acknowledgement within 3 business days, initial triage within 10 business days, and an update at least every 10 business days while a report remains active.
Targets are not guarantees, and the policy must not promise a bug bounty or fixed remediation deadline.
The supported runtime remains Node.js `>=24 <27` on macOS Apple Silicon (`darwin`/`arm64`).
Do not commit unless the user explicitly requests a commit.

---

### Task 1: Publish And Verify The Security Policy

**Files:**
- Create: `SECURITY.md`
- Modify: `package.json:10-15`
- Modify: `scripts/verify-package-contents.mjs:132-180`

**Interfaces:**
- Consumes: GitHub private vulnerability reporting for `talibilat/zentra` and the existing `npm pack` allowlist.
- Produces: A GitHub-discoverable policy and a deterministic package artifact containing `SECURITY.md`.

- [ ] **Step 1: Make the package-content check require the policy**

Add `SECURITY.md` to both source-copy and expected-manifest lists in `scripts/verify-package-contents.mjs`:

```js
  const sourceFiles = [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "SECURITY.md",
    "tsconfig.json",
    "tsconfig.build.json",
  ].map((name) => [name, validatePackageFile(name).absolutePath]);
```

```js
  const expected = [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    ...walkFiles(path.join(sourceRoot, "dist")).map((file) => relativePath(sourceRoot, file)),
    "fixtures/deterministic-worker.mjs",
    "package.json",
  ].sort();
```

- [ ] **Step 2: Run the package-content check and verify it fails**

Run: `pnpm package:contents`

Expected: FAIL because root `SECURITY.md` does not exist.

- [ ] **Step 3: Add the policy**

Create `SECURITY.md` with this content:

```markdown
# Security Policy

## Supported Versions

Until Zentra has an approved release channel, only the current `main` branch receives security fixes.
Older commits, tags, forks, unsupported platforms, and unsupported runtimes do not receive security fixes.
Reports affecting unsupported versions are still useful and will be assessed against `main`.

The supported platform and runtime boundary is documented in [MVP Platform And Runtime Support](https://github.com/talibilat/zentra/blob/main/docs/release/support-policy.md).

## Reporting A Vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/talibilat/zentra/security/advisories/new).
Do not disclose sensitive details in a public issue, discussion, pull request, commit, or other public channel before coordinated disclosure.

Include:

- A clear description of the issue and its impact.
- Reproduction steps or a minimal proof of concept.
- The affected commit, component, platform, and runtime.
- Relevant logs or evidence with secrets and personal data removed.
- Any known mitigations or suggested fixes.

Do not submit live credentials, access tokens, personal data, production secrets, or data belonging to other people.
Use synthetic or redacted evidence whenever possible.

## Scope

Security reports may include:

- Execution-containment failures or unintended process authority.
- Writes or effects escaping the assigned repository or worktree.
- Git ref, hook, integration, or repository-integrity failures.
- Secret exposure through subprocess environments, logs, errors, artifacts, or journals.
- Event-journal tampering, corruption, or integrity failures.
- Package build, provenance, artifact, or other supply-chain compromise.
- Exploitable vulnerabilities in direct or transitive dependencies.

The documented Trusted-Project MVP boundary is not a sandbox guarantee.
Hostile repositories, hostile project configuration, hostile validation code, multi-user operation, and access available to the operating-system user are unsupported unless the report demonstrates behavior beyond the documented boundary.

## Response And Disclosure

Maintainers aim to acknowledge a report within 3 business days, complete initial triage within 10 business days, and provide an update at least every 10 business days while the report remains active.
These are targets, not guarantees.

Remediation timing depends on severity, exploitability, complexity, and release readiness.
Maintainers will coordinate disclosure with the reporter after a fix or mitigation is ready, or agree on another disclosure date when appropriate.
This policy does not promise a bug bounty or a fixed remediation deadline.
```

- [ ] **Step 4: Add the policy to the package allowlist**

Add `SECURITY.md` to `package.json`:

```json
  "files": [
    "dist/",
    "fixtures/deterministic-worker.mjs",
    "README.md",
    "SECURITY.md",
    "LICENSE"
  ],
```

- [ ] **Step 5: Run the focused package check**

Run: `pnpm package:contents`

Expected: PASS and report a deterministic package file count with `SECURITY.md` included.

- [ ] **Step 6: Enable and verify GitHub private vulnerability reporting**

Run: `gh api --method PUT repos/talibilat/zentra/private-vulnerability-reporting`

Expected: successful response.

Run: `gh api repos/talibilat/zentra/private-vulnerability-reporting --jq '.enabled'`

Expected: `true`.

- [ ] **Step 7: Send and receive a harmless private test report**

Run:

```bash
TEST_GHSA_ID="$(gh api --method POST repos/talibilat/zentra/security-advisories/reports \
  -f summary='Security reporting route test - no vulnerability' \
  -f description='Harmless end-to-end test of the approved private reporting route. This report describes no vulnerability and contains no sensitive data.' \
  -f severity='low' \
  --jq '.ghsa_id')" && \
gh api "repos/talibilat/zentra/security-advisories/$TEST_GHSA_ID" \
  --jq '[.ghsa_id, .state, .summary] | @tsv' && \
gh api --method PATCH "repos/talibilat/zentra/security-advisories/$TEST_GHSA_ID" \
  -f state='closed' \
  --jq '[.ghsa_id, .state] | @tsv'
```

Expected: the created report appears in `triage` state with the harmless summary, proving maintainers can receive it, followed by the same GHSA identifier in `closed` state.

- [ ] **Step 8: Validate links, Markdown, and all repository gates**

Run: `gh api repos/talibilat/zentra/contents/docs/release/support-policy.md?ref=main --jq '.path'`

Expected: `docs/release/support-policy.md`.

Run: `pnpm test`

Expected: PASS.

Run: `pnpm check`

Expected: PASS.

Run: `pnpm build`

Expected: PASS.

Run: `pnpm package:verify`

Expected: PASS.

Inspect `SECURITY.md` directly because the repository has no configured Markdown or link checker.

- [ ] **Step 9: Review the final diff**

Run: `git diff --check`

Expected: no output.

Run: `git diff -- SECURITY.md package.json scripts/verify-package-contents.mjs docs/superpowers/specs/2026-07-13-security-reporting-policy-design.md docs/superpowers/plans/2026-07-13-security-reporting-policy.md`

Expected: only the approved policy, package-surface changes, and design/plan documentation.
