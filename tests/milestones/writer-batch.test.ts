import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { MilestonePlan } from "../../src/contracts/milestone.js";
import type { NewEvent, StoredEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE, artifactEvidenceSha256 } from "../../src/contracts/artifact.js";
import { canonicalValidationDigest } from "../../src/reviews/reviewer-adapter.js";

describe("journal-backed writer batch claims", () => {
  it("replays and re-verifies an actual legacy singleton completion payload", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-batch", projectId: "fixture", title: "Legacy singleton", correlationId: "trace-batch",
      plan: { ...batchPlan(), tasks: batchPlan().tasks.slice(0, 2) },
    });
    appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "writer-a", admissionDigest: "a".repeat(64) });
    registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
    registry.completeTask("milestone-batch", "writer-a", "completed");
    appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "review-a", admissionDigest: "b".repeat(64) });
    registry.startTask("milestone-batch", "review-a", "reviewer-a", "reviewer");
    appendIntegratedTask(journal, "writer-a");
    registry.completeTask("milestone-batch", "review-a", "completed");
    const taskEvents = journal.readStream("writer-a");
    const integration = taskEvents.find((event) => event.type === "task.integration_observed")!;
    const completion = taskEvents.find((event) => event.type === "task.completed")!;
    const receipt = (integration.payload as { receipt: { resultCommit: string } }).receipt;
    appendMilestoneEvent(journal, "milestone.completed", {
      outcome: "completed",
      evidence: {
        taskStreamId: "writer-a",
        integrationEventId: integration.eventId,
        integrationStreamVersion: integration.streamVersion,
        integrationPayloadDigest: digestCanonical(integration.payload),
        completionEventId: completion.eventId,
        completionStreamVersion: completion.streamVersion,
        completionPayloadDigest: digestCanonical(completion.payload),
        resultCommit: receipt.resultCommit,
      },
    });

    expect(registry.inspect("milestone-batch")).toMatchObject({
      lifecycle: "terminal", terminalOutcome: "completed", result: null,
    });
    journal.close();
  });

  it("atomically claims non-overlapping writers and retains ownership through review", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-1",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-b", "src/b.ts")],
      });

      const replayed = registry.inspect("milestone-batch")!;
      expect(Object.keys(replayed.writerOwnership)).toEqual(["writer-a", "writer-b"]);
      expect(replayed.writerOwnership["writer-a"]).toMatchObject({ reviewerTaskId: "review-a", status: "claimed" });
      expect(journal.readStream("milestone-batch").at(-1)?.type).toBe("milestone.writer_batch_started");
    } finally {
      journal.close();
    }
  });

  it("rejects overlapping, over-global, over-model, and dependency-blocked claims without appending", () => {
    const cases = [
      {
        writers: [claim("writer-a", "review-a", "model-a", "src/**"), claim("writer-b", "review-b", "model-b", "SRC/b.ts")],
        max: 2,
        message: "ownership overlap",
      },
      {
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-b", "src/b.ts")],
        max: 1,
        message: "global writer capacity",
      },
      {
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-a", "src/b.ts")],
        max: 2,
        message: "model writer capacity",
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const journal = new SqliteEventJournal(":memory:");
      try {
        const registry = registered(journal, testCase.writers);
        const before = journal.readStream("milestone-batch").length;
        expect(() => registry.startWriterBatch("milestone-batch", {
          batchId: `bad-${index}`,
          maxConcurrentWriters: testCase.max,
          writers: testCase.writers,
        })).toThrow(testCase.message);
        expect(journal.readStream("milestone-batch")).toHaveLength(before);
      } finally {
        journal.close();
      }
    }
  });

  it("verifies one specified writer stream and completes its reviewer without terminalizing the milestone", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-evidence",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.completeTask("milestone-batch", "writer-a", "completed");
      appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "review-a", admissionDigest: "b".repeat(64) });
      registry.startTask("milestone-batch", "review-a", "reviewer-a", "reviewer");
      appendIntegratedTask(journal, "writer-a");

      const result = registry.completeWriterIntegration("milestone-batch", "writer-a");

      expect(result.writerOwnership["writer-a"]?.status).toBe("integrated");
      expect(result.tasks["review-a"]?.terminalOutcome).toBe("completed");
      expect(result.lifecycle).toBe("running");
      expect(result.terminalOutcome).toBeNull();
      expect(journal.readStream("milestone-batch").map((event) => event.type)).not.toContain("milestone.completed");
    } finally {
      journal.close();
    }
  });

  it("rejects a completed integration stream without retained paired-review evidence", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-fabricated-review",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.completeTask("milestone-batch", "writer-a", "completed");
      appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "review-a", admissionDigest: "b".repeat(64) });
      registry.startTask("milestone-batch", "review-a", "reviewer-a", "reviewer");
      appendIntegratedTask(journal, "writer-a", false);

      expect(() => registry.completeWriterIntegration("milestone-batch", "writer-a"))
        .toThrow();
      expect(registry.inspect("milestone-batch")?.writerOwnership["writer-a"]?.status).toBe("claimed");
    } finally {
      journal.close();
    }
  });

  it.each([
    ["missing focused validation", "missing-validation"],
    ["substituted focused validation", "substituted-validation"],
    ["arbitrary review digests", "arbitrary-digests"],
  ] as const)("rejects reconciliation evidence with %s", (_name, mutation) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: `batch-${mutation}`,
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.completeTask("milestone-batch", "writer-a", "completed");
      appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "review-a", admissionDigest: "b".repeat(64) });
      registry.startTask("milestone-batch", "review-a", "reviewer-a", "reviewer");
      appendIntegratedTask(journal, "writer-a", true, "reviewer-a", "reviewer-a", mutation);

      expect(() => registry.completeWriterIntegration("milestone-batch", "writer-a")).toThrow();
      expect(registry.inspect("milestone-batch")?.writerOwnership["writer-a"]?.status).toBe("claimed");
    } finally {
      journal.close();
    }
  });

  it.each([
    ["wrong reviewer identity", "reviewer-b", "reviewer-b"],
    ["receipt review substitution", "reviewer-a", "reviewer-b"],
  ])("rejects retained per-task evidence with %s", (_name, reviewedBy, receiptReviewer) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: `batch-${_name.replaceAll(" ", "-")}`,
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.completeTask("milestone-batch", "writer-a", "completed");
      appendMilestoneEvent(journal, "milestone.task_ready", { taskId: "review-a", admissionDigest: "b".repeat(64) });
      registry.startTask("milestone-batch", "review-a", "reviewer-a", "reviewer");
      appendIntegratedTask(journal, "writer-a", true, reviewedBy, receiptReviewer);

      expect(() => registry.completeWriterIntegration("milestone-batch", "writer-a"))
        .toThrow();
    } finally {
      journal.close();
    }
  });

  it("retains ownership when a claimed writer fails", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-failed",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.completeTask("milestone-batch", "writer-a", "failed");

      expect(registry.inspect("milestone-batch")?.writerOwnership["writer-a"]?.status).toBe("claimed");
    } finally {
      journal.close();
    }
  });

  it("replays after an optimistic conflict with a competing durable claim", () => {
    const inner = new SqliteEventJournal(":memory:");
    try {
      const journal = new ConflictOnceJournal(inner);
      const registry = registered(journal as never);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-original",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts")],
      });

      expect(Object.keys(registry.inspect("milestone-batch")!.writerOwnership).sort()).toEqual(["writer-a", "writer-b"]);
    } finally {
      inner.close();
    }
  });

  it("revalidates concurrent milestone-stream starts and handoffs after optimistic conflicts", () => {
    const inner = new SqliteEventJournal(":memory:");
    try {
      const journal = new TransitionConflictJournal(inner);
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-handoff-race",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-b", "src/b.ts")],
      });
      journal.arm("milestone.task_running", "writer-a", () => {
        registry.startTask("milestone-batch", "writer-b", "model-b", "implementer");
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      journal.arm("milestone.task_completed", "writer-a", () => {
        registry.completeTask("milestone-batch", "writer-b", "completed");
      });
      registry.completeTask("milestone-batch", "writer-a", "completed");

      expect(registry.inspect("milestone-batch")?.tasks).toMatchObject({
        "writer-a": { status: "completed", terminalOutcome: "completed" },
        "writer-b": { status: "completed", terminalOutcome: "completed" },
      });
    } finally {
      inner.close();
    }
  });

  it("serializes concurrent reviewer handoffs while retaining per-writer integration evidence", () => {
    const inner = new SqliteEventJournal(":memory:");
    try {
      const journal = new TransitionConflictJournal(inner);
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-review-race",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-b", "src/b.ts")],
      });
      for (const [writer, model, reviewer, reviewerId] of [
        ["writer-a", "model-a", "review-a", "reviewer-a"],
        ["writer-b", "model-b", "review-b", "reviewer-b"],
      ] as const) {
        registry.startTask("milestone-batch", writer, model, "implementer");
        registry.completeTask("milestone-batch", writer, "completed");
        appendMilestoneEvent(inner, "milestone.task_ready", { taskId: reviewer, admissionDigest: "b".repeat(64) });
        registry.startTask("milestone-batch", reviewer, reviewerId, "reviewer");
        appendIntegratedTask(inner, writer, true, reviewerId);
      }
      journal.arm("milestone.task_completed", "review-a", () => {
        registry.completeWriterIntegration("milestone-batch", "writer-b");
      });

      registry.completeWriterIntegration("milestone-batch", "writer-a");

      expect(registry.inspect("milestone-batch")?.writerOwnership).toMatchObject({
        "writer-a": { status: "integrated" },
        "writer-b": { status: "integrated" },
      });
    } finally {
      inner.close();
    }
  });

  it.each([
    ["transport", { transportModelId: "forged/model" }],
    ["concurrency", { modelMaxConcurrency: 99 }],
    ["capability digest", { modelCapabilityDigest: "0".repeat(64) }],
    ["tools", { toolPermissions: ["read_repository"] }],
  ])("rejects a direct registry batch claim with forged pinned %s", (_name, change) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = authorizedRegistered(journal);
      const before = journal.readStream("milestone-batch").length;
      expect(() => registry.startWriterBatch("milestone-batch", {
        batchId: `forged-${_name.replaceAll(" ", "-")}`,
        maxConcurrentWriters: 2,
        writers: [{ ...claim("writer-a", "review-a", "model-a", "src/a.ts"), ...change }],
      })).toThrow("pinned model provenance");
      expect(journal.readStream("milestone-batch")).toHaveLength(before);
    } finally {
      journal.close();
    }
  });

  it("fails closed when forged claim provenance was appended outside the registry", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = authorizedRegistered(journal);
      appendMilestoneEvent(journal, "milestone.writer_batch_started", {
        schemaVersion: 1,
        batchId: "forged-replay",
        maxConcurrentWriters: 2,
        writers: [{
          ...claim("writer-a", "review-a", "model-a", "src/a.ts"),
          modelCapabilityDigest: "0".repeat(64),
        }],
      });

      expect(() => registry.inspect("milestone-batch")).toThrow("pinned model provenance");
      expect(() => registry.list()).toThrow("pinned model provenance");
    } finally {
      journal.close();
    }
  });

  it("revalidates a terminal ownership release after an optimistic stream conflict", () => {
    const inner = new SqliteEventJournal(":memory:");
    try {
      const journal = new TransitionConflictJournal(inner);
      const registry = registered(journal);
      registry.startWriterBatch("milestone-batch", {
        batchId: "batch-release-race",
        maxConcurrentWriters: 2,
        writers: [claim("writer-a", "review-a", "model-a", "src/a.ts"), claim("writer-b", "review-b", "model-b", "src/b.ts")],
      });
      registry.startTask("milestone-batch", "writer-a", "model-a", "implementer");
      registry.startTask("milestone-batch", "writer-b", "model-b", "implementer");
      appendFailedTask(inner, "writer-a", "model-a");
      appendFailedTask(inner, "writer-b", "model-b");
      journal.arm("milestone.task_completed", "writer-a", () => {
        registry.releaseTerminalWriter("milestone-batch", "writer-b");
      });

      registry.releaseTerminalWriter("milestone-batch", "writer-a");

      expect(registry.inspect("milestone-batch")?.writerOwnership).toMatchObject({
        "writer-a": { status: "released", releasePhase: "pre_review_writer" },
        "writer-b": { status: "released", releasePhase: "pre_review_writer" },
      });
    } finally {
      inner.close();
    }
  });
});

function appendFailedTask(journal: SqliteEventJournal, taskId: string, leaseOwner: string): void {
  journal.append(taskId, 0, [
    { streamId: taskId, type: "task.created", payload: { projectId: "fixture", title: taskId }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: "task.leased", payload: { leaseOwner }, causationId: null, correlationId: "trace-batch" },
    { streamId: taskId, type: "task.failed", payload: { stage: "writer", reason: "observed failed" }, causationId: null, correlationId: "trace-batch" },
  ]);
}

class TransitionConflictJournal implements EventJournal {
  private trigger: { type: string; taskId: string; action: () => void } | null = null;

  constructor(private readonly inner: SqliteEventJournal) {}

  arm(type: string, taskId: string, action: () => void): void {
    this.trigger = { type, taskId, action };
  }

  append(streamId: string, expectedVersion: number, events: readonly NewEvent<string, unknown>[]): readonly StoredEvent[] {
    const event = events[0];
    const payload = event?.payload as { taskId?: unknown } | undefined;
    if (this.trigger !== null && event?.type === this.trigger.type && payload?.taskId === this.trigger.taskId) {
      const trigger = this.trigger;
      this.trigger = null;
      trigger.action();
    }
    return this.inner.append(streamId, expectedVersion, events);
  }

  readStream(streamId: string, afterVersion?: number): readonly StoredEvent[] {
    return this.inner.readStream(streamId, afterVersion);
  }

  readAll(afterPosition?: number): readonly StoredEvent[] {
    return this.inner.readAll(afterPosition);
  }
}

class ConflictOnceJournal implements EventJournal {
  private injected = false;

  constructor(private readonly inner: SqliteEventJournal) {}

  append(streamId: string, expectedVersion: number, events: readonly NewEvent<string, unknown>[]): readonly StoredEvent[] {
    if (!this.injected && events[0]?.type === "milestone.writer_batch_started") {
      this.injected = true;
      this.inner.append(streamId, expectedVersion, [{
        streamId,
        type: "milestone.writer_batch_started",
        payload: { schemaVersion: 1, batchId: "batch-competing", maxConcurrentWriters: 2, writers: [claim("writer-b", "review-b", "model-b", "src/b.ts")] },
        causationId: null,
        correlationId: "trace-batch",
      }]);
    }
    return this.inner.append(streamId, expectedVersion, events);
  }

  readStream(streamId: string, afterVersion?: number): readonly StoredEvent[] {
    return this.inner.readStream(streamId, afterVersion);
  }

  readAll(afterPosition?: number): readonly StoredEvent[] {
    return this.inner.readAll(afterPosition);
  }
}

function appendMilestoneEvent(journal: SqliteEventJournal, type: string, payload: unknown): void {
  journal.append("milestone-batch", journal.readStream("milestone-batch").length, [{
    streamId: "milestone-batch", type, payload, causationId: null, correlationId: "trace-batch",
  }]);
}

function appendIntegratedTask(
  journal: SqliteEventJournal,
  taskId: string,
  includeReview = true,
  reviewerId = "reviewer-a",
  receiptReviewerId = reviewerId,
  mutation: "missing-validation" | "substituted-validation" | "arbitrary-digests" | null = null,
): void {
  const resultCommit = "c".repeat(40);
  const diff = `diff --git a/src/${taskId}.ts b/src/${taskId}.ts\n+updated\n`;
  const diffSha256 = createHash("sha256").update(diff).digest("hex");
  const command = [process.execPath, "--test", "test/focused.test.mjs"];
  const stdout = "focused validation passed\n";
  const stderr = "";
  const validation = {
    name: "focused",
    outcome: "completed" as const,
    exitCode: 0,
    stdout,
    stderr,
    startedAt: "2026-07-17T11:59:00.000Z",
    finishedAt: "2026-07-17T12:00:00.000Z",
    command,
    argvSha256: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    outputSha256: createHash("sha256").update(JSON.stringify({ stdout, stderr })).digest("hex"),
    timeoutMs: 5_000,
    provenance: { invocationId: `validation-${taskId}`, canonicalCwd: `/tmp/${taskId}`, subjectSha256: diffSha256, timeoutMs: 5_000 },
  };
  const requestedValidation = mutation === "substituted-validation"
    ? { ...validation, provenance: { ...validation.provenance, invocationId: "substituted-validation" } }
    : validation;
  const review = {
    reviewerId,
    approved: true,
    diffSha256: mutation === "arbitrary-digests" ? "d".repeat(64) : diffSha256,
    validationSha256: mutation === "arbitrary-digests" ? "e".repeat(64) : canonicalValidationDigest(validation),
    decidedAt: "2026-07-17T12:00:00.000Z",
    reason: "The exact validated change is approved.",
  };
  const receiptReview = { ...review, reviewerId: receiptReviewerId };
  const fullValidation = { ...validation, name: "full", provenance: { ...validation.provenance, invocationId: `full-${taskId}`, subjectSha256: resultCommit } };
  const receipt = {
    taskId,
    projectId: "fixture",
    sourceCommit: "a".repeat(40),
    originalIntegrationCommit: "b".repeat(40),
    resultCommit,
    review: receiptReview,
    validation: fullValidation,
    outcome: "completed",
  };
  const cleanup = { sourceCommit: "a".repeat(40), resultCommit, workspace: `/tmp/${taskId}`, branch: `ticket/${taskId}` };
  const patchEvidence = { diff, diffSha256, changedPath: `src/${taskId}.ts`, changedContentSha256: "f".repeat(64) };
  const timestamp = "2026-07-17T12:00:00.000Z";
  const artifact = (kind: "patch" | "validation_report" | "review_report" | "integration_receipt", evidence: unknown, phase?: "prepared") => {
    const artifactId = `${taskId}-${kind}`;
    const sha256 = artifactEvidenceSha256(kind, evidence);
    return [
      [ARTIFACT_PROTOCOL_MARKER_EVENT_TYPE, { artifactProtocolVersion: 1, artifactId, kind, sha256 }],
      [`artifact.${kind}_recorded`, {
        artifact: { artifactId, taskId, kind, path: `artifacts/${kind}.json`, sha256, createdAt: timestamp },
        evidence,
        ...(phase === undefined ? {} : { phase }),
      }],
    ] as const;
  };
  const events: Array<readonly [string, unknown]> = [
    ["task.created", { projectId: "fixture", title: taskId }],
    ["task.leased", { leaseOwner: "model-a" }],
    ["task.started", {}],
    ["task.writer_completed", { outcome: "completed" }],
    ...artifact("patch", patchEvidence),
    ["task.validation_started", { patch: { path: patchEvidence.changedPath, sha256: patchEvidence.changedContentSha256 }, diffSha256 }],
    ...(mutation === "missing-validation" ? [] : artifact("validation_report", validation)),
    ["task.validation_completed", { outcome: "completed", validation: requestedValidation, diffSha256 }],
    ["task.review_requested", { reviewerId: review.reviewerId, validation: requestedValidation }],
    ...(includeReview ? artifact("review_report", review) : []),
    ["task.review_approved", { review }],
    ["task.integration_started", { sourceCommit: receipt.sourceCommit, review }],
    ...artifact("integration_receipt", receipt, "prepared"),
    ["task.integration_prepared", { receipt }],
    ["task.integration_observed", { receipt, verification: "verified" }],
    ["task.cleanup_started", cleanup],
    ["task.cleanup_completed", cleanup],
    ["task.completed", { receipt }],
  ];
  journal.append(taskId, 0, events.map(([type, payload]) => ({
    streamId: taskId, type: type as string, payload, causationId: null, correlationId: "trace-batch",
  })));
}

function claim(writerTaskId: string, reviewerTaskId: string, modelId: string, ownedPath: string) {
  const capability = {
    id: modelId, harness: "opencode", model: `fixture/${modelId}`, roles: ["implementer"], specialties: ["coding"],
    costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository", "write_worktree"],
    network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
  };
  return {
    writerTaskId,
    reviewerTaskId,
    actorId: modelId,
    capabilityId: modelId,
    transportModelId: `fixture/${modelId}`,
    harness: "opencode" as const,
    roles: ["implementer" as const],
    toolPermissions: ["read_repository", "write_worktree"],
    network: "denied",
    contextTokens: 10_000,
    modelCapabilityDigest: digestCanonical(capability),
    ownedPaths: [ownedPath],
    modelMaxConcurrency: 1,
  };
}

function registered(
  journal: EventJournal,
  claims: readonly ReturnType<typeof claim>[] = [
    claim("writer-a", "review-a", "model-a", "src/a.ts"),
    claim("writer-b", "review-b", "model-b", "src/b.ts"),
  ],
): MilestoneRegistry {
  const registry = new MilestoneRegistry(journal);
  registry.register({
    milestoneId: "milestone-batch",
    projectId: "fixture",
    title: "Batch",
    correlationId: "trace-batch",
    plan: batchPlan(
      claims[0]!.ownedPaths[0]!,
      claims[1]!.ownedPaths[0]!,
      claims[0]!.actorId,
      claims[1]!.actorId,
    ),
  });
  for (const taskId of ["writer-a", "writer-b"]) {
    journal.append("milestone-batch", journal.readStream("milestone-batch").length, [{
      streamId: "milestone-batch",
      type: "milestone.task_ready",
      payload: { taskId, admissionDigest: "a".repeat(64) },
      causationId: null,
      correlationId: "trace-batch",
    }]);
  }
  return registry;
}

function authorizedRegistered(journal: SqliteEventJournal): MilestoneRegistry {
  const registry = new MilestoneRegistry(journal);
  const models = [
    writerCapability("model-a", "implementer"),
    writerCapability("model-b", "implementer"),
    writerCapability("reviewer-a", "reviewer"),
    writerCapability("reviewer-b", "reviewer"),
  ];
  registry.register({
    milestoneId: "milestone-batch",
    projectId: "fixture",
    title: "Authorized batch",
    correlationId: "trace-batch",
    plan: batchPlan(),
    authority: {
      security: {
        allowedRepositories: [process.cwd()],
        allowedFileScopes: ["src/**"],
        forbiddenPaths: [".env"],
        network: { default: "denied", allowedDestinations: [] },
        secretHandling: ["Do not inherit secrets."],
        approvalRequiredOperations: [],
        releaseBoundary: "local_preparation_only",
        stopAndAskConditions: ["plan_not_ready"],
      },
      modelSheet: { models },
    },
  });
  for (const taskId of ["writer-a", "writer-b"]) {
    appendMilestoneEvent(journal, "milestone.task_ready", { taskId, admissionDigest: "a".repeat(64) });
  }
  return registry;
}

function writerCapability(id: string, role: "implementer" | "reviewer") {
  return {
    id,
    harness: "opencode",
    model: `fixture/${id}`,
    roles: [role],
    specialties: [role === "implementer" ? "coding" : "review"],
    costTier: "low",
    contextTokens: 10_000,
    maxConcurrency: 1,
    toolPermissions: role === "implementer" ? ["read_repository", "write_worktree"] : ["read_repository", "review_diff"],
    network: "denied",
    fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 },
  };
}

function batchPlan(
  firstPath = "src/a.ts",
  secondPath = "src/b.ts",
  firstActor = "model-a",
  secondActor = "model-b",
): MilestonePlan {
  const budget = { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 };
  const task = (taskId: string, role: "implementer" | "reviewer", agentId: string, dependencies: string[], ownedPath: string) => ({
    taskId, title: taskId, description: taskId, dependencies, ownedPaths: [ownedPath], forbiddenPaths: [".env"],
    acceptanceCriteria: ["Done."], roleAssignment: { role, agentId, harness: "opencode" as const },
    risk: { level: "low" as const, authority: role === "implementer" ? "workspace_write" as const : "review" as const, requiresReview: role === "implementer", requiresApproval: false }, budget,
  });
  return { milestoneId: "milestone-batch", projectId: "fixture", goal: "Run independent writers.", tasks: [
    task("writer-a", "implementer", firstActor, [], firstPath),
    task("review-a", "reviewer", "reviewer-a", ["writer-a"], firstPath),
    task("writer-b", "implementer", secondActor, [], secondPath),
    task("review-b", "reviewer", "reviewer-b", ["writer-b"], secondPath),
  ] };
}
