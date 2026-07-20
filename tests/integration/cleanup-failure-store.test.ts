import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CleanupFailureStore,
  CleanupFailureEventRecordSchema,
  CleanupFailureRecordSchema,
  cleanupFailureStoreReference,
  MAX_CLEANUP_FAILURE_EVENTS,
  MAX_UNACKNOWLEDGED_CLEANUP_FAILURES,
  type NewCleanupFailure,
} from "../../src/integration/cleanup-failure-store.js";
import { IntegrationQueue } from "../../src/integration/integration-queue.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ValidationRunner } from "../../src/capabilities/validation-runner.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { createHash } from "node:crypto";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("CleanupFailureStore", () => {
  it("replays unacknowledged failures after restart as historical lease evidence", async () => {
    const databasePath = await temporaryDatabase();
    const first = new CleanupFailureStore(databasePath);
    const recorded = first.record(failure());
    first.close();

    const restarted = new CleanupFailureStore(databasePath);
    expect(restarted.listUnacknowledged(scope())).toEqual([recorded]);
    expect(restarted.listUnacknowledged(scope())[0]?.lease).toMatchObject({
      ownerToken: "owner-token-1",
      authority: "historical_evidence_only",
    });
    restarted.close();
  });

  it("uses one strict event schema for durable records and persisted legacy evidence", () => {
    const storeRecord = {
      ...failure(),
      recordId: "9ca3d4e9-5413-4a0b-bf77-791bd8f7847d",
      lease: {
        ...failure().lease!,
        authority: "historical_evidence_only" as const,
      },
      acknowledgement: null,
    };
    expect(CleanupFailureRecordSchema.parse(storeRecord)).toEqual(storeRecord);
    expect(CleanupFailureEventRecordSchema.parse({
      projectId: "legacy-project",
      taskId: "legacy-task",
      candidatePath: "/legacy/candidate",
      reason: "legacy cleanup failure",
      timestamp: "2026-07-19T12:00:00.000Z",
    })).toMatchObject({ taskId: "legacy-task" });
    expect(() => CleanupFailureEventRecordSchema.parse({
      ...storeRecord,
      unrelated: "not admitted",
    })).toThrow();
    expect(cleanupFailureStoreReference([storeRecord])).toMatchObject({
      schemaVersion: 1,
      recordIds: [storeRecord.recordId],
      recordsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("durably acknowledges a failure with disposition evidence", async () => {
    const databasePath = await temporaryDatabase();
    const first = new CleanupFailureStore(databasePath);
    const recorded = first.record(failure());
    const acknowledged = first.acknowledge({
      recordId: recorded.recordId,
      actor: "operator:talib",
      acknowledgedAt: "2026-07-20T12:00:00.000Z",
      dispositionEvidence: "candidate inspected and removed at commit abc123",
    });
    expect(first.listUnacknowledged(scope())).toEqual([]);
    first.close();

    const restarted = new CleanupFailureStore(databasePath);
    expect(restarted.getHistory(scope())).toEqual([acknowledged]);
    expect(acknowledged.acknowledgement).toEqual({
      actor: "operator:talib",
      acknowledgedAt: "2026-07-20T12:00:00.000Z",
      dispositionEvidence: "candidate inspected and removed at commit abc123",
    });
    restarted.close();
  });

  it("fails closed at the unacknowledged count bound without discarding records", async () => {
    const store = new CleanupFailureStore(await temporaryDatabase());
    for (let index = 0; index < MAX_UNACKNOWLEDGED_CLEANUP_FAILURES; index++) {
      store.record(failure({ taskId: `task-${index}`, candidateId: `candidate-${index}` }));
    }

    expect(() => store.record(failure({ taskId: "overflow" }))).toThrow(
      "cleanup failure journal unacknowledged count limit reached",
    );
    expect(store.stats().unacknowledgedCount).toBe(MAX_UNACKNOWLEDGED_CLEANUP_FAILURES);
    store.close();
  });

  it("rejects an individual record that exceeds the byte bound", async () => {
    const store = new CleanupFailureStore(await temporaryDatabase());
    expect(() => store.record(failure({ reason: "x".repeat(9_000) }))).toThrow(
      "cleanup failure journal event byte limit exceeded",
    );
    expect(store.stats()).toMatchObject({ eventCount: 0, eventBytes: 0 });
    store.close();
  });

  it("stays bounded through a long record and acknowledgement loop", async () => {
    const store = new CleanupFailureStore(await temporaryDatabase());
    for (let index = 0; index < MAX_CLEANUP_FAILURE_EVENTS * 4; index++) {
      const recorded = store.record(failure({
        taskId: `task-${index}`,
        candidateId: `candidate-${index}`,
      }));
      store.acknowledge({
        recordId: recorded.recordId,
        actor: "cleanup-worker",
        acknowledgedAt: new Date(1_700_000_000_000 + index).toISOString(),
        dispositionEvidence: `removed candidate-${index}`,
      });
    }

    expect(store.stats().eventCount).toBeLessThanOrEqual(MAX_CLEANUP_FAILURE_EVENTS);
    expect(store.stats().unacknowledgedCount).toBe(0);
    expect(store.getHistory({ ...scope(), taskId: `task-${MAX_CLEANUP_FAILURE_EVENTS * 4 - 1}` }))
      .toHaveLength(1);
    expect(store.getHistory({ ...scope(), taskId: "task-0" })).toEqual([]);
    store.close();
  });

  it("scopes current evidence by task, repository, ref, and lease owner token", async () => {
    const store = new CleanupFailureStore(await temporaryDatabase());
    const relevant = store.record(failure());
    store.record(failure({ taskId: "other-task", candidateId: "other-task-candidate" }));
    store.record(failure({
      commonDirectory: "/canonical/repository-b/.git",
      repositoryIdentitySha256: "b".repeat(64),
      candidateId: "other-repository-candidate",
    }));
    store.record(failure({
      integrationRef: "refs/heads/other",
      candidateId: "other-ref-candidate",
    }));
    store.record(failure({
      candidateId: "other-lease-candidate",
      lease: { ...failure().lease!, ownerToken: "owner-token-2" },
    }));

    expect(store.listUnacknowledged({ ...scope(), leaseOwnerToken: "owner-token-1" }))
      .toEqual([relevant]);
    store.close();
  });

  it("replays and acknowledges repository-scoped records through a restarted queue", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "zentra-cleanup-queue-"));
    temporaryDirectories.push(directory);
    const git = new GitClient();
    await gitSuccess(git, directory, ["init"]);
    const commonDirectory = await realpath(path.join(directory, ".git"));
    const store = new CleanupFailureStore(
      path.join(commonDirectory, ".zentra-integration-cleanup-failures.sqlite"),
    );
    const recorded = store.record(failure({
      commonDirectory,
      repositoryIdentitySha256: sha256(commonDirectory),
    }));
    store.close();

    const project: ProjectConfig = {
      projectId: "project-a",
      repositoryPath: directory,
      integrationBranch: "zentra/integration",
      worktreeRoot: directory,
      validations: {
        focused: [process.execPath, "--version"],
        full: [process.execPath, "--version"],
        focusedTimeoutMs: 1_000,
        fullTimeoutMs: 1_000,
      },
    };
    const restarted = new IntegrationQueue(
      git,
      new ValidationRunner(new ProcessSupervisor()),
    );
    expect(await restarted.getCleanupFailuresFor({ project, taskId: "task-1" }))
      .toEqual([recorded]);

    const acknowledged = await restarted.acknowledgeCleanupFailure({
      project,
      taskId: "task-1",
      recordId: recorded.recordId,
      actor: "operator:talib",
      dispositionEvidence: "candidate absence verified",
    });
    expect(acknowledged.acknowledgement).toMatchObject({
      actor: "operator:talib",
      dispositionEvidence: "candidate absence verified",
    });
    expect(await restarted.getCleanupFailuresFor({ project, taskId: "task-1" })).toEqual([]);
    expect(await restarted.getCleanupFailureHistoryFor({ project, taskId: "task-1" }))
      .toEqual([acknowledged]);
  });
});

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "zentra-cleanup-failures-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "cleanup.sqlite");
}

function scope() {
  return {
    commonDirectory: "/canonical/repository-a/.git",
    repositoryIdentitySha256: "a".repeat(64),
    integrationRef: "refs/heads/zentra/integration",
    taskId: "task-1",
  } as const;
}

function failure(overrides: Partial<NewCleanupFailure> = {}): NewCleanupFailure {
  return {
    projectId: "project-a",
    taskId: "task-1",
    commonDirectory: "/canonical/repository-a/.git",
    repositoryIdentitySha256: "a".repeat(64),
    integrationRef: "refs/heads/zentra/integration",
    candidateId: "candidate-1",
    candidatePath: "/worktrees/private/candidate-1",
    reason: "candidate cleanup failed",
    recordedAt: "2026-07-20T11:00:00.000Z",
    lease: {
      ownerToken: "owner-token-1",
      acquiredAt: 1_700_000_000_000,
      expiresAt: 1_700_000_010_000,
      pid: 123,
      hostname: "host-a",
    },
    ...overrides,
  };
}

async function gitSuccess(git: GitClient, cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  expect(result).toMatchObject({ exitCode: 0, termination: null, truncated: false });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
