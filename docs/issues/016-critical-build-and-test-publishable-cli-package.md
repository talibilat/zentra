# 016 - Build And Test Publishable CLI Package

Severity: Critical.
Initial status: Open.
Current disposition: Implemented and verified; see `docs/execution/issue-016-implementation-report.md`.
Execution wave: Wave 1, Pod C.
Suggested owner scope: Production build, package lifecycle, tarball installation, and binary end-to-end testing.
Dependencies: None.
Conflicts and serialization notes: Use the C1 package/build writer, integrate issue 016 before issue 019, start issue 024 only after its package prerequisites, and start issue 012 only after this packaged fixture layout is integrated.

## Problem

The package binary points at generated `dist` output, but package creation does not guarantee a production build and a clean `npm pack` omits a runnable CLI.
Source-checkout success therefore does not prove that the distributable package works.

## Repository Evidence

`package.json:6-8` maps the `zentra` binary to `./dist/src/cli/main.js`.
`package.json:9-15` defines `build` and `start` but no `prepack`, `prepare`, or package verification lifecycle.
`tsconfig.json:6-7` generates `dist` only when TypeScript compilation is run explicitly.
`README.md:23-33` instructs source users to build before running, which does not make a clean packed artifact self-building or prebuilt.

## Failure Sequence Or User Impact

A release job or developer runs `npm pack` from a clean checkout where ignored `dist` does not exist.
The tarball advertises a `zentra` binary whose target is absent.
Installation succeeds or partially succeeds, but invoking `zentra --help` fails with a missing module.

## Acceptance Criteria

- [ ] Add a dedicated production build that emits the runtime CLI, required modules, declarations only if intended, and bundled runtime fixtures in a deterministic layout.
- [ ] Configure package lifecycle scripts so a clean package operation builds before tarball contents are selected.
- [ ] Fail package creation when the binary target or required fixture is missing.
- [ ] Install the generated tarball into an empty temporary consumer project and run the package binary without repository-relative files.
- [ ] Test operational execution, not only `--help`, from the installed tarball.

## Required Tests

- [ ] Add a clean-checkout package end-to-end test that removes generated output, packs, installs, and invokes the binary.
- [ ] Verify shebang, executable mode, ESM imports, native `better-sqlite3`, and fixture lookup from the installed package.
- [ ] Add a negative test proving packaging fails when required production output is absent or stale.

## Final Verification

Run a frozen install, production build, `npm pack --dry-run`, real pack, empty-directory install, `zentra --help`, and one deterministic task command.
Run `pnpm test`, `pnpm check`, and the exact release build command.
Inspect the tarball rather than relying on the source working tree.

## Non-Goals

This issue does not choose the distribution channel, which belongs to issue 017.
This issue does not publish a release.
This issue does not include tests or internal planning documents in the production tarball unless explicitly required.
