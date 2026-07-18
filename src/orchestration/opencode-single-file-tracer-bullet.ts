import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isVerifiedValidationReport,
  type ValidationReport,
  type ValidationRunner,
} from "../capabilities/validation-runner.js";
import {
  ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE,
  artifactEvidenceSha256,
  type ArtifactKind,
  type PatchArtifactEvidence,
} from "../contracts/artifact.js";
import type { TerminalOutcome } from "../contracts/task.js";
import {
  uncertainEffectPayload,
  type UncertainEffectBoundary,
} from "../contracts/uncertain-effect.js";
import { PlannedTaskSchema, type PlannedTask } from "../contracts/milestone.js";
import { usdNumberToNano } from "../contracts/cost.js";
import {
  isVerifiedOpenCodeProbeReport,
  type OpenCodeProbeReport,
} from "../harnesses/opencode-probe.js";
import {
  IntegrationExecutionError,
  type IntegrationQueue,
  type IntegrationReceipt,
  IntegrationUncertainError,
} from "../integration/integration-queue.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { ReviewGate } from "../reviews/review-gate.js";
import { assessReviewPolicy } from "../reviews/review-policy.js";
import { OpenCodeReviewerUncertainError } from "../reviews/opencode-reviewer-adapter.js";
import {
  ReviewerExecutionError,
  type ReviewInput,
  type ReviewerAdapter,
} from "../reviews/reviewer-adapter.js";
import type { TaskService } from "../tasks/task-service.js";
import type { TaskView } from "../tasks/task-projection.js";
import type { GitClient } from "../workspaces/git-client.js";
import type { WorkspaceLease, WorktreeManager } from "../workspaces/worktree-manager.js";
import {
  IntegrationBranchCreationUncertainError,
  WorkspaceCommitUncertainError,
  WorkspaceCreationUncertainError,
  WorkspaceGitTerminationError,
} from "../workspaces/worktree-manager.js";
import { verifyCompletedIntegrationReceipt } from "./tracer-bullet.js";
import type {
  WriterCapsuleResult,
  WriterWorktreeCapsule,
} from "./writer-worktree-capsule.js";
import { WorkerLifecycleService } from "../workers/worker-lifecycle.js";
import { OpenCodeWorkerEventAdapter } from "../agents/opencode-worker-event-adapter.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import { projectMilestone } from "../milestones/milestone-projection.js";
import { MilestoneRegistry } from "../milestones/milestone-registry.js";
import { capabilityTaskHead, createCapabilityBoundaryOccurrence } from "../contracts/capability-boundary.js";
import {
  RoleCapabilityEnvelopeService,
  buildRoleCapabilityBinding,
} from "../workers/role-capability-envelope.js";

export interface OpenCodeSingleFileTracerRequest {
  readonly project: ProjectConfig;
  readonly task: PlannedTask;
  readonly model: ModelCapability;
  readonly security: SecuritySheet;
  readonly probe: OpenCodeProbeReport;
  readonly openCodeHome?: string;
  readonly reviewerId?: string;
  readonly correlationId?: string;
  readonly parentMilestoneId?: string;
  readonly onReviewReady?: (handoff: ValidatedChangeHandoff) => void | Promise<void>;
  readonly signal: AbortSignal;
}

export interface ValidatedChangeHandoff {
  readonly taskStreamId: string;
  readonly diffSha256: string;
  readonly validation: ValidationReport;
}

export interface OpenCodeIntegrationDependencies {
  readonly reviewer: ReviewerAdapter;
  readonly reviews: ReviewGate;
  readonly integrations: IntegrationQueue;
  readonly git: GitClient;
}

export interface OpenCodeIntegratedSingleFileTracerRequest
  extends OpenCodeSingleFileTracerRequest {
  readonly reviewerId: string;
}

const GIT_OPERATION_TIMEOUT_MS = 30_000;
const schedulerAuthorizedRequests = new WeakSet<object>();

export function authorizeScheduledTracerRequest<T extends OpenCodeIntegratedSingleFileTracerRequest>(request: T): T {
  schedulerAuthorizedRequests.add(request);
  return request;
}

export class OpenCodeIntegratedSingleFileTracer {
  private readonly tracer: OpenCodeSingleFileTracerBullet;

  constructor(
    tasks: TaskService,
    capsule: WriterWorktreeCapsule,
    validations: ValidationRunner,
    worktrees: WorktreeManager,
    integration: OpenCodeIntegrationDependencies,
  ) {
    this.tracer = new OpenCodeSingleFileTracerBullet(
      tasks,
      capsule,
      validations,
      worktrees,
      integration,
    );
  }

  run(request: OpenCodeIntegratedSingleFileTracerRequest): Promise<TaskView> {
    return this.tracer.run(request);
  }
}

export class OpenCodeSingleFileTracerBullet {
  constructor(
    private readonly tasks: TaskService,
    private readonly capsule: WriterWorktreeCapsule,
    private readonly validations: ValidationRunner,
    private readonly worktrees: WorktreeManager,
    private readonly integration?: OpenCodeIntegrationDependencies,
  ) {}

  async run(request: OpenCodeSingleFileTracerRequest): Promise<TaskView> {
    const changedPath = singleOwnedFile(request.task, schedulerAuthorizedRequests.has(request));
    assertWriterAdmission(request, changedPath);
    this.tasks.create({
      taskId: request.task.taskId,
      projectId: request.project.projectId,
      title: request.task.title,
      correlationId: request.correlationId ?? request.task.taskId,
    });

    let observedWorkspace: string | null = null;
    let capsule: WriterCapsuleResult;
    const workers = new WorkerLifecycleService(this.tasks.eventJournal());
    const roleCapabilities = new RoleCapabilityEnvelopeService(this.tasks.eventJournal());
    const workerEvents = new OpenCodeWorkerEventAdapter();
    const workerId = `writer-${createHash("sha256").update(`${request.task.taskId}\0${request.model.id}`, "utf8").digest("hex")}`;
    assertWriterAdmission(request, changedPath);
    const parentMilestone = request.parentMilestoneId === undefined
      ? null
      : projectMilestone(this.tasks.eventJournal().readStream(request.parentMilestoneId));
    const admissionDigest = parentMilestone?.tasks[request.task.taskId]?.admissionDigest ??
      digestCanonical({ taskId: request.task.taskId, mode: "standalone" });
    const roleBinding = roleCapabilities.accept(buildRoleCapabilityBinding({
      milestoneId: request.parentMilestoneId ?? request.task.taskId,
      taskId: request.task.taskId,
      projectId: request.project.projectId,
      correlationId: request.correlationId ?? request.task.taskId,
      role: "implementer",
      actorId: request.model.id,
      repository: request.project.repositoryPath,
      planDigest: digestCanonical(parentMilestone?.plan ?? request.task),
      securityDigest: digestCanonical(request.security),
      model: {
        capabilityId: request.model.id,
        transportModelId: request.model.model,
        digest: digestCanonical(request.model),
        harness: request.model.harness,
        roles: request.model.roles,
        toolPermissions: request.model.toolPermissions,
        network: request.model.network,
      },
      budget: request.task.budget,
      admissionDigest,
      configuredReadPaths: request.security.allowedFileScopes,
      ownedPaths: request.task.ownedPaths,
      forbiddenPaths: [...new Set([...request.task.forbiddenPaths, ...request.security.forbiddenPaths])],
    }));
    workers.bind({
      schemaVersion: 1,
      workerId,
      taskId: request.task.taskId,
      rootTaskId: request.task.taskId,
      parentWorkerId: null,
      harness: "opencode",
      role: request.task.roleAssignment.role,
      model: { capabilityId: request.model.id, modelId: request.model.model },
      envelope: roleBinding.envelope,
      taskContext: request.parentMilestoneId === undefined
        ? { kind: "standalone" }
        : { kind: "milestone", milestoneId: request.parentMilestoneId },
      budget: {
        budgetId: request.task.taskId,
        maxSeconds: request.task.budget.maxSeconds,
        maxCostUsd: request.task.budget.maxCostUsd,
        maxCostUsdNano: usdNumberToNano(request.task.budget.maxCostUsd),
        maxInputTokens: request.task.budget.maxInputTokens,
        maxOutputTokens: request.task.budget.maxOutputTokens,
        maxToolCalls: 10_000,
        maxModelTurns: 10_000,
        maxActiveWorkers: 1,
        maxConcurrentTools: 1,
        maxConcurrentModelTurns: 1,
      },
      trace: {
        traceId: request.correlationId ?? request.task.taskId,
        correlationId: request.correlationId ?? request.task.taskId,
      },
    });
    try {
      roleCapabilities.verify(roleBinding, {
        planDigest: digestCanonical(parentMilestone?.plan ?? request.task),
        securityDigest: digestCanonical(request.security),
        modelDigest: digestCanonical(request.model),
        repositoryDigest: digestCanonical(request.project.repositoryPath),
        ownershipDigest: roleBinding.ownershipDigest,
        budgetDigest: digestCanonical(request.task.budget),
        admissionDigest,
      });
      const launchDecisions = [
        ...roleBinding.access.readPaths.flatMap((scope) => [
          roleCapabilities.evaluate(roleBinding, { kind: "read", path: scope }),
          roleCapabilities.evaluate(roleBinding, { kind: "search", path: scope }),
        ]),
        ...roleBinding.access.writePaths.map((scope) => roleCapabilities.evaluate(roleBinding, { kind: "write", path: scope })),
      ];
      if (launchDecisions.some((decision) => decision.status !== "allowed")) {
        const decision = launchDecisions.find((candidate) => candidate.status !== "allowed")!;
        workers.cleanup(request.task.taskId, workerId, "completed");
        workers.terminate(request.task.taskId, workerId, "denied");
        const occurrence = createCapabilityBoundaryOccurrence({
          binding: roleBinding,
          decision,
          evaluationEvent: roleCapabilities.evaluationEvent(roleBinding, decision.decisionId),
          phase: "pre_effect",
          taskHead: capabilityTaskHead(this.tasks.readStream(request.task.taskId)),
        });
        if (request.parentMilestoneId === undefined) throw new Error("capability boundary pause requires an authoritative milestone");
        new MilestoneRegistry(this.tasks.eventJournal()).pauseForCapabilityBoundary(request.parentMilestoneId, occurrence, null);
        return this.tasks.get(request.task.taskId)!;
      }
      capsule = await this.capsule.run({
        ...request,
        capabilityBinding: roleBinding,
        executable: request.probe.executable!,
        executableSha256: request.probe.executableSha256!,
        observer: {
          onWorktreeCreationStarted: (intent) => {
            this.tasks.append(request.task.taskId, "task.worktree_creation_started", intent, null);
          },
          onLeaseCreated: ({ lease: createdLease, baseCommit }) => {
            observedWorkspace = createdLease.path;
            workers.observe(request.task.taskId, workerId, workerEvents.resourceObservation("assigned_worktree", "completed"));
            this.tasks.append(request.task.taskId, "task.leased", {
              leaseOwner: request.model.id,
              workspace: createdLease.path,
            }, null);
            void baseCommit;
          },
          onWriterStarted: ({ lease: writerLease }) => {
            workers.start(request.task.taskId, workerId);
            this.tasks.append(request.task.taskId, "task.started", {
              workerId: request.model.id,
            }, null);
            void writerLease;
          },
          onWriterCompleted: (report) => {
            workers.observe(request.task.taskId, workerId, workerEvents.processObservation(
              "opencode", report.outcome,
            ));
            workers.cleanup(request.task.taskId, workerId, "completed");
            workers.terminate(request.task.taskId, workerId, report.outcome);
            this.tasks.append(request.task.taskId, "task.writer_completed", writerSummary(report), null);
          },
        },
      });
    } catch (error) {
      const worker = workers.inspect(request.task.taskId).workers[workerId];
      if (worker !== undefined && worker.status !== "terminal" && worker.status !== "uncertain") {
        if (error instanceof WorkspaceCreationUncertainError || error instanceof IntegrationBranchCreationUncertainError || this.current(request.task.taskId).lifecycle === "running") {
          workers.uncertain(request.task.taskId, workerId, errorMessage(error));
          workers.cleanup(request.task.taskId, workerId, "uncertain");
        } else {
          workers.cleanup(request.task.taskId, workerId, "completed");
          workers.terminate(request.task.taskId, workerId, error instanceof WorkspaceGitTerminationError ? error.outcome : "failed");
        }
      }
      if (
        error instanceof WorkspaceCreationUncertainError ||
        error instanceof IntegrationBranchCreationUncertainError
      ) {
        return this.pauseForUncertainty(
          request.task.taskId,
          "worktree_creation",
          "Git worktree creation",
          errorMessage(error),
          observedWorkspace === null
            ? null
            : { path: observedWorkspace, branch: `ticket/${request.task.taskId}` },
        );
      }
      if (error instanceof WorkspaceGitTerminationError) {
        return this.terminate(request.task.taskId, error.outcome, "setup", error.message);
      }
      if (this.current(request.task.taskId).lifecycle === "running") {
        return this.pauseForUncertainty(
          request.task.taskId,
          "worker",
          "OpenCode writer",
          errorMessage(error),
          observedWorkspace === null
            ? null
            : { path: observedWorkspace, branch: `ticket/${request.task.taskId}` },
        );
      }
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "writer",
        reason: error instanceof Error ? error.message : String(error),
        workspace: observedWorkspace,
      }, null);
    }

    const changedPathDecisions = (capsule.ownership?.changedPaths ?? [])
      .map((changed) => roleCapabilities.evaluate(roleBinding, { kind: "write", path: changed }));
    const deniedToolDecisions = (capsule.writer?.deniedToolRequests ?? []).map((denied) => {
      try {
        if (denied.path !== null && (denied.tool === "edit" || denied.tool === "write" || denied.tool === "apply_patch")) {
          const decision = roleCapabilities.evaluate(roleBinding, { kind: "write", path: denied.path });
          return decision.status === "allowed" ? roleCapabilities.evaluate(roleBinding, { kind: "external_effect" }) : decision;
        }
        if (denied.path !== null && (denied.tool === "read" || denied.tool === "glob" || denied.tool === "grep")) {
          const decision = roleCapabilities.evaluate(roleBinding, { kind: denied.tool === "grep" ? "search" : "read", path: denied.path });
          return decision.status === "allowed" ? roleCapabilities.evaluate(roleBinding, { kind: "external_effect" }) : decision;
        }
      } catch {
        // An unsafe native path is itself outside the typed envelope.
      }
      return roleCapabilities.evaluate(roleBinding, { kind: "external_effect" });
    });
    if (changedPathDecisions.some((decision) => decision.status !== "allowed") || deniedToolDecisions.length > 0) {
      const decision = [...changedPathDecisions, ...deniedToolDecisions].find((candidate) => candidate.status !== "allowed")!;
      const evidence = {
        deniedToolRequests: capsule.writer?.deniedToolRequests ?? [],
        writer: capsule.writer === null ? null : writerSummary(capsule.writer),
        ownership: capsule.ownership,
        workspace: capsule.lease?.path ?? null,
      };
      const occurrence = createCapabilityBoundaryOccurrence({
        binding: roleBinding,
        decision,
        evaluationEvent: roleCapabilities.evaluationEvent(roleBinding, decision.decisionId),
        phase: "post_worker",
        taskHead: capabilityTaskHead(this.tasks.readStream(request.task.taskId)),
        workerSettlement: { workerId, cleanup: "completed", terminalOutcome: capsule.writer?.outcome ?? "failed" },
        evidence,
      });
      if (request.parentMilestoneId === undefined) throw new Error("capability boundary pause requires an authoritative milestone");
      new MilestoneRegistry(this.tasks.eventJournal()).pauseForCapabilityBoundary(request.parentMilestoneId, occurrence, evidence);
      return this.tasks.get(request.task.taskId)!;
    }
    if (capsule.outcome !== "completed") {
      return this.tasks.append(request.task.taskId, `task.${capsule.outcome}`, {
        stage: capsule.outcome === "denied" ? "ownership" : "writer",
        writer: capsule.writer === null ? null : writerSummary(capsule.writer),
        ownership: capsule.ownership,
        workspace: capsule.lease?.path ?? null,
      }, null);
    }
    try {
      assertSingleChange(capsule, changedPath);
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "writer",
        reason: error instanceof Error ? error.message : String(error),
        ownership: capsule.ownership,
        workspace: capsule.lease?.path ?? null,
      }, null);
    }
    const lease = capsule.lease!;
    let inspected;
    try {
      inspected = await this.worktrees.inspect(lease, { signal: request.signal });
    } catch (error) {
      return this.pauseForUncertainty(
        request.task.taskId,
        "worker",
        "writer workspace inspection",
        errorMessage(error),
        { path: lease.path, branch: lease.branch },
      );
    }
    const diffSha256 = createHash("sha256").update(inspected.diff, "utf8").digest("hex");
    if (inspected.diff === "") {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "artifact",
        reason: "OpenCode writer completed without a nonempty diff",
        workspace: lease.path,
      }, null);
    }
    const changedFile = path.join(lease.path, changedPath);
    let changedContentSha256: string;
    try {
      const file = lstatSync(changedFile);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error("writer change must be one regular file");
      }
      changedContentSha256 = createHash("sha256")
        .update(readFileSync(changedFile))
        .digest("hex");
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "artifact",
        reason: error instanceof Error ? error.message : String(error),
        workspace: lease.path,
      }, null);
    }
    const invocationId = randomUUID();
    const patch = { type: "artifact.ready", path: changedPath, sha256: changedContentSha256 };
    try {
      this.recordArtifact(request.task.taskId, "patch", {
        diff: inspected.diff,
        diffSha256,
        changedPath,
        changedContentSha256,
      } satisfies PatchArtifactEvidence, {
        type: "task.validation_started",
        payload: { patch, diffSha256 },
      });
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "artifact",
        reason: error instanceof Error ? error.message : String(error),
        workspace: lease.path,
      }, null);
    }
    let validation: ValidationReport;
    try {
      validation = await this.validations.run(
        request.project,
        "focused",
        lease.path,
        request.signal,
        { invocationId, subjectSha256: diffSha256 },
      );
    } catch (error) {
      return this.terminate(
        request.task.taskId,
        "failed",
        "validation",
        errorMessage(error),
        { workspace: lease.path },
      );
    }
    try {
      assertValidationEvidence(validation, request, lease, invocationId, diffSha256);
    } catch (error) {
      return this.terminate(request.task.taskId, "failed", "validation", errorMessage(error), {
        workspace: lease.path,
      });
    }
    let postValidation;
    try {
      postValidation = await this.worktrees.inspect(lease, { signal: request.signal });
    } catch (error) {
      const outcome = error instanceof WorkspaceGitTerminationError ? error.outcome : "failed";
      this.recordArtifact(request.task.taskId, "validation_report", validation, [
        {
          type: "task.validation_completed",
          payload: { outcome: validation.outcome, validation, diffSha256 },
        },
        {
          type: `task.${outcome}`,
          payload: {
            stage: "validation",
            reason: errorMessage(error),
            validation,
            workspace: lease.path,
          },
        },
      ]);
      return this.current(request.task.taskId);
    }
    const postValidationSha256 = createHash("sha256")
      .update(postValidation.diff, "utf8")
      .digest("hex");
    const workspaceUnchanged = postValidationSha256 === diffSha256;
    const terminal = validation.outcome === "completed" && workspaceUnchanged
      ? "completed"
      : validation.outcome === "completed"
      ? "failed"
      : validation.outcome;
    const continueToReview = terminal === "completed" && request.reviewerId !== undefined;
    try {
      this.recordArtifact(
        request.task.taskId,
        "validation_report",
        validation,
        [
          {
            type: "task.validation_completed",
            payload: { outcome: validation.outcome, validation, diffSha256 },
          },
          ...(continueToReview
            ? [{
              type: "task.review_requested",
              payload: { reviewerId: request.reviewerId, validation },
            }]
            : []),
        ],
      );
    } catch (error) {
      return this.terminate(request.task.taskId, "failed", "validation", errorMessage(error), {
        workspace: lease.path,
      });
    }
    if (!continueToReview) {
      return this.terminate(request.task.taskId, terminal, "validation", "focused validation finished", {
        validation,
        diffSha256,
        changedPath,
        workspace: lease.path,
      });
    }
    return this.reviewCommitAndIntegrate(
      request,
      lease,
      changedPath,
      inspected.diff,
      diffSha256,
      validation,
    );
  }

  private async reviewCommitAndIntegrate(
    request: OpenCodeSingleFileTracerRequest,
    lease: WorkspaceLease,
    changedPath: string,
    diff: string,
    diffSha256: string,
    validation: ValidationReport,
  ): Promise<TaskView> {
    const dependencies = this.integration;
    const reviewerId = request.reviewerId!;
    if (dependencies === undefined) {
      return this.terminate(
        request.task.taskId,
        "failed",
        "review",
        "OpenCode integration dependencies are not configured",
        { workspace: lease.path },
      );
    }
    const reviewInput: ReviewInput = {
      workerId: request.model.id,
      reviewerId,
      diff,
      validation,
    };
    try {
      await request.onReviewReady?.({
        taskStreamId: request.task.taskId,
        diffSha256,
        validation,
      });
      const decision = await dependencies.reviewer.review(reviewInput, request.signal);
      const evidence = dependencies.reviews.verifyEvidence(reviewInput, decision);
      if (!evidence.approved) {
        this.recordArtifact(request.task.taskId, "review_report", evidence, {
          type: "task.denied",
          payload: { stage: "review", reason: evidence.reason, review: evidence },
        });
        return this.current(request.task.taskId);
      }
      const review = dependencies.reviews.verify(reviewInput, evidence);
      if (review.diffSha256 !== diffSha256) {
        throw new Error("verified review digest differs from the validated diff");
      }
      const policy = assessReviewPolicy({
        task: request.task,
        security: request.security,
        workerId: request.model.id,
        reviewerIds: [review.reviewerId],
      });
      this.recordArtifact(
        request.task.taskId,
        "review_report",
        review,
        [
          { type: "task.review_approved", payload: { review } },
          ...(policy.status === "ready_for_review"
            ? []
            : [{
              type: "task.review_policy_blocked",
              payload: { stage: "review", reason: policy.reason, reviewPolicy: policy },
            }]),
        ],
      );
      if (policy.status !== "ready_for_review") return this.current(request.task.taskId);

      const sourceCommit = await this.worktrees.commit(
        lease,
        [changedPath],
        request.task.title,
        review.diffSha256,
        {
          signal: request.signal,
          timeoutMs: Math.min(
            request.task.budget.maxSeconds * 1_000,
            GIT_OPERATION_TIMEOUT_MS,
          ),
        },
      );
      const postCommitOutcome = signalOutcome(request.signal);
      if (postCommitOutcome !== null) {
        return this.terminate(
          request.task.taskId,
          postCommitOutcome,
          "commit",
          "task signal ended after commit acknowledgement",
          { sourceCommit, workspace: lease.path },
        );
      }
      this.tasks.append(request.task.taskId, "task.integration_started", {
        sourceCommit,
        review,
      }, null);

      const prepared = { receipt: null as IntegrationReceipt | null };
      let receipt: IntegrationReceipt;
      try {
        receipt = await dependencies.integrations.integrate({
          project: request.project,
          lease,
          review,
          signal: request.signal,
          onPrepared: (preparedReceipt) => {
            prepared.receipt = preparedReceipt;
            this.recordArtifact(
              request.task.taskId,
              "integration_receipt",
              preparedReceipt,
              {
                type: "task.integration_prepared",
                payload: { receipt: preparedReceipt },
              },
              "prepared",
            );
          },
        });
      } catch (error) {
        if (error instanceof IntegrationUncertainError) {
          return this.observeIntegration(request.task.taskId, {
            reason: error.message,
            evidence: error.evidence,
          }, true, lease);
        }
        if (error instanceof IntegrationExecutionError) throw error;
        return this.observeIntegration(request.task.taskId, {
          error: { name: errorName(error), message: errorMessage(error) },
        }, true, lease);
      }
      if (receipt.outcome !== "completed") {
        const finalReceipt = prepared.receipt === null
          ? receipt
          : { ...prepared.receipt, outcome: receipt.outcome };
        this.recordArtifact(
          request.task.taskId,
          "integration_receipt",
          finalReceipt,
          {
            type: `task.${receipt.outcome}`,
            payload: {
              stage: "integration",
              reason: "integration did not complete successfully",
              receipt: finalReceipt,
              candidateCleanupFailures: this.integrationCleanupFailures(request.task.taskId),
            },
          },
          "final",
        );
        return this.current(request.task.taskId);
      }
      try {
        await verifyCompletedIntegrationReceipt({
          project: request.project,
          taskId: request.task.taskId,
          sourceCommit,
          review,
          receipt,
          git: dependencies.git,
        });
      } catch (error) {
        return this.observeIntegration(request.task.taskId, {
          receipt,
          verification: "failed",
          reason: errorMessage(error),
        }, true, lease);
      }
      const cleanupFailures = this.integrationCleanupFailures(request.task.taskId);
      const integrationObserved = {
        receipt,
        verification: "verified",
        cleanupFailures,
      };
      if (cleanupFailures.length > 0) {
        return this.tasks.appendBatch(request.task.taskId, [
          { type: "task.integration_observed", payload: integrationObserved, causationId: null },
          {
            type: "task.effect_uncertain",
            payload: uncertainEffectPayload({
              boundary: "cleanup",
              operation: "integration candidate cleanup",
              reason: "integration candidate cleanup was not proven complete",
              requestedBy: "zentra-integration-controller",
              workspace: { path: lease.path, branch: lease.branch },
            }),
            causationId: null,
          },
        ]);
      }
      this.tasks.append(request.task.taskId, "task.integration_observed", integrationObserved, null);
      const cleanup = {
        sourceCommit,
        resultCommit: receipt.resultCommit,
        workspace: lease.path,
        branch: lease.branch,
      };
      this.tasks.append(request.task.taskId, "task.cleanup_started", cleanup, null);
      try {
        await this.worktrees.cleanupCompleted(request.project, lease, sourceCommit, {
          timeoutMs: GIT_OPERATION_TIMEOUT_MS,
        });
      } catch (error) {
        const observed = error as {
          readonly phase?: unknown;
          readonly uncertain?: unknown;
          readonly evidence?: unknown;
        };
        const cleanupObservation = {
          phase: typeof observed.phase === "string" ? observed.phase : "unknown",
          uncertain: observed.uncertain === true,
          evidence: observed.evidence ?? {},
          reason: errorMessage(error),
        };
        if (observed.uncertain !== true) {
          return this.terminate(
            request.task.taskId,
            "failed",
            "cleanup",
            errorMessage(error),
            { cleanup: cleanupObservation },
          );
        }
        return this.tasks.appendBatch(request.task.taskId, [
          { type: "task.cleanup_observed", payload: cleanupObservation, causationId: null },
          {
            type: "task.effect_uncertain",
            payload: uncertainEffectPayload({
              boundary: "cleanup",
              operation: "ticket worktree cleanup",
              reason: errorMessage(error),
              requestedBy: "zentra-integration-controller",
              workspace: { path: lease.path, branch: lease.branch },
            }),
            causationId: null,
          },
        ]);
      }
      this.tasks.append(request.task.taskId, "task.cleanup_completed", cleanup, null);
      return this.tasks.append(request.task.taskId, "task.completed", { receipt }, null);
    } catch (error) {
      if (error instanceof OpenCodeReviewerUncertainError) {
        return this.tasks.pauseForUncertainEffect(request.task.taskId, uncertainEffectPayload({
          boundary: "review",
          operation: "OpenCode independent review",
          reason: error.message,
          requestedBy: "zentra-recovery-controller",
          workspace: { path: lease.path, branch: lease.branch },
          evidence: error.evidence,
        }));
      }
      if (error instanceof WorkspaceCommitUncertainError) {
        return this.tasks.appendBatch(request.task.taskId, [
          {
            type: "task.commit_observed",
            payload: { stage: "commit", reason: error.message },
            causationId: null,
          },
          {
            type: "task.effect_uncertain",
            payload: uncertainEffectPayload({
              boundary: "commit",
              operation: "reviewed Git commit",
              reason: error.message,
              requestedBy: "zentra-integration-controller",
              workspace: { path: lease.path, branch: lease.branch },
            }),
            causationId: null,
          },
        ]);
      }
      const outcome = error instanceof ReviewerExecutionError ||
          error instanceof WorkspaceGitTerminationError ||
          error instanceof IntegrationExecutionError
        ? error.outcome
        : signalOutcome(request.signal) ?? "failed";
      const current = this.current(request.task.taskId);
      if (current.lifecycle === "integrating" && !(error instanceof IntegrationExecutionError)) {
        return this.observeIntegration(request.task.taskId, {
          error: { name: errorName(error), message: errorMessage(error) },
        }, true, lease);
      }
      return this.terminate(request.task.taskId, outcome, current.lifecycle, errorMessage(error), {
        workspace: lease.path,
      });
    }
  }

  private recordArtifact(
    taskId: string,
    kind: ArtifactKind,
    evidence: unknown,
    following:
      | { readonly type: string; readonly payload: unknown }
      | readonly { readonly type: string; readonly payload: unknown }[],
    phase?: "prepared" | "final",
  ): void {
    const sha256 = artifactEvidenceSha256(kind, evidence);
    const artifact = {
      artifactId: randomUUID(),
      taskId,
      kind,
      path: artifactPath(kind),
      sha256,
      createdAt: new Date().toISOString(),
    };
    this.tasks.appendBatch(taskId, [
      {
        type: ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE,
        payload: { artifactProtocolVersion: 1, artifactId: artifact.artifactId, kind, sha256 },
        causationId: null,
      },
      {
        type: `artifact.${kind}_recorded`,
        payload: {
          artifact,
          evidence,
          ...(phase === undefined ? {} : { phase }),
        },
        causationId: null,
      },
      ...(Array.isArray(following) ? following : [following]).map((event) => ({
        ...event,
        causationId: null,
      })),
    ]);
  }

  private terminate(
    taskId: string,
    outcome: TerminalOutcome,
    stage: string,
    reason: string,
    evidence: Record<string, unknown> = {},
  ): TaskView {
    const current = this.current(taskId);
    if (current.lifecycle === "terminal") return current;
    return this.tasks.append(taskId, `task.${outcome}`, { stage, reason, ...evidence }, null);
  }

  private current(taskId: string): TaskView {
    const current = this.tasks.get(taskId);
    if (current === null) throw new Error(`task ${taskId} not found`);
    return current;
  }

  private observeIntegration(
    taskId: string,
    payload: unknown,
    uncertain = false,
    lease?: WorkspaceLease,
  ): TaskView {
    const durable = typeof payload === "object" && payload !== null
      ? { ...payload, cleanupFailures: this.integrationCleanupFailures(taskId) }
      : { evidence: payload, cleanupFailures: this.integrationCleanupFailures(taskId) };
    if (!uncertain) return this.tasks.append(taskId, "task.integration_observed", durable, null);
    return this.tasks.appendBatch(taskId, [
      { type: "task.integration_observed", payload: durable, causationId: null },
      {
        type: "task.effect_uncertain",
        payload: uncertainEffectPayload({
          boundary: "integration",
          operation: "integration candidate and branch update",
          reason: payloadReason(payload),
          requestedBy: "zentra-integration-controller",
          workspace: lease === undefined ? null : { path: lease.path, branch: lease.branch },
        }),
        causationId: null,
      },
    ]);
  }

  private integrationCleanupFailures(taskId: string): readonly unknown[] {
    return this.integration?.integrations.getCleanupFailures()
      .filter((failure) => failure.taskId === taskId) ?? [];
  }

  private pauseForUncertainty(
    taskId: string,
    boundary: UncertainEffectBoundary,
    operation: string,
    reason: string,
    workspace: { readonly path: string; readonly branch: string | null } | null,
  ): TaskView {
    return this.tasks.pauseForUncertainEffect(taskId, uncertainEffectPayload({
      boundary,
      operation,
      reason,
      requestedBy: "zentra-recovery-controller",
      workspace,
    }));
  }
}

function artifactPath(kind: ArtifactKind): string {
  return {
    patch: "artifacts/patch.diff",
    validation_report: "artifacts/focused-validation.json",
    review_report: "artifacts/review-decision.json",
    integration_receipt: "artifacts/integration-receipt.json",
  }[kind];
}

function signalOutcome(signal: AbortSignal): "cancelled" | "timed_out" | null {
  if (!signal.aborted) return null;
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timed_out"
    : "cancelled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name !== "" ? error.name : "Error";
}

function payloadReason(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const reason = (payload as Readonly<Record<string, unknown>>)["reason"];
    if (typeof reason === "string" && reason !== "") return reason;
    const error = (payload as Readonly<Record<string, unknown>>)["error"];
    if (typeof error === "object" && error !== null) {
      const message = (error as Readonly<Record<string, unknown>>)["message"];
      if (typeof message === "string" && message !== "") return message;
    }
  }
  return "integration result requires explicit reconciliation";
}

function singleOwnedFile(task: PlannedTask, schedulerAdmitted: boolean): string {
  const parsed = PlannedTaskSchema.parse(task);
  if (
    (!schedulerAdmitted && parsed.dependencies.length !== 0) ||
    parsed.ownedPaths.length !== 1 ||
    parsed.ownedPaths[0]!.endsWith("/**") ||
    parsed.budget.maxRetries !== 0
  ) {
    throw new Error("OpenCode single-file tracer requires one concrete owned file, scheduler admission for dependencies, and no retries");
  }
  return parsed.ownedPaths[0]!;
}

function assertWriterAdmission(request: OpenCodeSingleFileTracerRequest, changedPath: string): void {
  const task = PlannedTaskSchema.parse(request.task);
  if (task.roleAssignment.role !== "implementer" || task.roleAssignment.harness !== "opencode" ||
    task.roleAssignment.agentId !== request.model.id || task.risk.authority !== "workspace_write" ||
    request.model.harness !== "opencode" || !request.model.roles.includes("implementer") ||
    !request.model.toolPermissions.includes("read_repository") || !request.model.toolPermissions.includes("write_worktree") ||
    request.model.toolPermissions.some((tool) => tool !== "read_repository" && tool !== "write_worktree") ||
    request.model.network !== "denied" || request.model.contextTokens < task.budget.maxInputTokens + task.budget.maxOutputTokens ||
    !request.security.allowedRepositories.includes(request.project.repositoryPath) ||
    !request.security.allowedFileScopes.some((scope) => scope === changedPath || scope === "**" || (scope.endsWith("/**") && changedPath.startsWith(scope.slice(0, -3) + "/"))) ||
    request.security.forbiddenPaths.some((scope) => scope === changedPath || (scope.endsWith("/**") && changedPath.startsWith(scope.slice(0, -3) + "/")))) {
    throw new Error("OpenCode writer request is outside its exact durable admission");
  }
  if (!isVerifiedOpenCodeProbeReport(request.probe, {
    modelId: request.model.id, model: request.model.model,
    provider: request.model.model.replace(/\/.*/, ""), cwd: request.project.repositoryPath,
  })) throw new Error("OpenCode single-file tracer requires a verified capability probe");
}

function assertSingleChange(result: WriterCapsuleResult, expectedPath: string): void {
  if (
    result.lease === null ||
    result.ownership?.outcome !== "accepted" ||
    result.ownership.changedPaths.length !== 1 ||
    result.ownership.changedPaths[0] !== expectedPath
  ) {
    throw new Error("OpenCode writer did not produce exactly the assigned single-file change");
  }
}

function assertValidationEvidence(
  validation: ValidationReport,
  request: OpenCodeSingleFileTracerRequest,
  lease: WorkspaceLease,
  invocationId: string,
  subjectSha256: string,
): void {
  if (
    validation.name !== "focused" ||
    JSON.stringify(validation.command) !== JSON.stringify(request.project.validations.focused) ||
    !isVerifiedValidationReport(validation, {
      invocationId,
      canonicalCwd: lease.path,
      subjectSha256,
    })
  ) {
    throw new Error("focused validation evidence is not bound to the writer change");
  }
}

function writerSummary(report: NonNullable<WriterCapsuleResult["writer"]>): object {
  return {
    workerId: report.modelId,
    harness: "opencode",
    outcome: report.outcome,
    exitCode: report.exitCode,
    executable: report.executable,
    requestedModelSha256: report.requestedModelSha256,
    argv: report.argv,
    cwd: report.cwd,
    packetSha256: report.packetSha256,
    networkBoundary: report.networkBoundary,
    stdoutSha256: report.stdoutSha256,
    stderrSha256: report.stderrSha256,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    deniedToolRequests: report.deniedToolRequests,
  };
}
