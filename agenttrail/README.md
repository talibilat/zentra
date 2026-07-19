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
