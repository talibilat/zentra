import type {
  OpenCodeReadOnlyProgram,
  OpenCodeReadOnlyProgramRequest,
} from "../agents/opencode-read-only-program.js";
import type { TerminalOutcome } from "../contracts/task.js";
import type { MilestoneRecord, MilestoneRegistry } from "../milestones/milestone-registry.js";
import type {
  MultiWriterOwnershipScheduler,
  MultiWriterScheduleRequest,
} from "./multi-writer-scheduler.js";
import type { WriterResourceGovernor } from "./writer-resource-governor.js";

export interface ScheduledReadOnlyTask {
  readonly taskId: string;
  readonly request: OpenCodeReadOnlyProgramRequest;
}

export interface MultiAgentMilestoneRequest {
  readonly milestoneId: string;
  readonly readOnlyTasks: readonly ScheduledReadOnlyTask[];
  readonly writerSchedule: MultiWriterScheduleRequest;
}

export class MultiAgentMilestoneCoordinator {
  constructor(
    private readonly milestones: MilestoneRegistry,
    private readonly readOnly: Pick<OpenCodeReadOnlyProgram, "run">,
    private readonly writers: Pick<MultiWriterOwnershipScheduler, "run">,
  ) {}

  usesWriterGovernor(governor: WriterResourceGovernor): boolean {
    return "usesGovernor" in this.writers &&
      typeof this.writers.usesGovernor === "function" &&
      this.writers.usesGovernor(governor);
  }

  inspectIdentity(milestoneId: string): { readonly projectId: string; readonly traceId: string } {
    const milestone = this.requireMilestone(milestoneId);
    return Object.freeze({ projectId: milestone.projectId, traceId: milestone.traceId });
  }

  async run(request: MultiAgentMilestoneRequest): Promise<MilestoneRecord> {
    if (request.writerSchedule.milestoneId !== undefined &&
      request.writerSchedule.milestoneId !== request.milestoneId) {
      throw new Error("writer schedule belongs to another milestone");
    }
    const configured = new Map(request.readOnlyTasks.map((item) => [item.taskId, item] as const));
    if (configured.size !== request.readOnlyTasks.length) throw new Error("read-only task identities must be unique");

    while (configured.size > 0) {
      const milestone = this.requireMilestone(request.milestoneId);
      if (milestone.lifecycle === "paused" || milestone.lifecycle === "terminal" ||
        milestone.hasActiveEffects || milestone.hasUncertainEffects ||
        [...configured.keys()].some((taskId) => milestone.tasks[taskId]?.status === "running")) {
        return milestone;
      }
      if (milestone.hasTraceFailure) return this.milestones.finishFromEvidence(request.milestoneId, "failed");
      const durableNonSuccess = firstNonSuccess(milestone);
      if (durableNonSuccess !== null) {
        return this.milestones.finishFromEvidence(request.milestoneId, durableNonSuccess);
      }
      for (const taskId of [...configured.keys()]) {
        if (milestone.tasks[taskId]?.status === "completed") configured.delete(taskId);
      }
      if (configured.size === 0) break;
      const task = milestone.plan!.tasks.find((task) => {
        if (!configured.has(task.taskId) || (task.roleAssignment.role !== "planner" && task.roleAssignment.role !== "researcher")) {
          return false;
        }
        return task.dependencies.every((dependency) => milestone.tasks[dependency]?.terminalOutcome === "completed");
      });
      if (task === undefined) return milestone;
      const scheduled = configured.get(task.taskId)!;
      if (scheduled.request.taskId !== task.taskId || scheduled.request.milestoneId !== request.milestoneId ||
        scheduled.request.role !== task.roleAssignment.role) {
        throw new Error(`read-only execution contradicts planned task ${task.taskId}`);
      }
      let result;
      try {
        result = await this.readOnly.run(scheduled.request);
      } catch (error) {
        const durable = this.requireMilestone(request.milestoneId);
        if (durable.hasActiveEffects || durable.hasUncertainEffects ||
          durable.tasks[task.taskId]?.status === "running" || durable.tasks[task.taskId]?.status === "completed") {
          return durable;
        }
        throw error;
      }
      if (result.status === "paused") return this.requireMilestone(request.milestoneId);
      configured.delete(task.taskId);
      if (result.operationOutcome !== "completed") {
        if (result.outcome === "completed") {
          const durable = this.requireMilestone(request.milestoneId);
          return durable.hasTraceFailure
            ? this.milestones.finishFromEvidence(request.milestoneId, "failed")
            : durable;
        }
        return this.milestones.finishFromEvidence(request.milestoneId, result.outcome);
      }
    }

    let milestone = await this.writers.run({ ...request.writerSchedule, milestoneId: request.milestoneId });
    if (milestone.lifecycle === "paused" || milestone.lifecycle === "terminal" ||
      milestone.hasActiveEffects || milestone.hasUncertainEffects ||
      Object.values(milestone.writerOwnership).some((ownership) => ownership.status === "claimed")) {
      return milestone;
    }
    const terminal = firstNonSuccess(milestone);
    if (terminal !== null) return this.milestones.finishFromEvidence(request.milestoneId, terminal);
    if (milestone.plan!.tasks.every((task) => milestone.tasks[task.taskId]?.terminalOutcome === "completed")) {
      milestone = this.milestones.completeFromEvidence(request.milestoneId);
    }
    return milestone;
  }

  private requireMilestone(milestoneId: string): MilestoneRecord {
    const milestone = this.milestones.inspect(milestoneId);
    if (milestone === null || milestone.plan === null) throw new Error(`milestone ${milestoneId} requires an accepted plan`);
    return milestone;
  }
}

function firstNonSuccess(milestone: MilestoneRecord): Exclude<TerminalOutcome, "completed"> | null {
  for (const task of milestone.plan?.tasks ?? []) {
    const outcome = milestone.tasks[task.taskId]?.terminalOutcome;
    if (outcome !== null && outcome !== undefined && outcome !== "completed") return outcome;
  }
  return null;
}
