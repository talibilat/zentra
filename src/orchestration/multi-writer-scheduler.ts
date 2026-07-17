import { randomUUID } from "node:crypto";

import type { OpenCodeTaskAdmissionContext } from "../contracts/authority-attention.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { PlannedTask } from "../contracts/milestone.js";
import type { MilestoneRecord, MilestoneRegistry } from "../milestones/milestone-registry.js";
import { logicalPathSetsOverlap } from "../milestones/path-ownership.js";
import type { ModelCapability, ModelSheet } from "../policy/model-sheet.js";
import type { SecuritySheet } from "../policy/security-sheet.js";
import type { TaskView } from "../tasks/task-projection.js";
import {
  authorizeScheduledTracerRequest,
  type OpenCodeIntegratedSingleFileTracerRequest,
  type ValidatedChangeHandoff,
} from "./opencode-single-file-tracer-bullet.js";
import {
  assertTwoAgentExecutionBinding,
  type TwoAgentExecution,
} from "./two-agent-milestone.js";
import {
  WriterResourceGovernor,
  type WriterResourcePermit,
  type WriterResourceRequest,
} from "./writer-resource-governor.js";

export interface ScheduledWriterTask {
  readonly writerTaskId: string;
  readonly reviewerTaskId: string;
  readonly writerAdmission: OpenCodeTaskAdmissionContext;
  readonly reviewerAdmission: OpenCodeTaskAdmissionContext;
  readonly execution: OpenCodeIntegratedSingleFileTracerRequest;
}

export interface MultiWriterScheduleRequest {
  readonly milestoneId: string;
  readonly maxConcurrentWriters: number;
  readonly security: SecuritySheet;
  readonly modelSheet: ModelSheet;
  readonly tasks: readonly ScheduledWriterTask[];
}

export class MultiWriterOwnershipScheduler {
  constructor(
    private readonly milestones: MilestoneRegistry,
    private readonly execution: TwoAgentExecution,
    private readonly governor?: WriterResourceGovernor,
  ) {}

  usesGovernor(governor: WriterResourceGovernor): boolean {
    return this.governor === governor;
  }

  async run(request: MultiWriterScheduleRequest): Promise<MilestoneRecord> {
    if (!Number.isSafeInteger(request.maxConcurrentWriters) || request.maxConcurrentWriters <= 0) {
      throw new Error("maxConcurrentWriters must be a positive integer");
    }
    const pending = new Map(request.tasks.map((task) => [task.writerTaskId, task] as const));
    if (pending.size !== request.tasks.length) throw new Error("scheduled writer task identities must be unique");
    const governor = this.governor ?? new WriterResourceGovernor(request.maxConcurrentWriters);
    if (request.maxConcurrentWriters > governor.maxConcurrentWriters) {
      throw new Error("milestone writer capacity exceeds shared global writer capacity");
    }

    while (pending.size > 0) {
      let milestone = this.requireMilestone(request.milestoneId);
      if (milestone.lifecycle === "paused" || milestone.lifecycle === "terminal") return milestone;
      if (milestone.maxConcurrentWriters !== null && milestone.maxConcurrentWriters !== request.maxConcurrentWriters) {
        throw new Error("schedule changes the durable global writer capacity");
      }
      let reconciled = false;
      for (const scheduled of [...pending.values()]) {
        const ownership = milestone.writerOwnership[scheduled.writerTaskId];
        if (ownership?.status === "integrated" || ownership?.status === "released") {
          assertClaimBinding(scheduled, milestone, request.modelSheet, ownership);
          governor.release(resourceRequest(request, milestone, scheduled));
          pending.delete(scheduled.writerTaskId);
          reconciled = true;
          continue;
        }
        if (ownership?.status !== "claimed") continue;
        assertClaimBinding(scheduled, milestone, request.modelSheet, ownership);
        const linked = this.milestones.inspectWriterTask(request.milestoneId, scheduled.writerTaskId);
        if (linked?.terminalOutcome === "completed") {
          try {
            this.reconcileCompletedWriter(request, scheduled, milestone);
          } finally {
            governor.release(resourceRequest(request, milestone, scheduled));
          }
          pending.delete(scheduled.writerTaskId);
          milestone = this.requireMilestone(request.milestoneId);
          reconciled = true;
        } else if (linked?.terminalOutcome !== null && linked?.terminalOutcome !== undefined) {
          try {
            this.milestones.releaseTerminalWriter(request.milestoneId, scheduled.writerTaskId);
          } finally {
            governor.release(resourceRequest(request, milestone, scheduled));
          }
          pending.delete(scheduled.writerTaskId);
          milestone = this.requireMilestone(request.milestoneId);
          reconciled = true;
        } else if (linked !== null || milestone.tasks[scheduled.writerTaskId]?.status === "running") {
          return milestone;
        }
      }
      if (reconciled) continue;

      milestone = this.requireMilestone(request.milestoneId);
      const claimed = [...pending.values()].filter((scheduled) =>
        milestone.writerOwnership[scheduled.writerTaskId]?.status === "claimed");
      const resumeBatchId = claimed[0] === undefined
        ? null
        : milestone.writerOwnership[claimed[0].writerTaskId]!.batchId;
      const wave = resumeBatchId === null
        ? selectWave(milestone, [...pending.values()], request.modelSheet, request.maxConcurrentWriters)
        : claimed.filter((scheduled) =>
          milestone.writerOwnership[scheduled.writerTaskId]?.batchId === resumeBatchId &&
          milestone.tasks[scheduled.writerTaskId]?.status === "ready");
      if (wave.length === 0) return milestone;

      const resources = wave.map((scheduled) => resourceRequest(request, milestone, scheduled));
      const waveSignal = AbortSignal.any(wave.map((scheduled) => scheduled.execution.signal));
      const permit = resumeBatchId === null
        ? await governor.acquire(resources, waveSignal)
        : governor.recoverIfActive(resources) ?? await governor.acquire(resources, waveSignal);

      if (waveSignal.aborted) {
        releaseWave(permit, request.milestoneId, wave);
        throw new DOMException("writer wave was aborted before effects", "AbortError");
      }

      milestone = this.requireMilestone(request.milestoneId);
      if (!wave.every((scheduled) => isStillRunnable(milestone, scheduled, resumeBatchId))) {
        releaseWave(permit, request.milestoneId, wave);
        return milestone;
      }

      let admitted;
      try {
        admitted = wave.map((scheduled) => {
          const writer = plannedTask(milestone, scheduled.writerTaskId, "implementer");
          const reviewer = plannedTask(milestone, scheduled.reviewerTaskId, "reviewer");
          const model = exactModel(request.modelSheet, writer.roleAssignment.agentId);
          assertSelectedModelCapability(scheduled.execution.model, model, scheduled.writerAdmission);
          const reviewerModel = exactModel(request.modelSheet, reviewer.roleAssignment.agentId);
          assertAdmissionCapability(scheduled.reviewerAdmission, reviewerModel);
          const admission = this.milestones.admitTask(
            request.milestoneId,
            writer.taskId,
            request.security,
            scheduled.writerAdmission,
            request.modelSheet,
          );
          if (admission.status !== "admitted") return null;
          assertTwoAgentExecutionBinding(
            { ...scheduled, milestoneId: request.milestoneId, security: request.security, modelSheet: request.modelSheet } as never,
            milestone,
            writer,
            reviewer,
            admission.admission.packet,
          );
          return { scheduled, writer, reviewer, model };
        });
      } catch (error) {
        releaseWave(permit, request.milestoneId, wave);
        throw error;
      }
      if (admitted.some((item) => item === null)) {
        releaseWave(permit, request.milestoneId, wave);
        return this.requireMilestone(request.milestoneId);
      }
      const runnable = admitted as readonly NonNullable<(typeof admitted)[number]>[];
      try {
        if (resumeBatchId === null) {
          const batchId = randomUUID();
          this.milestones.startWriterBatch(request.milestoneId, {
            batchId,
            maxConcurrentWriters: request.maxConcurrentWriters,
            writers: runnable.map(({ writer, reviewer, model }) => ({
              writerTaskId: writer.taskId,
              reviewerTaskId: reviewer.taskId,
              actorId: writer.roleAssignment.agentId,
              capabilityId: model.id,
              transportModelId: model.model,
              harness: model.harness as "opencode" | "claude_code" | "codex" | "deterministic",
              roles: model.roles as ("planner" | "researcher" | "implementer" | "validator" | "reviewer" | "integrator" | "verifier")[],
              toolPermissions: [...model.toolPermissions],
              network: model.network,
              contextTokens: model.contextTokens,
              modelCapabilityDigest: digestCanonical(model),
              ownedPaths: writer.ownedPaths,
              modelMaxConcurrency: model.maxConcurrency,
            })),
          });
        }
        for (const { writer } of runnable) {
          this.milestones.startTask(request.milestoneId, writer.taskId, writer.roleAssignment.agentId, "implementer");
        }
      } catch (error) {
        releaseWave(permit, request.milestoneId, wave);
        throw error;
      }

      const barrier = new WaveBarrier(runnable.length);
      const settled = await Promise.allSettled(runnable.map(async ({ scheduled, writer, reviewer }, index) => {
        let writerCompleted = false;
        let reviewerStarted = false;
        const executionRequest = authorizeScheduledTracerRequest({
          ...scheduled.execution,
          correlationId: milestone.traceId,
          onReviewReady: async (handoff: ValidatedChangeHandoff) => {
            if (handoff.taskStreamId !== writer.taskId) throw new Error("validated handoff contradicts its writer claim");
            this.milestones.completeTask(request.milestoneId, writer.taskId, "completed", { ...handoff });
            writerCompleted = true;
            permit.release(resourceWriterId(request.milestoneId, writer.taskId));
            const reviewAdmission = this.milestones.admitTask(
              request.milestoneId,
              reviewer.taskId,
              request.security,
              scheduled.reviewerAdmission,
              request.modelSheet,
            );
            if (reviewAdmission.status !== "admitted") throw new Error("reviewer admission paused the milestone");
            this.milestones.startTask(request.milestoneId, reviewer.taskId, reviewer.roleAssignment.agentId, "reviewer");
            reviewerStarted = true;
            await barrier.arrive(index);
          },
        });
        let result: TaskView;
        try {
          result = await this.execution.run(executionRequest);
        } finally {
          barrier.settle(index);
        }
        if (result.terminalOutcome === "completed") {
          this.milestones.completeWriterIntegration(request.milestoneId, writer.taskId);
          return;
        }
        if (!writerCompleted && result.terminalOutcome !== null) {
          this.milestones.completeTask(request.milestoneId, writer.taskId, result.terminalOutcome, { taskStreamId: result.taskId });
          this.milestones.releaseTerminalWriter(request.milestoneId, writer.taskId);
          permit.release(resourceWriterId(request.milestoneId, writer.taskId));
        } else if (reviewerStarted && result.terminalOutcome !== null) {
          this.milestones.completeTask(request.milestoneId, reviewer.taskId, result.terminalOutcome, { taskStreamId: result.taskId });
          this.milestones.releaseTerminalWriter(request.milestoneId, writer.taskId);
        }
      }));
      for (let index = 0; index < settled.length; index += 1) {
        const rejected = settled[index];
        if (rejected?.status !== "rejected") continue;
        const writer = runnable[index]!.writer;
        const scheduled = runnable[index]!.scheduled;
        const linked = this.milestones.inspectWriterTask(request.milestoneId, writer.taskId);
        if (linked?.terminalOutcome === "completed") {
          try {
            this.reconcileCompletedWriter(request, scheduled, this.requireMilestone(request.milestoneId));
          } finally {
            permit.release(resourceWriterId(request.milestoneId, writer.taskId));
          }
        } else if (linked?.terminalOutcome !== null && linked?.terminalOutcome !== undefined) {
          try {
            this.milestones.completeTask(request.milestoneId, writer.taskId, linked.terminalOutcome, {
              taskStreamId: linked.taskId,
            });
            this.milestones.releaseTerminalWriter(request.milestoneId, writer.taskId);
          } finally {
            permit.release(resourceWriterId(request.milestoneId, writer.taskId));
          }
        }
      }
      const reconciledWave = this.requireMilestone(request.milestoneId);
      if (
        settled.some((result) => result.status === "rejected") ||
        runnable.some(({ writer }) => reconciledWave.writerOwnership[writer.taskId]?.status === "claimed")
      ) return reconciledWave;
      for (const { writer } of runnable) pending.delete(writer.taskId);
    }
    return this.requireMilestone(request.milestoneId);
  }

  private requireMilestone(milestoneId: string): MilestoneRecord {
    const milestone = this.milestones.inspect(milestoneId);
    if (milestone === null || milestone.plan === null) throw new Error(`milestone ${milestoneId} requires an accepted plan`);
    return milestone;
  }

  private reconcileCompletedWriter(
    request: MultiWriterScheduleRequest,
    scheduled: ScheduledWriterTask,
    milestone: MilestoneRecord,
  ): void {
    const writer = plannedTask(milestone, scheduled.writerTaskId, "implementer");
    const reviewer = plannedTask(milestone, scheduled.reviewerTaskId, "reviewer");
    const writerState = milestone.tasks[writer.taskId];
    if (writerState?.status === "ready") {
      this.milestones.startTask(request.milestoneId, writer.taskId, writer.roleAssignment.agentId, "implementer");
    }
    const refreshedWriter = this.requireMilestone(request.milestoneId).tasks[writer.taskId];
    if (refreshedWriter?.status === "running") {
      this.milestones.completeTask(request.milestoneId, writer.taskId, "completed", {
        taskStreamId: writer.taskId,
        reconciliation: "completed_task_stream",
      });
    } else if (refreshedWriter?.terminalOutcome !== "completed") {
      throw new Error(`completed writer stream contradicts milestone task ${writer.taskId}`);
    }
    let current = this.requireMilestone(request.milestoneId);
    if (current.tasks[reviewer.taskId]?.status === "planned" || current.tasks[reviewer.taskId]?.status === "blocked") {
      const admission = this.milestones.admitTask(
        request.milestoneId,
        reviewer.taskId,
        request.security,
        scheduled.reviewerAdmission,
        request.modelSheet,
      );
      if (admission.status !== "admitted") throw new Error("reviewer reconciliation paused the milestone");
      current = admission.milestone;
    }
    if (current.tasks[reviewer.taskId]?.status === "ready") {
      this.milestones.startTask(request.milestoneId, reviewer.taskId, reviewer.roleAssignment.agentId, "reviewer");
    }
    this.milestones.completeWriterIntegration(request.milestoneId, writer.taskId);
  }
}

function isStillRunnable(
  milestone: MilestoneRecord,
  scheduled: ScheduledWriterTask,
  resumeBatchId: string | null,
): boolean {
  const state = milestone.tasks[scheduled.writerTaskId];
  if (resumeBatchId === null) {
    return milestone.writerOwnership[scheduled.writerTaskId] === undefined &&
      (state?.status === "planned" || state?.status === "ready") &&
      plannedTask(milestone, scheduled.writerTaskId, "implementer").dependencies.every((dependency) =>
        milestone.tasks[dependency]?.terminalOutcome === "completed");
  }
  const ownership = milestone.writerOwnership[scheduled.writerTaskId];
  return ownership?.status === "claimed" && ownership.batchId === resumeBatchId && state?.status === "ready";
}

function resourceWriterId(milestoneId: string, writerTaskId: string): string {
  return `${milestoneId}\u0000${writerTaskId}`;
}

function resourceRequest(
  request: MultiWriterScheduleRequest,
  milestone: MilestoneRecord,
  scheduled: ScheduledWriterTask,
): WriterResourceRequest {
  const writer = plannedTask(milestone, scheduled.writerTaskId, "implementer");
  const model = exactModel(request.modelSheet, writer.roleAssignment.agentId);
  return {
    writerId: resourceWriterId(request.milestoneId, writer.taskId),
    capabilityId: model.id,
    capabilityDigest: digestCanonical(model),
    maxConcurrency: model.maxConcurrency,
  };
}

function releaseWave(
  permit: WriterResourcePermit,
  milestoneId: string,
  wave: readonly ScheduledWriterTask[],
): void {
  for (const scheduled of wave) permit.release(resourceWriterId(milestoneId, scheduled.writerTaskId));
}

function selectWave(
  milestone: MilestoneRecord,
  requests: readonly ScheduledWriterTask[],
  modelSheet: ModelSheet,
  globalLimit: number,
): readonly ScheduledWriterTask[] {
  const selected: ScheduledWriterTask[] = [];
  const modelCounts = new Map<string, number>();
  for (const planned of milestone.plan!.tasks) {
    const request = requests.find((candidate) => candidate.writerTaskId === planned.taskId);
    if (request === undefined || planned.roleAssignment.role !== "implementer") continue;
    if (milestone.writerOwnership[planned.taskId] !== undefined) continue;
    if (milestone.tasks[planned.taskId]?.status !== "planned" && milestone.tasks[planned.taskId]?.status !== "ready") continue;
    if (planned.dependencies.some((dependency) => milestone.tasks[dependency]?.terminalOutcome !== "completed")) continue;
    const model = exactModel(modelSheet, planned.roleAssignment.agentId);
    assertSelectedModelCapability(request.execution.model, model, request.writerAdmission);
    const count = modelCounts.get(model.id) ?? 0;
    if (selected.length >= globalLimit || count >= model.maxConcurrency) continue;
    if (selected.some((candidate) => {
      const other = milestone.plan!.tasks.find((task) => task.taskId === candidate.writerTaskId)!;
      return logicalPathSetsOverlap(planned.ownedPaths, other.ownedPaths);
    })) continue;
    selected.push(request);
    modelCounts.set(model.id, count + 1);
  }
  return selected;
}

function plannedTask(milestone: MilestoneRecord, taskId: string, role: "implementer" | "reviewer"): PlannedTask {
  const task = milestone.plan?.tasks.find((candidate) => candidate.taskId === taskId);
  if (task?.roleAssignment.role !== role) throw new Error(`planned task ${taskId} must be a ${role}`);
  return task;
}

function exactModel(modelSheet: ModelSheet, modelId: string): ModelCapability {
  const model = modelSheet.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) throw new Error(`model ${modelId} is not bound by the model sheet`);
  return model;
}

function assertSelectedModelCapability(
  execution: ModelCapability,
  selected: ModelCapability,
  admission: OpenCodeTaskAdmissionContext,
): void {
  if (digestCanonical(execution) !== digestCanonical(selected)) {
    throw new Error("scheduled execution contradicts the selected model capability");
  }
  assertAdmissionCapability(admission, selected);
}

function assertAdmissionCapability(admission: OpenCodeTaskAdmissionContext, selected: ModelCapability): void {
  if (
    admission.actorId !== selected.id || admission.capabilityId !== selected.id ||
    admission.harness !== selected.harness || admission.transportModelId !== selected.model ||
    digestCanonical([...admission.roles].sort()) !== digestCanonical([...selected.roles].sort()) ||
    digestCanonical([...admission.toolPermissions].sort()) !== digestCanonical([...selected.toolPermissions].sort()) ||
    admission.network !== selected.network || admission.contextTokens !== selected.contextTokens
  ) throw new Error("scheduled admission contradicts the selected model capability");
}

function assertClaimBinding(
  scheduled: ScheduledWriterTask,
  milestone: MilestoneRecord,
  modelSheet: ModelSheet,
  ownership: MilestoneRecord["writerOwnership"][string],
): void {
  const writer = plannedTask(milestone, scheduled.writerTaskId, "implementer");
  const reviewer = plannedTask(milestone, scheduled.reviewerTaskId, "reviewer");
  if (ownership === undefined) throw new Error("writer ownership claim is missing");
  const selected = exactModel(modelSheet, writer.roleAssignment.agentId);
  const selectedReviewer = exactModel(modelSheet, reviewer.roleAssignment.agentId);
  assertSelectedModelCapability(scheduled.execution.model, selected, scheduled.writerAdmission);
  assertAdmissionCapability(scheduled.reviewerAdmission, selectedReviewer);
  if (
    ownership.reviewerTaskId !== scheduled.reviewerTaskId ||
    scheduled.execution.reviewerId !== reviewer.roleAssignment.agentId ||
    ownership.actorId !== selected.id || ownership.capabilityId !== selected.id ||
    ownership.transportModelId !== selected.model || ownership.harness !== selected.harness ||
    ownership.network !== selected.network || ownership.contextTokens !== selected.contextTokens ||
    ownership.modelCapabilityDigest !== digestCanonical(selected) ||
    digestCanonical([...ownership.roles].sort()) !== digestCanonical([...selected.roles].sort()) ||
    digestCanonical([...ownership.toolPermissions].sort()) !== digestCanonical([...selected.toolPermissions].sort())
  ) throw new Error("durable writer claim contradicts the selected model capability");
}

class WaveBarrier {
  private readonly pending = new Set<number>();
  private readonly waiters = new Map<number, () => void>();

  constructor(size: number) {
    for (let index = 0; index < size; index += 1) this.pending.add(index);
  }

  arrive(index: number): Promise<void> {
    this.pending.delete(index);
    this.releaseIfSettled();
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.set(index, resolve));
  }

  settle(index: number): void {
    this.pending.delete(index);
    this.releaseIfSettled();
  }

  private releaseIfSettled(): void {
    if (this.pending.size !== 0) return;
    for (const resolve of this.waiters.values()) resolve();
    this.waiters.clear();
  }
}
