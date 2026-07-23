# Zentra

Zentra is a local software-development orchestrator.
It coordinates bounded work and keeps durable evidence.

Zentra provides two main paths:

- A local service with a browser UI and CLI controls.
- A fixed OpenCode milestone workflow for trusted projects.

The current release is a Trusted-Project MVP.
It is not a multi-tenant sandbox.

## Requirements

- macOS on Apple Silicon.
- Node.js 24, 25, or 26.
- pnpm 10.
- Git.

See [platform support](docs/release/support-policy.md) for exact limits.

## Install

The package is not published to npm.
Build and install a local package tarball.

```bash
pnpm install
pnpm build
pnpm package:verify
pnpm package:contents
npm pack --pack-destination /absolute/path/to/artifacts
```

Install the tarball in a consumer project.

```bash
mkdir /absolute/path/to/consumer
cd /absolute/path/to/consumer
npm init -y
npm install /absolute/path/to/artifacts/zentra-0.1.0.tgz
./node_modules/.bin/zentra --help
```

Use this form in an installed project:

```bash
./node_modules/.bin/zentra <command>
```

Use this form in the Zentra source checkout:

```bash
pnpm start -- <command>
```

## Start The UI

Run Zentra from a trusted Git project.

```bash
zentra start
```

Zentra prints a private local session URL.
It opens the browser when the terminal is interactive.

Use `--project` from outside the project.

```bash
zentra start --project /absolute/path/to/project
```

Keep this process running while using the UI.
Press `Ctrl-C` to stop it.

The UI can:

- Submit an inline goal.
- Submit a ticket directory.
- List and inspect workflow runs.
- Show source and provenance.
- Show analysis and planning state.
- Show the authority envelope.
- Answer questions.
- Approve or reject plans.
- Cancel runs.
- Embed live AgentTrail evidence.

## Run From The CLI

Start the service first.
Then use another terminal in the same Git project.

```bash
zentra run "Update the greeting"
zentra list
zentra status <run-id>
```

The service and CLI share the project runtime.
State is stored under `.zentra/` in the project root.

## Commands

| Command | Purpose |
| --- | --- |
| `zentra start` | Start the local service, UI, scheduler, and AgentTrail. |
| `zentra run` | Submit an inline goal or ticket directory. |
| `zentra list` | List workflow runs. |
| `zentra status` | Inspect one workflow run. |
| `zentra cancel` | Cancel one workflow run. |
| `zentra question` | Answer or reject a workflow question. |
| `zentra plan` | Approve or reject a workflow plan. |
| `zentra project validate` | Validate project configuration. |
| `zentra policy preview` | Validate model and security sheets. |
| `zentra milestone` | Run or inspect installed OpenCode milestones. |
| `zentra capsule conformance` | Test the Docker capsule boundary. |
| `zentra github` | Dispatch or reconcile exact GitHub effects. |
| `zentra journal` | Manage journal retention and recovery. |
| `zentra task` | Run or inspect the deterministic tracer bullet. |
| `zentra recover` | Classify task recovery state. |
| `zentra recover-apply` | Apply an authorized recovery completion. |

See the [command reference](docs/commands.md) for every command and option.

## Project Configuration

Operational workflows use a JSON project file.
All paths must be absolute.

```json
{
  "projectId": "example-project",
  "repositoryPath": "/absolute/path/to/example-project",
  "integrationBranch": "zentra/integration",
  "worktreeRoot": "/absolute/path/to/zentra-worktrees",
  "validations": {
    "focused": ["/canonical/path/to/node", "--test", "test/greeting.test.mjs"],
    "full": ["/canonical/path/to/node", "--test"],
    "focusedTimeoutMs": 30000,
    "fullTimeoutMs": 300000
  }
}
```

The executable must be the canonical Node.js executable running Zentra.
Validation commands run without a shell.
They still use the current user's operating-system authority.

Validate the file before use.

```bash
zentra project validate --config /absolute/path/to/zentra.project.json
```

## Logs And Evidence

The local service stores its data here:

| Path | Content |
| --- | --- |
| `.zentra/events.sqlite` | Authoritative event journal. |
| `.zentra/traces/*.jsonl` | AgentTrail projections. |
| `.zentra/runtime/` | Private service discovery state. |

The UI embeds AgentTrail from the current service trace.
AgentTrail is read-only.
The SQLite journal remains authoritative.

Some operational commands accept `--agent-tail-jsonl`.
Those commands write a separate retained trace.
See the [logging guide](docs/commands.md#logging).

## 24-Hour Soak

The soak harness is a separate source-checkout tool.
It is not a `zentra` CLI command.
It is not shown in the live UI today.

See [UI, AgentTrail, and soak testing](docs/soak-and-ui.md).

## Verify The Repository

```bash
pnpm test
pnpm check
pnpm build
pnpm package:verify
pnpm package:contents
pnpm start -- --help
```

## Security

Use Zentra only with projects you control and trust.
Workers do not inherit arbitrary parent secrets.
Zentra does not expose a general shell capability.
Configured validations run with the same operating-system authority as the user.
The executable allowlist is not a filesystem sandbox.
Do not use hostile repositories.

Repository owner Md Talib explicitly accepted this authority model on 2026-07-12.

Read [SECURITY.md](SECURITY.md) before operational use.
