# Zentra Local Development Orchestrator MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript orchestrator that durably executes one software-development ticket through worktree creation, deterministic worker execution, validation, independent review, integration, and evidence-backed completion.

**Architecture:** Zentra begins as one Node.js process with deep internal modules for contracts, event persistence, projections, project configuration, Git workspaces, supervised workers, validation, review, and integration.
The first tracer bullet uses a deterministic fixture worker rather than a real coding harness so the orchestration, authority, cancellation, recovery, and evidence contracts can be proven before provider-specific risk is introduced.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 10, Zod, better-sqlite3, Commander, Vitest, and native Git subprocesses invoked without a shell.

## Global Constraints

- Execute the implementation in this repository on an isolated feature worktree.
- Use Node.js 24 or newer and pnpm 10.
- Target macOS for the first process-supervision and Git integration implementation, with Linux and Windows conformance planned separately.
- Keep the kernel domain-neutral even though the first capability package is software development.
- Do not expose a general shell capability.
- Invoke subprocesses with executable and argument arrays and `shell: false`.
- Pass workers and validation commands an explicit minimal environment rather than inheriting the full parent environment.
- Keep the event journal as the source of truth and treat task views as rebuildable projections.
- Use only `completed`, `cancelled`, `denied`, `timed_out`, or `failed` as terminal task outcomes.
- Keep `blocked`, `awaiting_approval`, `interrupted`, and process exit as lifecycle states or causes.
- Distinguish immutable task and event history from disposable process and worktree state.
- Never retry a potentially effectful operation automatically after an uncertain result.
- Use one sentence per physical line in long Markdown documents.
- Do not add real OpenCode, Claude Code, Codex, remote execution, email, meeting, device, or distributed-worker integration in this MVP.

---

## Program Decomposition

The approved orchestrator design spans several independently deliverable subprojects.

This implementation plan covers only Subproject 1.

| Subproject | Outcome | Planned Separately |
| --- | --- | --- |
| 1. Local tracer bullet | One durable ticket reaches verified integration through deterministic local components | This plan |
| 2. Real harness containment | One supported coding harness runs in a reduced, cancellable development capsule | Yes |
| 3. Pod execution | Four agent roles coordinate one measurable outcome | Yes |
| 4. Multi-project operation | Project isolation, fair scheduling, and independent integration queues | Yes |
| 5. Twenty-agent scale | Backpressure, cost control, duplicate-work detection, and recovery | Yes |
| 6. Forty-agent scale | Failure-domain isolation, remote workers, and high-volume event processing | Yes |
| 7. Zoe workflow packages | Communication, meetings, personal operations, and devices | Yes |

---

## File Map

```text
zentra/
  .gitignore
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
  README.md
  src/
    contracts/
      ids.ts
      task.ts
      event.ts
      artifact.ts
    journal/
      journal.ts
      sqlite-journal.ts
    tasks/
      task-projection.ts
      task-service.ts
    projects/
      project-config.ts
      project-registry.ts
    workspaces/
      git-client.ts
      worktree-manager.ts
    workers/
      worker-adapter.ts
      process-supervisor.ts
    capabilities/
      validation-runner.ts
    reviews/
      reviewer-adapter.ts
      review-gate.ts
    integration/
      integration-queue.ts
    orchestration/
      tracer-bullet.ts
      recovery.ts
    cli/
      main.ts
  fixtures/
    deterministic-worker.mjs
    deterministic-reviewer.mjs
  tests/
    contracts/
      task.test.ts
    journal/
      sqlite-journal.test.ts
    tasks/
      task-projection.test.ts
    projects/
      project-config.test.ts
    workspaces/
      worktree-manager.test.ts
    workers/
      process-supervisor.test.ts
    capabilities/
      validation-runner.test.ts
    reviews/
      review-gate.test.ts
    integration/
      integration-queue.test.ts
    orchestration/
      tracer-bullet.test.ts
      recovery.test.ts
```

## Stable Interfaces

Later tasks must use these exact interfaces.

```ts
export type TaskId = string;
export type StreamId = string;
export type ProjectId = string;
export type ArtifactId = string;

export type TaskLifecycleState =
  | "queued"
  | "leased"
  | "running"
  | "validating"
  | "awaiting_review"
  | "integration_ready"
  | "integrating"
  | "terminal";

export type TerminalOutcome =
  | "completed"
  | "cancelled"
  | "denied"
  | "timed_out"
  | "failed";

export interface NewEvent<TType extends string, TPayload> {
  readonly streamId: StreamId;
  readonly type: TType;
  readonly payload: TPayload;
  readonly causationId: string | null;
  readonly correlationId: string;
}

export interface StoredEvent<TType extends string = string, TPayload = unknown>
  extends NewEvent<TType, TPayload> {
  readonly eventId: string;
  readonly streamVersion: number;
  readonly globalPosition: number;
  readonly recordedAt: string;
}

export interface EventJournal {
  append(streamId: StreamId, expectedVersion: number, events: readonly NewEvent<string, unknown>[]): readonly StoredEvent[];
  readStream(streamId: StreamId, afterVersion?: number): readonly StoredEvent[];
  readAll(afterPosition?: number): readonly StoredEvent[];
}
```

---

### Task 1: Scaffold The Repository And Domain Contracts

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/contracts/ids.ts`
- Create: `src/contracts/task.ts`
- Create: `src/contracts/event.ts`
- Create: `src/contracts/artifact.ts`
- Create: `tests/contracts/task.test.ts`

- [ ] **Step 1: Verify the repository and toolchain baseline**

Run:

```bash
git status --short
git branch --show-current
node --version
pnpm --version
```

Expected: The worktree is clean, the branch is not `main`, Node.js is version 24 or newer, and pnpm is version 10.

- [ ] **Step 2: Configure scripts and TypeScript**

Set `package.json` to:

```json
{
  "name": "zentra",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "zentra": "./dist/src/cli/main.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/src/cli/main.js"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "better-sqlite3": "^12.0.0",
    "commander": "^14.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "packageManager": "pnpm@10.0.0"
}
```

Set `tsconfig.json` to:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Set `vitest.config.ts` to:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

Set `.gitignore` to:

```gitignore
node_modules/
dist/
coverage/
*.sqlite
*.sqlite-shm
*.sqlite-wal
.DS_Store
```

Run `pnpm install` after writing the final `package.json` so `pnpm-lock.yaml` matches the declared versions.

- [ ] **Step 3: Write failing contract tests**

Create `tests/contracts/task.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TaskSchema } from "../../src/contracts/task.js";

describe("TaskSchema", () => {
  it("accepts canonical lifecycle and terminal values", () => {
    const task = TaskSchema.parse({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "queued",
      terminalOutcome: null,
      budget: { maxSeconds: 60, maxRetries: 0 },
    });

    expect(task.lifecycle).toBe("queued");
  });

  it("rejects approval_required as a terminal outcome", () => {
    expect(() =>
      TaskSchema.parse({
        taskId: "task-1",
        projectId: "project-1",
        title: "Update greeting",
        lifecycle: "terminal",
        terminalOutcome: "approval_required",
        budget: { maxSeconds: 60, maxRetries: 0 },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run the contract test and verify failure**

Run:

```bash
pnpm test -- tests/contracts/task.test.ts
```

Expected: FAIL because `src/contracts/task.ts` does not exist.

- [ ] **Step 5: Implement the contract modules**

Create `src/contracts/ids.ts`:

```ts
export type TaskId = string;
export type StreamId = string;
export type ProjectId = string;
export type ArtifactId = string;
```

Create `src/contracts/task.ts`:

```ts
import { z } from "zod";

export const TaskLifecycleStateSchema = z.enum([
  "queued",
  "leased",
  "running",
  "validating",
  "awaiting_review",
  "integration_ready",
  "integrating",
  "terminal",
]);

export const TerminalOutcomeSchema = z.enum([
  "completed",
  "cancelled",
  "denied",
  "timed_out",
  "failed",
]);

export const TaskSchema = z
  .object({
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    lifecycle: TaskLifecycleStateSchema,
    terminalOutcome: TerminalOutcomeSchema.nullable(),
    budget: z.object({
      maxSeconds: z.number().int().positive(),
      maxRetries: z.number().int().nonnegative(),
    }),
  })
  .superRefine((task, context) => {
    if ((task.lifecycle === "terminal") !== (task.terminalOutcome !== null)) {
      context.addIssue({
        code: "custom",
        message: "terminal lifecycle and terminalOutcome must be set together",
      });
    }
  });

export type Task = z.infer<typeof TaskSchema>;
export type TaskLifecycleState = z.infer<typeof TaskLifecycleStateSchema>;
export type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;
```

Create `src/contracts/event.ts`:

```ts
import type { StreamId } from "./ids.js";

export interface NewEvent<TType extends string, TPayload> {
  readonly streamId: StreamId;
  readonly type: TType;
  readonly payload: TPayload;
  readonly causationId: string | null;
  readonly correlationId: string;
}

export interface StoredEvent<TType extends string = string, TPayload = unknown>
  extends NewEvent<TType, TPayload> {
  readonly eventId: string;
  readonly streamVersion: number;
  readonly globalPosition: number;
  readonly recordedAt: string;
}
```

Create `src/contracts/artifact.ts`:

```ts
import { z } from "zod";

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(["patch", "validation_report", "review_report", "integration_receipt"]),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
```

- [ ] **Step 6: Run tests and type checking**

Run:

```bash
pnpm test -- tests/contracts/task.test.ts
pnpm check
```

Expected: Both commands exit 0.

- [ ] **Step 7: Commit the contracts when commit authorization is active**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/contracts tests/contracts
git commit -m "feat: define Zentra task and event contracts"
```

---

### Task 2: Implement The Durable SQLite Event Journal

**Files:**
- Create: `src/journal/journal.ts`
- Create: `src/journal/sqlite-journal.ts`
- Create: `tests/journal/sqlite-journal.test.ts`

- [ ] **Step 1: Write failing journal tests**

Create `tests/journal/sqlite-journal.test.ts` with tests that:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const journals: SqliteEventJournal[] = [];

afterEach(() => {
  for (const journal of journals) journal.close();
  journals.length = 0;
});

describe("SqliteEventJournal", () => {
  it("appends and reads an ordered stream", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);

    const stored = journal.append("task-1", 0, [
      {
        streamId: "task-1",
        type: "task.created",
        payload: { title: "Update greeting" },
        causationId: null,
        correlationId: "goal-1",
      },
    ]);

    expect(stored[0]?.streamVersion).toBe(1);
    expect(journal.readStream("task-1")).toEqual(stored);
  });

  it("rejects stale expected versions", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);

    journal.append("task-1", 0, [
      {
        streamId: "task-1",
        type: "task.created",
        payload: {},
        causationId: null,
        correlationId: "goal-1",
      },
    ]);

    expect(() => journal.append("task-1", 0, [])).toThrow("expected version 0, actual 1");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run `pnpm test -- tests/journal/sqlite-journal.test.ts`.

Expected: FAIL because the journal modules do not exist.

- [ ] **Step 3: Implement the journal interface and SQLite adapter**

Create `src/journal/journal.ts` with the stable `EventJournal` interface from this plan.

Implement `src/journal/sqlite-journal.ts` with:

- Tables `streams` and `events`.
- `BEGIN IMMEDIATE` transaction around version check, append, and stream update.
- UUID event identities from `crypto.randomUUID()`.
- JSON payload encoding.
- ISO UTC timestamps.
- Ordered reads by stream version and global position.
- A `close()` method.

The append method must throw exactly `expected version X, actual Y` on optimistic concurrency failure.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test -- tests/journal/sqlite-journal.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Add restart persistence coverage**

Add a test that opens a temporary database file, appends an event, closes the journal, reopens it, and reads the same event with the same identity and positions.

Run the focused test again and expect PASS.

- [ ] **Step 6: Commit when authorized**

```bash
git add src/journal tests/journal
git commit -m "feat: add durable SQLite event journal"
```

---

### Task 3: Build The Task Projection And Task Service

**Files:**
- Create: `src/tasks/task-projection.ts`
- Create: `src/tasks/task-service.ts`
- Create: `tests/tasks/task-projection.test.ts`

- [ ] **Step 1: Write projection tests**

Cover these transitions:

```text
task.created -> queued
task.leased -> leased
task.started -> running
task.validation_started -> validating
task.review_requested -> awaiting_review
task.review_approved -> integration_ready
task.integration_started -> integrating
task.completed -> terminal/completed
task.cancelled -> terminal/cancelled
task.failed -> terminal/failed
```

Assert that an event after a terminal outcome throws `task is already terminal`.

- [ ] **Step 2: Run tests and verify failure**

Run `pnpm test -- tests/tasks/task-projection.test.ts`.

Expected: FAIL because projection modules do not exist.

- [ ] **Step 3: Implement a pure projection**

Export:

```ts
export interface TaskView {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly lifecycle: TaskLifecycleState;
  readonly terminalOutcome: TerminalOutcome | null;
  readonly streamVersion: number;
  readonly leaseOwner: string | null;
}

export function projectTask(events: readonly StoredEvent[]): TaskView | null;
```

The function must be deterministic, side-effect free, and reject invalid transitions.

- [ ] **Step 4: Implement TaskService**

Export:

```ts
export class TaskService {
  constructor(private readonly journal: EventJournal) {}
  create(input: { taskId: string; projectId: string; title: string; correlationId: string }): TaskView;
  append(taskId: string, type: string, payload: unknown, causationId: string | null): TaskView;
  get(taskId: string): TaskView | null;
}
```

Every write must read the current stream version and append with optimistic concurrency.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
pnpm test -- tests/tasks/task-projection.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Commit when authorized**

```bash
git add src/tasks tests/tasks
git commit -m "feat: project durable task lifecycle"
```

---

### Task 4: Register Projects And Manage Git Worktrees

**Files:**
- Create: `src/projects/project-config.ts`
- Create: `src/projects/project-registry.ts`
- Create: `src/workspaces/git-client.ts`
- Create: `src/workspaces/worktree-manager.ts`
- Create: `tests/projects/project-config.test.ts`
- Create: `tests/workspaces/worktree-manager.test.ts`

- [ ] **Step 1: Define a failing project-config test**

Use this supported configuration:

```json
{
  "projectId": "fixture-project",
  "repositoryPath": "/absolute/path/to/repository",
  "integrationBranch": "zentra/integration",
  "worktreeRoot": "/absolute/path/to/worktrees",
  "validations": {
    "focused": ["node", "--test", "test/greeting.test.mjs"],
    "full": ["node", "--test"]
  }
}
```

Reject relative repository and worktree paths, empty command arrays, and `sh -c` or `bash -c` validation commands.

- [ ] **Step 2: Implement ProjectConfigSchema and registry**

The registry reads one JSON file, validates it with Zod, resolves the project by `projectId`, and never reads secret values.

Export these exact interfaces:

The module imports `node:path` as `path` and `z` from `zod`.

```ts
export const ProjectConfigSchema = z.object({
  projectId: z.string().min(1),
  repositoryPath: z.string().refine(path.isAbsolute),
  integrationBranch: z.string().min(1),
  worktreeRoot: z.string().refine(path.isAbsolute),
  validations: z.object({
    focused: z.tuple([z.string().min(1)]).rest(z.string()),
    full: z.tuple([z.string().min(1)]).rest(z.string()),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export class ProjectRegistry {
  static fromFile(configPath: string): ProjectRegistry;
  constructor(configs: readonly ProjectConfig[]);
  get(projectId: string): ProjectConfig;
}
```

- [ ] **Step 3: Write failing worktree tests using a temporary real Git repository**

Cover:

- Creating an integration branch.
- Creating `ticket/<taskId>` from the integration branch.
- Configuring a local fixture-repository Git user name and email before commits.
- Rejecting an existing dirty worktree path.
- Committing only explicitly reviewed relative paths after review approval.
- Preserving a failed worktree.
- Removing a completed clean worktree.

- [ ] **Step 4: Implement GitClient without a shell**

Export:

```ts
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitClient {
  run(cwd: string, args: readonly string[]): Promise<CommandResult>;
}
```

Use `node:child_process.spawn` with `shell: false`, bounded captured output, explicit cwd, and an environment containing only `PATH`, `HOME`, `TMPDIR`, `LANG`, and `LC_ALL` when present.

- [ ] **Step 5: Implement WorktreeManager**

Export:

```ts
export interface WorkspaceLease {
  readonly taskId: string;
  readonly branch: string;
  readonly path: string;
}

export class WorktreeManager {
  ensureIntegrationBranch(project: ProjectConfig): Promise<void>;
  create(project: ProjectConfig, taskId: string): Promise<WorkspaceLease>;
  inspect(lease: WorkspaceLease): Promise<{ dirty: boolean; diff: string }>;
  commit(
    lease: WorkspaceLease,
    paths: readonly string[],
    message: string,
    expectedDiffSha256: string,
  ): Promise<string>;
  remove(project: ProjectConfig, lease: WorkspaceLease): Promise<void>;
}
```

`commit` must reject absolute paths, path traversal, an empty path list, any path not present in the current diff, and a current diff whose digest differs from `expectedDiffSha256`.

It must run `git add -- <paths>` followed by `git commit -m <message>` through `GitClient` and return the resulting commit identity.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test -- tests/projects tests/workspaces
pnpm check
```

Expected: PASS.

- [ ] **Step 7: Commit when authorized**

```bash
git add src/projects src/workspaces tests/projects tests/workspaces
git commit -m "feat: register projects and isolate worktrees"
```

---

### Task 5: Supervise A Deterministic Worker With Cancellation

**Files:**
- Create: `src/workers/worker-adapter.ts`
- Create: `src/workers/process-supervisor.ts`
- Create: `fixtures/deterministic-worker.mjs`
- Create: `tests/workers/process-supervisor.test.ts`

- [ ] **Step 1: Create the deterministic worker fixture**

The fixture accepts only:

```text
--workspace <absolute path>
--file <relative path>
--content <string>
```

It rejects absolute file paths and `..` traversal.

It writes the content, emits one JSON line containing `artifact.ready`, and exits 0.

When content is `__WAIT__`, it waits until terminated so cancellation can be tested.

- [ ] **Step 2: Write failing supervisor tests**

Cover:

- Successful JSON-line event collection.
- Minimal environment without arbitrary parent secrets.
- Output byte limit.
- Timeout producing `timed_out`.
- Abort signal producing `cancelled`.
- Nonzero exit producing `failed`.
- Process-group termination without stale child output.

- [ ] **Step 3: Implement WorkerAdapter and ProcessSupervisor**

Export:

```ts
export interface WorkerRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface WorkerResult {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly events: readonly unknown[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkerAdapter {
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult>;
}
```

The process supervisor must use `spawn`, `shell: false`, an explicit environment allowlist, bounded stdout and stderr, deadline cancellation, and deterministic terminal mapping.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test -- tests/workers/process-supervisor.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Commit when authorized**

```bash
git add src/workers fixtures tests/workers
git commit -m "feat: supervise deterministic workers"
```

---

### Task 6: Add Named Validation And Independent Review Gates

**Files:**
- Create: `src/capabilities/validation-runner.ts`
- Create: `src/reviews/reviewer-adapter.ts`
- Create: `src/reviews/review-gate.ts`
- Create: `fixtures/deterministic-reviewer.mjs`
- Create: `tests/capabilities/validation-runner.test.ts`
- Create: `tests/reviews/review-gate.test.ts`

- [ ] **Step 1: Write failing validation tests**

Cover:

- Only named project commands can run.
- Command arrays are passed directly without shell expansion.
- Environment inheritance is restricted.
- Timeout, cancellation, output limits, and nonzero exit are recorded.
- The report contains command identity, argv digest, timing, exit code, output digest, and terminal outcome.

- [ ] **Step 2: Implement ValidationRunner**

Export:

```ts
export interface ValidationReport {
  readonly name: string;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export class ValidationRunner {
  constructor(private readonly supervisor: ProcessSupervisor) {}
  run(project: ProjectConfig, name: "focused" | "full", cwd: string, signal: AbortSignal): Promise<ValidationReport>;
}
```

- [ ] **Step 3: Create a separately supervised deterministic reviewer**

The reviewer fixture accepts only diff and validation digests plus worker and reviewer identities.

It emits one JSON review decision and never receives a writable workspace path.

Export:

```ts
export interface ReviewInput {
  readonly workerId: string;
  readonly reviewerId: string;
  readonly diff: string;
  readonly validation: ValidationReport;
}

export interface ReviewerAdapter {
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision>;
}

export class DeterministicReviewerAdapter implements ReviewerAdapter {
  constructor(private readonly supervisor: ProcessSupervisor, private readonly executable: string) {}
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewDecision>;
}
```

The adapter must reject matching worker and reviewer identities before starting the process.

- [ ] **Step 4: Write failing review-gate tests**

The review gate approves only when:

- The worktree diff is nonempty.
- Focused validation completed with exit code 0.
- The reviewer identity differs from the worker identity.
- The reviewed diff digest matches the current diff digest.

It rejects stale, empty, failed-validation, or self-review evidence.

- [ ] **Step 5: Implement ReviewGate**

Export:

```ts
export interface ReviewDecision {
  readonly reviewerId: string;
  readonly approved: boolean;
  readonly diffSha256: string;
  readonly validationSha256: string;
  readonly decidedAt: string;
  readonly reason: string;
}

export class ReviewGate {
  verify(input: ReviewInput, decision: ReviewDecision): ReviewDecision;
}
```

The gate recomputes the diff and validation digests, rejects stale or mismatched decisions, and returns the verified decision unchanged.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm test -- tests/capabilities tests/reviews
pnpm check
```

Expected: PASS.

- [ ] **Step 7: Commit when authorized**

```bash
git add src/capabilities src/reviews fixtures/deterministic-reviewer.mjs tests/capabilities tests/reviews
git commit -m "feat: validate and independently review work"
```

---

### Task 7: Implement The Single-Project Integration Queue

**Files:**
- Create: `src/integration/integration-queue.ts`
- Create: `tests/integration/integration-queue.test.ts`

- [ ] **Step 1: Write failing real-Git integration tests**

Create temporary repositories and cover:

- One reviewed ticket branch merges into `zentra/integration`.
- A stale review digest is rejected.
- A failed full validation leaves the ticket branch and worktree preserved.
- A merge conflict returns `failed` without mutating the integration branch.
- Only one integration runs at a time per project.
- The receipt contains source and resulting commit identities and validation evidence.

- [ ] **Step 2: Implement IntegrationQueue**

Export:

```ts
export interface IntegrationReceipt {
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceCommit: string;
  readonly resultCommit: string | null;
  readonly review: ReviewDecision;
  readonly validation: ValidationReport;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
}

export class IntegrationQueue {
  constructor(
    private readonly git: GitClient,
    private readonly validations: ValidationRunner,
  ) {}

  integrate(input: {
    project: ProjectConfig;
    lease: WorkspaceLease;
    review: ReviewDecision;
    signal: AbortSignal;
  }): Promise<IntegrationReceipt>;
}
```

Use a per-project in-process mutex for the MVP.

Under the mutex, create a disposable candidate worktree from the current integration-branch commit, merge the reviewed source commit into the candidate, and run full validation there.

Only after full validation passes may the queue update the integration branch with compare-and-swap semantics against the original integration commit.

A conflict, validation failure, cancellation, timeout, or changed integration head must leave the integration branch unchanged and preserve the ticket worktree.

Do not automatically retry conflicts or uncertain Git outcomes.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm test -- tests/integration/integration-queue.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Commit when authorized**

```bash
git add src/integration tests/integration
git commit -m "feat: serialize reviewed project integration"
```

---

### Task 8: Orchestrate The Complete Tracer Bullet

**Files:**
- Create: `src/orchestration/tracer-bullet.ts`
- Create: `tests/orchestration/tracer-bullet.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

The test must create a temporary Git repository containing:

```text
greeting.txt
test/greeting.test.mjs
zentra.project.json
```

The deterministic worker changes `greeting.txt` from `hello` to `hello from Zentra`.

The workflow must:

1. Create the durable task.
2. Create the integration branch.
3. Create the ticket worktree.
4. Lease and start the task.
5. Run the deterministic worker.
6. Record the patch artifact.
7. Run focused validation.
8. Dispatch the separately supervised deterministic reviewer.
9. Verify the independent review decision.
10. Commit only the reviewed relative paths to the ticket branch.
11. Integrate through the queue's validated candidate worktree.
12. Record an integration receipt.
13. End in `completed`.

Assert the integration branch contains the changed greeting and the journal can replay every transition.

- [ ] **Step 2: Run the end-to-end test and verify failure**

Run `pnpm test -- tests/orchestration/tracer-bullet.test.ts`.

Expected: FAIL because the tracer-bullet orchestrator does not exist.

- [ ] **Step 3: Implement TracerBulletOrchestrator**

Export:

```ts
export class TracerBulletOrchestrator {
  constructor(
    private readonly tasks: TaskService,
    private readonly projects: ProjectRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly worker: WorkerAdapter,
    private readonly validations: ValidationRunner,
    private readonly reviewer: ReviewerAdapter,
    private readonly reviews: ReviewGate,
    private readonly integrations: IntegrationQueue,
  ) {}

  run(input: {
    taskId: string;
    projectId: string;
    title: string;
    workerId: string;
    reviewerId: string;
    workerRequest: Omit<WorkerRequest, "taskId" | "cwd">;
    signal: AbortSignal;
  }): Promise<TaskView>;
}
```

Every accepted transition must be appended to the journal before the next effect begins.

The review decision's diff digest must match the committed branch diff before integration begins.

Every failure must map to one terminal outcome and preserve the worktree for inspection.

- [ ] **Step 4: Run end-to-end and full tests**

Run:

```bash
pnpm test -- tests/orchestration/tracer-bullet.test.ts
pnpm test
pnpm check
pnpm build
```

Expected: All commands exit 0.

- [ ] **Step 5: Commit when authorized**

```bash
git add src/orchestration tests/orchestration
git commit -m "feat: execute one verified development ticket"
```

---

### Task 9: Add Restart Recovery And Reconciliation

**Files:**
- Create: `src/orchestration/recovery.ts`
- Create: `tests/orchestration/recovery.test.ts`

- [ ] **Step 1: Write recovery tests**

Cover crashes after:

- Task creation before worktree creation.
- Worktree creation before worker start.
- Worker process exit before result recording.
- Validation completion before review recording.
- Merge start with uncertain Git result.
- Integration completion before task completion recording.

Expected behavior:

- Safe preparation steps may resume.
- Potentially effectful uncertain operations enter reconciliation.
- No effectful operation retries automatically.
- Existing worktrees and commits are inspected before deciding next state.
- A completed integration can be reconciled and recorded exactly once.

- [ ] **Step 2: Implement RecoveryService**

Export:

```ts
export interface RecoveryDecision {
  readonly taskId: string;
  readonly action: "resume_preparation" | "await_reconciliation" | "record_completion" | "record_failure";
  readonly reason: string;
}

export class RecoveryService {
  constructor(
    private readonly journal: EventJournal,
    private readonly tasks: TaskService,
    private readonly projects: ProjectRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly git: GitClient,
  ) {}

  inspect(taskId: string): Promise<RecoveryDecision>;
}
```

The service reads journal state, project configuration, worktree state, branch commits, and integration evidence without performing a new effect.

- [ ] **Step 3: Run recovery and full verification**

Run:

```bash
pnpm test -- tests/orchestration/recovery.test.ts
pnpm test
pnpm check
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Commit when authorized**

```bash
git add src/orchestration/recovery.ts tests/orchestration/recovery.test.ts
git commit -m "feat: reconcile interrupted orchestration"
```

---

### Task 10: Expose The Local CLI And Document The MVP

**Files:**
- Create: `src/cli/main.ts`
- Create: `README.md`
- Create: `tests/orchestration/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Cover:

```text
zentra project validate --config <path>
zentra task run --config <path> --database <path> --task-id <id> --title <title> --file <relative-path> --content <text>
zentra task status --database <path> --task-id <id>
zentra recover --config <path> --database <path> --task-id <id>
```

Assert JSON output, stable exit codes, no secret values, and canonical terminal outcomes.

- [ ] **Step 2: Implement the Commander CLI**

The CLI must:

- Parse typed arguments.
- Construct dependencies in one composition root.
- Resolve the bundled deterministic worker internally rather than accepting an arbitrary executable from the CLI.
- Reject absolute and traversal-containing `--file` values before task creation.
- Handle `SIGINT` and `SIGTERM` with an `AbortController`.
- Print one JSON object per command.
- Return exit code 0 only for successful command execution.
- Never print inherited environment values.

- [ ] **Step 3: Write the README**

Document:

- Product boundary.
- Local MVP limitations.
- Installation.
- Project configuration.
- Commands.
- Security limitations.
- Event and recovery behavior.
- Test commands.
- Explicit statement that real coding harnesses and high concurrency are not included yet.

- [ ] **Step 4: Run complete verification**

Run:

```bash
pnpm test
pnpm check
pnpm build
pnpm start -- --help
```

Expected: All commands exit 0 and help lists project, task, and recovery commands.

- [ ] **Step 5: Commit when authorized**

```bash
git add src/cli tests/orchestration/cli.test.ts README.md
git commit -m "feat: expose Zentra local orchestrator CLI"
```

---

## Completion Gate

The MVP is complete only when fresh evidence confirms:

- All tests pass.
- Type checking passes.
- Build succeeds.
- One real temporary Git repository completes the tracer bullet.
- Cancellation produces `cancelled` without stale worker output.
- Timeout produces `timed_out`.
- Failure preserves the worktree.
- Restart recovery does not duplicate an effect.
- Review identity differs from worker identity.
- Integration is serialized.
- The event journal replays the final task state exactly.
- No fixture, worker, validation, or Git subprocess receives arbitrary parent secrets.
- No general shell command is exposed.

## Follow-On Plans

After this MVP passes, create separate implementation plans in this order:

1. Real harness capability probes and network-dark containment.
2. One four-agent pod with durable handoffs.
3. Multiple software projects and fair scheduling.
4. Twenty-agent resource governance.
5. Forty-agent worker isolation and optional distribution.
6. Zoe communication capability package.
7. Zoe meeting capability package.
8. Zoe personal-operations capability package.
9. Zoe device capability package.
