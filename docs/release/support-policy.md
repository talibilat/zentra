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

## Widening Platform Support

Support may be widened only through an explicit compatibility issue and retained platform-specific evidence for all of the following:

- Process creation, process groups, cancellation, timeouts, signals, and descendant termination.
- Filesystem paths, symlinks, permissions, temporary directories, and worktree cleanup.
- Git worktree, ref, hook-suppression, merge, and compare-and-swap behavior.
- SQLite journal durability, restart recovery, and the native `better-sqlite3` addon.
- Clean package installation, packed CLI startup, and the complete test, typecheck, and production-build gates.

Passing on one platform or architecture must not be treated as evidence for another.
