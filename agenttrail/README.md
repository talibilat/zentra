# AgentTrail Source Import

This directory contains Zentra's reviewed, reproducible AgentTrail source snapshot.

The user-facing product name is **AgentTrail**.
The upstream Python distribution and executable retain the compatibility name `agent-tail`.

## Compatibility

The imported parser preserves the versioned Agent Tail `1.x` event envelope used by Zentra's observability projection.
Importing the source grants no execution, repository, network, secret, or operating-system authority.
Any later sidecar integration must establish those capabilities separately.

## Reproduction

The authoritative source, commit, license decision, selected files, exclusions, individual content digests, and aggregate tree digest are recorded in `import-manifest.json`.
The importer reads blobs from the pinned Git commit rather than copying working-tree files.
It refuses dirty or mismatched source repositories.

From a clean checkout of the pinned upstream commit, verify the retained import with:

```bash
python3 agenttrail/import_agenttrail.py \
  --source /absolute/path/to/agent-trail \
  --check
```

Reproduce the snapshot in an empty directory with:

```bash
python3 agenttrail/import_agenttrail.py \
  --source /absolute/path/to/agent-trail \
  --destination /empty/agenttrail-upstream \
  --import-fresh
```

## Included Source

The import contains the MIT license, Python build metadata, production package, packaged browser UI, canonical feature documentation, Python tests, browser tests, fixtures, and performance workers.

Run the complete imported Python and browser suite from a disposable fresh import with:

```bash
python3 agenttrail/run_imported_tests.py \
  --source /absolute/path/to/agent-trail
```

The disposable test tree prevents bytecode, package metadata, and build output from contaminating the retained source snapshot.

## Exclusions

The import excludes upstream scratch and historical plans, repository-local Git configuration, upstream README, curated demos and their demo-only test, caches, bytecode, egg metadata, build output, distribution output, test caches, and local environment files.
These exclusions are product-import boundaries, not claims that excluded upstream content is unsafe.

## Darwin arm64 Package

`build-lock.json` pins the exact CPython executable digest, source manifest, entrypoint, hashed Python wheels, and PyInstaller dependency versions used for the self-contained Darwin arm64 executable.
Set `AGENTTRAIL_BUILD_PYTHON` only to the canonical absolute path of that exact pinned CPython build, then run `pnpm agenttrail:build`.
The build verifies the imported source manifest before invoking PyInstaller and installs every build dependency with pip `--require-hashes`.
It sets the reviewed deterministic inputs, packages the upstream browser asset, and writes `agenttrail/package/darwin-arm64/manifest.json` plus its sidecar attestation.

Run `pnpm agenttrail:reproducibility` explicitly to perform two clean builds and require identical package file sets, modes, and bytes on the supported build host.
This is same-host reproducibility evidence for the pinned toolchain and does not claim that PyInstaller output is identical across different macOS or toolchain environments.

Run `pnpm agenttrail:verify` to verify canonical paths, modes, source provenance, manifest and file digests, native arm64 Mach-O identity, and execution with no Python executable supplied by `PATH`.
Zentra re-runs equivalent attestation before every sidecar launch and supplies only fixed loopback serving arguments and a minimal environment.
Node on Darwin cannot execute the verified file descriptor directly: both a fixed inherited `/dev/fd/3` identity and the descriptor's actual inherited fd fail at exec with `EACCES`, and Node does not expose `fexecve`.
Zentra therefore keeps the verified private descriptor open, rechecks its digest and exact device/inode identity against the private `0700` pathname immediately before spawn, and rejects any observed replacement.
A malicious process already holding the same operating-system user authority could still race between that final identity check and pathname-based exec; this is a Trusted-Project same-user residual, not an absolute filesystem race elimination claim.
