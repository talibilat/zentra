import { createHash } from "node:crypto";

import type {
  OpenCodeProbeReport,
  OpenCodeProbeRequest,
} from "../harnesses/opencode-probe.js";
import type { ModelSheet } from "../policy/model-sheet.js";
import type { TaskService } from "../tasks/task-service.js";
import type { TaskView } from "../tasks/task-projection.js";
import type { OpenCodeSingleFileTracerRequest } from "../orchestration/opencode-single-file-tracer-bullet.js";
import { routeApprovedModel } from "./model-router.js";
import type { JournalOutcomeHistoryStore } from "./outcome-history.js";

interface OpenCodeTaskRunner {
  run(request: OpenCodeSingleFileTracerRequest): Promise<TaskView>;
}

export interface OpenCodeCapabilityProbe {
  probe(request: OpenCodeProbeRequest, signal: AbortSignal): Promise<OpenCodeProbeReport>;
}

export class RoutedOpenCodeExecution {
  constructor(
    private readonly history: JournalOutcomeHistoryStore,
    private readonly tasks: TaskService,
    private readonly probe: OpenCodeCapabilityProbe,
    private readonly runner: OpenCodeTaskRunner,
  ) {}

  async run(input: Omit<OpenCodeSingleFileTracerRequest, "model" | "probe"> & {
    readonly executionId: string;
    readonly taskType: string;
    readonly models: ModelSheet;
    readonly executable: string;
  }): Promise<TaskView> {
    const records = this.history.list({
      taskType: input.taskType,
      role: "implementer",
      harness: "opencode",
    });
    const selection = routeApprovedModel(input.models, records, {
      executionId: input.executionId,
      taskId: input.task.taskId,
      taskType: input.taskType,
      role: "implementer",
      harness: "opencode",
      requiredTools: ["read_repository", "write_worktree"],
      network: "denied",
      requiredContextTokens: input.task.budget.maxInputTokens + input.task.budget.maxOutputTokens,
    });
    this.history.begin({
      executionId: selection.executionId,
      taskId: input.task.taskId,
      taskType: input.taskType,
      role: "implementer",
      model: {
        capabilityId: selection.capability.id,
        harness: "opencode",
        transportModelSha256: createHash("sha256")
          .update(selection.capability.model, "utf8")
          .digest("hex"),
      },
      candidateCapabilityIds: [...selection.candidateCapabilityIds],
      modelSheetSha256: selection.modelSheetSha256,
      basis: selection.basis,
      correlationId: input.task.taskId,
    });
    const probe = await this.probe.probe({
      executable: input.executable,
      cwd: input.project.repositoryPath,
      timeoutMs: Math.min(input.task.budget.maxSeconds * 1_000, 30_000),
      modelId: selection.capability.id,
      models: input.models,
      security: input.security,
    }, input.signal);
    if (probe.outcome !== "completed") throw new Error("routed OpenCode capability probe failed");
    const task = {
      ...input.task,
      roleAssignment: {
        ...input.task.roleAssignment,
        agentId: selection.capability.id,
        harness: "opencode" as const,
      },
    };
    const view = await this.runner.run({
      project: input.project,
      task,
      model: selection.capability,
      security: input.security,
      probe,
      ...(input.reviewerId === undefined ? {} : { reviewerId: input.reviewerId }),
      signal: input.signal,
    });
    if (view.lifecycle === "terminal") {
      this.history.completeFromTask(input.executionId, this.tasks.readStream(task.taskId));
    }
    return view;
  }
}
