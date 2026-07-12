# Issue 008 Reproduction Report

## Status

`NOT_REPRODUCED`

## Disposition

The issue is explicitly disposed as **not reproduced** on the recorded runtime and lockfile state.
The built Zentra CLI emitted no `DEP0169` warning and no other standard-error output when invoked directly with Node.
No dependency, package manifest, source file, TypeScript configuration, or lockfile was changed.

## Environment

- Branch: `fix/predeploy-c0-deprecation`
- Node version: `v24.2.0`
- pnpm version: `10.0.0`
- Lockfile digest before install and build: `7891f8a50c858861b4400d21aa8fbf4b47bd7c48  pnpm-lock.yaml`
- Lockfile digest after install, build, and reproduction: `7891f8a50c858861b4400d21aa8fbf4b47bd7c48  pnpm-lock.yaml`

The digest was produced by `shasum pnpm-lock.yaml`.

## Commands Run

The following commands were run from the repository worktree in this order:

```text
git status --short --branch
node --version
pnpm --version
shasum pnpm-lock.yaml
git status --short
git diff -- package.json pnpm-lock.yaml
pnpm install --frozen-lockfile
pnpm build
git status --short
shasum pnpm-lock.yaml
git diff -- package.json pnpm-lock.yaml
node --trace-deprecation dist/src/cli/main.js --help
node --trace-deprecation dist/src/cli/main.js --help > /var/folders/10/9mqn0tw54gg6j709prq0ytv40000gn/T/opencode/issue-008-stdout.txt 2> /var/folders/10/9mqn0tw54gg6j709prq0ytv40000gn/T/opencode/issue-008-stderr.txt
wc -c /var/folders/10/9mqn0tw54gg6j709prq0ytv40000gn/T/opencode/issue-008-stdout.txt /var/folders/10/9mqn0tw54gg6j709prq0ytv40000gn/T/opencode/issue-008-stderr.txt
```

The second traced invocation used the same Node executable and argument sequence as the required command, with shell redirection only to retain stdout and stderr separately.
Both traced invocations had the same result.

## Captured Standard Output

The full stdout from the separately captured traced invocation was:

```text
Usage: zentra [options] [command]

Run the deterministic local Zentra MVP orchestrator.

Options:
  -h, --help         display help for command

Commands:
  project            Manage project configuration.
  task               Run and inspect deterministic tasks.
  recover [options]  Inspect one task and return its safe recovery
                     classification.
  help [command]     display help for command
```

The captured stdout size was 414 bytes.

## Captured Standard Error

The full stderr from the separately captured traced invocation was:

```text
```

The captured stderr file was empty and had a size of exactly 0 bytes.
No `DEP0169` warning was emitted by `node dist/src/cli/main.js`.

## Dependency And Git State Confirmation

Before installation, `git status --short` and `git diff -- package.json pnpm-lock.yaml` produced no output.
After `pnpm install --frozen-lockfile` and `pnpm build`, both commands again produced no output.
The lockfile digest remained `7891f8a50c858861b4400d21aa8fbf4b47bd7c48` throughout the procedure.
The only intended final worktree change is this reproduction report.
`package.json` and `pnpm-lock.yaml` remain unchanged.
