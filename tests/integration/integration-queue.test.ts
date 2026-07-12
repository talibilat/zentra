import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ValidationRunner,
  type ValidationReport,
} from "../../src/capabilities/validation-runner.js";
import {
  IntegrationExecutionError,
  IntegrationUncertainError,
  IntegrationQueue,
  isVerifiedIntegrationReceipt,
} from "../../src/integration/integration-queue.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ReviewGate } from "../../src/reviews/review-gate.js";
import {
  canonicalValidationDigest,
  type ReviewDecision,
} from "../../src/reviews/reviewer-adapter.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import {
  GitClient,
  type CommandResult,
  type GitRunOptions,
} from "../../src/workspaces/git-client.js";
import {
  WorktreeManager,
  type WorkspaceLease,
} from "../../src/workspaces/worktree-manager.js";

const git = new GitClient();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function terminatedGitResult(
  termination: "cancelled" | "timed_out",
): CommandResult {
  return {
    stdout: "",
    stderr: `Git ${termination}`,
    exitCode: -1,
    truncated: false,
    termination,
  };
}

describe("IntegrationQueue", () => {
  let baseDir: string;
  let repositoryPath: string;
  let worktreeRoot: string;
  let project: ProjectConfig;
  let originalIntegrationHead: string;
  const worktrees = new WorktreeManager();
  const reviewGate = new ReviewGate();

  beforeEach(async () => {
    baseDir = mkdtempSync(path.join(tmpdir(), "zentra-integration-"));
    repositoryPath = path.join(baseDir, "repository");
    worktreeRoot = path.join(baseDir, "worktrees");

    await gitOk(baseDir, ["init", "-b", "main", repositoryPath]);
    await gitOk(repositoryPath, ["config", "user.name", "Zentra Fixture"]);
    await gitOk(repositoryPath, [
      "config",
      "user.email",
      "fixture@zentra.local",
    ]);
    writeFileSync(path.join(repositoryPath, "shared.txt"), "original\n", "utf8");
    await gitOk(repositoryPath, ["add", "--", "shared.txt"]);
    await gitOk(repositoryPath, ["commit", "-m", "initial commit"]);

    project = {
      projectId: `fixture-${path.basename(baseDir)}`,
      repositoryPath,
      integrationBranch: "zentra/integration",
      worktreeRoot,
      validations: {
        focused: [process.execPath, "-e", "process.exit(0)"],
        full: [
          process.execPath,
          "-e",
          'process.stdout.write("full validation passed")',
        ],
      },
    };
    await worktrees.ensureIntegrationBranch(project);
    originalIntegrationHead = await integrationHead();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function queue(): IntegrationQueue {
    return new IntegrationQueue(
      git,
      new ValidationRunner(new ProcessSupervisor()),
    );
  }

  async function integrationHead(): Promise<string> {
    return gitOk(repositoryPath, [
      "rev-parse",
      `refs/heads/${project.integrationBranch}`,
    ]);
  }

  async function ticket(
    taskId: string,
    file: string,
    content: string,
  ): Promise<{ lease: WorkspaceLease; sourceCommit: string; review: ReviewDecision }> {
    const lease = await worktrees.create(project, taskId);
    writeFileSync(path.join(lease.path, file), content, "utf8");
    const { diff } = await worktrees.inspect(lease);
    const sourceCommit = await worktrees.commit(
      lease,
      [file],
      `feat: ${taskId}`,
      sha256(diff),
    );
    const focusedValidation = await new ValidationRunner(new ProcessSupervisor()).run(
      project,
      "focused",
      lease.path,
      AbortSignal.timeout(10_000),
      {
        invocationId: `focused-review-${taskId}-${randomUUID()}`,
        subjectSha256: sha256(diff),
      },
    );
    const decision: ReviewDecision = {
      reviewerId: "reviewer-1",
      approved: true,
      diffSha256: sha256(diff),
      validationSha256: canonicalValidationDigest(focusedValidation),
      decidedAt: new Date().toISOString(),
      reason: "approved",
    };
    return {
      lease,
      sourceCommit,
      review: reviewGate.verify(
        {
          workerId: "worker-1",
          reviewerId: "reviewer-1",
          diff,
          validation: focusedValidation,
        },
        decision,
      ),
    };
  }

  async function integrate(
    input: Awaited<ReturnType<typeof ticket>>,
    integrationQueue = queue(),
  ) {
    return integrationQueue.integrate({
      project,
      lease: input.lease,
      review: input.review,
      signal: AbortSignal.timeout(10_000),
    });
  }

  it("merges a reviewed ticket branch into zentra/integration", async () => {
    const reviewed = await ticket("task-001", "feature.txt", "integrated\n");

    const receipt = await integrate(reviewed);

    expect(receipt.outcome).toBe("completed");
    expect(receipt.resultCommit).toBe(await integrationHead());
    expect(receipt.resultCommit).not.toBe(originalIntegrationHead);
    expect(isVerifiedIntegrationReceipt(receipt)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.validation)).toBe(true);
    expect(Object.isFrozen(receipt.validation.command)).toBe(true);
    expect(isVerifiedIntegrationReceipt({ ...receipt })).toBe(false);
    expect(
      await gitOk(repositoryPath, [
        "show",
        `${project.integrationBranch}:feature.txt`,
      ]),
    ).toBe("integrated");
  });

  it("throws a typed timed_out error when source identity lookup times out", async () => {
    const reviewed = await ticket("task-source-timeout", "source-timeout.txt", "changed\n");
    class SourceTimeoutGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (args[0] === "rev-parse" && args.at(-1)?.includes(reviewed.lease.branch)) {
          return Promise.resolve(terminatedGitResult("timed_out"));
        }
        return super.run(cwd, args, options);
      }
    }
    const integrationQueue = new IntegrationQueue(
      new SourceTimeoutGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    await expect(integrate(reviewed, integrationQueue)).rejects.toEqual(
      expect.objectContaining<Partial<IntegrationExecutionError>>({
        name: "IntegrationExecutionError",
        outcome: "timed_out",
      }),
    );
  });

  it.each(["nonzero", "truncated", "empty", "throw"] as const)(
    "types source identity %s as failed before effects",
    async (mode) => {
      const reviewed = await ticket(`task-source-${mode}`, `source-${mode}.txt`, "changed\n");
      class SourceFailureGitClient extends GitClient {
        override run(
          cwd: string,
          args: readonly string[],
          options?: GitRunOptions,
        ): Promise<CommandResult> {
          if (args[0] === "rev-parse" && args.at(-1)?.includes(reviewed.lease.branch)) {
            if (mode === "throw") throw new Error("source unavailable");
            return Promise.resolve({
              stdout: mode === "empty" ? "" : "not-a-commit",
              stderr: mode === "nonzero" ? "missing" : "",
              exitCode: mode === "nonzero" ? 1 : 0,
              truncated: mode === "truncated",
              termination: null,
            });
          }
          return super.run(cwd, args, options);
        }
      }
      const integrationQueue = new IntegrationQueue(
        new SourceFailureGitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      );

      await expect(integrate(reviewed, integrationQueue)).rejects.toEqual(
        expect.objectContaining<Partial<IntegrationExecutionError>>({
          name: "IntegrationExecutionError",
          outcome: "failed",
        }),
      );
    },
  );

  it("rejects a stale review digest before creating candidate effects", async () => {
    const reviewed = await ticket("task-002", "stale.txt", "changed\n");
    writeFileSync(path.join(reviewed.lease.path, "stale.txt"), "changed again\n");
    const changed = await worktrees.inspect(reviewed.lease);
    const currentSourceCommit = await worktrees.commit(
      reviewed.lease,
      ["stale.txt"],
      "feat: change after review",
      sha256(changed.diff),
    );

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({
      outcome: "failed",
      resultCommit: null,
      sourceCommit: currentSourceCommit,
      validation: {
        name: "full",
        outcome: "failed",
        exitCode: null,
      },
    });
    expect(receipt.validation.stderr).toMatch(/review.*digest|digest.*review/i);
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it("rejects a fabricated approved decision before candidate effects", async () => {
    const reviewed = await ticket("task-forged", "forged.txt", "forged\n");
    const fabricated = { ...reviewed.review };

    const receipt = await integrate({ ...reviewed, review: fabricated });

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(receipt.validation.stderr).toMatch(/verified review/i);
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it("cannot retarget a verified decision to another ticket", async () => {
    const first = await ticket("task-reviewed-first", "first-reviewed.txt", "first\n");
    const second = await ticket("task-unreviewed-second", "second-unreviewed.txt", "second\n");
    const replacement = {
      reviewerId: "retargeted-reviewer",
      approved: false,
      diffSha256: second.review.diffSha256,
      validationSha256: second.review.validationSha256,
      decidedAt: new Date(0).toISOString(),
      reason: "retargeted",
    };

    expect(() => Object.assign(first.review, replacement)).toThrow();
    expect(first.review).not.toMatchObject(replacement);

    const receipt = await integrate({ ...second, review: first.review });
    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(false);
  });

  it("resolves the source commit before returning a pre-aborted receipt", async () => {
    const reviewed = await ticket("task-aborted", "aborted.txt", "aborted\n");
    const controller = new AbortController();
    controller.abort();

    const receipt = await queue().integrate({
      project,
      lease: reviewed.lease,
      review: reviewed.review,
      signal: controller.signal,
    });

    expect(receipt).toMatchObject({
      outcome: "cancelled",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
      validation: { name: "full", outcome: "cancelled", exitCode: null },
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it("rejects when the source branch cannot be resolved and releases the project lock", async () => {
    const reviewed = await ticket("task-missing-source", "source.txt", "source\n");
    const missingSourceLease = {
      ...reviewed.lease,
      branch: "ticket/missing-source",
    };
    const integrationQueue = queue();

    await expect(
      integrationQueue.integrate({
        project,
        lease: missingSourceLease,
        review: reviewed.review,
        signal: AbortSignal.timeout(10_000),
      }),
    ).rejects.toThrow(/source commit.*exit code/i);

    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      integrationQueue.integrate({
        project,
        lease: reviewed.lease,
        review: reviewed.review,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: "cancelled",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("rejects a thrown source Git call and releases the project lock", async () => {
    const reviewed = await ticket("task-source-throw", "throw.txt", "throw\n");

    class ThrowingSourceGitClient extends GitClient {
      private throwSourceLookup = true;

      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        if (
          this.throwSourceLookup &&
          args[0] === "rev-parse" &&
          args[2] === `refs/heads/${reviewed.lease.branch}^{commit}`
        ) {
          this.throwSourceLookup = false;
          return Promise.reject(new Error("source lookup unavailable"));
        }
        return super.run(cwd, args);
      }
    }

    const integrationQueue = new IntegrationQueue(
      new ThrowingSourceGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    await expect(integrate(reviewed, integrationQueue)).rejects.toThrow(
      "source lookup unavailable",
    );
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      integrationQueue.integrate({
        project,
        lease: reviewed.lease,
        review: reviewed.review,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: "cancelled",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("preserves the ticket branch and worktree when full validation fails", async () => {
    project.validations.full = [
      process.execPath,
      "-e",
      'process.stderr.write("full suite failed"); process.exit(7)',
    ];
    const reviewed = await ticket("task-003", "invalid.txt", "invalid\n");

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({
      outcome: "failed",
      resultCommit: null,
      sourceCommit: reviewed.sourceCommit,
      validation: {
        name: "full",
        outcome: "failed",
        exitCode: 7,
        stderr: "full suite failed",
      },
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(await gitOk(reviewed.lease.path, ["rev-parse", "HEAD"])).toBe(
      reviewed.sourceCommit,
    );
    expect(
      await gitOk(repositoryPath, ["rev-parse", reviewed.lease.branch]),
    ).toBe(reviewed.sourceCommit);
  });

  it("fails when successful validation modifies a tracked candidate file", async () => {
    project.validations.full = [
      process.execPath,
      "-e",
      'require("node:fs").appendFileSync("tracked.txt", "validation mutation\\n")',
    ];
    const reviewed = await ticket("task-dirty-validation", "tracked.txt", "reviewed\n");

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
  });

  it("fails when successful validation creates a candidate commit", async () => {
    project.validations.full = [
      process.execPath,
      "-e",
      [
        'const fs = require("node:fs");',
        'const { execFileSync } = require("node:child_process");',
        'fs.writeFileSync("validation-commit.txt", "mutation\\n");',
        'execFileSync("git", ["add", "--", "validation-commit.txt"]);',
        'execFileSync("git", ["-c", "commit.gpgSign=false", "commit", "-m", "validation mutation"]);',
      ].join(" "),
    ];
    const reviewed = await ticket("task-commit-validation", "reviewed.txt", "reviewed\n");

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
  });

  it("returns cancelled when aborted during full validation", async () => {
    const startedPath = path.join(baseDir, "validation-started");
    project.validations.full = [
      process.execPath,
      "-e",
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.argv[1], 'started');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
      startedPath,
    ];
    const reviewed = await ticket("task-cancelled", "cancelled.txt", "cancelled\n");
    const controller = new AbortController();

    const pending = queue().integrate({
      project,
      lease: reviewed.lease,
      review: reviewed.review,
      signal: controller.signal,
    });
    await waitForFile(startedPath);
    controller.abort();
    const receipt = await pending;

    expect(receipt).toMatchObject({
      outcome: "cancelled",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
      validation: { name: "full", outcome: "cancelled", exitCode: null },
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it("returns timed_out when full validation exceeds its deadline", async () => {
    project.validations.full = [
      process.execPath,
      "-e",
      "setInterval(() => {}, 1000)",
    ];
    const reviewed = await ticket("task-timeout", "timeout.txt", "timeout\n");
    const integrationQueue = new IntegrationQueue(
      git,
      new ValidationRunner(new ProcessSupervisor(), { timeoutMs: 50 }),
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(receipt).toMatchObject({
      outcome: "timed_out",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
      validation: { name: "full", outcome: "timed_out", exitCode: null },
    });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it.each([
    ["candidate", "cancelled"],
    ["candidate", "timed_out"],
    ["merge", "cancelled"],
    ["merge", "timed_out"],
    ["post-head", "cancelled"],
    ["post-head", "timed_out"],
    ["post-status", "cancelled"],
    ["post-status", "timed_out"],
  ] as const)(
    "maps %s Git termination to %s",
    async (stage, termination) => {
      let candidatePath = "";
      let candidateHeadReads = 0;
      let cleanupAttempted = false;
      class TerminatingGitClient extends GitClient {
        override run(
          cwd: string,
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<CommandResult> {
          const detachIndex = args.indexOf("--detach");
          if (detachIndex !== -1) {
            candidatePath = args[detachIndex + 1] ?? "";
            if (stage === "candidate") {
              return Promise.resolve(terminatedGitResult(termination));
            }
          }
          if (stage === "merge" && args.includes("merge") && !args.includes("merge-base")) {
            return Promise.resolve(terminatedGitResult(termination));
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            candidateHeadReads += 1;
            if (stage === "post-head" && candidateHeadReads === 2) {
              return Promise.resolve(terminatedGitResult(termination));
            }
          }
          if (stage === "post-status" && args.includes("status") && cwd === candidatePath) {
            return Promise.resolve(terminatedGitResult(termination));
          }
          if (args.includes("worktree") && args.includes("remove")) cleanupAttempted = true;
          return super.run(cwd, args, options);
        }
      }
      const reviewed = await ticket(
        `task-${stage}-${termination}`,
        `${stage}-${termination}.txt`,
        "change\n",
      );
      const integrationQueue = new IntegrationQueue(
        new TerminatingGitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      );

      const receipt = await integrate(reviewed, integrationQueue);

      expect(receipt).toMatchObject({ outcome: termination, resultCommit: null });
      if (stage === "post-head" || stage === "post-status") {
        expect(receipt.validation).toMatchObject({ outcome: "completed", exitCode: 0 });
      } else {
        expect(receipt.validation).toMatchObject({ outcome: termination, exitCode: null });
      }
      expect(await integrationHead()).toBe(originalIntegrationHead);
      expect(existsSync(reviewed.lease.path)).toBe(true);
      if (stage === "candidate") {
        expect(cleanupAttempted).toBe(false);
        expect(integrationQueue.getCleanupFailures()[0]).toEqual(
          expect.objectContaining({ candidatePath, reason: expect.stringContaining(termination) }),
        );
      }
    },
  );

  it("returns failed on merge conflict without mutating the integration branch", async () => {
    const reviewed = await ticket(
      "task-004",
      "shared.txt",
      "ticket version\n",
    );
    const competingPath = path.join(worktreeRoot, "competing");
    await gitOk(repositoryPath, [
      "worktree",
      "add",
      "-b",
      "competing",
      competingPath,
      project.integrationBranch,
    ]);
    writeFileSync(path.join(competingPath, "shared.txt"), "integration version\n");
    await gitOk(competingPath, ["add", "--", "shared.txt"]);
    await gitOk(competingPath, ["commit", "-m", "feat: competing change"]);
    const competingCommit = await gitOk(competingPath, ["rev-parse", "HEAD"]);
    await gitOk(repositoryPath, [
      "update-ref",
      `refs/heads/${project.integrationBranch}`,
      competingCommit,
      originalIntegrationHead,
    ]);

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({
      outcome: "failed",
      resultCommit: null,
      validation: { name: "full", outcome: "failed", exitCode: null },
    });
    expect(receipt.validation.stderr).toMatch(/conflict/i);
    expect(await integrationHead()).toBe(competingCommit);
    expect(existsSync(reviewed.lease.path)).toBe(true);
  });

  it("rejects a symbolic integration ref without changing its target", async () => {
    const reviewed = await ticket("task-symbolic", "symbolic.txt", "symbolic\n");
    await gitOk(repositoryPath, [
      "symbolic-ref",
      `refs/heads/${project.integrationBranch}`,
      "refs/heads/main",
    ]);
    const mainHead = await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"]);

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(await gitOk(repositoryPath, ["symbolic-ref", `refs/heads/${project.integrationBranch}`])).toBe(
      "refs/heads/main",
    );
    expect(await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(mainHead);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(false);
  });

  it("does not execute repository hooks during candidate checkout or merge", async () => {
    const reviewed = await ticket("task-hooks", "hooks.txt", "hooks\n");
    const checkoutMarker = path.join(baseDir, "post-checkout-ran");
    const mergeMarker = path.join(baseDir, "post-merge-ran");
    const hooksPath = path.join(repositoryPath, ".git", "hooks");
    for (const [name, marker] of [
      ["post-checkout", checkoutMarker],
      ["post-merge", mergeMarker],
    ] as const) {
      const hookPath = path.join(hooksPath, name);
      writeFileSync(
        hookPath,
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`,
      );
      chmodSync(hookPath, 0o755);
    }

    const receipt = await integrate(reviewed);

    expect(receipt.outcome).toBe("completed");
    expect(existsSync(checkoutMarker)).toBe(false);
    expect(existsSync(mergeMarker)).toBe(false);
  });

  it("does not execute a reference-transaction hook during final CAS", async () => {
    const reviewed = await ticket("task-ref-hook", "ref-hook.txt", "hook-safe\n");
    const marker = path.join(baseDir, "reference-transaction-ran");
    const hookPath = path.join(repositoryPath, ".git", "hooks", "reference-transaction");
    writeFileSync(
      hookPath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")\n`,
    );
    chmodSync(hookPath, 0o755);

    const receipt = await integrate(reviewed);

    expect(receipt.outcome).toBe("completed");
    expect(receipt.resultCommit).toBe(await integrationHead());
    expect(await gitOk(repositoryPath, ["rev-parse", `refs/heads/${project.integrationBranch}`])).toBe(
      receipt.resultCommit,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    "merge.evil.driver",
    "filter.evil.smudge",
    "diff.evil.command",
    "diff.evil.textconv",
    "diff.external",
  ])("fails closed for configured external Git program %s", async (configKey) => {
    const reviewed = await ticket(`task-config-${sha256(configKey).slice(0, 8)}`, "config.txt", "config\n");
    const marker = path.join(baseDir, "configured-program-ran");
    await gitOk(repositoryPath, [
      "config",
      configKey,
      `${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
    ]);

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(false);
  });

  it("runs only one integration at a time per project across queue instances", async () => {
    const lockPath = path.join(baseDir, "validation.lock");
    const overlapPath = path.join(baseDir, "validation.overlap");
    project.validations.full = [
      process.execPath,
      "-e",
      [
        'const fs = require("node:fs");',
        "const [lock, overlap] = process.argv.slice(1);",
        "try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }",
        "catch { fs.writeFileSync(overlap, 'overlap'); process.exit(9); }",
        "setTimeout(() => { fs.unlinkSync(lock); process.exit(0); }, 150);",
      ].join(" "),
      lockPath,
      overlapPath,
    ];
    const first = await ticket("task-005", "first.txt", "first\n");
    const second = await ticket("task-006", "second.txt", "second\n");

    const [firstReceipt, secondReceipt] = await Promise.all([
      integrate(first, queue()),
      integrate(second, queue()),
    ]);

    expect(firstReceipt.outcome).toBe("completed");
    expect(secondReceipt.outcome).toBe("completed");
    expect(existsSync(overlapPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(
      await gitOk(repositoryPath, ["show", `${project.integrationBranch}:first.txt`]),
    ).toBe("first");
    expect(
      await gitOk(repositoryPath, [
        "show",
        `${project.integrationBranch}:second.txt`,
      ]),
    ).toBe("second");
  });

  it("fails CAS when the integration ref moves after candidate validation", async () => {
    const competingPath = path.join(worktreeRoot, "cas-competing");
    await gitOk(repositoryPath, [
      "worktree",
      "add",
      "-b",
      "cas-competing",
      competingPath,
      project.integrationBranch,
    ]);
    writeFileSync(path.join(competingPath, "external.txt"), "external\n", "utf8");
    await gitOk(competingPath, ["add", "--", "external.txt"]);
    await gitOk(competingPath, ["commit", "-m", "feat: external integration"]);
    const competingCommit = await gitOk(competingPath, ["rev-parse", "HEAD"]);
    const reviewed = await ticket("task-cas", "candidate.txt", "candidate\n");

    class RefMovingValidationRunner extends ValidationRunner {
      constructor() {
        super(new ProcessSupervisor());
      }

      override async run(
        ...args: Parameters<ValidationRunner["run"]>
      ): Promise<ValidationReport> {
        const report = await super.run(...args);
        await gitOk(repositoryPath, [
          "update-ref",
          `refs/heads/${project.integrationBranch}`,
          competingCommit,
          originalIntegrationHead,
        ]);
        return report;
      }
    }

    const receipt = await integrate(
      reviewed,
      new IntegrationQueue(git, new RefMovingValidationRunner()),
    );

    expect(receipt).toMatchObject({
      outcome: "failed",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: null,
      validation: { name: "full", outcome: "completed", exitCode: 0 },
    });
    expect(await integrationHead()).toBe(competingCommit);
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(await gitOk(reviewed.lease.path, ["rev-parse", "HEAD"])).toBe(
      reviewed.sourceCommit,
    );
    expect(existsSync(path.join(worktreeRoot, ".integration-candidates"))).toBe(
      false,
    );
  });

  it.each([
    ["before-effect", "timed_out"],
    ["after-effect", "completed"],
    ["competing-head", "uncertain"],
    ["inspection-failure", "uncertain"],
    ["symbolic-after-effect", "uncertain"],
    ["descendant-only", "uncertain"],
  ] as const)(
    "reconciles update-ref timeout %s",
    async (mode, expectedOutcome) => {
      const realGit = new GitClient();
      const integrationRef = `refs/heads/${project.integrationBranch}`;
      const tree = await gitOk(repositoryPath, ["rev-parse", `${originalIntegrationHead}^{tree}`]);
      const competingCommit = await gitOk(repositoryPath, [
        "commit-tree",
        tree,
        "-p",
        originalIntegrationHead,
        "-m",
        "competing integration",
      ]);
      let candidatePath = "";
      let afterUpdate = false;
      let updateOptions: GitRunOptions | undefined;

      class UncertainUpdateGitClient extends GitClient {
        override async run(
          cwd: string,
          args: readonly string[],
          options: GitRunOptions = {},
        ): Promise<CommandResult> {
          const detachIndex = args.indexOf("--detach");
          if (detachIndex !== -1) candidatePath = args[detachIndex + 1] ?? "";
          const updateIndex = args.indexOf("update-ref");
          if (updateIndex !== -1 && args[updateIndex + 1] === "--no-deref") {
            updateOptions = options;
            afterUpdate = true;
            if (mode === "after-effect") {
              expect((await realGit.run(cwd, args)).exitCode).toBe(0);
            } else if (mode === "symbolic-after-effect") {
              const resultCommit = args[updateIndex + 3] ?? "";
              expect(
                (
                  await realGit.run(cwd, [
                    "update-ref",
                    "refs/heads/reconciled-result",
                    resultCommit,
                  ])
                ).exitCode,
              ).toBe(0);
              expect(
                (
                  await realGit.run(cwd, [
                    "symbolic-ref",
                    integrationRef,
                    "refs/heads/reconciled-result",
                  ])
                ).exitCode,
              ).toBe(0);
            } else if (mode === "descendant-only") {
              const resultCommit = args[updateIndex + 3] ?? "";
              expect(
                (
                  await realGit.run(cwd, [
                    "update-ref",
                    "--no-deref",
                    "-d",
                    integrationRef,
                    originalIntegrationHead,
                  ])
                ).exitCode,
              ).toBe(0);
              expect(
                (
                  await realGit.run(cwd, [
                    "update-ref",
                    `${integrationRef}/other`,
                    resultCommit,
                  ])
                ).exitCode,
              ).toBe(0);
            } else if (mode === "competing-head") {
              expect(
                (
                  await realGit.run(cwd, [
                    "update-ref",
                    "--no-deref",
                    integrationRef,
                    competingCommit,
                    originalIntegrationHead,
                  ])
                ).exitCode,
              ).toBe(0);
            }
            return terminatedGitResult("timed_out");
          }
          if (
            mode === "inspection-failure" &&
            afterUpdate &&
            args[0] === "for-each-ref"
          ) {
            return {
              stdout: "",
              stderr: "inspection unavailable",
              exitCode: 1,
              truncated: false,
              termination: null,
            };
          }
          return super.run(cwd, args, options);
        }
      }

      const reviewed = await ticket(`task-update-${mode}`, `${mode}.txt`, "change\n");
      const integrationQueue = new IntegrationQueue(
        new UncertainUpdateGitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      );

      const pending = integrate(reviewed, integrationQueue);
      const receipt = expectedOutcome === "uncertain" ? null : await pending;
      if (expectedOutcome === "uncertain") {
        await expect(pending).rejects.toBeInstanceOf(IntegrationUncertainError);
      } else {
        expect(receipt?.outcome).toBe(expectedOutcome);
        expect(receipt?.validation).toMatchObject({ outcome: "completed", exitCode: 0 });
      }
      expect(updateOptions?.timeoutMs).toBeGreaterThan(0);
      expect(updateOptions?.signal).toBeUndefined();
      if (mode === "after-effect") {
        expect(receipt?.resultCommit).toBe(await integrationHead());
        expect(existsSync(candidatePath)).toBe(false);
      } else if (mode === "before-effect") {
        expect(await integrationHead()).toBe(originalIntegrationHead);
        expect(existsSync(candidatePath)).toBe(false);
      } else {
        if (mode === "competing-head") {
          expect(await integrationHead()).toBe(competingCommit);
        }
        expect(existsSync(candidatePath)).toBe(true);
        expect(
          await gitOk(repositoryPath, ["worktree", "list", "--porcelain"]),
        ).toContain(candidatePath);
        expect(integrationQueue.getCleanupFailures()[0]).toEqual(
          expect.objectContaining({
            candidatePath,
            reason: expect.stringMatching(/update-ref|reconcil/i),
          }),
        );
      }
      expect(existsSync(reviewed.lease.path)).toBe(true);
    },
  );

  it("rejects a fabricated successful full validation before CAS", async () => {
    const reviewed = await ticket("task-fabricated-validation", "fabricated-validation.txt", "change\n");
    class CloningValidationRunner extends ValidationRunner {
      override async run(...args: Parameters<ValidationRunner["run"]>): Promise<ValidationReport> {
        return { ...(await super.run(...args)) };
      }
    }
    const integrationQueue = new IntegrationQueue(
      new GitClient(),
      new CloningValidationRunner(new ProcessSupervisor()),
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(receipt.outcome).toBe("failed");
    expect(receipt.resultCommit).toBeNull();
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("rejects a branded full-validation report replayed from an old subject and cwd", async () => {
    const reviewed = await ticket("task-replayed-validation", "replayed-validation.txt", "change\n");
    const oldReport = await new ValidationRunner(new ProcessSupervisor()).run(
      project,
      "full",
      repositoryPath,
      AbortSignal.timeout(10_000),
      { invocationId: "old-full-validation", subjectSha256: originalIntegrationHead },
    );
    let calls = 0;
    class ReplayingValidationRunner extends ValidationRunner {
      override run(): Promise<ValidationReport> {
        calls += 1;
        return Promise.resolve(oldReport);
      }
    }
    const integrationQueue = new IntegrationQueue(
      new GitClient(),
      new ReplayingValidationRunner(new ProcessSupervisor()),
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(calls).toBe(1);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.resultCommit).toBeNull();
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("includes source/result commits, review, and full validation evidence", async () => {
    const reviewed = await ticket("task-007", "evidence.txt", "evidence\n");

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({
      taskId: reviewed.lease.taskId,
      projectId: project.projectId,
      sourceCommit: reviewed.sourceCommit,
      resultCommit: await integrationHead(),
      review: reviewed.review,
      outcome: "completed",
      validation: {
        name: "full",
        outcome: "completed",
        exitCode: 0,
        stdout: "full validation passed",
        stderr: "",
        command: project.validations.full,
      },
    });
    expect(receipt.validation.argvSha256).toBe(
      sha256(JSON.stringify(project.validations.full)),
    );
    expect(receipt.validation.outputSha256).toBe(
      sha256(
        JSON.stringify({ stdout: "full validation passed", stderr: "" }),
      ),
    );
    expect(Date.parse(receipt.validation.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(receipt.validation.startedAt),
    );
    expect(readFileSync(reviewed.lease.path + "/evidence.txt", "utf8")).toBe(
      "evidence\n",
    );
  });

  it("uses a contained UUID-only candidate path even when taskId traverses", async () => {
    let candidatePath = "";
    let privateRootMode = 0;
    class CapturingGitClient extends GitClient {
      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        const detachIndex = args.indexOf("--detach");
        if (detachIndex !== -1) {
          candidatePath = args[detachIndex + 1] ?? "";
          privateRootMode = statSync(path.dirname(candidatePath)).mode & 0o777;
        }
        return super.run(cwd, args);
      }
    }
    const reviewed = await ticket("task-safe-path", "safe.txt", "safe\n");
    const traversalLease = { ...reviewed.lease, taskId: "../../escaped" };
    const integrationQueue = new IntegrationQueue(
      new CapturingGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    await integrationQueue.integrate({
      project,
      lease: traversalLease,
      review: reviewed.review,
      signal: AbortSignal.timeout(10_000),
    });

    const privateRoot = path.dirname(candidatePath);
    expect(path.dirname(privateRoot)).toBe(realpathSync(worktreeRoot));
    expect(path.basename(privateRoot)).toMatch(/^\.zentra-integration-[A-Za-z0-9_-]+$/);
    expect(privateRootMode).toBe(0o700);
    expect(path.basename(candidatePath)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(existsSync(path.join(baseDir, "escaped"))).toBe(false);
  });

  it("ignores a pre-existing shared candidate symlink", async () => {
    const reviewed = await ticket("task-symlink-root", "symlink.txt", "symlink\n");
    const outside = path.join(baseDir, "outside-candidates");
    mkdirSync(outside);
    symlinkSync(outside, path.join(worktreeRoot, ".integration-candidates"));

    const receipt = await integrate(reviewed);

    expect(receipt).toMatchObject({ outcome: "completed", resultCommit: expect.any(String) });
    expect(existsSync(reviewed.lease.path)).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not remove an unowned registered path when candidate creation reports failure", async () => {
    const realGit = new GitClient();
    let candidatePath = "";
    let cleanupAttempted = false;
    class FailedCreationGitClient extends GitClient {
      override async run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        const detachIndex = args.indexOf("--detach");
        if (detachIndex !== -1) {
          candidatePath = args[detachIndex + 1] ?? "";
          const actual = await realGit.run(cwd, args);
          expect(actual.exitCode).toBe(0);
          return {
            stdout: "",
            stderr: "uncertain creation",
            exitCode: 1,
            truncated: false,
            termination: null,
          };
        }
        if (args.includes("remove")) cleanupAttempted = true;
        return super.run(cwd, args);
      }
    }
    const reviewed = await ticket("task-unowned", "unowned.txt", "unowned\n");

    const integrationQueue = new IntegrationQueue(
      new FailedCreationGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );
    const receipt = await integrate(reviewed, integrationQueue);

    expect(receipt.outcome).toBe("failed");
    expect(cleanupAttempted).toBe(false);
    expect(existsSync(candidatePath)).toBe(true);
    expect(await gitOk(repositoryPath, ["worktree", "list", "--porcelain"])).toContain(
      candidatePath,
    );
    expect(integrationQueue.getCleanupFailures()[0]).toEqual(
      expect.objectContaining({ candidatePath, reason: expect.stringContaining("exit code 1") }),
    );
  });

  it("records thrown candidate creation as uncertain without cleanup", async () => {
    let candidatePath = "";
    let cleanupAttempted = false;
    class ThrowingCreationGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options: GitRunOptions = {},
      ): Promise<CommandResult> {
        const detachIndex = args.indexOf("--detach");
        if (detachIndex !== -1) {
          candidatePath = args[detachIndex + 1] ?? "";
          return Promise.reject(new Error("candidate add transport failure"));
        }
        if (args.includes("worktree") && args.includes("remove")) cleanupAttempted = true;
        return super.run(cwd, args, options);
      }
    }
    const reviewed = await ticket("task-add-throw", "add-throw.txt", "change\n");
    const integrationQueue = new IntegrationQueue(
      new ThrowingCreationGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(receipt.outcome).toBe("failed");
    expect(cleanupAttempted).toBe(false);
    expect(integrationQueue.getCleanupFailures()[0]).toEqual(
      expect.objectContaining({
        candidatePath,
        reason: expect.stringContaining("transport failure"),
      }),
    );
  });

  it("returns the known receipt if candidate cleanup cannot spawn Git", async () => {
    let candidatePath = "";
    class CleanupFailingGitClient extends GitClient {
      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        const detachIndex = args.indexOf("--detach");
        if (detachIndex !== -1) candidatePath = args[detachIndex + 1] ?? "";
        if (args.includes("worktree") && args.includes("remove")) {
          return Promise.reject(new Error("Git cleanup unavailable"));
        }
        return super.run(cwd, args);
      }
    }

    const reviewed = await ticket("task-008", "cleanup.txt", "cleanup\n");
    const integrationQueue = new IntegrationQueue(
      new CleanupFailingGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    await expect(integrate(reviewed, integrationQueue)).resolves.toMatchObject({
      outcome: "completed",
      sourceCommit: reviewed.sourceCommit,
      resultCommit: expect.any(String),
    });
    expect(existsSync(candidatePath)).toBe(true);
    expect(await gitOk(repositoryPath, ["worktree", "list", "--porcelain"])).toContain(
      candidatePath,
    );
    expect(integrationQueue.getCleanupFailures()).toEqual([
      expect.objectContaining({
        projectId: project.projectId,
        taskId: reviewed.lease.taskId,
        candidatePath,
        reason: expect.stringContaining("Git cleanup unavailable"),
      }),
    ]);
  });

  it("records nonzero candidate cleanup without changing the receipt", async () => {
    let candidatePath = "";
    class NonzeroCleanupGitClient extends GitClient {
      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        const detachIndex = args.indexOf("--detach");
        if (detachIndex !== -1) candidatePath = args[detachIndex + 1] ?? "";
        if (args.includes("worktree") && args.includes("remove")) {
          return Promise.resolve({
            stdout: "",
            stderr: "cleanup denied",
            exitCode: 1,
            truncated: false,
            termination: null,
          });
        }
        return super.run(cwd, args);
      }
    }
    const reviewed = await ticket("task-cleanup-nonzero", "cleanup-nonzero.txt", "cleanup\n");
    const integrationQueue = new IntegrationQueue(
      new NonzeroCleanupGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(receipt.outcome).toBe("completed");
    expect(existsSync(candidatePath)).toBe(true);
    expect(integrationQueue.getCleanupFailures()[0]).toEqual(
      expect.objectContaining({ candidatePath, reason: expect.stringContaining("exit code 1") }),
    );
  });
});
