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
import { digestCanonical } from "../../src/contracts/authority-attention.js";
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
import { ReadOnlyGitConflictAnalyzer } from "../../src/integration/conflict-analyzer.js";
import { IntegrationSubmissionSchema, RepositoryOrchestrator } from "../../src/integration/repository-orchestrator.js";
import { IntegrationLeaseStore } from "../../src/integration/integration-lease.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { JournalScheduler } from "../../src/scheduling/journal-scheduler.js";
import { DispatchGrantService } from "../../src/scheduling/dispatch-grant-service.js";
import { dispatchIntentSha256 } from "../../src/scheduling/scheduler-contracts.js";
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
import { PathClaimService } from "../../src/workspaces/path-claims.js";

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

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
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
        focusedTimeoutMs: 5_000,
        fullTimeoutMs: 5_000,
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

  // Mirrors the private INTEGRATION_LEASE_DATABASE filename and location
  // (inside the canonical Git common directory) used by IntegrationQueue.
  async function leaseDatabasePath(): Promise<string> {
    const commonDirectory = await gitOk(repositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return path.join(commonDirectory, ".zentra-integration-leases.sqlite");
  }

  function leaseKeyFor(): { commonDirectory: string; integrationRef: string } {
    return {
      commonDirectory: realpathSync(path.join(repositoryPath, ".git")),
      integrationRef: `refs/heads/${project.integrationBranch}`,
    };
  }

  async function ticket(
    taskId: string,
    file: string,
    content: string,
  ): Promise<{ lease: WorkspaceLease; sourceCommit: string; review: ReviewDecision;
    focusedValidation: ValidationReport }> {
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
      focusedValidation,
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

  async function admitDurably(controller: RepositoryOrchestrator, journal: SqliteEventJournal,
    reviewed: Awaited<ReturnType<typeof ticket>>, input: { readonly suffix: string; readonly podId: string;
      readonly claimId: string; readonly claimLeaseToken: string; readonly contractKey: string;
      readonly baseCommit?: string; readonly changedPath: string; readonly batchKey?: string;
      readonly assignmentCapability?: "write_worktree" | "run_validation";
      readonly schedulerEffect?: "computation" | "potentially_effectful";
      readonly schedulerWriters?: number; readonly focusedValidation?: ValidationReport;
      readonly review?: ReviewDecision; readonly candidateValidation?: ValidationReport;
      readonly correction?: { readonly unitId: string; readonly acceptanceRejectionSha256: string;
        readonly attempt: number; readonly maxAttempts: number; readonly paths: readonly string[] } }) {
    const baseCommit = input.baseCommit ?? originalIntegrationHead;
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();
    const focusedValidation = input.focusedValidation ?? reviewed.focusedValidation;
    const review = input.review ?? reviewed.review;
    const pod = new PodRegistry(journal);
    const charter = { schemaVersion: 1 as const, podId: input.podId, projectId: project.projectId, revision: 1,
      outcome: "Produce one reviewed integration source.", sourceRefs: [{ kind: "ticket" as const, value: input.suffix }],
      tasks: [{ milestoneId: `milestone-${input.suffix}`, taskId: reviewed.lease.taskId, title: "Implement",
        dependencies: [], acceptanceCriteria: ["Reviewed diff is ready."], evidenceRequirements: ["review"] }],
      roles: [{ roleId: "implementer", agentId: "worker-1", taskIds: [reviewed.lease.taskId] }],
      requiredCapabilities: ["run_validation" as const, "write_worktree" as const],
      ownership: { ownedPaths: [input.changedPath], forbiddenPaths: ["refs/**"] },
      budget: { maxSeconds: 60, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1000,
        maxOutputTokens: 1000, maxExternalEffects: 0 as const }, checkpoints: [],
      acceptanceCriteria: ["Source is reviewed."], evidenceRequirements: ["review"],
      forbiddenChanges: ["shared refs"], securityBoundary: "Bounded fixture authority.",
      escalationConditions: ["conflict"], completionRules: ["Reviewed source exists."],
      cleanupRules: ["Preserve on failure."],
      execution: { mode: "local_process" as const, nativeSubagents: false as const, distributed: false as const } };
    pod.register({ charter, correlationId: `run-${input.suffix}` });
    const parentGrant = { schemaVersion: 1 as const, grantId: `pod-grant-${input.suffix}`,
      parentAuthorityId: "repository-controller", podId: input.podId, projectId: project.projectId,
      repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot, charterRevision: 1,
      charterDigest: digestCanonical(charter), agentIds: ["worker-1"],
      capabilities: ["run_validation" as const, "write_worktree" as const],
      ownedPaths: [input.changedPath], forbiddenPaths: ["refs/**"], budget: charter.budget,
      sharedIntegrationRefs: [`refs/heads/${project.integrationBranch}`], issuedAt: now, expiresAt: later,
      executionMode: "local_process" as const, nativeSubagents: false as const, distributed: false as const };
    pod.admit(input.podId, parentGrant, now);
    const assignmentId = `assignment-${input.suffix}`;
    const podLease = { schemaVersion: 1 as const, leaseId: `pod-lease-${input.suffix}`,
      grantId: parentGrant.grantId, podId: input.podId, assignmentId,
      workspaceLeaseId: `workspace-${input.suffix}`, taskId: reviewed.lease.taskId, agentId: "worker-1",
      charterRevision: 1, capabilities: ["run_validation" as const, "write_worktree" as const],
      ownedPaths: [input.changedPath],
      budget: charter.budget, issuedAt: now, expiresAt: later, status: "active" as const };
    pod.receiveLease(input.podId, podLease);
    pod.receiveWorkspaceLease(input.podId, { schemaVersion: 1, workspaceLeaseId: podLease.workspaceLeaseId,
      podLeaseId: podLease.leaseId, podId: input.podId, projectId: project.projectId,
      taskId: reviewed.lease.taskId, repositoryPath: project.repositoryPath, path: reviewed.lease.path,
      branch: reviewed.lease.branch, baseCommit, status: "active" });
    pod.start(input.podId);
    const assignment = { assignmentId, taskId: reviewed.lease.taskId, roleId: "implementer",
      agentId: "worker-1", charterRevision: 1,
      capabilities: [input.assignmentCapability ?? "write_worktree"],
      ownedPaths: [input.changedPath], budget: charter.budget };
    const leaseDigest = digestCanonical(podLease); const grantDigest = digestCanonical(parentGrant);
    const assignmentDigest = digestCanonical(assignment); const charterDigest = digestCanonical(charter);
    const proposalId = digestCanonical({ podId: input.podId, charterRevision: 1,
      workspaceLeaseId: podLease.workspaceLeaseId, assignmentDigest, charterDigest, grantDigest, leaseDigest });
    pod.assign(input.podId, assignment, { proposalId, assignmentDigest, charterDigest, grantDigest, leaseDigest });
    const podDispatchId = randomUUID();
    pod.claimDispatch(input.podId, { assignmentId, proposalId, dispatchId: podDispatchId });
    const executionId = randomUUID();
    pod.startReservedInvocation(input.podId, { assignmentId, dispatchId: podDispatchId,
      authorizedAt: now, executionId, charterRevision: 1 });
    pod.bindExecution(input.podId, { assignmentId, dispatchId: podDispatchId, executionId,
      processId: `process-${input.suffix}`, processIncarnation: `incarnation-${input.suffix}` });
    const evidenceId = `review-${input.suffix}`;
    pod.recordEvidence(input.podId, { evidenceId, taskId: reviewed.lease.taskId, kind: "review",
      sha256: digestCanonical(review), sourceEventId: null });
    pod.observeDispatch(input.podId, { assignmentId, dispatchId: podDispatchId, outcome: "completed",
      evidenceIds: [evidenceId], usage: { elapsedMs: 1, retries: 0, costUsd: 0, inputTokens: 1,
        outputTokens: 1, externalEffects: 0 }, terminationAcknowledged: true });

    const schedulerId = `scheduler-${input.suffix}`;
    const controlIdentity = { controlPlaneId: schedulerId, repositoryIdentity: project.repositoryPath };
    const grants = new DispatchGrantService(journal, controlIdentity, "policy", () => Date.now());
    const scheduler = new JournalScheduler(journal, { schedulerId, processIncarnation: `daemon-${input.suffix}`,
      pid: process.pid, processStartIdentity: `start-${input.suffix}`, platform: "darwin-arm64",
      capabilities: ["run_validation", "write_worktree"], limits: { resources: { reasoning: 1, writers: 1,
        heavyValidation: 1, review: 1, integration: 1 }, budget: { seconds: 1000, inputTokens: 10000,
        outputTokens: 10000, costUsdNano: 1000000 } }, controlIdentity, grants, now: () => Date.now() });
    scheduler.start();
    const scheduled = { taskId: reviewed.lease.taskId, projectId: project.projectId, workerId: "worker-1",
      effect: input.schedulerEffect ?? "potentially_effectful",
      requiredCapabilities: [input.assignmentCapability ?? "write_worktree"],
      platform: "darwin-arm64" as const, workspace: { path: reviewed.lease.path, available: true },
      admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true,
        capabilitySupported: true, platformSupported: true, policyPermits: true, budgetAvailable: true,
        workspaceValid: true, acceptanceCriteria: ["reviewed"], evidenceRequirements: ["receipt"] },
      resources: { reasoning: input.schedulerWriters === 0 ? 1 : 0,
        writers: input.schedulerWriters ?? 1, heavyValidation: 0, review: 0, integration: 0 },
      budget: { seconds: 10, inputTokens: 100, outputTokens: 100, costUsdNano: 1000 },
      grantId: `scheduler-grant-${input.suffix}` };
    grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
      dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: Date.now() + 60_000 });
    scheduler.submit(scheduled);
    const intent = scheduler.tick()[0]!;
    scheduler.started(intent.dispatchId, process.pid, `worker-incarnation-${input.suffix}`, `worker-start-${input.suffix}`);
    scheduler.complete(intent.dispatchId, "completed");
    const candidateValidation = input.candidateValidation ??
      await new ValidationRunner(new ProcessSupervisor()).run(project, "full",
        reviewed.lease.path, AbortSignal.timeout(10_000), {
          invocationId: `candidate-${input.suffix}-${randomUUID()}`, subjectSha256: reviewed.sourceCommit });
    return controller.admitSubmission({ project, projectRevision: baseCommit, podId: input.podId,
      assignmentId, schedulerId, schedulerTaskId: scheduled.taskId,
      claimId: input.claimId, claimLeaseToken: input.claimLeaseToken, baseCommit,
      branch: reviewed.lease.branch, workspacePath: reviewed.lease.path,
      focusedValidation, review,
      contract: { scope: input.batchKey === undefined ? [input.changedPath] : ["coupled-a.txt", "coupled-b.txt"],
        behavior: { key: input.contractKey }, authority: ["worker-1"],
        batchKey: input.batchKey ?? null, candidateValidation },
      ...(input.correction === undefined ? {} : { correction: input.correction }),
      correlationId: `run-${input.suffix}` });
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
    expect(Object.isFrozen(receipt.validation.provenance)).toBe(true);
    expect(isVerifiedIntegrationReceipt({ ...receipt })).toBe(false);
    expect(
      await gitOk(repositoryPath, [
        "show",
        `${project.integrationBranch}:feature.txt`,
      ]),
    ).toBe("integrated");
  });

  it("rebases a tightly coupled unit into one validated CAS without changing main", async () => {
    const first = await ticket("task-coupled-a", "coupled-a.txt", "a\n");
    const second = await ticket("task-coupled-b", "coupled-b.txt", "b\n");
    const mainBefore = await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"]);

    const integrationQueue = queue();
    integrationQueue.bindAdmissionVerifier((_projectId, digest) => {
      const source = digest === "a".repeat(64) ? first : digest === "b".repeat(64) ? second : null;
      return source === null ? null : { digest, projectId: project.projectId, taskId: source.lease.taskId,
        branch: source.lease.branch, sourceCommit: source.sourceCommit,
        diffSha256: source.review.diffSha256, review: source.review };
    });
    const receipt = await integrationQueue.integrateUnit({
      project,
      unitId: "unit-coupled",
      sources: [
        { lease: first.lease, review: first.review, durableAdmissionDigest: "a".repeat(64) },
        { lease: second.lease, review: second.review, durableAdmissionDigest: "b".repeat(64) },
      ],
      historyMode: "rebase",
      signal: AbortSignal.timeout(10_000),
    });

    expect(receipt).toMatchObject({
      outcome: "completed",
      taskId: "unit-coupled",
      sourceCommits: [first.sourceCommit, second.sourceCommit],
    });
    expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:coupled-a.txt`])).toBe("a");
    expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:coupled-b.txt`])).toBe("b");
    expect(await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(mainBefore);
    expect((await gitOk(repositoryPath, ["rev-list", "--parents", "--max-count=1", receipt.resultCommit!]))
      .split(" ")).toHaveLength(2);
  });

  it("leaves no coupled member integrated when unit validation fails", async () => {
    const first = await ticket("task-coupled-fail-a", "fail-a.txt", "a\n");
    const second = await ticket("task-coupled-fail-b", "fail-b.txt", "b\n");
    project.validations.full = [process.execPath, "-e", "process.exit(9)"];

    const integrationQueue = queue();
    integrationQueue.bindAdmissionVerifier((_projectId, digest) => {
      const source = digest === "a".repeat(64) ? first : digest === "b".repeat(64) ? second : null;
      return source === null ? null : { digest, projectId: project.projectId, taskId: source.lease.taskId,
        branch: source.lease.branch, sourceCommit: source.sourceCommit,
        diffSha256: source.review.diffSha256, review: source.review };
    });
    const receipt = await integrationQueue.integrateUnit({
      project,
      unitId: "unit-coupled-fail",
      sources: [
        { lease: first.lease, review: first.review, durableAdmissionDigest: "a".repeat(64) },
        { lease: second.lease, review: second.review, durableAdmissionDigest: "b".repeat(64) },
      ],
      historyMode: "rebase",
      signal: AbortSignal.timeout(10_000),
    });

    expect(receipt).toMatchObject({ outcome: "failed", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
    await expect(git.run(repositoryPath, ["show", `${project.integrationBranch}:fail-a.txt`]))
      .resolves.toMatchObject({ exitCode: 128 });
    await expect(git.run(repositoryPath, ["show", `${project.integrationBranch}:fail-b.txt`]))
      .resolves.toMatchObject({ exitCode: 128 });
  });

  it("rejects raw unit integration without a durable admission lookup", async () => {
    const reviewed = await ticket("task-raw-unit", "raw-unit.txt", "blocked\n");
    await expect(queue().integrateUnit({ project, unitId: "unit-raw", sources: [{
      lease: reviewed.lease, review: reviewed.review, durableAdmissionDigest: "a".repeat(64),
    }], historyMode: "rebase", signal: AbortSignal.timeout(10_000) }))
      .rejects.toThrow(/verifier/i);
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it.each([
    ["assignment without write_worktree", { assignmentCapability: "run_validation" as const }],
    ["computational scheduler effect", { schedulerEffect: "computation" as const }],
    ["scheduler without a writer reservation", { schedulerWriters: 0 }],
  ])("rejects admission with %s", async (_label, override) => {
    const suffix = `negative-${Object.keys(override)[0]}`;
    const changedPath = `${suffix}.txt`;
    const reviewed = await ticket(`task-${suffix}`, changedPath, "blocked\n");
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: reviewed.lease.taskId, claimId: `claim-${suffix}`, revision: originalIntegrationHead,
        paths: [changedPath], leaseMs: 60_000, correlationId: suffix });
      await expect(admitDurably(controller, journal, reviewed, { suffix, podId: `pod-${suffix}`,
        claimId: claim.claimId, claimLeaseToken: claim.leaseToken, contractKey: suffix,
        changedPath, ...override })).rejects.toThrow(/assignment|scheduler|writer/i);
      expect(controller.inspect(project.projectId).admissions).toEqual({});
    } finally {
      journal.close();
    }
  });

  it("rejects focused validation from a stale configured argv", async () => {
    const reviewed = await ticket("task-stale-focused-admission", "stale-focused-admission.txt", "blocked\n");
    project.validations.focused = [process.execPath, "-e", "process.exit(0)", "changed-argv"];
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: reviewed.lease.taskId, claimId: "claim-stale-focused-admission", revision: originalIntegrationHead,
        paths: ["stale-focused-admission.txt"], leaseMs: 60_000, correlationId: "stale-focused" });
      await expect(admitDurably(controller, journal, reviewed, { suffix: "stale-focused-admission",
        podId: "pod-stale-focused-admission", claimId: claim.claimId,
        claimLeaseToken: claim.leaseToken, contractKey: "stale-focused",
        changedPath: "stale-focused-admission.txt" })).rejects.toThrow(/validation evidence/i);
    } finally {
      journal.close();
    }
  });

  it("rejects focused validation submitted from another canonical workspace and subject", async () => {
    const reviewed = await ticket("task-cwd-admission", "cwd-admission.txt", "candidate\n");
    const other = await ticket("task-other-cwd-admission", "other-cwd-admission.txt", "other\n");
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: reviewed.lease.taskId, claimId: "claim-cwd-admission", revision: originalIntegrationHead,
        paths: ["cwd-admission.txt"], leaseMs: 60_000, correlationId: "cwd-admission" });
      await expect(admitDurably(controller, journal, reviewed, { suffix: "cwd-admission",
        podId: "pod-cwd-admission", claimId: claim.claimId, claimLeaseToken: claim.leaseToken,
        contractKey: "cwd-admission", changedPath: "cwd-admission.txt",
        focusedValidation: other.focusedValidation }))
        .rejects.toThrow(/validation evidence/i);
    } finally {
      journal.close();
    }
  });

  it.each(["cancelled", "timed_out", "failed", "failed_nonzero_without_completed_process"] as const)(
    "rejects inconclusive %s candidate validation instead of batching it",
    async (outcome) => {
      const suffix = `inconclusive-${outcome}`;
      const changedPath = `${suffix}.txt`;
      const reviewed = await ticket(`task-${suffix}`, changedPath, "blocked\n");
      let signal: AbortSignal = AbortSignal.timeout(10_000);
      let supervisor = new ProcessSupervisor();
      let expectedOutcome: ValidationReport["outcome"] = outcome === "failed_nonzero_without_completed_process"
        ? "failed" : outcome;
      let expectedExitCode: number | null = null;
      if (outcome === "cancelled") {
        const aborted = new AbortController();
        aborted.abort();
        signal = aborted.signal;
      } else if (outcome === "timed_out") {
        project.validations.full = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
        project.validations.fullTimeoutMs = 100;
      } else if (outcome === "failed") {
        supervisor = new ProcessSupervisor({ maxOutputBytes: 1 });
      } else {
        expectedExitCode = 9;
        supervisor = new class extends ProcessSupervisor {
          override execute(): ReturnType<ProcessSupervisor["execute"]> {
            return Promise.resolve({ outcome: "failed", exitCode: 9, events: [], stdout: "",
              rawStdout: "", stderr: "uncertain process failure" });
          }
        }();
      }
      const candidateValidation = await new ValidationRunner(supervisor).run(project, "full",
        reviewed.lease.path, signal, { invocationId: `candidate-${suffix}`,
          subjectSha256: reviewed.sourceCommit });
      expect(candidateValidation).toMatchObject({ outcome: expectedOutcome, exitCode: expectedExitCode });

      const journal = new SqliteEventJournal(":memory:");
      try {
        const claims = new PathClaimService(journal);
        const controller = new RepositoryOrchestrator(journal, claims, queue(),
          new ReadOnlyGitConflictAnalyzer(git), git);
        const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
          taskId: reviewed.lease.taskId, claimId: `claim-${suffix}`, revision: originalIntegrationHead,
          paths: [changedPath], leaseMs: 60_000, correlationId: suffix });
        await expect(admitDurably(controller, journal, reviewed, { suffix, podId: `pod-${suffix}`,
          claimId: claim.claimId, claimLeaseToken: claim.leaseToken, contractKey: "coupled",
          batchKey: "coupled", changedPath, candidateValidation }))
          .rejects.toThrow(/inconclusive/i);
        expect(controller.inspect(project.projectId).admissions).toEqual({});
      } finally {
        journal.close();
      }
    },
  );

  it("batches only durable partial candidate failures and validates the combined candidate", async () => {
    const first = await ticket("task-durable-coupled-a", "coupled-a.txt", "a\n");
    const second = await ticket("task-durable-coupled-b", "coupled-b.txt", "b\n");
    project.validations.full = [process.execPath, "-e", [
      'const fs = require("node:fs");',
      'process.exit(fs.existsSync("coupled-a.txt") && fs.existsSync("coupled-b.txt") ? 0 : 9);',
    ].join(" ")];
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const firstClaim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: first.lease.taskId, claimId: "claim-durable-coupled-a", revision: originalIntegrationHead,
        paths: ["coupled-a.txt"], leaseMs: 60_000, correlationId: "run-durable-coupled" });
      const secondClaim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: second.lease.taskId, claimId: "claim-durable-coupled-b", revision: originalIntegrationHead,
        paths: ["coupled-b.txt"], leaseMs: 60_000, correlationId: "run-durable-coupled" });
      const firstAdmission = await admitDurably(controller, journal, first, { suffix: "durable-coupled-a",
        podId: "pod-durable-coupled-a", claimId: firstClaim.claimId,
        claimLeaseToken: firstClaim.leaseToken, contractKey: "durable-coupled",
        batchKey: "durable-coupled", changedPath: "coupled-a.txt" });
      const secondAdmission = await admitDurably(controller, journal, second, { suffix: "durable-coupled-b",
        podId: "pod-durable-coupled-b", claimId: secondClaim.claimId,
        claimLeaseToken: secondClaim.leaseToken, contractKey: "durable-coupled",
        batchKey: "durable-coupled", changedPath: "coupled-b.txt" });
      expect(firstAdmission.contract.candidateOutcome).toBe("non_green");
      expect(secondAdmission.contract.candidateOutcome).toBe("non_green");
      const [unit] = controller.formUnits(project.projectId,
        [firstAdmission.receiptId, secondAdmission.receiptId], "run-durable-coupled");
      expect(unit).toMatchObject({ tightlyCoupled: true });
      await expect(controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-durable-coupled" }))
        .resolves.toMatchObject({ kind: "integrated" });
      expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:coupled-a.txt`])).toBe("a");
      expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:coupled-b.txt`])).toBe("b");
    } finally {
      journal.close();
    }
  });

  it("runs central ownership, stale rebase, durable acceptance, restart, and cancellation end to end", async () => {
    const reviewed = await ticket("task-central", "central.txt", "central\n");
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const integrationQueue = queue();
      const controller = new RepositoryOrchestrator(journal, claims, integrationQueue,
        new ReadOnlyGitConflictAnalyzer(git), git);
      const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: reviewed.lease.taskId, claimId: "claim-central", revision: originalIntegrationHead,
        paths: ["central.txt"], leaseMs: 60_000, correlationId: "run-central" });
      expect(claim.ownerId).toBe("worker-1");

      const advancePath = path.join(worktreeRoot, "central-advance");
      await gitOk(repositoryPath, ["worktree", "add", "-b", "central-advance",
        advancePath, project.integrationBranch]);
      writeFileSync(path.join(advancePath, "advanced.txt"), "advanced\n");
      await gitOk(advancePath, ["add", "--", "advanced.txt"]);
      await gitOk(advancePath, ["commit", "-m", "advance integration"]);
      const advanced = await gitOk(advancePath, ["rev-parse", "HEAD"]);
      await gitOk(repositoryPath, ["update-ref", `refs/heads/${project.integrationBranch}`,
        advanced, originalIntegrationHead]);

      const admission = await admitDurably(controller, journal, reviewed, { suffix: "central", podId: "pod-central",
        claimId: claim.claimId, claimLeaseToken: claim.leaseToken, contractKey: "central",
        changedPath: "central.txt" });
      const [unit] = controller.formUnits(project.projectId, [admission.receiptId], "run-central");
      const result = await controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-central" });
      expect(result.kind).toBe("integrated");
      expect(controller.inspect(project.projectId).units[unit!.unitId]).toMatchObject({
        status: "integrated", expectedCommit: advanced, resultCommit: await integrationHead(),
      });
      expect(journal.readStream(`repository-orchestration:${project.projectId}`).map((event) => event.type))
        .toEqual(["repository.submission_admitted", "integration.unit_formed", "rebase.started", "integration.candidate_created",
          "integration.candidate_validated", "rebase.completed", "integration.committed"]);

      controller.requestFinalAcceptance(project.projectId, unit!.unitId, "f".repeat(64), "run-central");
      const rejection = controller.decideFinalAcceptance(project.projectId, { unitId: unit!.unitId, accepted: false,
        decidedBy: "operator", reason: "One bounded correction is required." }, "run-central");
      const correctionBase = await integrationHead();
      claims.release({ projectId: project.projectId, claimId: claim.claimId, ownerId: "worker-1",
        revision: originalIntegrationHead, leaseToken: claim.leaseToken, correlationId: "run-central" });
      const corrected = await ticket("task-central-correction", "central.txt", "corrected\n");
      const correctionClaim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: corrected.lease.taskId, claimId: "claim-central-correction", revision: correctionBase,
        paths: ["central.txt"], leaseMs: 60_000, correlationId: "run-central" });
      const correctionAdmission = await admitDurably(controller, journal, corrected, {
        suffix: "central-correction", podId: "pod-central-correction", claimId: correctionClaim.claimId,
        claimLeaseToken: correctionClaim.leaseToken, contractKey: "central", changedPath: "central.txt",
        baseCommit: correctionBase, correction: { unitId: unit!.unitId,
          acceptanceRejectionSha256: rejection.acceptanceRejectionSha256!, attempt: 1,
          maxAttempts: 1, paths: ["central.txt"] } });
      expect(() => controller.planCorrection(project.projectId, { unitId: unit!.unitId, attempt: 2,
        maxAttempts: 2, paths: ["central.txt"], acceptanceRejectionSha256: rejection.acceptanceRejectionSha256!,
        replacementAdmissionReceiptIds: [correctionAdmission.receiptId], behaviorChanges: [], authorityChanges: [],
        rationale: "Invalid non-monotonic correction." }, "run-central")).toThrow(/monotonic/i);
      const correction = controller.planCorrection(project.projectId, { unitId: unit!.unitId, attempt: 1,
        maxAttempts: 1, paths: ["central.txt"], acceptanceRejectionSha256: rejection.acceptanceRejectionSha256!,
        replacementAdmissionReceiptIds: [correctionAdmission.receiptId], behaviorChanges: [], authorityChanges: [],
        rationale: "Apply the exact final-acceptance correction." }, "run-central");
      expect(correction.requiresApproval).toBe(true);
      expect(() => controller.decideCorrection(project.projectId, { unitId: unit!.unitId,
        approvalDigest: "0".repeat(64), approved: true, decidedBy: "operator" }, "run-central"))
        .toThrow(/exact/i);
      expect(controller.decideCorrection(project.projectId, { unitId: unit!.unitId,
        approvalDigest: correction.approvalDigest, approved: true, decidedBy: "operator" },
      "run-central").status).toBe("formed");
      await expect(controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-central" }))
        .resolves.toMatchObject({ kind: "integrated" });
      controller.requestFinalAcceptance(project.projectId, unit!.unitId, "e".repeat(64), "run-central");
      controller.decideFinalAcceptance(project.projectId, { unitId: unit!.unitId, accepted: true,
        decidedBy: "operator", reason: "Correction accepted." }, "run-central");
      await controller.cancel(project, "operator", "stop remaining units", "run-central");
      const restarted = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git).inspect(project.projectId);
      expect(restarted).toMatchObject({ cancelled: true });
      expect(restarted.units[unit!.unitId]).toMatchObject({
        status: "accepted", correctionCount: 1,
      });
      expect(restarted.integratedCommits).toHaveLength(2);
      expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:central.txt`])).toBe("corrected");
    } finally {
      journal.close();
    }
  });

  it("durably replaces a conflicted source after exact approval and integrates the replacement", async () => {
    const first = await ticket("task-conflict-a", "shared.txt", "first\n");
    const competingPath = path.join(worktreeRoot, "replan-competing");
    await gitOk(repositoryPath, ["worktree", "add", "-b", "replan-competing", competingPath,
      project.integrationBranch]);
    writeFileSync(path.join(competingPath, "shared.txt"), "integration\n");
    await gitOk(competingPath, ["commit", "-am", "advance shared"]);
    const advanced = await gitOk(competingPath, ["rev-parse", "HEAD"]);
    await gitOk(repositoryPath, ["update-ref", `refs/heads/${project.integrationBranch}`, advanced,
      originalIntegrationHead]);
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const firstClaim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: first.lease.taskId, claimId: "claim-conflict-a", revision: originalIntegrationHead,
        paths: ["shared.txt"], leaseMs: 60_000, correlationId: "run-conflict" });
      const firstAdmission = await admitDurably(controller, journal, first, { suffix: "conflict-a", podId: "pod-conflict-a",
        claimId: firstClaim.claimId, claimLeaseToken: firstClaim.leaseToken,
        contractKey: "shared-contract", changedPath: "shared.txt" });
      const streamId = `repository-orchestration:${project.projectId}`;
      const [unit] = controller.formUnits(project.projectId, [firstAdmission.receiptId], "run-conflict");
      const result = await controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-conflict" });

      expect(result).toMatchObject({ kind: "conflict" });
      expect(await integrationHead()).toBe(advanced);
      const conflict = journal.readStream(streamId)
        .find((event) => event.type === "conflict.observed")!.payload as { conflictId: string };
      claims.release({ projectId: project.projectId, claimId: firstClaim.claimId, ownerId: "worker-1",
        revision: originalIntegrationHead, leaseToken: firstClaim.leaseToken, correlationId: "run-conflict" });
      const replacement = await ticket("task-conflict-replacement", "shared.txt", "resolved\n");
      const replacementClaim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: replacement.lease.taskId, claimId: "claim-conflict-replacement", revision: advanced,
        paths: ["shared.txt"], leaseMs: 60_000, correlationId: "run-conflict" });
      const replacementAdmission = await admitDurably(controller, journal, replacement, { suffix: "conflict-replacement",
        podId: "pod-conflict-replacement", claimId: replacementClaim.claimId,
        claimLeaseToken: replacementClaim.leaseToken,
        contractKey: "shared-contract", baseCommit: advanced, changedPath: "shared.txt" });
      const proposal = controller.proposeReplan(project.projectId, { projectId: project.projectId,
        unitId: unit!.unitId, conflictId: conflict.conflictId, attempt: 1, maxAttempts: 1,
        changedPaths: ["shared.txt"], behaviorChanges: [], authorityChanges: [],
        rationale: "Resolve the exact conflict.",
        replacementAdmissionReceiptIds: [replacementAdmission.receiptId] }, "run-conflict");
      expect(() => controller.decideReplan(project.projectId, { unitId: unit!.unitId,
        approvalDigest: "0".repeat(64), approved: true, decidedBy: "operator" }, "run-conflict"))
        .toThrow(/exact/i);
      expect(controller.decideReplan(project.projectId, { unitId: unit!.unitId,
        approvalDigest: proposal.approvalDigest, approved: true, decidedBy: "operator" },
      "run-conflict").status).toBe("formed");
      await expect(controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-conflict" }))
        .resolves.toMatchObject({ kind: "integrated" });
      expect(await gitOk(repositoryPath, ["show", `${project.integrationBranch}:shared.txt`])).toBe("resolved");
    } finally {
      journal.close();
    }
  });

  it("serializes durable cancellation behind the exact CAS lease and records it after a winning commit", async () => {
    const reviewed = await ticket("task-controller-cancel", "controller-cancel.txt", "candidate\n");
    let casReached!: () => void;
    let releaseCas!: () => void;
    const casBarrier = new Promise<void>((resolve) => { casReached = resolve; });
    const releaseBarrier = new Promise<void>((resolve) => { releaseCas = resolve; });
    class BarrierGitClient extends GitClient {
      override async run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<CommandResult> {
        if (args.includes("update-ref") && args.includes(`refs/heads/${project.integrationBranch}`)) {
          casReached();
          await releaseBarrier;
        }
        return super.run(cwd, args, options);
      }
    }
    const barrierGit = new BarrierGitClient();
    const journal = new SqliteEventJournal(":memory:");
    try {
      const claims = new PathClaimService(journal);
      const controller = new RepositoryOrchestrator(journal, claims,
        new IntegrationQueue(barrierGit, new ValidationRunner(new ProcessSupervisor())),
        new ReadOnlyGitConflictAnalyzer(barrierGit), barrierGit);
      const cancellingController = new RepositoryOrchestrator(journal, claims, queue(),
        new ReadOnlyGitConflictAnalyzer(git), git);
      const claim = controller.arbitrateOwnership({ projectId: project.projectId, podId: "worker-1",
        taskId: reviewed.lease.taskId, claimId: "claim-controller-cancel", revision: originalIntegrationHead,
        paths: ["controller-cancel.txt"], leaseMs: 60_000, correlationId: "run-cancel" });
      const admission = await admitDurably(controller, journal, reviewed, { suffix: "controller-cancel", podId: "pod-controller-cancel",
        claimId: claim.claimId, claimLeaseToken: claim.leaseToken, contractKey: "cancel",
        changedPath: "controller-cancel.txt" });
      const [unit] = controller.formUnits(project.projectId, [admission.receiptId], "run-cancel");
      const pending = controller.integrate({ project, unitId: unit!.unitId,
        signal: AbortSignal.timeout(10_000), correlationId: "run-cancel" });
      await casBarrier;

      let cancellationSettled = false;
      const cancellation = cancellingController.cancel(project, "operator", "cancel active candidate", "run-cancel")
        .finally(() => { cancellationSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cancellationSettled).toBe(false);
      expect(controller.inspect(project.projectId).cancelled).toBe(false);

      releaseCas();
      await expect(pending).resolves.toMatchObject({ kind: "integrated" });
      await expect(cancellation).resolves.toMatchObject({ cancelled: true });
      expect(await integrationHead()).not.toBe(originalIntegrationHead);
      const terminalOrder = journal.readStream(`repository-orchestration:${project.projectId}`)
        .map((event) => event.type).filter((type) =>
          type === "integration.committed" || type === "repository.cancellation_requested");
      expect(terminalOrder).toEqual(["integration.committed", "repository.cancellation_requested"]);
    } finally {
      releaseCas();
      journal.close();
    }
  });

  it("aborts integration when durable cancellation wins the canonical repository lease", async () => {
    const reviewed = await ticket("task-cancellation-wins", "cancellation-wins.txt", "candidate\n");
    let cancelled = false;
    const cancellationQueue = queue();
    await cancellationQueue.serializeRepositoryCancellation({ project,
      signal: AbortSignal.timeout(10_000), appendUnderLease() { cancelled = true; } });
    const integrationQueue = queue();
    integrationQueue.bindCancellationVerifier(() => cancelled);

    await expect(integrationQueue.integrate({ project, lease: reviewed.lease, review: reviewed.review,
      signal: AbortSignal.timeout(10_000) }))
      .resolves.toMatchObject({ outcome: "cancelled", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("invokes the prepared sink exactly once before update-ref", async () => {
    const reviewed = await ticket("task-prepared-order", "prepared.txt", "prepared\n");
    const ordering: string[] = [];
    class OrderingGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (args.includes("update-ref")) ordering.push("update-ref");
        return super.run(cwd, args, options);
      }
    }
    const integrationQueue = new IntegrationQueue(
      new OrderingGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
    );

    const receipt = await integrationQueue.integrate({
      project,
      lease: reviewed.lease,
      review: reviewed.review,
      signal: AbortSignal.timeout(10_000),
      onPrepared(prepared) {
        ordering.push("prepared");
        expect(Object.isFrozen(prepared)).toBe(true);
        expect(prepared).toMatchObject({ outcome: "completed", resultCommit: expect.any(String) });
      },
    });

    expect(receipt.outcome).toBe("completed");
    expect(ordering).toEqual(["prepared", "update-ref"]);
  });

  it("does not update the integration ref when the prepared sink fails", async () => {
    const reviewed = await ticket("task-prepared-failure", "prepared-failure.txt", "prepared\n");

    await expect(queue().integrate({
      project,
      lease: reviewed.lease,
      review: reviewed.review,
      signal: AbortSignal.timeout(10_000),
      onPrepared() {
        throw new Error("journal unavailable");
      },
    })).rejects.toThrow("journal unavailable");
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });

  it("honors cancellation that races prepared evidence before CAS", async () => {
    const reviewed = await ticket("task-prepared-cancel", "prepared-cancel.txt", "prepared\n");
    const controller = new AbortController();
    let prepared!: () => void;
    let release!: () => void;
    const preparedSignal = new Promise<void>((resolve) => { prepared = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const pending = queue().integrate({ project, lease: reviewed.lease, review: reviewed.review,
      signal: controller.signal, async onPrepared() { prepared(); await releaseSignal; } });
    await preparedSignal;
    controller.abort();
    release();
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", resultCommit: null });
    expect(await integrationHead()).toBe(originalIntegrationHead);
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
      originalIntegrationCommit: null,
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
      originalIntegrationCommit: originalIntegrationHead,
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
    project.validations.fullTimeoutMs = 100;
    const reviewed = await ticket("task-timeout", "timeout.txt", "timeout\n");
    const integrationQueue = new IntegrationQueue(
      git,
      new ValidationRunner(new ProcessSupervisor()),
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
      originalIntegrationCommit: competingCommit,
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

  it.each(["main", "master"])("rejects protected integration branch %s before Git effects", async (branch) => {
    const reviewed = await ticket(`task-protected-${branch}`, `protected-${branch}.txt`, "blocked\n");
    const mainBefore = await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"]);
    await expect(new IntegrationQueue(git, new ValidationRunner(new ProcessSupervisor())).integrate({
      project: { ...project, integrationBranch: branch }, lease: reviewed.lease,
      review: reviewed.review, signal: AbortSignal.timeout(10_000),
    })).rejects.toThrow(/dedicated|protected/i);
    expect(await gitOk(repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(mainBefore);
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

  it("runs only one integration at a time for one common directory and ref", async () => {
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

  it("reconciles the exact integration ref only while holding the durable integration lease", async () => {
    const store = new IntegrationLeaseStore(await leaseDatabasePath());
    const held = store.acquire(leaseKeyFor(), 10_000)!;
    let observed = false;
    try {
      const pending = queue().reconcileIntegrationRef({ project, signal: AbortSignal.timeout(10_000),
        observeUnderLease(actualCommit) { observed = true; return actualCommit; } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(observed).toBe(false);
      expect(store.release(held)).toBe(true);
      await expect(pending).resolves.toBe(originalIntegrationHead);
      expect(observed).toBe(true);
    } finally {
      store.close();
    }
  });

  it("does not serialize a reused project ID across canonical repositories", async () => {
    const otherRepository = path.join(baseDir, "other-repository");
    mkdirSync(otherRepository);
    const reviewed = await ticket("task-reused-project", "reused.txt", "change\n");
    const sourceResolvers: Array<() => void> = [];
    let concurrentSourceReads = 0;

    class ConcurrentSourceGitClient extends GitClient {
      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        if (args.includes("--git-common-dir")) {
          return Promise.resolve({
            stdout: `${cwd}\n`, stderr: "", exitCode: 0, truncated: false, termination: null,
          });
        }
        if (args.includes("refs/replace/")) {
          return Promise.resolve({
            stdout: "", stderr: "", exitCode: 0, truncated: false, termination: null,
          });
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          concurrentSourceReads += 1;
          return new Promise((resolve) => sourceResolvers.push(() => resolve({
            stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0, truncated: false, termination: null,
          })));
        }
        throw new Error(`unexpected Git call: ${args.join(" ")}`);
      }
    }

    const fakeReview = { ...reviewed.review };
    const otherProject = { ...project, repositoryPath: otherRepository };
    const pending = [project, otherProject].map((selectedProject, index) =>
      new IntegrationQueue(
        new ConcurrentSourceGitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      ).integrate({
        project: selectedProject,
        lease: { taskId: `reuse-${index}`, branch: `ticket/reuse-${index}`, path: repositoryPath },
        review: fakeReview,
        signal: AbortSignal.timeout(10_000),
      })
    );

    await waitForCondition(() => concurrentSourceReads === 2);
    for (const resolve of sourceResolvers) resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      expect.objectContaining({ outcome: "failed" }),
      expect.objectContaining({ outcome: "failed" }),
    ]);
  });

  it("does not serialize different exact refs in one canonical repository", async () => {
    const reviewed = await ticket("task-different-refs", "refs.txt", "change\n");
    const sourceResolvers: Array<() => void> = [];
    let concurrentSourceReads = 0;

    class ConcurrentRefGitClient extends GitClient {
      override run(cwd: string, args: readonly string[]): Promise<CommandResult> {
        if (args.includes("--git-common-dir")) {
          return Promise.resolve({
            stdout: `${repositoryPath}\n`, stderr: "", exitCode: 0, truncated: false, termination: null,
          });
        }
        if (args.includes("refs/replace/")) {
          return Promise.resolve({
            stdout: "", stderr: "", exitCode: 0, truncated: false, termination: null,
          });
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          concurrentSourceReads += 1;
          return new Promise((resolve) => sourceResolvers.push(() => resolve({
            stdout: `${"b".repeat(40)}\n`, stderr: "", exitCode: 0, truncated: false, termination: null,
          })));
        }
        throw new Error(`unexpected Git call: ${args.join(" ")}`);
      }
    }

    const fakeReview = { ...reviewed.review };
    const pending = [project, { ...project, integrationBranch: "release" }].map(
      (selectedProject, index) => new IntegrationQueue(
        new ConcurrentRefGitClient(),
        new ValidationRunner(new ProcessSupervisor()),
      ).integrate({
        project: selectedProject,
        lease: { taskId: `ref-${index}`, branch: `ticket/ref-${index}`, path: repositoryPath },
        review: fakeReview,
        signal: AbortSignal.timeout(10_000),
      }),
    );

    await waitForCondition(() => concurrentSourceReads === 2);
    for (const resolve of sourceResolvers) resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      expect.objectContaining({ outcome: "failed" }),
      expect.objectContaining({ outcome: "failed" }),
    ]);
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
      originalIntegrationCommit: originalIntegrationHead,
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
    expect(receipt.validation.provenance).toMatchObject({
      subjectSha256: receipt.resultCommit,
    });
    expect(receipt.validation.provenance.invocationId).not.toBe("");
    expect(path.dirname(path.dirname(receipt.validation.provenance.canonicalCwd))).toBe(
      realpathSync(worktreeRoot),
    );
    expect(path.basename(path.dirname(receipt.validation.provenance.canonicalCwd))).toMatch(
      /^\.zentra-integration-[A-Za-z0-9_-]{6}$/,
    );
    expect(Object.isFrozen(receipt.validation.provenance)).toBe(true);
    expect(Date.parse(receipt.validation.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(receipt.validation.startedAt),
    );
    expect(readFileSync(reviewed.lease.path + "/evidence.txt", "utf8")).toBe(
      "evidence\n",
    );
  });

  it("records the advanced integration base used for a stale ticket source", async () => {
    const reviewed = await ticket("task-stale-base", "stale.txt", "ticket from A\n");
    await gitOk(repositoryPath, ["switch", project.integrationBranch]);
    writeFileSync(path.join(repositoryPath, "base-b.txt"), "integration advanced\n", "utf8");
    await gitOk(repositoryPath, ["add", "--", "base-b.txt"]);
    await gitOk(repositoryPath, ["commit", "-m", "advance integration to B"]);
    const baseB = await integrationHead();

    const receipt = await integrate(reviewed);

    expect(receipt.outcome).toBe("completed");
    expect(receipt.originalIntegrationCommit).toBe(baseB);
    const parents = (
      await gitOk(repositoryPath, ["rev-list", "--parents", "--max-count=1", receipt.resultCommit!])
    ).split(" ");
    expect(parents).toEqual([receipt.resultCommit, baseB, reviewed.sourceCommit]);
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

  it("preserves a completed result when the lease is discovered lost only after update-ref already succeeded", async () => {
    const key = leaseKeyFor();
    const databasePath = await leaseDatabasePath();
    let stolen = false;

    class LeaseStealingGitClient extends GitClient {
      override async run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (!stolen && args.includes("update-ref") && args.includes("--no-deref")) {
          stolen = true;
          // Simulate a competing process reclaiming the lease the instant after
          // this process's own assertLease() checkpoint has already passed, but
          // before the periodic renewal timer notices. The real update-ref below
          // still runs and succeeds under this process's ownership.
          const thief = new IntegrationLeaseStore(databasePath);
          try {
            thief.acquire(key, 1_000, Date.now() + 1_000_000);
          } finally {
            thief.close();
          }
        }
        return super.run(cwd, args, options);
      }
    }

    const reviewed = await ticket("task-lease-lost-after-success", "lease-lost.txt", "change\n");
    const integrationQueue = new IntegrationQueue(
      new LeaseStealingGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
      { integrationLeaseRenewalMs: 20 },
    );

    const receipt = await integrate(reviewed, integrationQueue);

    expect(stolen).toBe(true);
    expect(receipt.outcome).toBe("completed");
    expect(receipt.resultCommit).toBe(await integrationHead());
    expect(isVerifiedIntegrationReceipt(receipt)).toBe(true);
    await waitForCondition(() => integrationQueue.getLeaseAnomalies().length > 0);
    expect(integrationQueue.getLeaseAnomalies()[0]).toEqual(
      expect.objectContaining({
        commonDirectory: key.commonDirectory,
        integrationRef: key.integrationRef,
        reason: expect.stringContaining("lost after action() already completed successfully"),
      }),
    );
  });

  it("preserves a thrown action() error and its evidence even when lease release also fails", async () => {
    const key = leaseKeyFor();
    const databasePath = await leaseDatabasePath();

    class ReconciliationFailureGitClient extends GitClient {
      private stoleAfterUpdate = false;

      override async run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        const updateIndex = args.indexOf("update-ref");
        if (updateIndex !== -1 && args[updateIndex + 1] === "--no-deref") {
          return terminatedGitResult("timed_out");
        }
        if (!this.stoleAfterUpdate && args[0] === "for-each-ref") {
          this.stoleAfterUpdate = true;
          // Corrupt the owner token directly in the durable lease store so the
          // eventual release() call (owner-token compare-and-swap) fails for a
          // reason unrelated to the real IntegrationUncertainError below.
          const saboteur = new IntegrationLeaseStore(databasePath);
          try {
            const current = saboteur.read(key);
            if (current !== null) {
              saboteur.release(current);
              saboteur.acquire(key, 1_000);
            }
          } finally {
            saboteur.close();
          }
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

    const reviewed = await ticket(
      "task-lease-release-fails",
      "lease-release-fails.txt",
      "change\n",
    );
    const integrationQueue = new IntegrationQueue(
      new ReconciliationFailureGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
      { integrationLeaseRenewalMs: 60_000 },
    );

    await expect(integrate(reviewed, integrationQueue)).rejects.toMatchObject({
      name: "IntegrationUncertainError",
      message: expect.stringContaining("update-ref reconciliation unresolved"),
      evidence: expect.objectContaining({
        reconciliationIssue: expect.stringContaining("inspection unavailable"),
      }),
    });
    expect(integrationQueue.getLeaseAnomalies()[0]).toEqual(
      expect.objectContaining({
        commonDirectory: key.commonDirectory,
        integrationRef: key.integrationRef,
        reason: expect.stringContaining("release failed"),
      }),
    );
  });

  it("fails closed and never attempts update-ref when the lease was reclaimed during a long onPrepared callback", async () => {
    const key = leaseKeyFor();
    const databasePath = await leaseDatabasePath();
    let updateRefAttempted = false;

    class SpyGitClient extends GitClient {
      override run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): Promise<CommandResult> {
        if (args.includes("update-ref") && args.includes("--no-deref")) {
          updateRefAttempted = true;
        }
        return super.run(cwd, args, options);
      }
    }

    const reviewed = await ticket(
      "task-reclaimed-during-onprepared",
      "reclaimed.txt",
      "change\n",
    );
    const integrationQueue = new IntegrationQueue(
      new SpyGitClient(),
      new ValidationRunner(new ProcessSupervisor()),
      { integrationLeaseRenewalMs: 60_000 },
    );

    await expect(
      integrationQueue.integrate({
        project,
        lease: reviewed.lease,
        review: reviewed.review,
        signal: AbortSignal.timeout(10_000),
        onPrepared() {
          // A long-running caller-supplied callback during which another
          // process reclaims the lease after it (legitimately) expired.
          const thief = new IntegrationLeaseStore(databasePath);
          try {
            const current = thief.read(key);
            if (current !== null) thief.release(current);
            thief.acquire(key, 1_000);
          } finally {
            thief.close();
          }
        },
      }),
    ).rejects.toThrow("integration lease ownership was lost");

    expect(updateRefAttempted).toBe(false);
    expect(await integrationHead()).toBe(originalIntegrationHead);
  });
});
