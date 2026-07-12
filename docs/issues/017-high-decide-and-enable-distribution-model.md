# 017 - Decide And Enable Distribution Model

Severity: High.
Status: Blocked on human distribution decision.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Distribution decision, package visibility, release automation, and installation documentation.
Dependencies: A human distribution-model decision and issues 016, 019, and 024.
Conflicts and serialization notes: C4 begins only after all dependencies are complete, and an agent must not select the distribution model.

## Problem

The repository has not selected a distribution model, while package metadata explicitly prevents npm publication.
Deployment cannot be repeatable until public npm, GitHub release tarballs, or a private distribution channel is chosen and automated.

## Repository Evidence

`package.json:2-5` names and versions the package but sets `private` to `true`.
`package.json:6-8` defines a package binary, indicating an intended installable artifact despite publication being disabled.
`README.md:19-33` documents only source checkout installation and execution.

## Failure Sequence Or User Impact

An operator attempts to deploy Zentra outside the source checkout.
No supported artifact location, authenticity procedure, version selection, or installation path exists.
An ad hoc tarball or local clone is used, making upgrades and rollback irreproducible.

## Acceptance Criteria

- [ ] A human selects exactly one initial model from public npm, GitHub release tarball, or private distribution.
- [ ] Metadata, access controls, provenance, checksums, versioning, installation, upgrade, and rollback procedures match the selected model.
- [ ] `private` is retained or removed intentionally according to the selected channel.
- [ ] Release automation consumes the verified package artifact from issues 016, 019, and 024 rather than rebuilding unverified content later.
- [ ] Documentation names the supported channel and rejects unsupported installation paths.

## Required Tests

- [ ] Add a release dry run that creates but does not publish the selected artifact.
- [ ] Install the dry-run artifact in a clean environment and verify its version and binary.
- [ ] Test channel-specific authentication or access failure without exposing secrets.

## Final Verification

Run the selected release workflow in dry-run mode from a tagged test version.
Verify artifact checksum, provenance, package metadata, installation, upgrade, and rollback instructions.
Confirm no command publishes unless an explicitly authorized release action is taken.

## Non-Goals

This issue does not make the human licensing decision from issue 018.
This issue does not publish the first production release by itself.
This issue does not support multiple channels initially unless a concrete requirement is approved.
