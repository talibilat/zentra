# MVP Platform And Runtime Support

## Supported Platform

The Zentra MVP supports only macOS on Apple Silicon, represented by npm platform identifiers `darwin` and `arm64`.
The package declares this boundary through `os: ["darwin"]` and `cpu: ["arm64"]`.
npm rejects unsupported target installations with `EBADPLATFORM` before Zentra is installed or an operational command can begin.

Local package, native-addon, CLI, Git, process-supervision, signal, filesystem, and SQLite evidence was produced on macOS 26.6 arm64.
This records the tested host; it does not establish a minimum or maximum macOS release.
No other macOS version or CPU architecture is claimed as tested by this issue.

Intel macOS, Linux, Windows, and every other operating-system or architecture combination are unsupported in the MVP.
Package-manager override flags do not convert an unsupported host into a supported deployment.

## Supported Node.js Versions

The exact Zentra engine range is `>=24 <27`, covering Node.js major versions 24, 25, and 26.
Node.js 27 and later are unsupported.
Strict engine enforcement rejects Node.js 27 with `EBADENGINE` before package installation proceeds.

The locked native dependency is `better-sqlite3` 12.11.1.
Its published package metadata declares `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`, which includes every Zentra-supported major and excludes Node.js 27.

Local clean-install, native-addon loading, SQLite, packed CLI help, test, typecheck, and build evidence is currently available for Node.js 24.2.0 only.
Node.js 25 and 26 were not installed on the implementation host and are not claimed as locally tested.
Issue 024 must run the exact Node.js 24, 25, and 26 matrix with frozen installation, native-addon loading, packed installation, CLI help, SQLite-backed operation, the complete test suite, typechecking, and production build.
It must also retain an expected strict-engine rejection check for Node.js 27.

## Widening Runtime Support

The upper bound may be widened only through an explicit compatibility issue after the candidate Node.js major is released and the complete matrix passes with the selected `better-sqlite3` release.
Dependency metadata alone is necessary but not sufficient evidence for runtime support.

## Widening Platform Support

Support may be widened only through an explicit compatibility issue and retained platform-specific evidence for all of the following:

- Process creation, process groups, cancellation, timeouts, signals, and descendant termination.
- Filesystem paths, symlinks, permissions, temporary directories, and worktree cleanup.
- Git worktree, ref, hook-suppression, merge, and compare-and-swap behavior.
- SQLite journal durability, restart recovery, and the native `better-sqlite3` addon.
- Clean package installation, packed CLI startup, and the complete test, typecheck, and production-build gates.

Passing on one platform or architecture must not be treated as evidence for another.
