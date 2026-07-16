import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { artifactEvidenceSha256 } from "../../src/contracts/artifact.js";
import type { StoredEvent } from "../../src/contracts/event.js";
import { uncertainEffectPayload } from "../../src/contracts/uncertain-effect.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { projectTask } from "../../src/tasks/task-projection.js";
import { TaskService } from "../../src/tasks/task-service.js";

const journals: SqliteEventJournal[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const journal of journals) journal.close();
  journals.length = 0;
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

function makeEvent(
  type: string,
  streamVersion: number,
  payload: unknown = {},
): StoredEvent {
  return {
    streamId: "task-1",
    type,
    payload,
    causationId: null,
    correlationId: "goal-1",
    eventId: `event-${streamVersion}`,
    streamVersion,
    globalPosition: streamVersion,
    recordedAt: "2026-07-12T00:00:00.000Z",
  };
}

function createdEvent(): StoredEvent {
  return makeEvent("task.created", 1, {
    projectId: "project-1",
    title: "Update greeting",
  });
}

function happyPath(): StoredEvent[] {
  return [
    createdEvent(),
    makeEvent("task.leased", 2, { leaseOwner: "worker-1" }),
    makeEvent("task.started", 3),
    makeEvent("task.validation_started", 4),
    makeEvent("task.review_requested", 5),
    makeEvent("task.review_approved", 6),
    makeEvent("task.integration_started", 7),
  ];
}

describe("projectTask", () => {
  it("returns null for an empty event list", () => {
    expect(projectTask([])).toBeNull();
  });

  it("projects task.created into a queued task", () => {
    const view = projectTask([createdEvent()]);
    expect(view).toEqual({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "queued",
      terminalOutcome: null,
      streamVersion: 1,
      leaseOwner: null,
      paused: false,
      stopAndAsk: null,
      uncertainEffect: null,
    });
  });

  it("rejects an empty task.created streamId", () => {
    expect(() =>
      projectTask([{ ...createdEvent(), streamId: "" }]),
    ).toThrow("task.created streamId must be a nonempty string");
  });

  it("projects task.leased into leased and captures the lease owner", () => {
    const view = projectTask(happyPath().slice(0, 2));
    expect(view?.lifecycle).toBe("leased");
    expect(view?.leaseOwner).toBe("worker-1");
    expect(view?.streamVersion).toBe(2);
  });

  it.each([
    ["projectId", { title: "Update greeting" }],
    ["projectId", { projectId: "", title: "Update greeting" }],
    ["projectId", { projectId: 42, title: "Update greeting" }],
    ["title", { projectId: "project-1" }],
    ["title", { projectId: "project-1", title: "" }],
    ["title", { projectId: "project-1", title: 42 }],
  ])("rejects a malformed task.created %s", (field, payload) => {
    expect(() => projectTask([makeEvent("task.created", 1, payload)])).toThrow(
      `task.created payload.${field} must be a nonempty string`,
    );
  });

  it.each([{}, { leaseOwner: "" }, { leaseOwner: 42 }])(
    "rejects a malformed task.leased payload %#",
    (payload) => {
      expect(() =>
        projectTask([createdEvent(), makeEvent("task.leased", 2, payload)]),
      ).toThrow("task.leased payload.leaseOwner must be a nonempty string");
    },
  );

  it("projects task.started into running", () => {
    expect(projectTask(happyPath().slice(0, 3))?.lifecycle).toBe("running");
  });

  it("projects task.validation_started into validating", () => {
    expect(projectTask(happyPath().slice(0, 4))?.lifecycle).toBe("validating");
  });

  it("pauses on uncertain effects without claiming a terminal outcome", () => {
    const events = [
      createdEvent(),
      makeEvent("task.leased", 2, { leaseOwner: "worker-1" }),
      makeEvent("task.started", 3),
      makeEvent("task.effect_uncertain", 4, uncertainEffectPayload({
        boundary: "worker",
        operation: "worker invocation",
        reason: "worker result is uncertain",
        requestedBy: "zentra-worker-controller",
        workspace: { path: "/work/task-1", branch: "ticket/task-1" },
      })),
    ];

    expect(projectTask(events)).toMatchObject({
      lifecycle: "running",
      terminalOutcome: null,
      paused: true,
      stopAndAsk: { reason: "uncertain_effect" },
      uncertainEffect: { boundary: "worker", retryPolicy: "never_automatic" },
    });
    expect(() => projectTask([
      ...events,
      makeEvent("task.validation_started", 5),
    ])).toThrow(/paused.*reconciliation/i);
    expect(() => projectTask([
      ...events,
      makeEvent("task.failed", 5),
    ])).toThrow(/paused.*reconciliation/i);

    expect(projectTask([
      ...events,
      makeEvent("task.effect_reconciled", 5, {
        schemaVersion: 1,
        boundary: "worker",
        resolution: "abandoned",
        reason: "operator abandoned the retained worker result",
        decidedBy: "operator-1",
        decisionId: "decision-1",
      }),
    ])).toMatchObject({ paused: false, stopAndAsk: null, uncertainEffect: null });
  });

  it("completes a focused writer task only after durable successful validation", () => {
    const events = focusedCompletionEvents();

    expect(projectTask(events)).toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
      streamVersion: 11,
    });
  });

  function focusedCompletionEvents(): StoredEvent[] {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n";
    const diffSha256 = createHash("sha256").update(diff).digest("hex");
    const validation = {
      ...serviceValidation,
      provenance: { ...serviceValidation.provenance, subjectSha256: diffSha256 },
    };
    const validationSha256 = artifactEvidenceSha256("validation_report", validation);
    return [
      createdEvent(),
      makeEvent("task.leased", 2, { leaseOwner: "writer-1" }),
      makeEvent("task.started", 3),
      makeEvent("task.writer_completed", 4, { outcome: "completed" }),
      makeEvent("task.artifact_recording", 5, { artifactProtocolVersion: 1, artifactId: "patch-1", kind: "patch", sha256: diffSha256 }),
      makeEvent("artifact.patch_recorded", 6, {
        artifact: { artifactId: "patch-1", taskId: "task-1", kind: "patch", path: "artifacts/patch.diff", sha256: diffSha256, createdAt: "2026-07-12T00:00:00.000Z" },
        evidence: { diff, diffSha256, changedPath: "src/a.ts", changedContentSha256: "a".repeat(64) },
      }),
      makeEvent("task.validation_started", 7, { patch: { type: "artifact.ready", path: "src/a.ts", sha256: "a".repeat(64) }, diffSha256 }),
      makeEvent("task.artifact_recording", 8, { artifactProtocolVersion: 1, artifactId: "validation-1", kind: "validation_report", sha256: validationSha256 }),
      makeEvent("artifact.validation_report_recorded", 9, {
        artifact: { artifactId: "validation-1", taskId: "task-1", kind: "validation_report", path: "artifacts/focused-validation.json", sha256: validationSha256, createdAt: "2026-07-12T00:00:00.000Z" },
        evidence: validation,
      }),
      makeEvent("task.validation_completed", 10, { outcome: "completed", validation, diffSha256, workspaceUnchanged: true }),
      makeEvent("task.completed", 11),
    ];
  }

  it("rejects focused completion without successful validation evidence", () => {
    const validating = [
      createdEvent(),
      makeEvent("task.leased", 2, { leaseOwner: "writer-1" }),
      makeEvent("task.started", 3),
      makeEvent("task.writer_completed", 4, { outcome: "completed" }),
      makeEvent("task.validation_started", 5),
    ];

    expect(() => projectTask([...validating, makeEvent("task.completed", 6)]))
      .toThrow(/successful.*validation evidence/i);
    expect(() => projectTask([
      ...validating,
      makeEvent("task.validation_completed", 6, { outcome: "failed" }),
      makeEvent("task.completed", 7),
    ])).toThrow(/successful.*validation evidence/i);
  });

  it.each(["task.writer_completed", "task.validation_completed"])(
    "rejects duplicate %s evidence",
    (type) => {
      const prefix = type === "task.writer_completed"
        ? [createdEvent(), makeEvent("task.leased", 2, { leaseOwner: "writer-1" }), makeEvent("task.started", 3)]
        : [
          createdEvent(),
          makeEvent("task.leased", 2, { leaseOwner: "writer-1" }),
          makeEvent("task.started", 3),
          makeEvent("task.writer_completed", 4, { outcome: "completed" }),
          makeEvent("task.validation_started", 5),
        ];
      const version = prefix.length + 1;
      expect(() => projectTask([
        ...prefix,
        makeEvent(type, version, { outcome: "completed" }),
        makeEvent(type, version + 1, { outcome: "completed" }),
      ])).toThrow(`duplicate ${type} event`);
    },
  );

  it("projects task.review_requested into awaiting_review", () => {
    expect(projectTask(happyPath().slice(0, 5))?.lifecycle).toBe("awaiting_review");
  });

  it("projects task.review_approved into integration_ready", () => {
    expect(projectTask(happyPath().slice(0, 6))?.lifecycle).toBe("integration_ready");
  });

  it("projects task.integration_started into integrating", () => {
    expect(projectTask(happyPath())?.lifecycle).toBe("integrating");
  });

  it("keeps task.integration_observed nonterminal and integrating", () => {
    const view = projectTask([
      ...happyPath(),
      makeEvent("task.integration_observed", 8, { receipt: { outcome: "completed" } }),
    ]);
    expect(view?.lifecycle).toBe("integrating");
    expect(view?.terminalOutcome).toBeNull();
    expect(view?.streamVersion).toBe(8);
  });

  it("keeps prepared and cleanup events integrating through durable cleanup", () => {
    const receipt = { outcome: "completed" };
    const events = [
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt }),
      makeEvent("task.integration_observed", 9, {
        receipt,
        verification: "verified",
      }),
      makeEvent("task.cleanup_started", 10),
      makeEvent("task.cleanup_completed", 11),
      makeEvent("task.completed", 12, { receipt }),
    ];

    expect(projectTask(events.slice(0, -1))).toMatchObject({
      lifecycle: "integrating",
      terminalOutcome: null,
      streamVersion: 11,
    });
    expect(projectTask(events)).toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
      streamVersion: 12,
    });
  });

  it.each([
    "task.integration_prepared",
    "task.integration_observed",
    "task.cleanup_started",
    "task.cleanup_completed",
    "task.cleanup_observed",
  ])("rejects duplicate %s evidence", (type) => {
    const prepared = makeEvent("task.integration_prepared", 8);
    const observed = makeEvent("task.integration_observed", 9, { verification: "verified" });
    const cleanupStarted = makeEvent("task.cleanup_started", 10);
    const prefix = type === "task.integration_prepared"
      ? [...happyPath(), prepared]
      : type === "task.integration_observed"
        ? [...happyPath(), prepared, observed]
        : type === "task.cleanup_started"
          ? [...happyPath(), prepared, observed, cleanupStarted]
          : [
              ...happyPath(),
              prepared,
              observed,
              cleanupStarted,
              makeEvent(type, 11),
            ];
    expect(() => projectTask([
      ...prefix,
      makeEvent(type, prefix.at(-1)!.streamVersion + 1),
    ])).toThrow(`duplicate ${type}`);
  });

  it("keeps task.commit_observed nonterminal and integration_ready", () => {
    const view = projectTask([
      ...happyPath().slice(0, 6),
      makeEvent("task.commit_observed", 7, { reason: "commit uncertain" }),
    ]);
    expect(view?.lifecycle).toBe("integration_ready");
    expect(view?.terminalOutcome).toBeNull();
    expect(view?.streamVersion).toBe(7);
  });

  it("projects task.completed into terminal with the completed outcome", () => {
    const view = projectTask([
      ...happyPath(),
      makeEvent("task.integration_prepared", 8),
      makeEvent("task.integration_observed", 9, { verification: "verified" }),
      makeEvent("task.cleanup_started", 10),
      makeEvent("task.cleanup_completed", 11),
      makeEvent("task.completed", 12),
    ]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("completed");
    expect(view?.streamVersion).toBe(12);
  });

  it.each([
    ["task.integration_observed", { verification: "verified" }],
    ["task.cleanup_started", {}],
    ["task.cleanup_completed", {}],
    ["task.cleanup_observed", {}],
    ["task.completed", {}],
  ] as const)("rejects out-of-order %s", (type, payload) => {
    expect(() => projectTask([...happyPath(), makeEvent(type, 8, payload)])).toThrow();
  });

  it("allows uncertain integration observation only as a nonterminal state", () => {
    const uncertain = [
      ...happyPath(),
      makeEvent("task.integration_observed", 8, { reason: "uncertain" }),
    ];
    expect(projectTask(uncertain)).toMatchObject({
      lifecycle: "integrating",
      terminalOutcome: null,
    });
    expect(() =>
      projectTask([...uncertain, makeEvent("task.cleanup_started", 9)]),
    ).toThrow();
    expect(() =>
      projectTask([...uncertain, makeEvent("task.completed", 9)]),
    ).toThrow();
  });

  it("rejects a verified observation whose receipt contradicts preparation", () => {
    expect(() => projectTask([
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt: { resultCommit: "a" } }),
      makeEvent("task.integration_observed", 9, {
        receipt: { resultCommit: "b" },
        verification: "verified",
      }),
    ])).toThrow(/receipt.*prepared|prepared.*receipt/i);
  });

  it("rejects cleanup completion facts that contradict cleanup start", () => {
    const cleanup = { sourceCommit: "a", resultCommit: "b", workspace: "/work", branch: "ticket/1" };
    expect(() => projectTask([
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt: { resultCommit: "b" } }),
      makeEvent("task.integration_observed", 9, {
        receipt: { resultCommit: "b" },
        verification: "verified",
      }),
      makeEvent("task.cleanup_started", 10, cleanup),
      makeEvent("task.cleanup_completed", 11, { ...cleanup, branch: "ticket/other" }),
    ])).toThrow(/cleanup.*facts|facts.*cleanup/i);
  });

  it("completes from cleanup reconciliation bound to observed uncertainty and cleanup facts", () => {
    const receipt = { resultCommit: "b" };
    const cleanup = { sourceCommit: "a", resultCommit: "b", workspace: "/work", branch: "ticket/1" };
    const observation = { phase: "ref_deletion", uncertain: true, evidence: {}, reason: "unknown" };
    const events = [
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt }),
      makeEvent("task.integration_observed", 9, { receipt, verification: "verified" }),
      makeEvent("task.cleanup_started", 10, cleanup),
      makeEvent("task.cleanup_observed", 11, observation),
      makeEvent("task.cleanup_reconciled", 12, { cleanup, observation }),
      makeEvent("task.completed", 13, { receipt }),
    ];

    expect(projectTask(events)).toMatchObject({
      lifecycle: "terminal",
      terminalOutcome: "completed",
      streamVersion: 13,
    });
  });

  it("rejects cleanup reconciliation without matching uncertainty and target facts", () => {
    const receipt = { resultCommit: "b" };
    const cleanup = { sourceCommit: "a", resultCommit: "b", workspace: "/work", branch: "ticket/1" };
    const throughCleanup = [
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt }),
      makeEvent("task.integration_observed", 9, { receipt, verification: "verified" }),
      makeEvent("task.cleanup_started", 10, cleanup),
    ];
    expect(() => projectTask([
      ...throughCleanup,
      makeEvent("task.cleanup_reconciled", 11, { cleanup, observation: {} }),
    ])).toThrow();
    const observation = { phase: "ref_deletion", uncertain: true, evidence: {}, reason: "unknown" };
    expect(() => projectTask([
      ...throughCleanup,
      makeEvent("task.cleanup_observed", 11, observation),
      makeEvent("task.cleanup_reconciled", 12, {
        cleanup: { ...cleanup, workspace: "/other" },
        observation,
      }),
    ])).toThrow(/cleanup.*facts|facts.*cleanup/i);
  });

  it("rejects terminal completion whose receipt contradicts verified observation", () => {
    const receipt = { resultCommit: "b" };
    const cleanup = { sourceCommit: "a", resultCommit: "b", workspace: "/work", branch: "ticket/1" };
    expect(() => projectTask([
      ...happyPath(),
      makeEvent("task.integration_prepared", 8, { receipt }),
      makeEvent("task.integration_observed", 9, { receipt, verification: "verified" }),
      makeEvent("task.cleanup_started", 10, cleanup),
      makeEvent("task.cleanup_completed", 11, cleanup),
      makeEvent("task.completed", 12, { receipt: { resultCommit: "other" } }),
    ])).toThrow(/completion.*receipt|receipt.*completion/i);
  });

  it("projects task.cancelled into terminal with the cancelled outcome", () => {
    const view = projectTask([createdEvent(), makeEvent("task.cancelled", 2)]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("cancelled");
  });

  it("projects task.failed into terminal with the failed outcome", () => {
    const events = [
      createdEvent(),
      makeEvent("task.leased", 2, { leaseOwner: "worker-1" }),
      makeEvent("task.failed", 3),
    ];
    const view = projectTask(events);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("failed");
  });

  it("projects task.timed_out into terminal with the timed_out outcome", () => {
    const view = projectTask([createdEvent(), makeEvent("task.timed_out", 2)]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("timed_out");
  });

  it("permits a separately supervised review to time out", () => {
    const view = projectTask([
      ...happyPath().slice(0, 5),
      makeEvent("task.timed_out", 6),
    ]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("timed_out");
  });

  it("permits a bounded commit to time out after review approval", () => {
    const view = projectTask([
      ...happyPath().slice(0, 6),
      makeEvent("task.timed_out", 7),
    ]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("timed_out");
  });

  it("projects task.denied into terminal with the denied outcome", () => {
    const view = projectTask([createdEvent(), makeEvent("task.denied", 2)]);
    expect(view?.lifecycle).toBe("terminal");
    expect(view?.terminalOutcome).toBe("denied");
  });

  it("throws when an event follows a terminal outcome", () => {
    const events = [
      createdEvent(),
      makeEvent("task.cancelled", 2),
      makeEvent("task.leased", 3),
    ];
    expect(() => projectTask(events)).toThrow("task is already terminal");
  });

  it("throws when the first event is not task.created", () => {
    expect(() => projectTask([makeEvent("task.leased", 1)])).toThrow();
  });

  it("throws on a duplicate task.created event", () => {
    expect(() => projectTask([createdEvent(), makeEvent("task.created", 2)])).toThrow();
  });

  it("rejects invalid transitions", () => {
    const skipLease = [createdEvent(), makeEvent("task.started", 2)];
    expect(() => projectTask(skipLease)).toThrow();

    const completeEarly = [
      createdEvent(),
      makeEvent("task.leased", 2, { leaseOwner: "worker-1" }),
      makeEvent("task.completed", 3),
    ];
    expect(() => projectTask(completeEarly)).toThrow();
  });

  it("throws on unknown event types", () => {
    expect(() => projectTask([createdEvent(), makeEvent("task.exploded", 2)])).toThrow();
  });

  it("rejects an undocumented repeated review request", () => {
    expect(() =>
      projectTask([
        ...happyPath().slice(0, 5),
        makeEvent("task.review_requested", 6),
      ]),
    ).toThrow("invalid transition from awaiting_review via task.review_requested");
  });
});

describe("TaskService", () => {
  function makeService(): { service: TaskService; journal: SqliteEventJournal } {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    return { service: new TaskService(journal), journal };
  }

  const createInput = {
    taskId: "task-1",
    projectId: "project-1",
    title: "Update greeting",
    correlationId: "goal-1",
  };

  it("creates a queued task", () => {
    const { service } = makeService();
    const view = service.create(createInput);
    expect(view).toEqual({
      taskId: "task-1",
      projectId: "project-1",
      title: "Update greeting",
      lifecycle: "queued",
      terminalOutcome: null,
      streamVersion: 1,
      leaseOwner: null,
      paused: false,
      stopAndAsk: null,
      uncertainEffect: null,
    });
  });

  it.each(["projectId", "title"] as const)(
    "rejects an empty %s without creating a stream",
    (field) => {
      const { service, journal } = makeService();

      expect(() => service.create({ ...createInput, [field]: "" })).toThrow(
        `task.created payload.${field} must be a nonempty string`,
      );
      expect(journal.readStream("task-1")).toEqual([]);

      const view = service.create(createInput);
      expect(view.lifecycle).toBe("queued");
      expect(view.streamVersion).toBe(1);
    },
  );

  it("rejects an empty taskId without creating a stream", () => {
    const { service, journal } = makeService();

    expect(() => service.create({ ...createInput, taskId: "" })).toThrow(
      "task.created streamId must be a nonempty string",
    );
    expect(journal.readStream("")).toEqual([]);
  });

  it("rejects creating a task that already exists", () => {
    const { service } = makeService();
    service.create(createInput);
    expect(() => service.create(createInput)).toThrow();
  });

  it("appends lifecycle events with the stream correlation id", () => {
    const { service, journal } = makeService();
    service.create(createInput);
    const view = service.append("task-1", "task.leased", { leaseOwner: "worker-1" }, "cause-1");
    expect(view.lifecycle).toBe("leased");
    expect(view.leaseOwner).toBe("worker-1");
    expect(view.streamVersion).toBe(2);

    const stored = journal.readStream("task-1");
    expect(stored[1]?.correlationId).toBe("goal-1");
    expect(stored[1]?.causationId).toBe("cause-1");
  });

  it("appends a validated nonempty event batch in one journal transaction", () => {
    const appendedBatches: string[][] = [];
    class RecordingJournal extends SqliteEventJournal {
      override append(
        ...args: Parameters<SqliteEventJournal["append"]>
      ): ReturnType<SqliteEventJournal["append"]> {
        appendedBatches.push(args[2].map((event) => event.type));
        return super.append(...args);
      }
    }
    const journal = new RecordingJournal(":memory:");
    journals.push(journal);
    const service = new TaskService(journal);
    service.create(createInput);
    appendedBatches.length = 0;

    const view = service.appendBatch("task-1", [
      { type: "task.leased", payload: { leaseOwner: "worker-1" }, causationId: null },
      { type: "task.started", payload: { workerId: "worker-1" }, causationId: "cause-2" },
    ]);

    expect(view).toMatchObject({ lifecycle: "running", streamVersion: 3 });
    expect(journal.readStream("task-1").map((stored) => stored.type)).toEqual([
      "task.created",
      "task.leased",
      "task.started",
    ]);
    expect(journal.readStream("task-1")[2]?.causationId).toBe("cause-2");
    expect(appendedBatches).toEqual([["task.leased", "task.started"]]);
  });

  it("delegates a single append through appendBatch", () => {
    const journal = new SqliteEventJournal(":memory:");
    journals.push(journal);
    let batchCalls = 0;
    class RecordingTaskService extends TaskService {
      override appendBatch(
        ...args: Parameters<TaskService["appendBatch"]>
      ): ReturnType<TaskService["appendBatch"]> {
        batchCalls += 1;
        return super.appendBatch(...args);
      }
    }
    const service = new RecordingTaskService(journal);
    service.create(createInput);

    service.append("task-1", "task.leased", { leaseOwner: "worker-1" }, null);

    expect(batchCalls).toBe(1);
  });

  it("rejects an empty batch without persistence", () => {
    const { service, journal } = makeService();
    service.create(createInput);

    expect(() => service.appendBatch("task-1", [])).toThrow("event batch must not be empty");
    expect(journal.readStream("task-1")).toHaveLength(1);
  });

  it("validates the full prospective batch before persisting any event", () => {
    const { service, journal } = makeService();
    service.create(createInput);

    expect(() => service.appendBatch("task-1", [
      { type: "task.leased", payload: { leaseOwner: "worker-1" }, causationId: null },
      { type: "task.review_requested", payload: {}, causationId: null },
    ])).toThrow("invalid transition from leased via task.review_requested");
    expect(journal.readStream("task-1").map((stored) => stored.type)).toEqual(["task.created"]);
  });

  it.each(taskServiceArtifactBoundaries())(
    "rolls back an incomplete marked $name artifact batch",
    ({ prefix, marker, recorded }) => {
      const { service, journal } = makeService();
      service.create(createInput);
      service.appendBatch("task-1", prefix);
      const before = journal.readStream("task-1");

      expect(() => service.appendBatch("task-1", [marker, recorded])).toThrow(
        "requires an immediate consuming lifecycle event",
      );
      expect(journal.readStream("task-1")).toEqual(before);
    },
  );

  it.each(taskServiceArtifactBoundaries())(
    "rolls back a marked $name artifact batch with the wrong consumer",
    ({ prefix, marker, recorded, wrongConsumer }) => {
      const { service, journal } = makeService();
      service.create(createInput);
      service.appendBatch("task-1", prefix);
      const before = journal.readStream("task-1");

      expect(() => service.appendBatch("task-1", [marker, recorded, wrongConsumer])).toThrow(
        "requires an immediate consuming lifecycle event",
      );
      expect(journal.readStream("task-1")).toEqual(before);
    },
  );

  it("rejects appending to an unknown task", () => {
    const { service } = makeService();
    expect(() => service.append("nope", "task.leased", {}, null)).toThrow();
  });

  it("rejects appending to a terminal task", () => {
    const { service } = makeService();
    service.create(createInput);
    service.append("task-1", "task.cancelled", {}, null);
    expect(() => service.append("task-1", "task.leased", {}, null)).toThrow(
      "task is already terminal",
    );
  });

  it.each(["task.started", "task.exploded"])(
    "does not persist a rejected %s append and remains usable",
    (type) => {
      const { service, journal } = makeService();
      service.create(createInput);

      expect(() => service.append("task-1", type, {}, null)).toThrow();
      expect(journal.readStream("task-1")).toHaveLength(1);
      expect(service.get("task-1")?.streamVersion).toBe(1);

      const view = service.append(
        "task-1",
        "task.leased",
        { leaseOwner: "worker-1" },
        null,
      );
      expect(view.lifecycle).toBe("leased");
      expect(view.streamVersion).toBe(2);
    },
  );

  it("validates the serialized payload before persistence and replay", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "zentra-task-service-"));
    temporaryDirectories.push(temporaryDirectory);
    const databasePath = join(temporaryDirectory, "journal.db");
    const firstJournal = new SqliteEventJournal(databasePath);
    journals.push(firstJournal);
    const firstService = new TaskService(firstJournal);
    firstService.create(createInput);

    const payload = {
      leaseOwner: "worker-1",
      toJSON: () => ({}),
    };
    expect(() =>
      firstService.append("task-1", "task.leased", payload, "cause-invalid"),
    ).toThrow("task.leased payload.leaseOwner must be a nonempty string");
    expect(firstJournal.readStream("task-1")).toHaveLength(1);

    firstJournal.close();
    journals.pop();
    const reopenedJournal = new SqliteEventJournal(databasePath);
    journals.push(reopenedJournal);
    const reopenedService = new TaskService(reopenedJournal);
    expect(reopenedService.get("task-1")?.lifecycle).toBe("queued");

    reopenedService.append(
      "task-1",
      "task.leased",
      { leaseOwner: "worker-1" },
      "cause-valid",
    );
    const replayed = reopenedJournal.readStream("task-1");
    expect(replayed).toHaveLength(2);
    expect(replayed[1]?.correlationId).toBe("goal-1");
    expect(replayed[1]?.causationId).toBe("cause-valid");
  });

  it.each([undefined, () => undefined, Symbol("payload"), 1n])(
    "rejects a non-JSON payload without persistence %#",
    (payload) => {
      const { service, journal } = makeService();
      service.create(createInput);

      expect(() =>
        service.append("task-1", "task.cancelled", payload, null),
      ).toThrow("event payload must be JSON-serializable");
      expect(journal.readStream("task-1")).toHaveLength(1);
    },
  );

  it("gets the projected view for an existing task and null otherwise", () => {
    const { service } = makeService();
    expect(service.get("task-1")).toBeNull();
    service.create(createInput);
    service.append("task-1", "task.leased", { leaseOwner: "worker-1" }, null);
    service.append("task-1", "task.started", {}, null);
    const view = service.get("task-1");
    expect(view?.lifecycle).toBe("running");
    expect(view?.streamVersion).toBe(3);
  });

  it("rejects contradictory integration and cleanup facts before persistence", () => {
    const { service, journal } = makeService();
    service.create(createInput);
    service.append("task-1", "task.leased", { leaseOwner: "worker-1" }, null);
    service.append("task-1", "task.started", {}, null);
    service.append("task-1", "task.validation_started", {}, null);
    service.append("task-1", "task.review_requested", {}, null);
    service.append("task-1", "task.review_approved", {}, null);
    service.append("task-1", "task.integration_started", {}, null);
    const receipt = { resultCommit: "result" };
    service.append("task-1", "task.integration_prepared", { receipt }, null);

    expect(() => service.append("task-1", "task.integration_observed", {
      receipt: { resultCommit: "other" },
      verification: "verified",
    }, null)).toThrow(/receipt.*prepared|prepared.*receipt/i);
    expect(journal.readStream("task-1")).toHaveLength(8);

    service.append("task-1", "task.integration_observed", {
      receipt,
      verification: "verified",
    }, null);
    const cleanup = { sourceCommit: "source", resultCommit: "result", workspace: "/work", branch: "ticket/task-1" };
    service.append("task-1", "task.cleanup_started", cleanup, null);
    expect(() => service.append("task-1", "task.cleanup_completed", {
      ...cleanup,
      workspace: "/other",
    }, null)).toThrow(/cleanup.*facts|facts.*cleanup/i);
    expect(journal.readStream("task-1")).toHaveLength(10);

    service.append("task-1", "task.cleanup_completed", cleanup, null);
    expect(() => service.append("task-1", "task.completed", {
      receipt: { resultCommit: "other" },
    }, null)).toThrow(/completion.*receipt|receipt.*completion/i);
    expect(journal.readStream("task-1")).toHaveLength(11);
  });
});

const artifactDigest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const servicePatch = {
  diff: "diff",
  diffSha256: artifactDigest("diff"),
  changedPath: "greeting.txt",
  changedContentSha256: artifactDigest("hello\n"),
};
const serviceValidation = {
  name: "focused",
  outcome: "completed" as const,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  startedAt: "2026-07-13T00:00:00.000Z",
  finishedAt: "2026-07-13T00:00:01.000Z",
  command: ["/usr/bin/node", "--test"],
  argvSha256: artifactDigest(JSON.stringify(["/usr/bin/node", "--test"])),
  outputSha256: artifactDigest(JSON.stringify({ stdout: "ok\n", stderr: "" })),
  provenance: {
    invocationId: "validation-1",
    canonicalCwd: "/workspace",
    subjectSha256: servicePatch.diffSha256,
  },
};
const serviceReview = {
  reviewerId: "reviewer-1",
  approved: true,
  diffSha256: servicePatch.diffSha256,
  validationSha256: artifactEvidenceSha256("validation_report", serviceValidation),
  decidedAt: "2026-07-13T00:00:02.000Z",
  reason: "approved",
};
const serviceFullValidation = {
  ...serviceValidation,
  name: "full",
  provenance: { ...serviceValidation.provenance, subjectSha256: "c".repeat(40) },
};
const serviceReceipt = {
  taskId: "task-1",
  projectId: "project-1",
  sourceCommit: "a".repeat(40),
  originalIntegrationCommit: "b".repeat(40),
  resultCommit: "c".repeat(40),
  review: serviceReview,
  validation: serviceFullValidation,
  outcome: "completed" as const,
};

type ServiceInput = {
  type: string;
  payload: unknown;
  causationId: null;
};

function serviceArtifact(kind: "patch" | "validation_report" | "review_report" | "integration_receipt", evidence: unknown, phase?: "prepared" | "final"): ServiceInput {
  const sha256 = artifactEvidenceSha256(kind, evidence);
  return {
    type: `artifact.${kind}_recorded`,
    payload: {
      artifact: {
        artifactId: `artifact-${kind}-${phase ?? "only"}`,
        taskId: "task-1",
        kind,
        path: `artifacts/${kind}.json`,
        sha256,
        createdAt: "2026-07-13T00:00:03.000Z",
      },
      evidence,
      ...(phase === undefined ? {} : { phase }),
    },
    causationId: null,
  };
}

function serviceMarker(recorded: ServiceInput): ServiceInput {
  const artifact = (recorded.payload as { artifact: { artifactId: string; kind: string; sha256: string } }).artifact;
  return {
    type: "task.artifact_recording",
    payload: {
      artifactProtocolVersion: 1,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      sha256: artifact.sha256,
    },
    causationId: null,
  };
}

function taskServiceArtifactBoundaries(): readonly {
  name: string;
  prefix: ServiceInput[];
  marker: ServiceInput;
  recorded: ServiceInput;
  wrongConsumer: ServiceInput;
}[] {
  const lifecycle = (type: string, payload: unknown = {}): ServiceInput => ({ type, payload, causationId: null });
  const patchArtifact = serviceArtifact("patch", servicePatch);
  const throughValidation = [
    lifecycle("task.leased", { leaseOwner: "worker-1" }),
    lifecycle("task.started", { workerId: "worker-1" }),
    patchArtifact,
    lifecycle("task.validation_started", {
      diffSha256: servicePatch.diffSha256,
      patch: { path: servicePatch.changedPath, sha256: servicePatch.changedContentSha256 },
    }),
  ];
  const validationArtifact = serviceArtifact("validation_report", serviceValidation);
  const throughReviewRequest = [
    ...throughValidation,
    validationArtifact,
    lifecycle("task.review_requested", { reviewerId: "reviewer-1", validation: serviceValidation }),
  ];
  const reviewArtifact = serviceArtifact("review_report", serviceReview);
  const throughIntegration = [
    ...throughReviewRequest,
    reviewArtifact,
    lifecycle("task.review_approved", { review: serviceReview }),
    lifecycle("task.integration_started", { sourceCommit: serviceReceipt.sourceCommit, review: serviceReview }),
  ];
  const preparedArtifact = serviceArtifact("integration_receipt", serviceReceipt, "prepared");
  const failedReceipt = { ...serviceReceipt, outcome: "failed" as const };
  const failedArtifact = serviceArtifact("integration_receipt", failedReceipt, "final");
  return [
    {
      name: "patch",
      prefix: throughValidation.slice(0, 2),
      marker: serviceMarker(patchArtifact),
      recorded: patchArtifact,
      wrongConsumer: lifecycle("task.failed"),
    },
    {
      name: "focused validation",
      prefix: throughValidation,
      marker: serviceMarker(validationArtifact),
      recorded: validationArtifact,
      wrongConsumer: lifecycle("task.denied", { validation: serviceValidation }),
    },
    {
      name: "review",
      prefix: throughReviewRequest,
      marker: serviceMarker(reviewArtifact),
      recorded: reviewArtifact,
      wrongConsumer: lifecycle("task.denied", { review: serviceReview }),
    },
    {
      name: "prepared integration receipt",
      prefix: throughIntegration,
      marker: serviceMarker(preparedArtifact),
      recorded: preparedArtifact,
      wrongConsumer: lifecycle("task.failed", { receipt: serviceReceipt }),
    },
    {
      name: "final failure integration receipt",
      prefix: throughIntegration,
      marker: serviceMarker(failedArtifact),
      recorded: failedArtifact,
      wrongConsumer: lifecycle("task.cancelled", { receipt: failedReceipt }),
    },
  ];
}
