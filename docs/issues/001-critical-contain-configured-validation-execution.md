# 001 - Contain Configured Validation Execution

Severity: Critical.
Status: Blocked on trust-model decision.
Execution wave: Wave 1, Pod A.
Suggested owner scope: Validation policy, project configuration, validation runner, and security documentation.
Dependencies: A named human trust-model decision.
Conflicts and serialization notes: Serialize every shared edit with issue 023 in `src/projects/project-config.ts` and `src/capabilities/validation-runner.ts`, while issue 011 exclusively owns `src/workers/process-supervisor.ts` changes.

## Problem

Trusted project configuration currently permits arbitrary executable arrays that run with the user's host authority and without filesystem containment.
Rejecting shell wrappers does not enforce the repository file boundary because a directly invoked executable can read, write, or execute anywhere the user can.

## Repository Evidence

`src/projects/project-config.ts:50-81` strips an `env` prefix and rejects shell `-c` wrappers but accepts every other nonempty executable and argument array.
`src/capabilities/validation-runner.ts:119-144` copies the configured command and passes its executable, arguments, and canonical working directory directly to `ProcessSupervisor`.
`README.md:122-126` explicitly states that configured validation executables retain host filesystem authority and are unsafe for hostile configuration or repositories.

## Failure Sequence Or User Impact

An authorized or compromised project configuration names a direct executable outside an approved toolchain.
Zentra invokes that executable with the user's authority during focused or full validation.
The executable reads secrets or mutates files outside the assigned repository even though no shell wrapper was used.
The apparent no-general-shell guarantee therefore fails to enforce the documented file boundary.

## Acceptance Criteria

A named human must select one of the following closure paths, and an agent must not infer or invent that decision.

### Contained Mode

- [ ] A real OS-enforced sandbox or virtual-machine boundary limits validation code to explicitly granted repository resources.
- [ ] End-to-end tests prove repository-only filesystem authority and descendant-process containment against outside canaries.
- [ ] Executable identity, arguments, working directories, environment, network access, and inherited resources are constrained consistently with the documented boundary.
- [ ] Security documentation states the exact enforced boundary and its supported platforms.

### Trusted-Project MVP Mode

- [ ] A named human explicitly accepts that validation code executes with the host user's authority and is not filesystem-contained by executable validation.
- [ ] `AGENTS.md`, `README.md`, and all security claims state that host-user authority and do not describe the executable policy as containment.
- [ ] Hostile repositories and hostile or untrusted project configuration are explicitly prohibited.
- [ ] Deployment is restricted to owner-controlled projects.
- [ ] A strict exact-executable policy resolves and permits only approved executable identities to reduce accidental execution, without claiming to stop an approved executable from exercising host-user authority.
- [ ] Policy checks are canonical-path aware and reject relative, symlinked, `env`-prefixed, alternately spelled, or replaced executable identities before process creation.

## Required Tests

- [ ] Add project-configuration and runner tests for allowed executables and denied absolute, relative, symlinked, and `env`-prefixed alternatives under either closure path.
- [ ] In Contained Mode, add an end-to-end test proving validation code and descendants cannot read or modify a canary outside the granted repository boundary.
- [ ] In Trusted-Project MVP Mode, test exact-executable rejection and documentation consistency without asserting filesystem containment.
- [ ] Add regression tests showing focused and full validation still run through the same policy.
- [ ] Run the issue 011 descendant tests and issue 023 timeout tests against allowed validation processes.

## Final Verification

Run `pnpm test`, `pnpm check`, and `pnpm build`.
Run the packaged CLI against an allowed project and against a denied executable and verify executable-policy denial occurs before process creation.
Review `AGENTS.md`, `README.md`, and security language against the human-selected guarantee rather than treating `shell: false` or an allowlist as containment.

## Non-Goals

This issue does not let an agent choose between Contained Mode and Trusted-Project MVP Mode.
This issue does not claim that an executable allowlist provides filesystem containment or supports untrusted repositories.
This issue does not add distributed, multi-user, or container orchestration.
This issue does not broaden the set of validation tools beyond those explicitly selected for the trusted MVP.
