# Validation Invocation ID Lifetime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound validation invocation ID memory to active in-process validations while preserving rejection of concurrent duplicate IDs.

**Architecture:** Keep one process-wide module-level `Set` so separate `ValidationRunner` instances share the same active-ID boundary.
Register immediately before asynchronous validation work and delete from the set in `finally` after every settled path.
Expose only the registry count needed by the required bounded-lifetime test.

**Tech Stack:** Node.js 24, TypeScript 5.9, Vitest 3, pnpm 10.

## Global Constraints

- Work only in the isolated `issue/015-bound-validation-invocation-ids` worktree.
- Follow test-driven development for the behavioral change.
- Preserve process-wide rejection of concurrent duplicates across separate runner instances.
- Permit invocation ID reuse only after the prior invocation settles.
- Do not add durable storage, retention configuration, restart semantics, dependencies, or a registry abstraction.
- Do not change integration cleanup-failure behavior from issue 028.
- Do not commit unless the user explicitly authorizes a commit.

---

## File Structure

- Modify `src/capabilities/validation-runner.ts` to own active-ID registration, cleanup, and read-only count observation.
- Modify `tests/capabilities/validation-runner.test.ts` to prove concurrent rejection, cleanup after success and rejection, sequential boundedness, and completed-ID reuse.

---

### Task 1: Bound Active Validation Invocation IDs

**Files:**
- Modify: `src/capabilities/validation-runner.ts:89-203`
- Test: `tests/capabilities/validation-runner.test.ts`

**Interfaces:**
- Consumes: `ValidationRunner.run(project, name, cwd, signal, context)` and `ProcessSupervisor.execute(request, signal, kind)`.
- Produces: `activeValidationInvocationCount(): number` and active-only duplicate semantics for `ValidationRunner.run`.

- [ ] **Step 1: Add test supervisors and import the active count**

Extend the validation-runner import with `activeValidationInvocationCount`:

```ts
import {
  ValidationRunner,
  ValidationReportSchema,
  activeValidationInvocationCount,
  isVerifiedValidationReport,
} from "../../src/capabilities/validation-runner.js";
```

Add these supervisors after `CountingSupervisor`:

```ts
class BlockingSupervisor extends ProcessSupervisor {
  readonly started = Promise.withResolvers<void>();
  readonly result = Promise.withResolvers<WorkerResult>();

  override execute(): Promise<WorkerResult> {
    this.started.resolve();
    return this.result.promise;
  }
}

class AlternatingSupervisor extends ProcessSupervisor {
  private calls = 0;

  override execute(): Promise<WorkerResult> {
    this.calls += 1;
    if (this.calls % 2 === 0) return Promise.reject(new Error("spawn failed"));
    return Promise.resolve({
      outcome: "completed",
      exitCode: 0,
      events: [],
      stdout: "",
      rawStdout: "",
      stderr: "",
    });
  }
}

const completedWorkerResult: WorkerResult = {
  outcome: "completed",
  exitCode: 0,
  events: [],
  stdout: "",
  rawStdout: "",
  stderr: "",
};
```

- [ ] **Step 2: Write the failing concurrent duplicate test**

Add this test near the existing provenance tests:

```ts
it("rejects a duplicate invocation ID only while the first invocation is active", async () => {
  const cwd = await workspace();
  const configured = project([process.execPath, "--version"]);
  const supervisor = new BlockingSupervisor();
  const context = { invocationId: "concurrent-validation", subjectSha256: "subject" };
  const first = new ValidationRunner(supervisor).run(
    configured,
    "focused",
    cwd,
    AbortSignal.timeout(5_000),
    context,
  );
  await supervisor.started.promise;

  expect(activeValidationInvocationCount()).toBe(1);
  await expect(
    new ValidationRunner(new CountingSupervisor()).run(
      configured,
      "focused",
      cwd,
      AbortSignal.timeout(5_000),
      context,
    ),
  ).rejects.toThrow("validation invocationId must be nonempty and not already active");
  expect(activeValidationInvocationCount()).toBe(1);

  supervisor.result.resolve(completedWorkerResult);
  await expect(first).resolves.toMatchObject({ outcome: "completed" });
  expect(activeValidationInvocationCount()).toBe(0);
});
```

- [ ] **Step 3: Write the failing sequential stress and reuse test**

Add this test after the concurrent test:

```ts
it("releases invocation IDs after many sequential successes and failures", async () => {
  await withTemporaryApprovedExecutable(async (approvedExecutable) => {
    const isolated = await import("../../src/capabilities/validation-runner.js");
    const cwd = await workspace();
    const runner = new isolated.ValidationRunner(new AlternatingSupervisor());
    const configured = project([approvedExecutable]);

    for (let index = 0; index < 100; index += 1) {
      const pending = runner.run(
        configured,
        "focused",
        cwd,
        AbortSignal.timeout(5_000),
        { invocationId: `stress-${index}`, subjectSha256: "subject" },
      );
      if (index % 2 === 0) {
        await expect(pending).resolves.toMatchObject({ outcome: "completed" });
      } else {
        await expect(pending).rejects.toThrow("spawn failed");
      }
      expect(isolated.activeValidationInvocationCount()).toBe(0);
    }

    await expect(
      runner.run(
        configured,
        "focused",
        cwd,
        AbortSignal.timeout(5_000),
        { invocationId: "stress-0", subjectSha256: "subject" },
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(isolated.activeValidationInvocationCount()).toBe(0);
  });
});
```

- [ ] **Step 4: Run the focused tests and verify the red state**

Run:

```bash
pnpm exec vitest run tests/capabilities/validation-runner.test.ts
```

Expected: TypeScript transformation or test execution fails because `activeValidationInvocationCount` is not exported, and the current implementation retains settled IDs.

- [ ] **Step 5: Implement active-only registration and cleanup**

In `src/capabilities/validation-runner.ts`, replace the process-lifetime set declaration with:

```ts
const verifiedValidationReports = new WeakMap<ValidationReport, DurableValidationProvenance>();
const activeInvocationIds = new Set<string>();

export function activeValidationInvocationCount(): number {
  return activeInvocationIds.size;
}
```

In `ValidationRunner.run`, replace the current duplicate check, registration, and post-registration body with:

```ts
const invocationId = context?.invocationId ?? randomUUID();
if (invocationId === "" || activeInvocationIds.has(invocationId)) {
  throw new Error("validation invocationId must be nonempty and not already active");
}
if (context !== undefined && context.subjectSha256 === "") {
  throw new Error("validation subjectSha256 must be nonempty");
}

activeInvocationIds.add(invocationId);
try {
  const canonicalCwd = await realpath(cwd);
  const startedAt = new Date().toISOString();
  await assertApprovedValidationExecutableIdentity(command[0]);

  const result = await this.supervisor.execute(
    {
      taskId: "validation",
      executable: command[0],
      args: command.slice(1),
      cwd: canonicalCwd,
      timeoutMs,
    },
    signal,
    "validation",
  );

  const finishedAt = new Date().toISOString();
  const argvSha256 = createHash("sha256")
    .update(JSON.stringify(command), "utf8")
    .digest("hex");
  const stdout = result.rawStdout;
  const outputContent = JSON.stringify({ stdout, stderr: result.stderr });
  const outputSha256 = createHash("sha256")
    .update(outputContent, "utf8")
    .digest("hex");
  const provenance: DurableValidationProvenance = Object.freeze({
    invocationId,
    canonicalCwd,
    subjectSha256: context?.subjectSha256 ?? null,
    timeoutMs,
  });

  const parsed = ValidationReportSchema.parse({
    name,
    outcome: result.outcome,
    exitCode: result.exitCode,
    stdout,
    stderr: result.stderr,
    startedAt,
    finishedAt,
    command,
    argvSha256,
    outputSha256,
    timeoutMs,
    provenance,
  });
  const frozen: ValidationReport = Object.freeze({
    ...parsed,
    command: Object.freeze([...parsed.command]),
    provenance: Object.freeze({ ...parsed.provenance }),
  });
  verifiedValidationReports.set(frozen, frozen.provenance);
  return frozen;
} finally {
  activeInvocationIds.delete(invocationId);
}
```

Do not catch or remap errors in this change.
The `finally` block must surround `realpath`, executable identity verification, supervisor execution, report parsing, branding, and return.

- [ ] **Step 6: Run the focused tests and type checker**

Run:

```bash
pnpm exec vitest run tests/capabilities/validation-runner.test.ts
pnpm check
```

Expected: Both commands exit 0, concurrent duplicates fail while active, all 100 sequential iterations return the count to zero, and `stress-0` is reusable.

- [ ] **Step 7: Run the complete verification gate**

Run:

```bash
pnpm test
pnpm check
pnpm build
```

Expected: All commands exit 0.

- [ ] **Step 8: Run the standalone heap and registry loop**

After `pnpm build`, run this from the worktree root:

```bash
node --expose-gc --input-type=module -e 'import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"; import { tmpdir } from "node:os"; import path from "node:path"; const directory = await mkdtemp(path.join(tmpdir(), "zentra-015-loop-")); const executable = path.join(directory, "approved-node"); await writeFile(executable, "approved", { mode: 0o755 }); const canonicalExecutable = await realpath(executable); process.execPath = canonicalExecutable; const { ValidationRunner, activeValidationInvocationCount } = await import(`./dist/src/capabilities/validation-runner.js?${Date.now()}`); const { ProcessSupervisor } = await import("./dist/src/workers/process-supervisor.js"); class Supervisor extends ProcessSupervisor { execute() { return Promise.resolve({ outcome: "completed", exitCode: 0, events: [], stdout: "", rawStdout: "", stderr: "" }); } } const project = { projectId: "loop", repositoryPath: directory, integrationBranch: "zentra/integration", worktreeRoot: directory, validations: { focused: [canonicalExecutable], full: [canonicalExecutable], focusedTimeoutMs: 5000, fullTimeoutMs: 5000 } }; const runner = new ValidationRunner(new Supervisor()); global.gc(); const before = process.memoryUsage().heapUsed; for (let index = 0; index < 10000; index += 1) await runner.run(project, "focused", directory, AbortSignal.timeout(5000), { invocationId: `loop-${index}`, subjectSha256: "subject" }); global.gc(); const after = process.memoryUsage().heapUsed; console.log(JSON.stringify({ iterations: 10000, activeInvocationIds: activeValidationInvocationCount(), heapBefore: before, heapAfter: after, heapDelta: after - before })); await rm(directory, { recursive: true, force: true });'
```

Expected: The JSON output reports `iterations: 10000`, `activeInvocationIds: 0`, and a bounded heap delta that does not grow proportionally with the number of completed IDs.

- [ ] **Step 9: Inspect the final diff without committing**

Run:

```bash
git status --short
git diff --check
git diff -- src/capabilities/validation-runner.ts tests/capabilities/validation-runner.test.ts docs/superpowers
```

Expected: Only the validation runner, its test, and the approved design and plan documents are changed, with no whitespace errors.
Do not commit unless the user separately authorizes it.
