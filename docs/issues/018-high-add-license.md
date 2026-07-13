# 018 - Add License

Severity: High.
Status: Blocked on human license decision.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Human licensing decision, root license text, and package SPDX metadata.
Dependencies: A human license selection.
Conflicts and serialization notes: Use the C2 package-metadata writer after a human decision, and run issue 019's license-inclusion verification after the license lands without adding a reverse dependency.

## Problem

The repository and package do not state a software license.
Recipients cannot determine their legal permissions to use, modify, or redistribute the deployable CLI.

## Repository Evidence

`package.json:1-37` contains no `license` field.
No `LICENSE`, `LICENSE.md`, or `LICENSE.txt` file exists at the repository root.
`README.md:1-155` contains no licensing section or reference.

## Failure Sequence Or User Impact

A package or release artifact is distributed to an operator or contributor.
The artifact contains no grant of rights and no SPDX metadata.
Use and redistribution become legally ambiguous, and automated compliance tooling reports missing license information.

## Acceptance Criteria

- [ ] The repository owner explicitly selects the license rather than an agent inferring one.
- [ ] Add the canonical license text in a root `LICENSE` file with any required copyright holder and year.
- [ ] Add the exactly matching SPDX identifier to package metadata.
- [ ] Include the license in every packed or released artifact and reference it from the README.
- [ ] If the selected terms are not represented by one SPDX identifier, use standards-compliant metadata and document the exception.

## Required Tests

- [ ] Add package-content verification that the root license is present in the tarball.
- [ ] Add metadata validation that the SPDX expression matches the selected license.
- [ ] Run the project's selected license or package compliance checker.

## Final Verification

Obtain explicit human confirmation of the license choice.
Compare `LICENSE`, package metadata, README language, and release artifact contents for exact agreement.
Run `pnpm test`, `pnpm check`, and the package dry run.

## Non-Goals

This issue does not provide legal advice.
This issue does not select a license without repository-owner approval.
This issue does not add contributor agreements or trademark policies unless separately requested.
