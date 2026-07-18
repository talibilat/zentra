import type { OpenCodeTaskAdmissionContext } from "../contracts/authority-attention.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { MilestoneRecord, MilestoneRegistry } from "../milestones/milestone-registry.js";
import type { ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { TaskView } from "../tasks/task-projection.js";
import type {
  OpenCodeIntegratedSingleFileTracerRequest,
  ValidatedChangeHandoff,
} from "./opencode-single-file-tracer-bullet.js";

export interface TwoAgentExecutionRequest extends OpenCodeIntegratedSingleFileTracerRequest {
  readonly correlationId: string;
  readonly onReviewReady: (handoff: ValidatedChangeHandoff) => Promise<void>;
}

export interface TwoAgentExecution {
  run(request: TwoAgentExecutionRequest): Promise<TaskView>;
  resumeValidatedHandoff?(request: TwoAgentExecutionRequest): Promise<TaskView>;
}

export interface TwoAgentMilestoneRequest {
  readonly milestoneId: string;
  readonly writerTaskId: string;
  readonly reviewerTaskId: string;
  readonly security: SecuritySheet;
  readonly modelSheet?: ModelSheet;
  readonly writerAdmission: OpenCodeTaskAdmissionContext;
  readonly reviewerAdmission: OpenCodeTaskAdmissionContext;
  readonly execution: OpenCodeIntegratedSingleFileTracerRequest;
}

export class TwoAgentMilestoneCoordinator {
  constructor(
    private readonly milestones: MilestoneRegistry,
    private readonly execution: TwoAgentExecution,
  ) {}

  async run(request: TwoAgentMilestoneRequest): Promise<MilestoneRecord> {
    const milestone = this.milestones.inspect(request.milestoneId);
    if (milestone === null || milestone.plan === null) {
      throw new Error(`milestone ${request.milestoneId} requires an accepted plan`);
    }
    const writer = milestone.plan.tasks.find((task) => task.taskId === request.writerTaskId);
    const reviewer = milestone.plan.tasks.find((task) => task.taskId === request.reviewerTaskId);
    if (
      writer?.roleAssignment.role !== "implementer" ||
      reviewer?.roleAssignment.role !== "reviewer" ||
      !reviewer.dependencies.includes(writer.taskId) ||
      request.execution.task.taskId !== writer.taskId ||
      request.execution.reviewerId !== reviewer.roleAssignment.agentId
    ) {
      throw new Error("two-agent milestone requires an implementer followed by its assigned reviewer");
    }
    const writerState = milestone.tasks[writer.taskId];
    const reviewerState = milestone.tasks[reviewer.taskId];
    if (
      writerState?.status === "completed" &&
      (reviewerState?.status === "running" || reviewerState?.status === "completed")
    ) {
      try {
        return this.milestones.completeIntegrated(request.milestoneId, writer.taskId);
      } catch {
        return milestone;
      }
    }
    if (
      milestone.lifecycle === "paused" || milestone.lifecycle === "terminal" ||
      writerState?.status === "running" || writerState?.status === "completed" ||
      reviewerState?.status !== "planned"
    ) return milestone;

    const writerAdmission = this.milestones.admitTask(
      request.milestoneId,
      writer.taskId,
      request.security,
      request.writerAdmission,
      request.modelSheet,
    );
    if (writerAdmission.status !== "admitted") return writerAdmission.milestone;
    assertTwoAgentExecutionBinding(request, milestone, writer, reviewer, writerAdmission.admission.packet);
    this.milestones.startTask(
      request.milestoneId,
      writer.taskId,
      writer.roleAssignment.agentId,
      writer.roleAssignment.role,
    );

    let writerCompleted = false;
    let reviewerStarted = false;
    const result = await this.execution.run({
      ...request.execution,
      correlationId: milestone.traceId,
      parentMilestoneId: request.milestoneId,
      onReviewReady: async (handoff) => {
        if (handoff.taskStreamId !== writer.taskId) {
          throw new Error("validated change handoff contradicts the writer task");
        }
        this.milestones.completeTask(request.milestoneId, writer.taskId, "completed", {
          taskStreamId: handoff.taskStreamId,
          diffSha256: handoff.diffSha256,
          validation: handoff.validation,
        });
        writerCompleted = true;
        const admission = this.milestones.admitTask(
          request.milestoneId,
          reviewer.taskId,
          request.security,
          request.reviewerAdmission,
          request.modelSheet,
        );
        if (admission.status !== "admitted") throw new Error("reviewer admission paused the milestone");
        this.milestones.startTask(
          request.milestoneId,
          reviewer.taskId,
          reviewer.roleAssignment.agentId,
          reviewer.roleAssignment.role,
        );
        reviewerStarted = true;
      },
    });

    if (result.terminalOutcome === null) return this.milestones.inspect(request.milestoneId)!;
    const outcome = result.terminalOutcome;
    if (!reviewerStarted) {
      const current = this.milestones.inspect(request.milestoneId)!;
      if (current.lifecycle === "paused" || writerCompleted) return current;
      if (outcome === "completed") throw new Error("completed writer result lacks its review handoff");
      this.milestones.completeTask(request.milestoneId, writer.taskId, outcome, { taskStreamId: result.taskId });
      return this.milestones.finishFromEvidence(request.milestoneId, outcome);
    }
    this.milestones.completeTask(request.milestoneId, reviewer.taskId, outcome, {
      taskStreamId: result.taskId,
      verifiedLocalIntegration: outcome === "completed",
    });
    return outcome === "completed"
      ? this.milestones.completeIntegrated(request.milestoneId, result.taskId)
      : this.milestones.finishFromEvidence(request.milestoneId, outcome);
  }
}

export function assertTwoAgentExecutionBinding(
  request: TwoAgentMilestoneRequest,
  milestone: MilestoneRecord,
  writer: NonNullable<MilestoneRecord["plan"]>["tasks"][number],
  reviewer: NonNullable<MilestoneRecord["plan"]>["tasks"][number],
  packet: { readonly repository: string; readonly actorId: string; readonly capabilityId: string; readonly transportModelId: string },
): void {
  const execution = request.execution;
  if (
    digestCanonical(execution.task) !== digestCanonical(writer) ||
    digestCanonical(execution.security) !== digestCanonical(request.security) ||
    execution.project.projectId !== milestone.projectId ||
    execution.project.repositoryPath !== packet.repository ||
    execution.model.id !== packet.actorId ||
    execution.model.id !== packet.capabilityId ||
    execution.model.model !== packet.transportModelId ||
    digestCanonical([...execution.model.roles].sort()) !== digestCanonical([...request.writerAdmission.roles].sort()) ||
    digestCanonical([...execution.model.toolPermissions].sort()) !== digestCanonical([...request.writerAdmission.toolPermissions].sort()) ||
    execution.model.network !== request.writerAdmission.network ||
    execution.model.contextTokens !== request.writerAdmission.contextTokens ||
    execution.reviewerId !== reviewer.roleAssignment.agentId ||
    request.writerAdmission.repositoryPath !== execution.project.repositoryPath ||
    request.reviewerAdmission.repositoryPath !== execution.project.repositoryPath ||
    request.reviewerAdmission.actorId !== reviewer.roleAssignment.agentId ||
    request.reviewerAdmission.role !== reviewer.roleAssignment.role ||
    request.reviewerAdmission.authority !== reviewer.risk.authority
  ) throw new Error("two-agent execution contradicts its admitted plan or authority");
}
