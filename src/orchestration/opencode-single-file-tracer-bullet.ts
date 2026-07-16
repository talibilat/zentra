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
  type PatchArtifactEvidence,
} from "../contracts/artifact.js";
import { PlannedTaskSchema, type PlannedTask } from "../contracts/milestone.js";
import {
  isVerifiedOpenCodeProbeReport,
  type OpenCodeProbeReport,
} from "../harnesses/opencode-probe.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { TaskService } from "../tasks/task-service.js";
import type { TaskView } from "../tasks/task-projection.js";
import type { WorkspaceLease, WorktreeManager } from "../workspaces/worktree-manager.js";
import {
  WorkspaceCreationUncertainError,
  WorkspaceGitTerminationError,
} from "../workspaces/worktree-manager.js";
import type {
  WriterCapsuleResult,
  WriterWorktreeCapsule,
} from "./writer-worktree-capsule.js";

export interface OpenCodeSingleFileTracerRequest {
  readonly project: ProjectConfig;
  readonly task: PlannedTask;
  readonly model: ModelCapability;
  readonly security: SecuritySheet;
  readonly probe: OpenCodeProbeReport;
  readonly signal: AbortSignal;
}

export class OpenCodeSingleFileTracerBullet {
  constructor(
    private readonly tasks: TaskService,
    private readonly capsule: WriterWorktreeCapsule,
    private readonly validations: ValidationRunner,
    private readonly worktrees: WorktreeManager,
  ) {}

  async run(request: OpenCodeSingleFileTracerRequest): Promise<TaskView> {
    const changedPath = singleOwnedFile(request.task);
    if (!isVerifiedOpenCodeProbeReport(request.probe, {
      modelId: request.model.id,
      model: request.model.model,
      provider: request.model.model.replace(/\/.*/, ""),
      cwd: request.project.repositoryPath,
    })) {
      throw new Error("OpenCode single-file tracer requires a verified capability probe");
    }
    this.tasks.create({
      taskId: request.task.taskId,
      projectId: request.project.projectId,
      title: request.task.title,
      correlationId: request.task.taskId,
    });

    let observedWorkspace: string | null = null;
    let capsule: WriterCapsuleResult;
    try {
      capsule = await this.capsule.run({
        ...request,
        executable: request.probe.executable!,
        executableSha256: request.probe.executableSha256!,
        observer: {
          onWorktreeCreationStarted: (intent) => {
            this.tasks.append(request.task.taskId, "task.worktree_creation_started", intent, null);
          },
          onLeaseCreated: ({ lease: createdLease, baseCommit }) => {
            observedWorkspace = createdLease.path;
            this.tasks.append(request.task.taskId, "task.leased", {
              leaseOwner: request.model.id,
              workspace: createdLease.path,
            }, null);
            void baseCommit;
          },
          onWriterStarted: ({ lease: writerLease }) => {
            this.tasks.append(request.task.taskId, "task.started", {
              workerId: request.model.id,
            }, null);
            void writerLease;
          },
          onWriterCompleted: (report) => {
            this.tasks.append(request.task.taskId, "task.writer_completed", writerSummary(report), null);
          },
        },
      });
    } catch (error) {
      if (
        error instanceof WorkspaceCreationUncertainError ||
        error instanceof WorkspaceGitTerminationError
      ) throw error;
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "writer",
        reason: error instanceof Error ? error.message : String(error),
        workspace: observedWorkspace,
      }, null);
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
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "artifact",
        reason: error instanceof Error ? error.message : String(error),
        workspace: lease.path,
      }, null);
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
      assertValidationEvidence(validation, request, lease, invocationId, diffSha256);
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "validation",
        reason: error instanceof Error ? error.message : String(error),
        workspace: lease.path,
      }, null);
    }
    try {
      this.recordArtifact(request.task.taskId, "validation_report", validation, {
        type: "task.validation_completed",
        payload: { outcome: validation.outcome, validation, diffSha256 },
      });
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "validation",
        reason: error instanceof Error ? error.message : String(error),
        workspace: lease.path,
      }, null);
    }
    let postValidation;
    try {
      postValidation = await this.worktrees.inspect(lease, { signal: request.signal });
    } catch (error) {
      return this.tasks.append(request.task.taskId, "task.failed", {
        stage: "validation",
        reason: error instanceof Error ? error.message : String(error),
        validation,
        workspace: lease.path,
      }, null);
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
    return this.tasks.append(request.task.taskId, `task.${terminal}`, {
      stage: "validation",
      validation,
      diffSha256,
      changedPath,
      workspace: lease.path,
    }, null);
  }

  private recordArtifact(
    taskId: string,
    kind: "patch" | "validation_report",
    evidence: unknown,
    following: { readonly type: string; readonly payload: unknown },
  ): void {
    const sha256 = artifactEvidenceSha256(kind, evidence);
    const artifact = {
      artifactId: randomUUID(),
      taskId,
      kind,
      path: kind === "patch" ? "artifacts/patch.diff" : "artifacts/focused-validation.json",
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
        payload: { artifact, evidence },
        causationId: null,
      },
      { ...following, causationId: null },
    ]);
  }
}

function singleOwnedFile(task: PlannedTask): string {
  const parsed = PlannedTaskSchema.parse(task);
  if (
    parsed.dependencies.length !== 0 ||
    parsed.ownedPaths.length !== 1 ||
    parsed.ownedPaths[0]!.endsWith("/**") ||
    parsed.budget.maxRetries !== 0
  ) {
    throw new Error("OpenCode single-file tracer requires one concrete independent owned file and no retries");
  }
  return parsed.ownedPaths[0]!;
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
    model: report.model,
    provider: report.provider,
    argv: report.argv,
    cwd: report.cwd,
    packetSha256: report.packetSha256,
    stdoutSha256: report.stdoutSha256,
    stderrSha256: report.stderrSha256,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  };
}
