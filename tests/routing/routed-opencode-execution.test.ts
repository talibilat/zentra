import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import type { OpenCodeProbeReport } from "../../src/harnesses/opencode-probe.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";
import type { OpenCodeSingleFileTracerRequest } from "../../src/orchestration/opencode-single-file-tracer-bullet.js";
import { TaskService } from "../../src/tasks/task-service.js";
import type { TaskView } from "../../src/tasks/task-projection.js";
import { JournalOutcomeHistoryStore } from "../../src/routing/outcome-history.js";
import {
  RoutedOpenCodeExecution,
  type OpenCodeCapabilityProbe,
} from "../../src/routing/routed-opencode-execution.js";

describe("RoutedOpenCodeExecution", () => {
  it("records selection before execution and derives terminal history from task evidence", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const tasks = new TaskService(journal);
    const history = new JournalOutcomeHistoryStore(journal);
    const probe: OpenCodeCapabilityProbe = {
      probe: vi.fn(async (request): Promise<OpenCodeProbeReport> => ({
        outcome: "completed",
        reason: null,
        modelId: request.modelId,
        harness: "opencode",
        model: "provider/a",
        provider: "provider",
        executable: process.execPath,
        executableSha256: "a".repeat(64),
        argv: ["--version"],
        cwd: request.cwd,
        version: "OpenCode fixture",
        startedAt: "2026-07-16T12:00:00.000Z",
        finishedAt: "2026-07-16T12:00:00.100Z",
      })),
    };
    const runner: { run(request: OpenCodeSingleFileTracerRequest): Promise<TaskView> } = {
      run: vi.fn(async (request) => {
        tasks.create({
          taskId: request.task.taskId,
          projectId: request.project.projectId,
          title: request.task.title,
          correlationId: request.task.taskId,
        });
        tasks.append(request.task.taskId, "task.leased", { leaseOwner: request.model.id }, null);
        tasks.append(request.task.taskId, "task.started", { workerId: request.model.id }, null);
        tasks.append(request.task.taskId, "task.writer_completed", {
          workerId: request.model.id,
          requestedModelSha256: createHash("sha256").update(request.model.model).digest("hex"),
          outcome: "failed",
          startedAt: "2026-07-16T12:00:00.000Z",
          finishedAt: "2026-07-16T12:00:01.000Z",
        }, null);
        return tasks.append(request.task.taskId, "task.failed", { stage: "writer" }, null);
      }),
    };
    const routed = new RoutedOpenCodeExecution(history, tasks, probe, runner);

    const view = await routed.run({
      executionId: "execution-1",
      taskType: "single_file_implementation",
      models: modelSheet(),
      executable: process.execPath,
      project: {
        projectId: "project-1",
        repositoryPath: process.cwd(),
        integrationBranch: "zentra/integration",
        worktreeRoot: "/tmp/zentra-routing-worktrees",
        validations: {
          focused: [process.execPath, "--version"],
          full: [process.execPath, "--version"],
          focusedTimeoutMs: 5_000,
          fullTimeoutMs: 5_000,
        },
      },
      task: {
        taskId: "task-1",
        title: "Route writer",
        description: "Route an approved writer.",
        dependencies: [],
        ownedPaths: ["src/index.ts"],
        forbiddenPaths: [".env"],
        acceptanceCriteria: ["History is recorded."],
        roleAssignment: { role: "implementer", agentId: "placeholder", harness: "opencode" },
        risk: { level: "low", authority: "workspace_write", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
      },
      security: {
        allowedRepositories: [process.cwd()],
        allowedFileScopes: ["src/**"],
        forbiddenPaths: [".env"],
        network: { default: "denied", allowedDestinations: [] },
        secretHandling: ["No inherited secrets."],
        approvalRequiredOperations: ["external_effect"],
        releaseBoundary: "local_preparation_only",
        stopAndAskConditions: ["uncertain_effect"],
      },
      signal: new AbortController().signal,
    });

    expect(view.terminalOutcome).toBe("failed");
    expect(journal.readAll().map((event) => event.type)).toEqual([
      "routing.model_selected",
      "task.created",
      "task.leased",
      "task.started",
      "task.writer_completed",
      "task.failed",
      "routing.outcome_recorded",
    ]);
    expect(history.list({
      taskType: "single_file_implementation",
      role: "implementer",
      harness: "opencode",
    })[0]).toMatchObject({
      model: { capabilityId: "writer-a" },
      durationMs: 1_000,
      outcome: "failed",
      validation: { status: "not_observed" },
      review: { status: "not_required" },
    });
    journal.close();
  });
});

function modelSheet(): ModelSheet {
  return {
    models: [{
      id: "writer-a",
      harness: "opencode",
      model: "provider/a",
      roles: ["implementer"],
      specialties: ["coding"],
      costTier: "low",
      contextTokens: 10_000,
      maxConcurrency: 1,
      toolPermissions: ["read_repository", "write_worktree"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    }],
  };
}
