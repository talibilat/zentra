import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { OpenCodeTaskAdmissionContext } from "../../src/contracts/authority-attention.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
import type { MilestoneRecord } from "../../src/milestones/milestone-registry.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE, artifactEvidenceSha256 } from "../../src/contracts/artifact.js";
import { canonicalValidationDigest } from "../../src/reviews/reviewer-adapter.js";
import { uncertainEffectPayload } from "../../src/contracts/uncertain-effect.js";
import { MultiWriterOwnershipScheduler } from "../../src/orchestration/multi-writer-scheduler.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

describe("MultiWriterOwnershipScheduler", () => {
  it("runs a deterministic non-overlapping wave concurrently and holds review behind the writer barrier", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const registry = new ControlledRegistry(plan);
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const integrations: string[] = [];
    registry.onIntegration = (taskId) => {
      expect(activeWriters).toBe(0);
      integrations.push(taskId);
    };
    const execution = {
      run: async (request: any) => {
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        await new Promise((resolve) => setTimeout(resolve, request.task.taskId === "writer-a" ? 15 : 5));
        activeWriters -= 1;
        await request.onReviewReady({
          taskStreamId: request.task.taskId,
          diffSha256: "a".repeat(64),
          validation: {},
        });
        return completedTask(request.task.taskId);
      },
    };

    const result = await new MultiWriterOwnershipScheduler(registry as never, execution).run(schedule(plan));

    expect(maxActiveWriters).toBe(2);
    expect(registry.batches).toEqual([["writer-a", "writer-b"]]);
    expect(integrations.sort()).toEqual(["writer-a", "writer-b"]);
    expect(result.lifecycle).toBe("running");
    expect(result.terminalOutcome).toBeNull();
  });

  it.each([
    ["overlap", "src/**", "SRC/b.ts", 2, 2, [["writer-a"], ["writer-b"]]],
    ["global limit", "src/a.ts", "src/b.ts", 1, 2, [["writer-a"], ["writer-b"]]],
    ["model limit", "src/a.ts", "src/b.ts", 2, 1, [["writer-a"], ["writer-b"]]],
  ] as const)("serializes by %s", async (_name, first, second, globalLimit, modelLimit, expected) => {
    const plan = planWithPaths(first, second);
    const registry = new ControlledRegistry(plan);
    const execution = {
      run: async (request: any) => {
        await request.onReviewReady({ taskStreamId: request.task.taskId, diffSha256: "a".repeat(64), validation: {} });
        return completedTask(request.task.taskId);
      },
    };

    await new MultiWriterOwnershipScheduler(registry as never, execution).run(schedule(plan, globalLimit, modelLimit));

    expect(registry.batches).toEqual(expected);
  });

  it("waits for a completed dependency before selecting the next writer", async () => {
    const baseline = planWithPaths("src/a.ts", "src/b.ts");
    const plan: MilestonePlan = {
      ...baseline,
      tasks: baseline.tasks.map((task) => task.taskId === "writer-b" ? { ...task, dependencies: ["review-a"] } : task),
    };
    const registry = new ControlledRegistry(plan);
    const execution = {
      run: async (request: any) => {
        await request.onReviewReady({ taskStreamId: request.task.taskId, diffSha256: "a".repeat(64), validation: {} });
        return completedTask(request.task.taskId);
      },
    };

    await new MultiWriterOwnershipScheduler(registry as never, execution).run(schedule(plan));

    expect(registry.batches).toEqual([["writer-a"], ["writer-b"]]);
  });

  it("rejects execution model metadata that differs from the selected capability", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = schedule(plan);
    const first = request.tasks[0]!;
    const originalExecution = first.execution as any;
    const changed = {
      ...request,
      tasks: [{
        ...first,
        execution: { ...originalExecution, model: { ...originalExecution.model, maxConcurrency: 99 } },
      }, ...request.tasks.slice(1)],
    };
    const execution = { run: async () => { throw new Error("execution must not start"); } };

    await expect(new MultiWriterOwnershipScheduler(new ControlledRegistry(plan) as never, execution).run(changed))
      .rejects.toThrow("selected model capability");
  });

  it("resumes a durable claim before task start without creating another claim", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, false);
    let executions = 0;
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async () => {
          executions += 1;
          appendTerminalWriterStream(journal, "writer-a", "failed");
          return failedTask("writer-a");
        },
      }).run(request);

      expect(executions).toBe(1);
      expect(journal.readStream(plan.milestoneId).filter((event) => event.type === "milestone.writer_batch_started")).toHaveLength(1);
      expect(result.writerOwnership["writer-a"]).toMatchObject({
        status: "released",
        releasePhase: "pre_review_writer",
      });
    } finally {
      journal.close();
    }
  });

  it("does not retry a claimed writer whose milestone start is already durable", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, true);
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async () => { throw new Error("worker effect must not retry"); },
      }).run(request);

      expect(result.tasks["writer-a"]?.status).toBe("running");
      expect(registry.inspectWriterTask(plan.milestoneId, "writer-a")).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("retains ownership and never retries a nonterminal uncertain writer stream", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, true);
    journal.append("writer-a", 0, [
      { streamId: "writer-a", type: "task.created", payload: { projectId: "fixture", title: "writer-a" }, causationId: null, correlationId: "trace-batch" },
      { streamId: "writer-a", type: "task.leased", payload: { leaseOwner: "shared-model" }, causationId: null, correlationId: "trace-batch" },
      { streamId: "writer-a", type: "task.started", payload: {}, causationId: null, correlationId: "trace-batch" },
      {
        streamId: "writer-a",
        type: "task.effect_uncertain",
        payload: uncertainEffectPayload({
          boundary: "worker",
          operation: "writer execution",
          reason: "writer result is uncertain",
          requestedBy: "recovery-controller",
          workspace: null,
        }),
        causationId: null,
        correlationId: "trace-batch",
      },
    ]);
    let executions = 0;
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async () => {
          executions += 1;
          throw new Error("uncertain effect must not retry");
        },
      }).run(request);

      expect(executions).toBe(0);
      expect(result.writerOwnership["writer-a"]?.status).toBe("claimed");
      expect(registry.inspectWriterTask(plan.milestoneId, "writer-a")).toMatchObject({ paused: true, terminalOutcome: null });
    } finally {
      journal.close();
    }
  });

  it("does not over-select a second writer after an active max-one writer becomes uncertain", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = schedule(plan, 1, 2);
    const journal = new SqliteEventJournal(":memory:");
    const registry = registeredSchedulerRegistry(journal, plan, request);
    const executed: string[] = [];
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async (execution) => {
          executed.push(execution.task.taskId);
          appendUncertainWriterStream(journal, execution.task.taskId);
          return uncertainTask(execution.task.taskId);
        },
      }).run(request);

      expect(executed).toEqual(["writer-a"]);
      expect(result.writerOwnership["writer-a"]?.status).toBe("claimed");
      expect(result.writerOwnership["writer-b"]).toBeUndefined();
      expect(result.tasks["writer-b"]?.status).toBe("planned");
      expect(journal.readStream(plan.milestoneId).filter((event) =>
        event.type === "milestone.writer_batch_started")).toHaveLength(1);
    } finally {
      journal.close();
    }
  });

  it.each([
    ["per-model capacity", "src/a.ts", "src/b.ts", 2, 1],
    ["overlapping ownership", "src/**", "src/b.ts", 2, 2],
  ] as const)("does not over-select after uncertainty constrained by %s", async (_name, first, second, globalLimit, modelLimit) => {
    const plan = planWithPaths(first, second);
    const request = schedule(plan, globalLimit, modelLimit);
    const journal = new SqliteEventJournal(":memory:");
    const registry = registeredSchedulerRegistry(journal, plan, request);
    const executed: string[] = [];
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async (execution) => {
          executed.push(execution.task.taskId);
          appendUncertainWriterStream(journal, execution.task.taskId);
          return uncertainTask(execution.task.taskId);
        },
      }).run(request);

      expect(executed).toEqual(["writer-a"]);
      expect(result.writerOwnership["writer-a"]?.status).toBe("claimed");
      expect(result.writerOwnership["writer-b"]).toBeUndefined();
      expect(journal.readStream(plan.milestoneId).filter((event) =>
        event.type === "milestone.writer_batch_started")).toHaveLength(1);
    } finally {
      journal.close();
    }
  });

  it("reconciles a completed task stream by recording only missing milestone evidence", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, true);
    appendCompletedWriterStream(journal, "writer-a", "reviewer-a");
    let executions = 0;
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async () => {
          executions += 1;
          throw new Error("completed effects must not retry");
        },
      }).run(request);

      expect(executions).toBe(0);
      expect(result.writerOwnership["writer-a"]?.status).toBe("integrated");
      expect(result.tasks["review-a"]?.terminalOutcome).toBe("completed");
      expect(result.terminalOutcome).toBeNull();
    } finally {
      journal.close();
    }
  });

  it("rejects resume when selected capability no longer matches the durable batch claim", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, false);
    const changedWriter = { ...request.modelSheet.models[0]!, maxConcurrency: 3 };
    const changed = {
      ...request,
      modelSheet: { models: [changedWriter, ...request.modelSheet.models.slice(1)] },
      tasks: [{
        ...request.tasks[0]!,
        execution: { ...(request.tasks[0]!.execution as any), model: changedWriter },
      }],
    };
    try {
      await expect(new MultiWriterOwnershipScheduler(registry, {
        run: async () => { throw new Error("worker effect must not start"); },
      }).run(changed)).rejects.toThrow("durable writer claim");
    } finally {
      journal.close();
    }
  });

  it.each(["failed", "cancelled", "timed_out", "denied"] as const)(
    "reconciles a durable %s writer outcome, releases ownership, and never starts review",
    async (outcome) => {
      const plan = planWithPaths("src/a.ts", "src/b.ts");
      const request = singleWriterSchedule(plan);
      const { journal, registry } = claimedRegistry(plan, request, true);
      appendTerminalWriterStream(journal, "writer-a", outcome);
      let executions = 0;
      try {
        const result = await new MultiWriterOwnershipScheduler(registry, {
          run: async () => {
            executions += 1;
            throw new Error("terminal writer effect must not retry");
          },
        }).run(request);

        expect(executions).toBe(0);
        expect(result.writerOwnership["writer-a"]).toMatchObject({ status: "released", terminalOutcome: outcome });
        expect(result.tasks["writer-a"]?.terminalOutcome).toBe(outcome);
        expect(result.tasks["review-a"]?.status).toBe("planned");
        expect(journal.readStream(plan.milestoneId).map((event) => event.type)).toContain("milestone.writer_terminal_released");
      } finally {
        journal.close();
      }
    },
  );

  it("continues independent work after observing a failed writer without admitting its reviewer", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = schedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, true);
    appendTerminalWriterStream(journal, "writer-a", "failed");
    const executed: string[] = [];
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async (execution) => {
          executed.push(execution.task.taskId);
          appendTerminalWriterStream(journal, execution.task.taskId, "failed");
          return failedTask(execution.task.taskId);
        },
      }).run(request);

      expect(executed).toEqual(["writer-b"]);
      expect(result.writerOwnership["writer-a"]?.status).toBe("released");
      expect(result.tasks["review-a"]?.status).toBe("planned");
    } finally {
      journal.close();
    }
  });

  it("keeps dependent work blocked after observing a failed dependency", async () => {
    const baseline = planWithPaths("src/a.ts", "src/b.ts");
    const plan: MilestonePlan = {
      ...baseline,
      tasks: baseline.tasks.map((task) => task.taskId === "writer-b" ? { ...task, dependencies: ["writer-a"] } : task),
    };
    const request = schedule(plan);
    const { journal, registry } = claimedRegistry(plan, request, true);
    appendTerminalWriterStream(journal, "writer-a", "failed");
    let executions = 0;
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async () => {
          executions += 1;
          throw new Error("dependent writer must remain blocked");
        },
      }).run(request);

      expect(executions).toBe(0);
      expect(result.tasks["writer-b"]?.status).toBe("planned");
      expect(result.writerOwnership["writer-a"]?.status).toBe("released");
    } finally {
      journal.close();
    }
  });

  it("releases a pre-review failure before max-one scheduling starts the next independent writer", async () => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = schedule(plan, 1, 2);
    const journal = new SqliteEventJournal(":memory:");
    const registry = registeredSchedulerRegistry(journal, plan, request);
    const executed: string[] = [];
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async (execution) => {
          executed.push(execution.task.taskId);
          appendTerminalWriterStream(journal, execution.task.taskId, "failed");
          return failedTask(execution.task.taskId);
        },
      }).run(request);

      expect(executed).toEqual(["writer-a", "writer-b"]);
      expect(result.writerOwnership).toMatchObject({
        "writer-a": { status: "released", releasePhase: "pre_review_writer" },
        "writer-b": { status: "released", releasePhase: "pre_review_writer" },
      });
      const events = journal.readStream(plan.milestoneId);
      const releaseA = events.findIndex((event) => event.type === "milestone.writer_terminal_released" &&
        (event.payload as { writerTaskId?: string }).writerTaskId === "writer-a");
      const claimB = events.findIndex((event) => event.type === "milestone.writer_batch_started" &&
        JSON.stringify(event.payload).includes("writer-b"));
      expect(releaseA).toBeGreaterThan(-1);
      expect(claimB).toBeGreaterThan(releaseA);
    } finally {
      journal.close();
    }
  });

  it.each([
    ["reviewer denial", "denied", "review"],
    ["reviewer failure", "failed", "review"],
    ["integration failure", "failed", "integration"],
    ["full-validation failure", "failed", "full_validation"],
    ["integration cancellation", "cancelled", "integration"],
    ["integration timeout", "timed_out", "integration"],
  ] as const)("releases ownership after post-handoff %s", async (_name, outcome, stage) => {
    const plan = planWithPaths("src/a.ts", "src/b.ts");
    const request = singleWriterSchedule(plan);
    const journal = new SqliteEventJournal(":memory:");
    const registry = registeredSchedulerRegistry(journal, plan, request);
    try {
      const result = await new MultiWriterOwnershipScheduler(registry, {
        run: async (execution) => {
          await execution.onReviewReady!({
            taskStreamId: execution.task.taskId,
            diffSha256: "a".repeat(64),
            validation: {} as never,
          });
          appendPostHandoffTerminalStream(journal, execution.task.taskId, outcome, stage);
          return terminalTask(execution.task.taskId, outcome);
        },
      }).run(request);

      expect(result.tasks["writer-a"]?.terminalOutcome).toBe("completed");
      expect(result.tasks["review-a"]?.terminalOutcome).toBe(outcome);
      expect(result.writerOwnership["writer-a"]).toMatchObject({
        status: "released",
        terminalOutcome: outcome,
        releasePhase: "post_handoff_reviewer",
      });
    } finally {
      journal.close();
    }
  });
});

function registeredSchedulerRegistry(
  journal: SqliteEventJournal,
  plan: MilestonePlan,
  request: ReturnType<typeof schedule>,
): MilestoneRegistry {
  const registry = new MilestoneRegistry(journal);
  registry.register({
    milestoneId: plan.milestoneId,
    projectId: plan.projectId,
    title: "Active scheduler",
    correlationId: "trace-batch",
    plan,
    authority: { security: request.security, modelSheet: request.modelSheet },
  });
  return registry;
}

function appendTerminalWriterStream(
  journal: SqliteEventJournal,
  taskId: string,
  outcome: "failed" | "cancelled" | "timed_out" | "denied",
): void {
  journal.append(taskId, 0, [
    { streamId: taskId, type: "task.created", payload: { projectId: "fixture", title: taskId }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: "task.leased", payload: { leaseOwner: "shared-model" }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: `task.${outcome}`, payload: { stage: "writer", reason: `observed ${outcome}` }, causationId: null, correlationId: "trace-batch" },
  ]);
}

function appendUncertainWriterStream(journal: SqliteEventJournal, taskId: string): void {
  journal.append(taskId, 0, [
    { streamId: taskId, type: "task.created", payload: { projectId: "fixture", title: taskId }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: "task.leased", payload: { leaseOwner: "shared-model" }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: "task.started", payload: {}, causationId: null, correlationId: "trace-batch" },
    {
      streamId: taskId,
      type: "task.effect_uncertain",
      payload: uncertainEffectPayload({
        boundary: "worker",
        operation: "writer execution",
        reason: "writer result is uncertain",
        requestedBy: "recovery-controller",
        workspace: null,
      }),
      causationId: null,
      correlationId: "trace-batch",
    },
  ]);
}

function appendPostHandoffTerminalStream(
  journal: SqliteEventJournal,
  taskId: string,
  outcome: "failed" | "cancelled" | "timed_out" | "denied",
  stage: "review" | "integration" | "full_validation",
): void {
  const events: Array<{ type: string; payload: unknown }> = [
    { type: "task.created", payload: { projectId: "fixture", title: taskId } },
    { type: "task.leased", payload: { leaseOwner: "shared-model" } },
    { type: "task.started", payload: {} },
    { type: "task.validation_started", payload: {} },
    { type: "task.validation_completed", payload: { outcome: "completed" } },
    { type: "task.review_requested", payload: {} },
  ];
  if (stage !== "review") {
    events.push({ type: "task.review_approved", payload: {} });
    events.push({ type: "task.integration_started", payload: {} });
  }
  events.push({ type: `task.${outcome}`, payload: { stage, reason: `observed ${outcome}` } });
  journal.append(taskId, 0, events.map((event) => ({
    streamId: taskId,
    ...event,
    causationId: null,
    correlationId: "trace-batch",
  })));
}

function singleWriterSchedule(plan: MilestonePlan) {
  const request = schedule(plan);
  return { ...request, tasks: [request.tasks[0]!] };
}

function claimedRegistry(plan: MilestonePlan, request: ReturnType<typeof singleWriterSchedule>, start: boolean) {
  const journal = new SqliteEventJournal(":memory:");
  const registry = new MilestoneRegistry(journal);
  registry.register({
    milestoneId: plan.milestoneId,
    projectId: plan.projectId,
    title: "Resume batch",
    correlationId: "trace-batch",
    plan,
    authority: { security: request.security, modelSheet: request.modelSheet },
  });
  const scheduled = request.tasks[0]!;
  const writer = plan.tasks.find((task) => task.taskId === scheduled.writerTaskId)!;
  const reviewer = plan.tasks.find((task) => task.taskId === scheduled.reviewerTaskId)!;
  const selected = request.modelSheet.models.find((model) => model.id === writer.roleAssignment.agentId)!;
  const admitted = registry.admitTask(plan.milestoneId, writer.taskId, request.security, scheduled.writerAdmission, request.modelSheet);
  if (admitted.status !== "admitted") throw new Error("fixture writer admission failed");
  registry.startWriterBatch(plan.milestoneId, {
    batchId: "durable-batch",
    maxConcurrentWriters: request.maxConcurrentWriters,
    writers: [{
      writerTaskId: writer.taskId,
      reviewerTaskId: reviewer.taskId,
      actorId: selected.id,
      capabilityId: selected.id,
      transportModelId: selected.model,
      harness: "opencode",
      roles: ["implementer"],
      toolPermissions: [...selected.toolPermissions],
      network: selected.network,
      contextTokens: selected.contextTokens,
      modelCapabilityDigest: digestCanonical(selected),
      ownedPaths: writer.ownedPaths,
      modelMaxConcurrency: selected.maxConcurrency,
    }],
  });
  if (start) registry.startTask(plan.milestoneId, writer.taskId, writer.roleAssignment.agentId, "implementer");
  return { journal, registry };
}

function appendCompletedWriterStream(journal: SqliteEventJournal, taskId: string, reviewerId: string): void {
  const resultCommit = "c".repeat(40);
  const diff = `diff --git a/src/${taskId}.ts b/src/${taskId}.ts\n+updated\n`;
  const diffSha256 = createHash("sha256").update(diff).digest("hex");
  const command = [process.execPath, "--test", "test/focused.test.mjs"];
  const stdout = "focused validation passed\n";
  const stderr = "";
  const validation = {
    name: "focused", outcome: "completed" as const, exitCode: 0, stdout, stderr,
    startedAt: "2026-07-17T11:59:00.000Z", finishedAt: "2026-07-17T12:00:00.000Z", command,
    argvSha256: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    outputSha256: createHash("sha256").update(JSON.stringify({ stdout, stderr })).digest("hex"),
    timeoutMs: 5_000,
    provenance: { invocationId: `validation-${taskId}`, canonicalCwd: `/tmp/${taskId}`, subjectSha256: diffSha256, timeoutMs: 5_000 },
  };
  const review = {
    reviewerId, approved: true, diffSha256, validationSha256: canonicalValidationDigest(validation),
    decidedAt: "2026-07-17T12:00:00.000Z", reason: "Approved exact validated change.",
  };
  const fullValidation = { ...validation, name: "full", provenance: { ...validation.provenance, invocationId: `full-${taskId}`, subjectSha256: resultCommit } };
  const receipt = {
    taskId, projectId: "fixture", sourceCommit: "a".repeat(40), originalIntegrationCommit: "b".repeat(40),
    resultCommit, review, validation: fullValidation, outcome: "completed",
  };
  const cleanup = { sourceCommit: "a".repeat(40), resultCommit, workspace: `/tmp/${taskId}`, branch: `ticket/${taskId}` };
  const patchEvidence = { diff, diffSha256, changedPath: `src/${taskId}.ts`, changedContentSha256: "f".repeat(64) };
  const artifact = (kind: "patch" | "validation_report" | "review_report" | "integration_receipt", evidence: unknown, phase?: "prepared") => {
    const artifactId = `${taskId}-${kind}`;
    const sha256 = artifactEvidenceSha256(kind, evidence);
    return [
      [ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE, { artifactProtocolVersion: 1, artifactId, kind, sha256 }],
      [`artifact.${kind}_recorded`, {
        artifact: { artifactId, taskId, kind, path: `artifacts/${kind}.json`, sha256, createdAt: "2026-07-17T12:00:00.000Z" },
        evidence, ...(phase === undefined ? {} : { phase }),
      }],
    ] as const;
  };
  const events: Array<readonly [string, unknown]> = [
    ["task.created", { projectId: "fixture", title: taskId }], ["task.leased", { leaseOwner: "shared-model" }],
    ["task.started", {}], ["task.writer_completed", { outcome: "completed" }],
    ...artifact("patch", patchEvidence),
    ["task.validation_started", { patch: { path: patchEvidence.changedPath, sha256: patchEvidence.changedContentSha256 }, diffSha256 }],
    ...artifact("validation_report", validation),
    ["task.validation_completed", { outcome: "completed", validation, diffSha256 }],
    ["task.review_requested", { reviewerId, validation }],
    ...artifact("review_report", review),
    ["task.review_approved", { review }], ["task.integration_started", { sourceCommit: receipt.sourceCommit, review }],
    ...artifact("integration_receipt", receipt, "prepared"), ["task.integration_prepared", { receipt }],
    ["task.integration_observed", { receipt, verification: "verified" }], ["task.cleanup_started", cleanup],
    ["task.cleanup_completed", cleanup], ["task.completed", { receipt }],
  ];
  journal.append(taskId, 0, events.map(([type, payload]) => ({
    streamId: taskId, type, payload, causationId: null, correlationId: "trace-batch",
  })));
}

class ControlledRegistry {
  readonly batches: string[][] = [];
  onIntegration: (taskId: string) => void = () => {};
  private readonly statuses: Record<string, any>;

  constructor(private readonly plan: MilestonePlan) {
    this.statuses = Object.fromEntries(plan.tasks.map((task) => [task.taskId, {
      taskId: task.taskId, status: "planned", terminalOutcome: null, blockedReason: null, admissionDigest: null,
    }]));
  }

  inspect(): MilestoneRecord {
    return {
      milestoneId: this.plan.milestoneId, projectId: this.plan.projectId, title: "Batch", lifecycle: "running",
      terminalOutcome: null, streamVersion: 1, plan: this.plan, stopAndAsk: null, attention: null,
      replanningAttention: null, tasks: this.statuses, historicalTasks: {}, authorityEnvelope: null, revisions: [],
      planHistory: [this.plan], executedTaskIds: [], hasActiveEffects: false, hasUncertainEffects: false, hasTraceFailure: false,
      replanningAttentionHistory: [], replanningResolutions: [], replanningPolicy: null, replanningPauseOccurrence: null,
      writerOwnership: {}, maxConcurrentWriters: null, traceId: "trace-batch", tracePath: null,
      result: null,
    };
  }

  admitTask(_milestoneId: string, taskId: string, _security: unknown, context: any) {
    this.statuses[taskId].status = "ready";
    this.statuses[taskId].admissionDigest = "a".repeat(64);
    return { status: "admitted", milestone: this.inspect(), admission: { digest: "a".repeat(64), packet: {
      repository: context.repositoryPath, actorId: context.actorId, capabilityId: context.capabilityId,
      transportModelId: context.transportModelId,
    } } };
  }

  startWriterBatch(_milestoneId: string, input: any) {
    this.batches.push(input.writers.map((writer: any) => writer.writerTaskId));
    return this.inspect();
  }

  startTask(_milestoneId: string, taskId: string) {
    this.statuses[taskId].status = "running";
    return this.inspect();
  }

  completeTask(_milestoneId: string, taskId: string, outcome: string) {
    this.statuses[taskId].status = "completed";
    this.statuses[taskId].terminalOutcome = outcome;
    return this.inspect();
  }

  completeWriterIntegration(_milestoneId: string, writerTaskId: string) {
    this.onIntegration(writerTaskId);
    const reviewer = this.plan.tasks.find((task) => task.dependencies.includes(writerTaskId) && task.roleAssignment.role === "reviewer")!;
    this.statuses[reviewer.taskId].status = "completed";
    this.statuses[reviewer.taskId].terminalOutcome = "completed";
    return this.inspect();
  }
}

function schedule(plan: MilestonePlan, maxConcurrentWriters = 2, modelMaxConcurrency = 2) {
  const security = securitySheet();
  const modelSheet: ModelSheet = { models: [
    model("shared-model", modelMaxConcurrency, "implementer"),
    model("reviewer-a", 1, "reviewer"),
    model("reviewer-b", 1, "reviewer"),
  ] };
  return {
    milestoneId: plan.milestoneId,
    maxConcurrentWriters,
    security,
    modelSheet,
    tasks: ["writer-a", "writer-b"].map((writerTaskId) => {
      const writer = plan.tasks.find((task) => task.taskId === writerTaskId)!;
      const reviewer = plan.tasks.find((task) => task.dependencies.includes(writerTaskId) && task.roleAssignment.role === "reviewer")!;
      return {
        writerTaskId, reviewerTaskId: reviewer.taskId,
        writerAdmission: admission("shared-model", "implementer", "workspace_write"),
        reviewerAdmission: admission(reviewer.roleAssignment.agentId, "reviewer", "review"),
        execution: {
          project: { projectId: "fixture", repositoryPath: process.cwd() }, task: writer,
          model: modelSheet.models[0], security, reviewerId: reviewer.roleAssignment.agentId,
          signal: new AbortController().signal,
        } as never,
      };
    }),
  };
}

function planWithPaths(firstPath: string, secondPath: string): MilestonePlan {
  const budget = { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 };
  const task = (taskId: string, role: "implementer" | "reviewer", agentId: string, dependencies: string[], ownedPath: string) => ({
    taskId, title: taskId, description: taskId, dependencies, ownedPaths: [ownedPath], forbiddenPaths: [".env"], acceptanceCriteria: ["Done."],
    roleAssignment: { role, agentId, harness: "opencode" as const }, risk: { level: "low" as const, authority: role === "implementer" ? "workspace_write" as const : "review" as const, requiresReview: role === "implementer", requiresApproval: false }, budget,
  });
  return { milestoneId: "milestone-batch", projectId: "fixture", goal: "Parallel work.", tasks: [
    task("writer-a", "implementer", "shared-model", [], firstPath), task("review-a", "reviewer", "reviewer-a", ["writer-a"], firstPath),
    task("writer-b", "implementer", "shared-model", [], secondPath), task("review-b", "reviewer", "reviewer-b", ["writer-b"], secondPath),
  ] };
}

function model(id: string, maxConcurrency: number, role: "implementer" | "reviewer") {
  return { id, harness: "opencode", model: `fixture/${id}`, roles: [role], specialties: [role === "implementer" ? "coding" : "review"], costTier: "low", contextTokens: 10_000,
    maxConcurrency, toolPermissions: role === "implementer" ? ["read_repository", "write_worktree"] : ["read_repository", "review_diff"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } };
}

function admission(
  actorId: string,
  role: "implementer" | "reviewer",
  authority: "workspace_write" | "review",
): OpenCodeTaskAdmissionContext {
  return { kind: "opencode", repositoryPath: process.cwd(), actorId, harness: "opencode", role, capabilityId: actorId,
    transportModelId: `fixture/${actorId}`, authority, roles: [role], toolPermissions: role === "implementer" ? ["read_repository", "write_worktree"] : ["read_repository", "review_diff"],
    network: "denied", contextTokens: 10_000, requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500, timeoutMs: 30_000 } };
}

function securitySheet(): SecuritySheet {
  return { allowedRepositories: [process.cwd()], allowedFileScopes: ["src/**"], forbiddenPaths: [".env"], network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Do not inherit secrets."], approvalRequiredOperations: [], releaseBoundary: "local_preparation_only", stopAndAskConditions: ["plan_not_ready"] };
}

function completedTask(taskId: string) {
  return { taskId, projectId: "fixture", title: taskId, lifecycle: "terminal", terminalOutcome: "completed", streamVersion: 12,
    leaseOwner: "shared-model", paused: false, stopAndAsk: null, uncertainEffect: null } as const;
}

function failedTask(taskId: string) {
  return { ...completedTask(taskId), terminalOutcome: "failed" as const };
}

function terminalTask(taskId: string, outcome: "failed" | "cancelled" | "timed_out" | "denied") {
  return { ...completedTask(taskId), terminalOutcome: outcome };
}

function uncertainTask(taskId: string) {
  return {
    ...completedTask(taskId),
    lifecycle: "running" as const,
    terminalOutcome: null,
    paused: true,
    uncertainEffect: { boundary: "worker" },
  } as never;
}
