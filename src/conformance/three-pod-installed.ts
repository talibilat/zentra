import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ValidationRunner, type ValidationReport } from "../capabilities/validation-runner.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { PlannedTask } from "../contracts/milestone.js";
import { buildWriterPatchProposal } from "../contracts/writer-patch.js";
import { OpenCodeProbe } from "../harnesses/opencode-probe.js";
import { OpenCodeWriter } from "../harnesses/opencode-writer.js";
import { ReadOnlyGitConflictAnalyzer } from "../integration/conflict-analyzer.js";
import { IntegrationQueue } from "../integration/integration-queue.js";
import { RepositoryOrchestrator, type IntegrationSubmission } from "../integration/repository-orchestrator.js";
import { SqliteEventJournal } from "../journal/sqlite-journal.js";
import { OpenCodeMultiFileWriter, type OpenCodeMultiFileWriterRequest } from "../orchestration/opencode-multi-file-writer.js";
import { WriterWorktreeCapsule, type WriterCapsuleResult } from "../orchestration/writer-worktree-capsule.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import { authorizePodUsageMeter, PodCoordinator, type PodDispatchAdapter, type PodDispatchPacket,
  type PodDispatchResult, type PodExecutionHandle, type PodExecutionReservation, type PodUsageMeter } from "../pods/pod-coordinator.js";
import type { PodAssignment, PodCharter, PodLease, PodParentGrant, PodWorkspaceLease } from "../pods/pod-contracts.js";
import { PodRegistry } from "../pods/pod-registry.js";
import { type ProjectConfig } from "../projects/project-config.js";
import { ReviewGate } from "../reviews/review-gate.js";
import { canonicalValidationDigest, type ReviewDecision } from "../reviews/reviewer-adapter.js";
import { DaemonScheduler, type DispatchExecution, type SchedulerExecutor } from "../scheduling/daemon-scheduler.js";
import { DispatchGrantService } from "../scheduling/dispatch-grant-service.js";
import { dispatchIntentSha256, JournalScheduler } from "../scheduling/journal-scheduler.js";
import type { DispatchIntent, SchedulerTaskInput } from "../scheduling/scheduler-contracts.js";
import { ProcessSupervisor } from "../workers/process-supervisor.js";
import { buildRoleCapabilityBinding, RoleCapabilityEnvelopeService } from "../workers/role-capability-envelope.js";
import { GitClient, type CommandResult, type GitRunOptions } from "../workspaces/git-client.js";
import { PathClaimConflictError, PathClaimService } from "../workspaces/path-claims.js";
import { WorkspaceOwnershipGate } from "../workspaces/workspace-ownership.js";
import { WorktreeManager, type WorkspaceLease } from "../workspaces/worktree-manager.js";
import { buildThreePodConformanceReport, type ThreePodConformanceReport } from "./three-pod-report.js";

const RUN_ID = "run-three-pod-installed";
const PROJECT_ID = "three-pod-installed";
const SCHEDULER_ID = RUN_ID;
const LIMITS = { resources: { reasoning: 8, writers: 4, heavyValidation: 2, review: 2, integration: 1 },
  budget: { seconds: 10_000, inputTokens: 100_000, outputTokens: 100_000, costUsdNano: 1_000_000 } } as const;

export interface InstalledThreePodResult {
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly project: ProjectConfig;
  readonly report: ThreePodConformanceReport;
  readonly reportPath: string;
  readonly mainCommit: string;
  readonly integrationCommit: string;
  readonly writerMutationCount: number;
}

export async function runInstalledThreePodConformance(rootInput: string): Promise<InstalledThreePodResult> {
  const root = realpathSync.native(rootInput);
  const databasePath = path.join(root, "three-pod.sqlite");
  const repositoryPath = path.join(root, "repository");
  const git = new GitClient();
  await gitOk(git, root, ["init", "-b", "main", repositoryPath]);
  await gitOk(git, repositoryPath, ["config", "user.name", "Zentra Conformance"]);
  await gitOk(git, repositoryPath, ["config", "user.email", "conformance@zentra.local"]);
  mkdirSync(path.join(repositoryPath, "src")); mkdirSync(path.join(repositoryPath, "test"));
  for (const suffix of ["a", "b", "c", "d"]) writeFileSync(path.join(repositoryPath, `src/${suffix}.ts`), `export const ${suffix} = "base-${suffix}";\n`);
  writeFileSync(path.join(repositoryPath, "test/all.test.mjs"), "import test from 'node:test'; test('green', () => {});\n");
  await gitOk(git, repositoryPath, ["add", "--", "."]); await gitOk(git, repositoryPath, ["commit", "-m", "fixture"]);
  const mainCommit = await gitText(git, repositoryPath, ["rev-parse", "HEAD"]);
  const project: ProjectConfig = { projectId: PROJECT_ID, repositoryPath, integrationBranch: "zentra/integration",
    worktreeRoot: path.join(root, "worktrees"), validations: { focused: [process.execPath, "--test", "test/all.test.mjs"],
      full: [process.execPath, "--test"], focusedTimeoutMs: 10_000, fullTimeoutMs: 10_000 } };
  await new WorktreeManager(git).ensureIntegrationBranch(project);

  const clock = new TrustedFixtureClock();
  let journal = new SqliteEventJournal(databasePath);
  const rootEvent = journal.append(`run:${RUN_ID}`, 0, [{ streamId: `run:${RUN_ID}`, type: "conformance.started",
    payload: { schemaVersion: 1, podCount: 3, submittedAtMs: clock.nowMs() }, causationId: null,
    correlationId: RUN_ID }])[0]!;
  const registry = new PodRegistry(journal);
  const claims = new PathClaimService(journal, clock.nowDate);
  const grants = new DispatchGrantService(journal, { controlPlaneId: SCHEDULER_ID, repositoryIdentity: repositoryPath },
    "three-pod-policy", clock.nowMs);
  let scheduler = createScheduler(journal, grants, clock, "daemon-one", 101, () => "unknown", rootEvent.eventId);
  scheduler.start();
  const supervisor = new ProcessSupervisor();
  const writer = new OpenCodeMultiFileWriter(new WriterWorktreeCapsule(new WorktreeManager(git),
    new OpenCodeWriter(supervisor), new WorkspaceOwnershipGate(), git));
  const executor = new ConformanceWriterExecutor();
  let daemon = new DaemonScheduler(scheduler, executor, { heartbeatJitterMs: () => 0 });
  const usage = new AuthoritativeUsageMeter();
  const adapter = new SchedulerPodAdapter(journal, grants, scheduler, daemon, executor, usage, clock, claims);
  const coordinators = new Map<string, PodCoordinator>();
  const assignments: AssignmentFixture[] = [];
  const podDefinitions = [{ podId: "pod-a", suffixes: ["a"] },
    { podId: "pod-b", suffixes: ["b", "c", "d"] }, { podId: "pod-c", suffixes: ["cancel"] }] as const;
  for (const definition of podDefinitions) {
    const prepared = registerPod(registry, definition.podId, definition.suffixes, project, mainCommit,
      clock, rootEvent.eventId);
    coordinators.set(definition.podId, new PodCoordinator(registry, adapter, clock.nowDate, undefined, usage));
    assignments.push(...prepared);
  }
  const cancelledWorkspace = path.join(root, "cancelled-workspace"); mkdirSync(cancelledWorkspace);
  const cancelledTask: SchedulerTaskInput = { taskId: "writer-cancel", correlationId: RUN_ID,
    projectId: PROJECT_ID, workerId: "writer-model", effect: "potentially_effectful",
    requiredCapabilities: ["write_worktree"], platform: "darwin-arm64",
    workspace: { path: cancelledWorkspace, available: true }, admission: { dependencies: [], decisionsApproved: true,
      pathsAvailable: false, capabilitySupported: true, platformSupported: true, policyPermits: true,
      budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["Cancellation retained."],
      evidenceRequirements: ["cancellation"] }, resources: { reasoning: 1, writers: 1, heavyValidation: 0,
      review: 0, integration: 0 }, budget: { seconds: 60, inputTokens: 10, outputTokens: 10, costUsdNano: 10 },
    grantId: "scheduler-grant-writer-cancel" };
  grants.issue({ grantId: cancelledTask.grantId, audience: cancelledTask.workerId,
    dispatchIntentSha256: dispatchIntentSha256(cancelledTask), expiresAtMs: clock.nowMs() + 1_000_000 });
  scheduler.submit(cancelledTask); scheduler.cancel(cancelledTask.taskId, "third pod cancelled before dispatch");

  const security = securitySheet(repositoryPath);
  const capability = writerModel();
  const overlap = path.join(root, "writer-overlap.jsonl");
  process.env.ZENTRA_THREE_POD_SECRET_CANARY = "must-not-cross";
  try {
    for (const fixture of assignments.filter((item) => item.suffix !== "cancel")) {
      const executable = createProvider(root, overlap, fixture.suffix, `${fixture.pathName}.ts`, mainCommit,
        `base-${fixture.pathName}`, `updated-${fixture.pathName}`);
      const probe = await new OpenCodeProbe(supervisor).probe({ executable, cwd: repositoryPath, timeoutMs: 5_000,
        modelId: capability.id, models: { models: [capability] }, security }, AbortSignal.timeout(10_000));
      const task = plannedTask(fixture.taskId, `src/${fixture.pathName}.ts`);
      const binding = new RoleCapabilityEnvelopeService(journal).accept(buildRoleCapabilityBinding({
        milestoneId: "milestone-three-pod", taskId: task.taskId, projectId: PROJECT_ID, correlationId: RUN_ID,
        role: "implementer", actorId: capability.id, repository: repositoryPath, planDigest: digestCanonical(task),
        securityDigest: digestCanonical(security), model: { capabilityId: capability.id,
          transportModelId: capability.model, digest: digestCanonical(capability), harness: capability.harness,
          roles: capability.roles, toolPermissions: capability.toolPermissions, network: capability.network },
        budget: task.budget, admissionDigest: digestCanonical({ taskId: task.taskId }),
        configuredReadPaths: security.allowedFileScopes, ownedPaths: task.ownedPaths,
        forbiddenPaths: security.forbiddenPaths }));
      const request: OpenCodeMultiFileWriterRequest = { project, task, model: capability, security, probe,
        signal: AbortSignal.timeout(30_000), claims, claimId: `claim-${fixture.taskId}`, correlationId: RUN_ID,
        capabilityBinding: binding, retainClaimAfterCheckpoint: true,
        writer: { schemaVersion: 1, taskId: task.taskId, projectId: PROJECT_ID, baseRevision: mainCommit,
          readPaths: [...security.allowedFileScopes], potentialWritePaths: [...task.ownedPaths],
          claimedWritePaths: [...task.ownedPaths], forbiddenPaths: [...security.forbiddenPaths],
          checkpoint: { maxDurationMs: 20_000, maxToolCalls: 1 } } };
      adapter.bind(fixture.assignment.assignmentId, request, fixture.taskId === "writer-d");
    }
    const active = assignments.filter((item) => item.suffix !== "cancel").map((fixture) => {
      const coordinator = coordinators.get(fixture.podId)!;
      const proposal = coordinator.propose({ podId: fixture.podId, grant: fixture.grant,
        lease: fixture.lease, assignment: fixture.assignment });
      registry.recordOwnershipIntent(fixture.podId, { assignmentId: fixture.assignment.assignmentId,
        taskId: fixture.taskId, ownedPaths: fixture.assignment.ownedPaths });
      return coordinator.dispatch({ proposal, signal: new AbortController().signal });
    });
    const outcomes = await Promise.all(active);
    await daemon.awaitIdle();
    if (outcomes.filter((item) => item.outcome === "completed").length !== 3 ||
      outcomes.filter((item) => item.outcome === "uncertain").length !== 1) throw new Error("writer crash fixture outcomes are invalid");
    if (readFileSync(overlap, "utf8").trim().split("\n").length !== 4) throw new Error("four writers did not overlap");
    for (const suffix of ["a", "b", "c", "d"]) assertProviderSecurity(root, suffix);
    let contentionDenied = false;
    try { claims.acquire({ projectId: PROJECT_ID, claimId: "claim-contended-pod-c", ownerId: "pod-c",
      revision: mainCommit, paths: ["src/a.ts"], leaseMs: 60_000, correlationId: RUN_ID }); }
    catch (error) { if (error instanceof PathClaimConflictError) contentionDenied = true; else throw error; }
    if (!contentionDenied) throw new Error("contended durable claim bypassed ownership arbitration");
  } finally { delete process.env.ZENTRA_THREE_POD_SECRET_CANARY; }

  journal.close();
  journal = new SqliteEventJournal(databasePath);
  const reopenedClaims = new PathClaimService(journal, clock.nowDate);
  const reopenedGrants = new DispatchGrantService(journal,
    { controlPlaneId: SCHEDULER_ID, repositoryIdentity: repositoryPath }, "three-pod-policy", clock.nowMs);
  scheduler = createScheduler(journal, reopenedGrants, clock, "daemon-two", 202, () => "dead");
  await scheduler.recover(async (candidate) => ({ taskId: candidate.taskId, workerAlive: false,
    workspace: "dirty", effect: retainedWriterEffect(reopenedClaims, candidate.taskId) ? "completed" : "uncertain",
    reason: "retained supervised receipt, trusted patch completion, and checkpoint inspected after restart" }));
  const crashedTask = scheduler.inspect().tasks["writer-d"];
  if (crashedTask?.status === "reconciling" && crashedTask.dispatch !== null) {
    if (!retainedWriterEffect(reopenedClaims, "writer-d")) throw new Error("crashed writer retained effect is incomplete");
    scheduler.resolveReconciliation(crashedTask.dispatch.dispatchId, "completed",
      "retained supervised receipt and trusted patch checkpoint prove the exact effect");
  }
  const restartedExecutor = new ConformanceWriterExecutor();
  daemon = new DaemonScheduler(scheduler, restartedExecutor, { heartbeatJitterMs: () => 0 });
  const restartedUsage = new AuthoritativeUsageMeter(reopenedClaims);
  const restartedAdapter = new SchedulerPodAdapter(journal, reopenedGrants, scheduler, daemon,
    restartedExecutor, restartedUsage, clock, reopenedClaims);
  const reconciledPod = await new PodCoordinator(registryFor(journal), restartedAdapter, clock.nowDate, undefined, restartedUsage)
    .reconcile("pod-b", "assignment-writer-d", "three-pod-reconciler");
  if (reconciledPod.assignments["assignment-writer-d"]?.status !== "completed") {
    throw new Error(`pod writer reconciliation remained ${reconciledPod.assignments["assignment-writer-d"]?.status}`);
  }

  const finalRegistry = registryFor(journal);
  const worktrees = new WorktreeManager(git); const validations = new ValidationRunner(supervisor);
  const reviewGate = new ReviewGate(); const queue = new IntegrationQueue(git, validations);
  const repository = new RepositoryOrchestrator(journal, reopenedClaims, queue,
    new ReadOnlyGitConflictAnalyzer(git), git, clock.nowDate);
  const admissions: IntegrationSubmission[] = [];
  const initialFixtures = assignments.filter((item) => !["cancel", "b"].includes(item.suffix));
  const preparedInitial = [] as Array<{ fixture: AssignmentFixture; lease: WorkspaceLease;
    diff: string; diffSha256: string }>;
  for (const fixture of initialFixtures) {
    const podAssignment = finalRegistry.inspect(fixture.podId)?.assignments[fixture.assignment.assignmentId];
    const scheduledAssignment = scheduler.inspect().tasks[fixture.taskId];
    if (podAssignment?.status !== "completed" || scheduledAssignment?.terminalOutcome !== "completed") {
      throw new Error(`integrated handoff is incomplete: ${fixture.taskId}:${podAssignment?.status}:${scheduledAssignment?.terminalOutcome}`);
    }
    if (scheduledAssignment.input.workspace.path !== path.join(project.worktreeRoot, fixture.taskId) ||
      scheduledAssignment.input.workerId !== podAssignment.agentId ||
      scheduledAssignment.input.taskId !== podAssignment.taskId ||
      !podAssignment.capabilities.includes("write_worktree") ||
      !scheduler.inspect().consumedGrantIds.includes(scheduledAssignment.input.grantId)) {
      throw new Error(`integrated handoff binding mismatch: ${fixture.taskId}:${JSON.stringify({
        workspace: scheduledAssignment.input.workspace.path, worker: scheduledAssignment.input.workerId,
        agent: podAssignment.agentId, consumed: scheduler.inspect().consumedGrantIds })}`);
    }
    const lease: WorkspaceLease = { taskId: fixture.taskId, branch: `ticket/${fixture.taskId}`,
      path: path.join(project.worktreeRoot, fixture.taskId) };
    const { diff } = await worktrees.inspect(lease); const diffSha256 = sha256(diff);
    preparedInitial.push({ fixture, lease, diff, diffSha256 });
  }
  const focusedInitial = await scheduledBatch(scheduler, reopenedGrants, clock, "validation",
    preparedInitial.map((item) => ({ taskId: `focused-${item.fixture.taskId}`, workspace: item.lease.path,
      action: () => validations.run(project, "focused", item.lease.path, AbortSignal.timeout(15_000),
        { invocationId: `focused-${item.fixture.taskId}`, subjectSha256: item.diffSha256 }) })));
  const reviewInitial = await scheduledBatch(scheduler, reopenedGrants, clock, "review",
    preparedInitial.map((item, index) => ({ taskId: `review-${item.fixture.taskId}`, workspace: item.lease.path,
      action: async () => { await new Promise((resolve) => setTimeout(resolve, 5));
        return verifiedReview(reviewGate, item.fixture.taskId, item.diff, focusedInitial[index]!,
          clock.nowDate().toISOString()); } })));
  const committedInitial = [] as Array<{ sourceCommit: string }>;
  for (const item of preparedInitial) committedInitial.push({ sourceCommit: await worktrees.commit(item.lease,
    [`src/${item.fixture.pathName}.ts`], `complete ${item.fixture.taskId}`, item.diffSha256) });
  const candidateInitial = await scheduledBatch(scheduler, reopenedGrants, clock, "validation",
    preparedInitial.map((item, index) => ({ taskId: `candidate-${item.fixture.taskId}`, workspace: item.lease.path,
      action: () => validations.run(project, "full", item.lease.path, AbortSignal.timeout(15_000),
        { invocationId: `candidate-${item.fixture.taskId}`, subjectSha256: committedInitial[index]!.sourceCommit }) })));
  for (const [index, item] of preparedInitial.entries()) {
    const { fixture, lease, diffSha256 } = item;
    const claim = reopenedClaims.inspect(PROJECT_ID).active.find((item) => item.claimId === `claim-${fixture.taskId}`)!;
    admissions.push(await repository.admitSubmission({ project, projectRevision: mainCommit, podId: fixture.podId,
      assignmentId: fixture.assignment.assignmentId, schedulerId: SCHEDULER_ID, schedulerTaskId: fixture.taskId,
      claimId: claim.claimId, claimLeaseToken: claim.leaseToken, baseCommit: mainCommit, branch: lease.branch,
      workspacePath: lease.path, focusedValidation: focusedInitial[index]!, review: reviewInitial[index]!,
      contract: { scope: [`src/${fixture.pathName}.ts`], behavior: { value: `updated-${fixture.pathName}` },
        authority: [capability.id], batchKey: null, candidateValidation: candidateInitial[index]! }, correlationId: RUN_ID }));
  }
  const units = repository.formUnits(PROJECT_ID, admissions.map((item) => item.receiptId), RUN_ID);
  const acceptUnit = async (unitId: string): Promise<void> => {
    const integrated = await scheduledOperation(scheduler, reopenedGrants, clock, "integration",
      `integrate-${unitId.slice(-12)}`, repositoryPath, () => repository.integrate({ project, unitId,
        signal: AbortSignal.timeout(30_000), correlationId: RUN_ID }));
    if (integrated.kind !== "integrated") throw new Error(`green integration unit failed: ${JSON.stringify(integrated)}`);
    repository.requestFinalAcceptance(PROJECT_ID, unitId, sha256(unitId), RUN_ID);
    repository.decideFinalAcceptance(PROJECT_ID, { unitId, accepted: true,
      decidedBy: "operator", reason: "Exact retained evidence accepted." }, RUN_ID);
  };
  const conflictWorkspace = await worktrees.create(project, "writer-conflict");
  const initialIntegrations = await scheduledBatch(scheduler, reopenedGrants, clock, "integration",
    units.map((unit) => ({ taskId: `integrate-${unit.unitId.slice(-12)}`, workspace: repositoryPath,
      action: () => repository.integrate({ project, unitId: unit.unitId,
        signal: AbortSignal.timeout(30_000), correlationId: RUN_ID }) })));
  for (const [index, unit] of units.entries()) {
    if (initialIntegrations[index]!.kind !== "integrated") throw new Error("initial integration unit failed");
    repository.requestFinalAcceptance(PROJECT_ID, unit.unitId, sha256(unit.unitId), RUN_ID);
    repository.decideFinalAcceptance(PROJECT_ID, { unitId: unit.unitId, accepted: true,
      decidedBy: "operator", reason: "Exact retained evidence accepted." }, RUN_ID);
  }
  const initialAClaim = reopenedClaims.inspect(PROJECT_ID).active.find((item) => item.claimId === "claim-writer-a")!;
  reopenedClaims.release({ projectId: PROJECT_ID, claimId: initialAClaim.claimId, ownerId: initialAClaim.ownerId,
    revision: initialAClaim.revision, leaseToken: initialAClaim.leaseToken, correlationId: RUN_ID });
  const executeFreshRevision = async (input: { podId: "pod-a" | "pod-b"; revision: number; taskId: string;
    baseRevision: string; pathName: string; beforeValue: string | null; afterValue: string; causeEventId: string;
    behavior: unknown; scope?: unknown; batchKey?: unknown; correction?: { unitId: string; acceptanceRejectionSha256: string;
      attempt: number; maxAttempts: number; paths: readonly string[] }; retainedLease?: WorkspaceLease }): Promise<IntegrationSubmission> => {
    const prior = finalRegistry.inspect(input.podId)!;
    const changedPath = `src/${input.pathName}`;
    const revised = revisionCharter(prior.charter, input.revision, input.taskId, [changedPath]);
    const cause = journal.readStream(input.podId).find((event) => event.eventId === input.causeEventId)!;
    finalRegistry.revise(input.podId, { revisionId: `revision-${input.taskId}`, priorRevision: input.revision - 1,
      charter: revised, cause: { eventId: cause.eventId, streamVersion: cause.streamVersion,
        eventType: cause.type, payloadDigest: digestCanonical(cause.payload) } });
    const issuedAt = clock.nowDate().toISOString(); const expiresAt = new Date(clock.nowMs() + 3_600_000).toISOString();
    const grant = podGrantForRevision(revised, project, issuedAt, expiresAt);
    finalRegistry.admit(input.podId, grant, issuedAt);
    const assignmentId = `assignment-${input.taskId}`;
    const podLease = podLeaseForRevision(input.podId, grant, assignmentId, input.taskId,
      [changedPath], issuedAt, expiresAt);
    finalRegistry.receiveLease(input.podId, podLease);
    finalRegistry.receiveWorkspaceLease(input.podId, { schemaVersion: 1, workspaceLeaseId: podLease.workspaceLeaseId,
      podLeaseId: podLease.leaseId, podId: input.podId, projectId: PROJECT_ID, taskId: input.taskId,
      repositoryPath, path: path.join(project.worktreeRoot, input.taskId), branch: `refs/heads/ticket/${input.taskId}`,
      baseCommit: input.baseRevision, status: "active" });
    finalRegistry.start(input.podId);
    const assignment: PodAssignment = { assignmentId, taskId: input.taskId, roleId: `role-${input.taskId}`,
      agentId: "writer-model", charterRevision: input.revision, capabilities: ["write_worktree"],
      ownedPaths: [changedPath], budget: podBudget() };
    const executable = createProvider(root, overlap, input.taskId, input.pathName, input.baseRevision,
      input.beforeValue, input.afterValue);
    const probe = await new OpenCodeProbe(supervisor).probe({ executable, cwd: repositoryPath, timeoutMs: 5_000,
      modelId: capability.id, models: { models: [capability] }, security }, AbortSignal.timeout(10_000));
    const task = plannedTask(input.taskId, changedPath);
    const binding = new RoleCapabilityEnvelopeService(journal).accept(buildRoleCapabilityBinding({
      milestoneId: "milestone-three-pod", taskId: input.taskId, projectId: PROJECT_ID, correlationId: RUN_ID,
      role: "implementer", actorId: capability.id, repository: repositoryPath, planDigest: digestCanonical(task),
      securityDigest: digestCanonical(security), model: { capabilityId: capability.id,
        transportModelId: capability.model, digest: digestCanonical(capability), harness: capability.harness,
        roles: capability.roles, toolPermissions: capability.toolPermissions, network: capability.network },
      budget: task.budget, admissionDigest: digestCanonical({ taskId: input.taskId }),
      configuredReadPaths: security.allowedFileScopes, ownedPaths: task.ownedPaths,
      forbiddenPaths: security.forbiddenPaths }));
    restartedAdapter.bind(assignmentId, { project, task, model: capability, security, probe,
      signal: AbortSignal.timeout(30_000), claims: reopenedClaims, claimId: `claim-${input.taskId}`,
      correlationId: RUN_ID, capabilityBinding: binding, retainClaimAfterCheckpoint: true,
      ...(input.retainedLease === undefined ? {} : { retainedLease: input.retainedLease }),
      writer: { schemaVersion: 1, taskId: input.taskId, projectId: PROJECT_ID, baseRevision: input.baseRevision,
        readPaths: [...security.allowedFileScopes], potentialWritePaths: [changedPath], claimedWritePaths: [changedPath],
        forbiddenPaths: [...security.forbiddenPaths], checkpoint: { maxDurationMs: 20_000, maxToolCalls: 1 } } }, false);
    const coordinator = new PodCoordinator(finalRegistry, restartedAdapter, clock.nowDate, undefined, restartedUsage);
    const proposal = coordinator.propose({ podId: input.podId, grant, lease: podLease, assignment });
    finalRegistry.recordOwnershipIntent(input.podId, { assignmentId, taskId: input.taskId, ownedPaths: [changedPath] });
    const dispatched = await coordinator.dispatch({ proposal, signal: new AbortController().signal });
    if (dispatched.outcome !== "completed") throw new Error(`fresh writer ${input.taskId} did not complete`);
    await daemon.awaitIdle();
    assertProviderSecurity(root, input.taskId);
    const lease: WorkspaceLease = { taskId: input.taskId, branch: `ticket/${input.taskId}`,
      path: path.join(project.worktreeRoot, input.taskId) };
    const { diff } = await worktrees.inspect(lease); const diffSha256 = sha256(diff);
    const focused = await validations.run(project, "focused", lease.path, AbortSignal.timeout(15_000),
      { invocationId: `focused-${input.taskId}`, subjectSha256: diffSha256 });
    const review = verifiedReview(reviewGate, input.taskId, diff, focused, clock.nowDate().toISOString());
    const sourceCommit = await worktrees.commit(lease, [changedPath], `complete ${input.taskId}`, diffSha256);
    const candidate = await validations.run(project, "full", lease.path, AbortSignal.timeout(15_000),
      { invocationId: `candidate-${input.taskId}`, subjectSha256: sourceCommit });
    const claim = reopenedClaims.inspect(PROJECT_ID).active.find((item) => item.claimId === `claim-${input.taskId}`)!;
    return repository.admitSubmission({ project, projectRevision: input.baseRevision, podId: input.podId,
      assignmentId, schedulerId: SCHEDULER_ID, schedulerTaskId: input.taskId, claimId: claim.claimId,
      claimLeaseToken: claim.leaseToken, baseCommit: input.baseRevision, branch: lease.branch,
      workspacePath: lease.path, focusedValidation: focused, review,
      contract: { scope: input.scope ?? [changedPath], behavior: input.behavior, authority: [capability.id],
        batchKey: input.batchKey ?? null, candidateValidation: candidate },
      ...(input.correction === undefined ? {} : { correction: input.correction }), correlationId: RUN_ID });
  };
  const podBCause = journal.readStream("pod-b").at(-1)!.eventId;
  const conflictingAdmission = await executeFreshRevision({ podId: "pod-b", revision: 2,
    taskId: "writer-conflict", baseRevision: mainCommit, beforeValue: "base-a", afterValue: "conflicting-a",
    pathName: "a.ts", causeEventId: podBCause, behavior: { value: "resolved-a", generation: "conflict-resolution" },
    retainedLease: conflictWorkspace });
  const conflictUnit = repository.formUnits(PROJECT_ID, [conflictingAdmission.receiptId], RUN_ID)[0]!;
  const conflictResult = await scheduledOperation(scheduler, reopenedGrants, clock, "integration",
    "integrate-conflict", repositoryPath, () => repository.integrate({ project, unitId: conflictUnit.unitId,
      signal: AbortSignal.timeout(30_000), correlationId: RUN_ID }));
  if (conflictResult.kind !== "conflict") throw new Error("true repository conflict was not observed");
  const conflictView = repository.inspect(PROJECT_ID).units[conflictUnit.unitId]!;
  const conflictWriterClaim = reopenedClaims.inspect(PROJECT_ID).active
    .find((item) => item.claimId === "claim-writer-conflict")!;
  reopenedClaims.release({ projectId: PROJECT_ID, claimId: conflictWriterClaim.claimId,
    ownerId: conflictWriterClaim.ownerId, revision: conflictWriterClaim.revision,
    leaseToken: conflictWriterClaim.leaseToken, correlationId: RUN_ID });
  const conflictEvent = journal.readStream(`repository-orchestration:${PROJECT_ID}`)
    .findLast((event) => event.type === "conflict.observed")!;
  const bridgeEvidence = finalRegistry.recordEvidence("pod-a", { evidenceId: "conflict-source",
    taskId: null, kind: "conflict", sha256: digestCanonical(conflictEvent.payload),
    sourceEventId: conflictEvent.eventId }, conflictEvent.eventId);
  const integrationBase = await gitText(git, repositoryPath, ["rev-parse", project.integrationBranch]);
  const replacement = await executeFreshRevision({ podId: "pod-a", revision: 2,
    taskId: "writer-replacement", baseRevision: integrationBase, beforeValue: "updated-a", afterValue: "resolved-a",
    pathName: "a.ts", causeEventId: bridgeEvidence.eventId,
    behavior: { value: "resolved-a", generation: "conflict-resolution" } });
  const proposal = repository.proposeReplan(PROJECT_ID, { projectId: PROJECT_ID, unitId: conflictUnit.unitId,
    conflictId: conflictView.conflictId!, attempt: 1, maxAttempts: 1, changedPaths: [], behaviorChanges: [],
    authorityChanges: [], rationale: "Use the exact reviewed source matching accepted behavior.",
    replacementAdmissionReceiptIds: [replacement.receiptId] }, RUN_ID);
  let staleRejected = false;
  try { repository.decideReplan(PROJECT_ID, { unitId: conflictUnit.unitId,
    approvalDigest: "0".repeat(64), approved: true, decidedBy: "operator" }, RUN_ID); }
  catch { staleRejected = true; }
  if (!staleRejected) throw new Error("stale conflict decision was accepted");
  repository.decideReplan(PROJECT_ID, { unitId: conflictUnit.unitId,
    approvalDigest: proposal.approvalDigest, approved: true, decidedBy: "operator" }, RUN_ID);
  await acceptUnit(conflictUnit.unitId);

  project.validations.full = [process.execPath, "-e",
    'const fs=require("node:fs");process.exit(fs.existsSync("src/e.ts")&&fs.existsSync("src/f.ts")?0:9)'];
  const coupledScope = ["src/e.ts", "src/f.ts"];
  const coupledBehavior = { contract: "coupled-non-green" };
  const podACause = journal.readStream("pod-a").at(-1)!.eventId;
  const coupledBase = await gitText(git, repositoryPath, ["rev-parse", project.integrationBranch]);
  const coupledE = await executeFreshRevision({ podId: "pod-a", revision: 3, taskId: "writer-coupled-e",
    baseRevision: coupledBase, pathName: "e.ts", beforeValue: null, afterValue: "coupled-e",
    causeEventId: podACause, behavior: coupledBehavior, scope: coupledScope, batchKey: "coupled-batch" });
  const podFCause = journal.readStream("pod-b").at(-1)!.eventId;
  const coupledF = await executeFreshRevision({ podId: "pod-b", revision: 3, taskId: "writer-coupled-f",
    baseRevision: coupledBase, pathName: "f.ts", beforeValue: null, afterValue: "coupled-f",
    causeEventId: podFCause, behavior: coupledBehavior, scope: coupledScope, batchKey: "coupled-batch" });
  if (coupledE.contract.candidateOutcome !== "non_green" || coupledF.contract.candidateOutcome !== "non_green") {
    throw new Error("coupled candidate members did not retain non-green evidence");
  }
  const coupledUnit = repository.formUnits(PROJECT_ID, [coupledE.receiptId, coupledF.receiptId], RUN_ID)[0]!;
  const coupledResult = await scheduledOperation(scheduler, reopenedGrants, clock, "integration", "integrate-coupled",
    repositoryPath, () => repository.integrate({ project, unitId: coupledUnit.unitId,
      signal: AbortSignal.timeout(30_000), correlationId: RUN_ID }));
  if (coupledResult.kind !== "integrated") throw new Error("coupled non-green unit did not integrate atomically");
  repository.requestFinalAcceptance(PROJECT_ID, coupledUnit.unitId, sha256("coupled-reject"), RUN_ID);
  const coupledRejection = repository.decideFinalAcceptance(PROJECT_ID, { unitId: coupledUnit.unitId,
    accepted: false, decidedBy: "operator", reason: "Require one exact correction." }, RUN_ID);
  for (const claimId of ["claim-writer-coupled-e", "claim-writer-coupled-f"]) {
    const retained = reopenedClaims.inspect(PROJECT_ID).active.find((claim) => claim.claimId === claimId)!;
    reopenedClaims.release({ projectId: PROJECT_ID, claimId: retained.claimId, ownerId: retained.ownerId,
      revision: retained.revision, leaseToken: retained.leaseToken, correlationId: RUN_ID });
  }
  project.validations.full = [process.execPath, "--test"];
  const correctionBase = await gitText(git, repositoryPath, ["rev-parse", project.integrationBranch]);
  const correctionCause = journal.readStream("pod-a").at(-1)!.eventId;
  const corrected = await executeFreshRevision({ podId: "pod-a", revision: 4, taskId: "writer-correction-e",
    baseRevision: correctionBase, pathName: "e.ts", beforeValue: "coupled-e", afterValue: "corrected-e",
    causeEventId: correctionCause, behavior: coupledBehavior, scope: coupledScope,
    correction: { unitId: coupledUnit.unitId,
      acceptanceRejectionSha256: coupledRejection.acceptanceRejectionSha256!, attempt: 1,
      maxAttempts: 1, paths: ["src/e.ts"] } });
  const correctionPlan = repository.planCorrection(PROJECT_ID, { unitId: coupledUnit.unitId, attempt: 1,
    maxAttempts: 1, paths: ["src/e.ts"], acceptanceRejectionSha256: coupledRejection.acceptanceRejectionSha256!,
    replacementAdmissionReceiptIds: [corrected.receiptId], behaviorChanges: [], authorityChanges: [],
    rationale: "Apply the exact reviewed correction." }, RUN_ID);
  repository.decideCorrection(PROJECT_ID, { unitId: coupledUnit.unitId,
    approvalDigest: correctionPlan.approvalDigest, approved: true, decidedBy: "operator" }, RUN_ID);
  await acceptUnit(coupledUnit.unitId);

  const cancelBase = await gitText(git, repositoryPath, ["rev-parse", project.integrationBranch]);
  const cancelCause = journal.readStream("pod-b").at(-1)!.eventId;
  const cancellable = await executeFreshRevision({ podId: "pod-b", revision: 4, taskId: "writer-cancel-race",
    baseRevision: cancelBase, pathName: "g.ts", beforeValue: null, afterValue: "cancel-race",
    causeEventId: cancelCause, behavior: { contract: "cancel-race" } });
  const cancellableUnit = repository.formUnits(PROJECT_ID, [cancellable.receiptId], RUN_ID)[0]!;
  let casReached!: () => void; let releaseCas!: () => void;
  const atCas = new Promise<void>((resolve) => { casReached = resolve; });
  const release = new Promise<void>((resolve) => { releaseCas = resolve; });
  class BarrierGitClient extends GitClient {
    override async run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<CommandResult> {
      if (args.includes("update-ref") && args.includes(`refs/heads/${project.integrationBranch}`)) {
        casReached(); await release;
      }
      return super.run(cwd, args, options);
    }
  }
  const barrierGit = new BarrierGitClient();
  const integratingController = new RepositoryOrchestrator(journal, reopenedClaims,
    new IntegrationQueue(barrierGit, validations), new ReadOnlyGitConflictAnalyzer(barrierGit), barrierGit, clock.nowDate);
  const cancellingController = new RepositoryOrchestrator(journal, reopenedClaims,
    new IntegrationQueue(git, validations), new ReadOnlyGitConflictAnalyzer(git), git, clock.nowDate);
  const pendingIntegration = integratingController.integrate({ project, unitId: cancellableUnit.unitId,
    signal: AbortSignal.timeout(30_000), correlationId: RUN_ID });
  await atCas;
  let cancellationSettled = false;
  const pendingCancellation = cancellingController.cancel(project, "operator", "cancel after winning CAS", RUN_ID)
    .finally(() => { cancellationSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (cancellationSettled) throw new Error("repository cancellation bypassed the active integration CAS lease");
  releaseCas();
  const integratedCancellationUnit = await pendingIntegration;
  if (integratedCancellationUnit.kind !== "integrated") throw new Error("cancellation race integration did not win CAS");
  await pendingCancellation;
  integratingController.requestFinalAcceptance(PROJECT_ID, cancellableUnit.unitId, sha256("cancel-race"), RUN_ID);
  integratingController.decideFinalAcceptance(PROJECT_ID, { unitId: cancellableUnit.unitId, accepted: true,
    decidedBy: "operator", reason: "Winning integration accepted before cancellation cleanup." }, RUN_ID);
  for (const podId of ["pod-a", "pod-b"]) {
    const pod = finalRegistry.inspect(podId)!;
    for (const checkpoint of pod.charter.checkpoints) finalRegistry.checkpoint(podId,
      { checkpointId: checkpoint.checkpointId, evidenceIds: Object.keys(pod.evidence).sort(), status: "passed" });
    finalRegistry.complete(podId);
  }
  finalRegistry.requestCancellation("pod-c", { requestedBy: "operator", reason: "third pod cancellation" });
  finalRegistry.cancel("pod-c");
  const events = journal.readAll();
  const report = buildThreePodConformanceReport(events, { expectedPods: 3, expectedWriterCapacity: 4,
    expectedValidationCapacity: 2, expectedReviewCapacity: 2, expectedIntegrationCapacity: 1,
    trustedNowMs: Math.max(clock.nowMs(), Date.parse(events.at(-1)!.recordedAt)), requiredEvidenceTypes: [
      "writer.receipt_observed", "writer.patch_apply_completed", "writer.checkpointed",
      "scheduler.worker_heartbeat", "repository.submission_admitted", "integration.committed",
      "final_acceptance.accepted", "pod.cancelled"] });
  const integrationCommit = await gitText(git, repositoryPath, ["rev-parse", project.integrationBranch]);
  if (await gitText(git, repositoryPath, ["rev-parse", "main"]) !== mainCommit) {
    throw new Error("three-pod conformance mutated main");
  }
  const writerMutationCount = events.filter((event) => event.type === "writer.patch_apply_completed").length;
  const reportPath = path.join(root, "three-pod-conformance-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  journal.close();
  return Object.freeze({ databasePath, repositoryPath, project, report, reportPath,
    mainCommit, integrationCommit, writerMutationCount });
}

class TrustedFixtureClock {
  readonly nowMs = (): number => Date.now();
  readonly nowDate = (): Date => new Date(this.nowMs());
}

class AuthoritativeUsageMeter implements PodUsageMeter {
  readonly capability = { elapsed: true as const, tokens: true, cost: true, retries: true, externalEffects: true };
  private readonly usage = new Map<string, { elapsedMs: number; inputTokens: number; outputTokens: number;
    costUsd: number; retries: number; externalEffects: 0 }>();
  constructor(claims?: PathClaimService) {
    if (claims !== undefined) {
      for (const claim of claims.inspect(PROJECT_ID).active) {
        const receipt = claim.workerReceipt;
        if (receipt !== null) this.usage.set(`assignment-${claim.claimId.replace(/^claim-/, "")}`, { elapsedMs: 1,
          inputTokens: receipt.usage.inputTokens, outputTokens: receipt.usage.outputTokens,
          costUsd: 0, retries: 0, externalEffects: 0 });
      }
    }
    return authorizePodUsageMeter(this);
  }
  record(assignmentId: string, result: WriterCapsuleResult): void {
    this.usage.set(assignmentId, { elapsedMs: 1,
      inputTokens: result.writer?.usage.inputTokens ?? 0, outputTokens: result.writer?.usage.outputTokens ?? 0,
      costUsd: 0, retries: 0, externalEffects: 0 });
  }
  open(identity: { assignmentId: string }) {
    const snapshot = () => this.usage.get(identity.assignmentId) ??
      { elapsedMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, retries: 0, externalEffects: 0 as const };
    return { snapshot, close: () => undefined };
  }
  verify(): boolean { return true; }
}

class ConformanceWriterExecutor implements SchedulerExecutor {
  private readonly requests = new Map<string, { request: OpenCodeMultiFileWriterRequest;
    writer: OpenCodeMultiFileWriter; crash: boolean; assignmentId: string; usage: AuthoritativeUsageMeter }>();
  readonly results = new Map<string, Promise<WriterCapsuleResult>>();
  bind(taskId: string, assignmentId: string, request: OpenCodeMultiFileWriterRequest,
    writer: OpenCodeMultiFileWriter, crash: boolean, usage: AuthoritativeUsageMeter): void {
    this.requests.set(taskId, { request, writer, crash, assignmentId, usage });
  }
  start(intent: DispatchIntent): Promise<DispatchExecution> {
    const bound = this.requests.get(intent.taskId);
    if (bound === undefined) return Promise.reject(new Error(`writer request ${intent.taskId} is not bound`));
    const result = bound.writer.run({ ...bound.request,
      dispatchAuthority: { mode: "scheduled", dispatchId: intent.dispatchId } });
    this.results.set(intent.taskId, result);
    const completion = result.then((observed) => {
      bound.usage.record(bound.assignmentId, observed);
      if (bound.crash) throw new Error("injected crash after trusted effect and retained receipt");
      return { outcome: observed.outcome === "denied" ? "denied" as const : observed.outcome,
        usage: { seconds: 1, inputTokens: observed.writer?.usage.inputTokens ?? 0,
          outputTokens: observed.writer?.usage.outputTokens ?? 0, costUsdNano: 0 } };
    });
    return Promise.resolve({ pid: 10_000 + this.results.size, workerIncarnation: `writer-incarnation-${intent.taskId}`,
      processStartIdentity: `writer-start-${intent.taskId}`, completion, cancel: () => undefined });
  }
}

class SchedulerPodAdapter implements PodDispatchAdapter {
  private readonly requests = new Map<string, { request: OpenCodeMultiFileWriterRequest; crash: boolean }>();
  constructor(private readonly journal: SqliteEventJournal, private readonly grants: DispatchGrantService,
    private readonly scheduler: JournalScheduler, private readonly daemon: DaemonScheduler,
    private readonly executor: ConformanceWriterExecutor, private readonly usage: AuthoritativeUsageMeter,
    private readonly clock: TrustedFixtureClock, private readonly claims: PathClaimService) {}
  bind(assignmentId: string, request: OpenCodeMultiFileWriterRequest, crash: boolean): void {
    this.requests.set(assignmentId, { request, crash });
  }
  async start(packet: PodDispatchPacket & { executionId: string }): Promise<PodExecutionHandle> {
    const bound = this.requests.get(packet.assignment.assignmentId);
    if (bound === undefined) throw new Error("pod assignment has no scheduler writer binding");
    const scheduled = schedulerTask(packet);
    this.grants.issue({ grantId: scheduled.grantId, audience: scheduled.workerId,
      dispatchIntentSha256: dispatchIntentSha256(scheduled), expiresAtMs: this.clock.nowMs() + 1_000_000 });
    this.executor.bind(scheduled.taskId, packet.assignment.assignmentId, bound.request,
      new OpenCodeMultiFileWriter(new WriterWorktreeCapsule(new WorktreeManager(),
        new OpenCodeWriter(new ProcessSupervisor()), new WorkspaceOwnershipGate())), bound.crash, this.usage);
    this.scheduler.submit(scheduled);
    await this.daemon.runOnce();
    const task = this.scheduler.inspect().tasks[scheduled.taskId]!;
    const identity = { dispatchId: packet.dispatchId, executionId: packet.executionId,
      assignmentId: packet.assignment.assignmentId, charterRevision: packet.assignment.charterRevision,
      processId: `process-${packet.assignment.assignmentId}`,
      processIncarnation: task.workerIncarnation ?? `writer-incarnation-${scheduled.taskId}` };
    const result = this.executor.results.get(scheduled.taskId)!;
    const completion = result.then(async (writerResult): Promise<PodDispatchResult> => {
      if (bound.crash) return { outcome: "uncertain", evidence: [] };
      await this.daemon.awaitIdle();
      return { outcome: writerResult.outcome === "denied" ? "failed" : writerResult.outcome,
        evidence: [{ evidenceId: `writer-${scheduled.taskId}`,
        kind: "writer-receipt", sha256: writerResult.writer?.dispatchBinding.digest ?? sha256(scheduled.taskId) }] };
    });
    return { identity, started: Promise.resolve({ executionId: identity.executionId,
      processId: identity.processId, acknowledgedAt: this.clock.nowDate().toISOString() }), completion,
      requestCancellation: async () => { this.scheduler.cancel(scheduled.taskId, "pod cancellation");
        await this.daemon.runOnce(); await this.daemon.awaitIdle(); return { executionId: identity.executionId,
          processId: identity.processId, terminated: true, acknowledgedAt: this.clock.nowDate().toISOString() }; } };
  }
  lookup(identity: PodExecutionReservation): ReturnType<PodDispatchAdapter["lookup"]> {
    const assignment = findAssignment(this.journal, identity.assignmentId);
    const claim = this.claims.inspect(PROJECT_ID).active
      .find((item) => item.ownerId === assignment.agentId && item.workerReceipt !== null && item.patchApplicationCompleted);
    const completed = claim !== undefined;
    return Promise.resolve({ identity: { ...identity, processId: `process-${identity.assignmentId}`,
      processIncarnation: assignment.processIncarnation }, status: "terminated", effect: completed ? "completed" : "uncertain",
      terminationEvidenceSha256: completed ? sha256(`terminated:${identity.executionId}`) : null,
      effectEvidenceSha256: sha256(`effect:${identity.executionId}:${completed}`), evidence: completed ? [{
        evidenceId: `writer-${assignment.taskId}`, kind: "writer-receipt",
        sha256: claim.workerReceipt!.dispatchBindingDigest }] : [] });
  }
}

interface AssignmentFixture { podId: string; suffix: string; pathName: string; taskId: string; assignment: PodAssignment;
  lease: PodLease; grant: PodParentGrant }

function registerPod(registry: PodRegistry, podId: string, suffixes: readonly string[], project: ProjectConfig,
  baseCommit: string, clock: TrustedFixtureClock, causationId: string): AssignmentFixture[] {
  const tasks = suffixes.map((suffix) => ({ milestoneId: "milestone-three-pod", taskId: `writer-${suffix}`,
    title: `writer-${suffix}`, dependencies: [], acceptanceCriteria: ["Exact reviewed source accepted."],
    evidenceRequirements: ["writer-receipt"] }));
  const ownedPaths = [...new Set(suffixes.filter((item) => item !== "cancel").flatMap((suffix) =>
    suffix === "a" ? ["src/a.ts", "src/replan.txt"] :
    suffix === "b" ? ["src/a.ts", "src/b.ts"] : [`src/${pathName(suffix)}.ts`]))];
  const assignmentBudget = podBudget();
  const aggregateBudget = { ...assignmentBudget, maxSeconds: assignmentBudget.maxSeconds * suffixes.length,
    maxCostUsd: assignmentBudget.maxCostUsd * suffixes.length,
    maxInputTokens: assignmentBudget.maxInputTokens * suffixes.length,
    maxOutputTokens: assignmentBudget.maxOutputTokens * suffixes.length };
  const charter: PodCharter = { schemaVersion: 1, podId, projectId: PROJECT_ID, revision: 1,
    outcome: `Complete ${podId}.`, sourceRefs: [{ kind: "ticket", value: "#101" }], tasks,
    roles: suffixes.map((suffix) => ({ roleId: `implementer-${suffix}`, agentId: "writer-model",
      taskIds: [`writer-${suffix}`] })), requiredCapabilities: ["write_worktree"],
    ownership: { ownedPaths: ownedPaths.length === 0 ? ["src/cancel.ts"] : ["src/**"], forbiddenPaths: ["refs/**"] },
    budget: aggregateBudget, checkpoints: suffixes.filter((item) => item !== "cancel").map((suffix) => ({
      checkpointId: `green-${suffix}`, afterTaskIds: [`writer-${suffix}`], evidenceRequirements: ["writer-receipt"] })),
    acceptanceCriteria: ["All exact evidence is retained."], evidenceRequirements: ["writer-receipt"],
    forbiddenChanges: ["shared refs"], securityBoundary: "Scheduler, claims, and repository admission are authoritative.",
    escalationConditions: ["uncertain effect"], completionRules: ["All assignments and units complete."],
    cleanupRules: ["Preserve uncertain workspaces."], execution: { mode: "local_process", nativeSubagents: false,
      distributed: false } };
  registry.register({ charter, correlationId: RUN_ID, causationId });
  const issuedAt = clock.nowDate().toISOString(); const expiresAt = new Date(clock.nowMs() + 3_600_000).toISOString();
  const grant: PodParentGrant = { schemaVersion: 1, grantId: `grant-${podId}`, parentAuthorityId: RUN_ID,
    podId, projectId: PROJECT_ID, repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot,
    charterRevision: 1, charterDigest: digestCanonical(charter), agentIds: ["writer-model"],
    capabilities: ["write_worktree"], ownedPaths: ["src/**"],
    forbiddenPaths: ["refs/**"], budget: charter.budget,
    sharedIntegrationRefs: ["refs/heads/main", `refs/heads/${project.integrationBranch}`], issuedAt, expiresAt,
    executionMode: "local_process", nativeSubagents: false, distributed: false };
  registry.admit(podId, grant, issuedAt); registry.start(podId);
  return suffixes.map((suffix) => {
    const taskId = `writer-${suffix}`; const assignmentId = `assignment-${taskId}`;
    const lease: PodLease = { schemaVersion: 1, leaseId: `lease-${taskId}`, grantId: grant.grantId, podId,
      assignmentId, workspaceLeaseId: `workspace-${taskId}`, taskId, agentId: "writer-model", charterRevision: 1,
      capabilities: ["write_worktree"], ownedPaths: suffix === "cancel" ? ["src/cancel.ts"] :
        suffix === "a" ? ["src/a.ts", "src/replan.txt"] :
        suffix === "b" ? ["src/a.ts", "src/b.ts"] : [`src/${pathName(suffix)}.ts`],
      budget: assignmentBudget, issuedAt, expiresAt, status: "active" };
    const workspace: PodWorkspaceLease = { schemaVersion: 1, workspaceLeaseId: lease.workspaceLeaseId,
      podLeaseId: lease.leaseId, podId, projectId: PROJECT_ID, taskId, repositoryPath: project.repositoryPath,
      path: path.join(project.worktreeRoot, taskId), branch: `refs/heads/ticket/${taskId}`,
      baseCommit, status: "active" };
    registry.receiveLease(podId, lease);
    if (suffix !== "replacement") registry.receiveWorkspaceLease(podId, workspace);
    const assignment: PodAssignment = { assignmentId, taskId, roleId: `implementer-${suffix}`,
      agentId: "writer-model", charterRevision: 1, capabilities: ["write_worktree"],
      ownedPaths: lease.ownedPaths, budget: lease.budget };
    return { podId, suffix, pathName: pathName(suffix), taskId, assignment, lease, grant };
  });
}

function revisionCharter(prior: PodCharter, revision: number, taskId: string,
  ownedPaths: readonly string[]): PodCharter {
  return { ...prior, revision, tasks: [{ milestoneId: "milestone-three-pod", taskId, title: taskId,
    dependencies: [], acceptanceCriteria: ["Fresh reviewed source accepted."], evidenceRequirements: ["writer-receipt"] }],
  roles: [{ roleId: `role-${taskId}`, agentId: "writer-model", taskIds: [taskId] }],
  ownership: { ownedPaths: [...ownedPaths], forbiddenPaths: ["refs/**"] },
  budget: podBudget(), checkpoints: [{ checkpointId: `green-${taskId}`, afterTaskIds: [taskId],
    evidenceRequirements: ["writer-receipt"] }], acceptanceCriteria: ["Fresh authority is fully evidenced."],
  evidenceRequirements: ["writer-receipt"] };
}

function podGrantForRevision(charter: PodCharter, project: ProjectConfig, issuedAt: string,
  expiresAt: string): PodParentGrant {
  return { schemaVersion: 1, grantId: `grant-${charter.podId}-revision-${charter.revision}`,
    parentAuthorityId: RUN_ID, podId: charter.podId, projectId: PROJECT_ID,
    repositoryPath: project.repositoryPath, worktreeRoot: project.worktreeRoot,
    charterRevision: charter.revision, charterDigest: digestCanonical(charter), agentIds: ["writer-model"],
    capabilities: ["write_worktree"], ownedPaths: ["src/**"],
    forbiddenPaths: charter.ownership.forbiddenPaths, budget: charter.budget,
    sharedIntegrationRefs: ["refs/heads/main", `refs/heads/${project.integrationBranch}`],
    issuedAt, expiresAt, executionMode: "local_process", nativeSubagents: false, distributed: false };
}

function podLeaseForRevision(podId: string, grant: PodParentGrant, assignmentId: string,
  taskId: string, ownedPaths: readonly string[], issuedAt: string, expiresAt: string): PodLease {
  return { schemaVersion: 1, leaseId: `lease-${taskId}`, grantId: grant.grantId, podId,
    assignmentId, workspaceLeaseId: `workspace-${taskId}`, taskId, agentId: "writer-model",
    charterRevision: grant.charterRevision, capabilities: ["write_worktree"],
    ownedPaths: [...ownedPaths], budget: grant.budget, issuedAt, expiresAt, status: "active" };
}

function createScheduler(journal: SqliteEventJournal, grants: DispatchGrantService, clock: TrustedFixtureClock,
  incarnation: string, pid: number, liveness: () => "dead" | "unknown", causationId?: string) {
  return new JournalScheduler(journal, { schedulerId: SCHEDULER_ID, processIncarnation: incarnation, pid,
    processStartIdentity: `start-${incarnation}`, platform: "darwin-arm64",
    capabilities: ["write_worktree", "run_validation", "review_diff", "integrate"], limits: LIMITS,
    controlIdentity: grants.identity, grants, daemonOwnerLiveness: liveness, now: clock.nowMs,
    ...(causationId === undefined ? {} : { causationId }) });
}

function schedulerTask(packet: PodDispatchPacket): SchedulerTaskInput {
  const input = { taskId: packet.assignment.taskId, correlationId: RUN_ID, projectId: PROJECT_ID, workerId: packet.assignment.agentId,
    effect: "potentially_effectful" as const, requiredCapabilities: ["write_worktree"],
    platform: "darwin-arm64" as const, workspace: { path: packet.workspace.path, available: true },
    admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
      platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
      acceptanceCriteria: ["Trusted patch checkpoint retained."], evidenceRequirements: ["writer receipt"] },
    resources: { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
    budget: { seconds: packet.assignment.budget.maxSeconds, inputTokens: packet.assignment.budget.maxInputTokens,
      outputTokens: packet.assignment.budget.maxOutputTokens, costUsdNano: 1_000 },
    grantId: `scheduler-grant-${packet.assignment.taskId}` };
  return input;
}

async function scheduledOperation<T>(scheduler: JournalScheduler, grants: DispatchGrantService,
  clock: TrustedFixtureClock, resource: "validation" | "review" | "integration", taskId: string, workspace: string,
  action: () => Promise<T>): Promise<T> {
  const input: SchedulerTaskInput = { taskId, correlationId: RUN_ID, projectId: PROJECT_ID,
    workerId: `worker-${taskId}`, effect: "computation",
    requiredCapabilities: [resource === "validation" ? "run_validation" : resource === "review" ? "review_diff" : "integrate"],
    platform: "darwin-arm64", workspace: { path: workspace, available: true },
    admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
      platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
      acceptanceCriteria: ["Exact stage evidence retained."], evidenceRequirements: ["stage receipt"] },
    resources: { reasoning: 0, writers: 0, heavyValidation: resource === "validation" ? 1 : 0,
      review: resource === "review" ? 1 : 0, integration: resource === "integration" ? 1 : 0 },
    budget: { seconds: 60, inputTokens: 10, outputTokens: 10, costUsdNano: 10 }, grantId: `grant-${taskId}` };
  grants.issue({ grantId: input.grantId, audience: input.workerId,
    dispatchIntentSha256: dispatchIntentSha256(input), expiresAtMs: clock.nowMs() + 1_000_000 });
  scheduler.submit(input);
  const intent = scheduler.tick().find((candidate) => candidate.taskId === taskId);
  if (intent === undefined) throw new Error(`scheduled ${resource} stage was not dispatched`);
  scheduler.started(intent.dispatchId, 20_000 + scheduler.inspect().streamVersion,
    `incarnation-${taskId}`, `start-${taskId}`);
  scheduler.heartbeat(intent.dispatchId, `incarnation-${taskId}`);
  try { const result = await action(); scheduler.complete(intent.dispatchId, "completed"); return result; }
  catch (error) { scheduler.complete(intent.dispatchId, "failed"); throw error; }
}

async function scheduledBatch<T>(scheduler: JournalScheduler, grants: DispatchGrantService,
  clock: TrustedFixtureClock, resource: "validation" | "review" | "integration",
  items: readonly { readonly taskId: string; readonly workspace: string; readonly action: () => Promise<T> }[]): Promise<T[]> {
  const actions = new Map(items.map((item) => [item.taskId, item]));
  const results = new Map<string, T>();
  for (const item of items) {
    const input = stageTask(resource, item.taskId, item.workspace);
    grants.issue({ grantId: input.grantId, audience: input.workerId,
      dispatchIntentSha256: dispatchIntentSha256(input), expiresAtMs: clock.nowMs() + 1_000_000 });
    scheduler.submit(input);
  }
  while (results.size < items.length) {
    const intents = scheduler.tick().filter((intent) => actions.has(intent.taskId) && !results.has(intent.taskId));
    if (intents.length === 0) throw new Error(`scheduled ${resource} batch made no progress`);
    await Promise.all(intents.map(async (intent) => {
      scheduler.started(intent.dispatchId, 30_000 + scheduler.inspect().streamVersion,
        `incarnation-${intent.taskId}`, `start-${intent.taskId}`);
      scheduler.heartbeat(intent.dispatchId, `incarnation-${intent.taskId}`);
      try { const result = await actions.get(intent.taskId)!.action(); results.set(intent.taskId, result);
        scheduler.complete(intent.dispatchId, "completed"); }
      catch (error) { scheduler.complete(intent.dispatchId, "failed"); throw error; }
    }));
  }
  return items.map((item) => results.get(item.taskId)!);
}

function stageTask(resource: "validation" | "review" | "integration", taskId: string,
  workspace: string): SchedulerTaskInput {
  return { taskId, correlationId: RUN_ID, projectId: PROJECT_ID, workerId: `worker-${taskId}`, effect: "computation",
    requiredCapabilities: [resource === "validation" ? "run_validation" : resource === "review" ? "review_diff" : "integrate"],
    platform: "darwin-arm64", workspace: { path: workspace, available: true },
    admission: { dependencies: [], decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
      platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
      acceptanceCriteria: ["Exact stage evidence retained."], evidenceRequirements: ["stage receipt"] },
    resources: { reasoning: 0, writers: 0, heavyValidation: resource === "validation" ? 1 : 0,
      review: resource === "review" ? 1 : 0, integration: resource === "integration" ? 1 : 0 },
    budget: { seconds: 60, inputTokens: 10, outputTokens: 10, costUsdNano: 10 }, grantId: `grant-${taskId}` };
}

function retainedWriterEffect(claims: PathClaimService, taskId: string): boolean {
  const claim = claims.inspect(PROJECT_ID).active.find((item) => item.claimId === `claim-${taskId}`);
  return claim?.workerReceipt !== null && claim?.patchApplicationCompleted === true;
}

function findAssignment(journal: SqliteEventJournal, assignmentId: string) {
  for (const podId of ["pod-a", "pod-b", "pod-c"]) {
    const assignment = new PodRegistry(journal).inspect(podId)?.assignments[assignmentId];
    if (assignment !== undefined) return assignment;
  }
  throw new Error(`assignment ${assignmentId} was not found`);
}

function registryFor(journal: SqliteEventJournal): PodRegistry { return new PodRegistry(journal); }

function verifiedReview(gate: ReviewGate, workerId: string, diff: string, validation: ValidationReport,
  decidedAt: string): ReviewDecision {
  return gate.verify({ workerId, reviewerId: `reviewer-${workerId}`, diff, validation }, {
    reviewerId: `reviewer-${workerId}`, approved: true, diffSha256: sha256(diff),
    validationSha256: canonicalValidationDigest(validation), decidedAt,
    reason: "Approved exact validated conformance source." });
}

function createProvider(root: string, overlap: string, suffix: string, targetFile: string, revision: string,
  beforeValue: string | null, afterValue: string): string {
  const target = targetFile.replace(/\..*$/, "").replace(/[^A-Za-z0-9_$]/g, "_");
  const before = beforeValue === null ? null : `export const ${target} = "${beforeValue}";\n`;
  const after = `export const ${target} = "${afterValue}";\n`;
  const proposal = buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
    proposalId: `proposal-${suffix}`, baseRevision: revision, operations: [{ path: `src/${targetFile}`,
      expectedSha256: before === null ? null : sha256(before), content: after, contentSha256: sha256(after) }] });
  const executable = path.join(root, `provider-${suffix}.mjs`);
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.length === 3 && process.argv[2] === "--version") { process.stdout.write("three-pod-provider 1\\n"); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const permissions = config.agent["zentra-writer"].permission;
const attempts = { secret: process.env.ZENTRA_THREE_POD_SECRET_CANARY ?? null, edit: permissions.edit,
  shell: permissions.bash, path: permissions.read[".env"], wildcard: permissions["*"] };
if (attempts.secret !== null || attempts.edit !== "deny" || attempts.shell !== "deny" || attempts.path !== "deny" || attempts.wildcard !== "deny") process.exit(71);
writeFileSync(${JSON.stringify(path.join(root, `security-${suffix}.json`))}, JSON.stringify(attempts));
appendFileSync(${JSON.stringify(overlap)}, ${JSON.stringify(`${suffix}\n`)});
const deadline = Date.now() + 10000;
while (readFileSync(${JSON.stringify(overlap)}, "utf8").trim().split("\\n").length < 4) { if (Date.now() > deadline) process.exit(72); await new Promise(resolve => setTimeout(resolve, 10)); }
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: ${JSON.stringify(JSON.stringify(proposal))} } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } }) + "\\n");
`, { mode: 0o755 });
  return realpathSync.native(executable);
}

function pathName(suffix: string): string { return suffix === "conflict" || suffix === "replacement" ? "a" : suffix; }

function assertProviderSecurity(root: string, suffix: string): void {
  const observed = JSON.parse(readFileSync(path.join(root, `security-${suffix}.json`), "utf8")) as {
    secret: string | null; edit: string; shell: string; path: string; wildcard: string };
  if (observed.secret !== null || observed.edit !== "deny" || observed.shell !== "deny" ||
    observed.path !== "deny" || observed.wildcard !== "deny") {
    throw new Error(`provider security attempt was not denied: ${suffix}`);
  }
}

function plannedTask(taskId: string, ownedPath: string): PlannedTask {
  return { taskId, title: taskId, description: `Update ${ownedPath}.`, dependencies: [], ownedPaths: [ownedPath],
    forbiddenPaths: [".env", ".git/**"], acceptanceCriteria: ["Exact validation passes."],
    roleAssignment: { role: "implementer", agentId: "writer-model", harness: "opencode" },
    risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
    budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 } };
}

function writerModel(): ModelCapability { return { id: "writer-model", harness: "opencode", model: "fixture/model",
  roles: ["implementer"], specialties: ["coding"], costTier: "low", contextTokens: 128_000,
  maxConcurrency: 4, toolPermissions: ["read_repository", "write_worktree"], network: "denied",
  fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }; }
function securitySheet(repositoryPath: string): SecuritySheet { return { allowedRepositories: [repositoryPath],
  allowedFileScopes: ["src/**", "test/**"], forbiddenPaths: [".env", ".git/**"],
  network: { default: "denied", allowedDestinations: [] }, secretHandling: ["No inherited secrets."],
  approvalRequiredOperations: ["external_effect"], releaseBoundary: "local_preparation_only",
  stopAndAskConditions: ["forbidden_file_scope"] }; }
function podBudget() { return { maxSeconds: 60, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000,
  maxOutputTokens: 1_000, maxExternalEffects: 0 as const }; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function gitOk(git: GitClient, cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args); if (result.exitCode !== 0) throw new Error(result.stderr);
}
async function gitText(git: GitClient, cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args); if (result.exitCode !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
