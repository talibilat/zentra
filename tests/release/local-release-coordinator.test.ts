import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { LocalReleaseCoordinator } from "../../src/release/local-release-coordinator.js";
import { createLocalReleasePacket } from "../../src/release/local-release-runner.js";
import { RELEASE_BLOCKED_OPERATIONS, RELEASE_PREPARED_MESSAGE, RELEASE_TRUSTED_PROJECT_NOTICE } from "../../src/release/release-events.js";

describe("LocalReleaseCoordinator", () => {
  it("binds no_release_operations then pauses before worktree or command effects", async () => {
    const fixture = coordinatorFixture("no_release_operations");
    const runner = { run: vi.fn() };
    const coordinator = coordinatorWithRunner(fixture, runner);

    const result = await coordinator.run(request(fixture.security));

    expect(result.status).toBe("blocked");
    expect(result.blockedOperations).toEqual(RELEASE_BLOCKED_OPERATIONS);
    expect(fixture.transitions).toEqual(["bound", "paused"]);
    expect(runner.run).not.toHaveBeenCalled();
    fixture.journal.close();
  });

  it("requires exactly one deterministic local release verifier", async () => {
    const fixture = coordinatorFixture("local_preparation_only");
    fixture.milestone.plan.tasks[1].roleAssignment.harness = "opencode";
    const coordinator = coordinatorWithRunner(fixture, {});
    await expect(coordinator.run(request(fixture.security))).rejects.toThrow("exactly one verifier");
    fixture.journal.close();
  });

  it("runs after durable verified integration, completes the verifier, and pauses at the release boundary", async () => {
    const fixture = coordinatorFixture("approval_required_for_remote");
    const release = preparedResult();
    const coordinator = coordinatorWithRunner(fixture, successfulOutcomeRunner(fixture.journal, release));

    const result = await coordinator.run(request(fixture.security));

    expect(result.status).toBe("prepared_local_only");
    expect(result.milestone.lifecycle).toBe("paused");
    expect(fixture.transitions).toEqual(["bound", "started", "completed:completed", "paused"]);
    fixture.journal.close();
  });

  it("rejects a new release identity after an uncertain operation is durably bound", async () => {
    const fixture = coordinatorFixture("local_preparation_only");
    fixture.milestone.releaseOperation = {
      schemaVersion: 1, releaseId: "release-old", taskId: "verifier",
      packetDigest: "a".repeat(64), verifierAdmissionDigest: "c".repeat(64),
    };
    fixture.milestone.tasks.verifier.status = "running";
    const runner = { run: vi.fn() };
    const coordinator = coordinatorWithRunner(fixture, runner);

    await expect(coordinator.run(request(fixture.security, "release-new"))).rejects.toThrow(/release-old|already bound/i);
    expect(runner.run).not.toHaveBeenCalled();
    fixture.journal.close();
  });

  it("returns same-ID prepared evidence after release-boundary pause without rerunning", async () => {
    const fixture = coordinatorFixture("local_preparation_only");
    const packet = await createLocalReleasePacket({
      releaseId: "release-1", milestoneId: "m", taskId: "verifier", project: fixture.project,
      resultCommit: fixture.commit, securityDigest: digestCanonical(fixture.security),
      authorityDigest: digestCanonical(fixture.milestone.authorityEnvelope), verifierAdmissionDigest: "c".repeat(64),
    });
    const packetDigest = digestCanonical(packet);
    fixture.milestone.releaseOperation = {
      schemaVersion: 1, releaseId: "release-1", taskId: "verifier", packetDigest,
      verifierAdmissionDigest: "c".repeat(64),
    };
    fixture.milestone.lifecycle = "paused";
    fixture.milestone.attention = { reason: "release_boundary" };
    fixture.milestone.tasks.verifier = { status: "completed", terminalOutcome: "completed", admissionDigest: "c".repeat(64) };
    fixture.journal.append("release:release-1", 0, [{
      streamId: "release:release-1", type: "release.created", payload: { schemaVersion: 1, packet, packetDigest },
      causationId: null, correlationId: "m",
    }, {
      streamId: "release:release-1", type: "release.prepared_local_only", payload: {
        schemaVersion: 1, status: "prepared_local_only", blockedOperations: RELEASE_BLOCKED_OPERATIONS,
        message: RELEASE_PREPARED_MESSAGE, authorityModel: "trusted_project_config",
        trustedProjectCodeNotice: RELEASE_TRUSTED_PROJECT_NOTICE,
      }, causationId: null, correlationId: "m",
    }]);
    const retainedReleaseEvents = fixture.journal.readStream("release:release-1");
    fixture.journal.append("m", 0, [{
      streamId: "m", type: "milestone.task_completed", payload: {
        taskId: "verifier", actorId: "verifier", role: "verifier", outcome: "completed",
        evidence: {
          schemaVersion: 1, releaseStreamId: "release:release-1", packetDigest,
          resultCommit: fixture.commit, status: "prepared_local_only",
          releaseEvents: [retainedReleaseEvents[0], retainedReleaseEvents.at(-1)].map((event: any) => ({
            streamId: event.streamId, eventId: event.eventId, eventType: event.type,
            streamVersion: event.streamVersion, payloadDigest: digestCanonical(event.payload),
          })), artifacts: [],
        },
      }, causationId: null, correlationId: "trace",
    }]);
    const runner = { run: vi.fn() };
    const coordinator = coordinatorWithRunner(fixture, runner);

    const result = await coordinator.run(request(fixture.security));

    expect(result.status).toBe("prepared_local_only");
    expect(runner.run).not.toHaveBeenCalled();
    expect(fixture.transitions).toEqual([]);
    fixture.journal.close();
  });

  it.each([
    ["build", "failed"], ["build", "cancelled"], ["build", "timed_out"],
    ["package", "failed"], ["package", "cancelled"], ["package", "timed_out"],
    ["verify", "failed"], ["verify", "cancelled"], ["verify", "timed_out"],
  ] as const)("durably completes a known %s %s outcome and converges on replay", async (step, outcome) => {
    const fixture = coordinatorFixture("local_preparation_only");
    const runner = knownOutcomeRunner(fixture.journal, step, outcome);
    const coordinator = coordinatorWithRunner(fixture, runner);

    const first = await coordinator.run(request(fixture.security));
    const second = await coordinator.run(request(fixture.security));

    expect(first.status).toBe(outcome);
    expect(second.status).toBe(outcome);
    expect(first.milestone.tasks.verifier?.terminalOutcome).toBe(outcome);
    expect(second.milestone.tasks.verifier?.terminalOutcome).toBe(outcome);
    expect(fixture.transitions).toEqual(["bound", "started", `completed:${outcome}`]);
    expect(fixture.completionEvidence.releaseEvents).toHaveLength(2);
    expect(fixture.completionEvidence.releaseEvents.every((reference: any) => reference.streamId === "release:release-1")).toBe(true);
    fixture.journal.close();
  });

  it.each(["artifact", "refs"] as const)("durably completes a known %s validation failure", async (stage) => {
    const fixture = coordinatorFixture("local_preparation_only");
    const coordinator = coordinatorWithRunner(fixture, knownValidationFailureRunner(fixture.journal, stage));

    const result = await coordinator.run(request(fixture.security));

    expect(result.status).toBe("failed");
    expect(result.milestone.tasks.verifier?.terminalOutcome).toBe("failed");
    expect(fixture.completionEvidence.releaseEvents[1].eventType).toBe("release.failed");
    fixture.journal.close();
  });

  it("fails closed on forged retained release completion evidence without invoking the runner", async () => {
    const fixture = coordinatorFixture("local_preparation_only");
    const runner = knownOutcomeRunner(fixture.journal, "build", "failed");
    const coordinator = coordinatorWithRunner(fixture, runner);
    await coordinator.run(request(fixture.security));
    const completion = fixture.journal.readStream("m").find((event: any) => event.type === "milestone.task_completed");
    expect(completion).toBeDefined();
    const forgedJournal = {
      readStream: (streamId: string, afterVersion?: number) => fixture.journal.readStream(streamId, afterVersion).map((event: any) =>
        event.type === "milestone.task_completed"
          ? { ...event, payload: { ...event.payload, evidence: { ...event.payload.evidence, packetDigest: "0".repeat(64) } } }
          : event),
      readAll: (afterPosition?: number) => fixture.journal.readAll(afterPosition),
      append: () => { throw new Error("forged replay must not append"); },
    };
    const replayRunner = { run: vi.fn() };
    const replay = new LocalReleaseCoordinator(forgedJournal as never, fixture.registry as never, fixture.projects as never);
    (replay as unknown as { runner: unknown }).runner = replayRunner;

    await expect(replay.run(request(fixture.security))).rejects.toThrow(/completion evidence|contradicts|retained/i);
    expect(replayRunner.run).not.toHaveBeenCalled();
    fixture.journal.close();
  });

  it("replays a production-runner build failure from journal after disposable Git and worktree state changes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-release-coordinator-replay-"));
    const repository = path.join(root, "repository");
    const worktrees = path.join(root, "worktrees");
    mkdirSync(repository);
    mkdirSync(worktrees);
    try {
      git(repository, "init", "-b", "main");
      git(repository, "config", "user.email", "fixture@example.test");
      git(repository, "config", "user.name", "Fixture");
      writeFileSync(path.join(repository, "build.mjs"), "process.exit(7);\n");
      writeFileSync(path.join(repository, "package.mjs"), "process.exit(0);\n");
      writeFileSync(path.join(repository, "verify.mjs"), "process.exit(0);\n");
      git(repository, "add", ".");
      git(repository, "commit", "-m", "fixture");
      git(repository, "branch", "zentra/integration");
      const commit = git(repository, "rev-parse", "HEAD").trim();
      const fixture = coordinatorFixture("local_preparation_only", commit);
      fixture.project = {
        ...fixture.project, repositoryPath: repository, worktreeRoot: worktrees,
        releasePreparation: {
          build: [process.execPath, "build.mjs"], package: [process.execPath, "package.mjs"], verify: [process.execPath, "verify.mjs"],
          buildTimeoutMs: 5_000, packageTimeoutMs: 5_000, verifyTimeoutMs: 5_000, artifacts: ["dist/package.tgz"],
        },
      };
      fixture.projects.get = vi.fn(() => fixture.project);
      const coordinator = new LocalReleaseCoordinator(fixture.journal, fixture.registry as never, fixture.projects as never);

      const first = await coordinator.run(request(fixture.security));
      expect(first.status).toBe("failed");
      expect(first.milestone.tasks.verifier?.terminalOutcome).toBe("failed");
      const beforeReplay = fixture.journal.readAll();
      git(repository, "branch", "unrelated-after-failure", "HEAD");
      rmSync(first.release!.worktreePath, { recursive: true, force: true });
      rmSync(path.join(worktrees, ".release-release-1-environment"), { recursive: true, force: true });
      writeFileSync(path.join(repository, "build.mjs"), "process.exit(0);\n");

      const second = await new LocalReleaseCoordinator(
        fixture.journal, fixture.registry as never, fixture.projects as never,
      ).run(request(fixture.security));

      expect(second.status).toBe("failed");
      expect(second.release).toEqual(first.release);
      expect(second.milestone.tasks.verifier?.terminalOutcome).toBe("failed");
      expect(fixture.projects.get).toHaveBeenCalledTimes(1);
      expect(fixture.journal.readAll()).toEqual(beforeReplay);
      expect(() => git(repository, "show-ref", "--verify", "refs/heads/unrelated-after-failure")).not.toThrow();
      expect(existsSync(first.release!.worktreePath)).toBe(false);
      fixture.journal.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function coordinatorFixture(releaseBoundary: string, commit = "a".repeat(40)): any {
  const journal = new SqliteEventJournal(":memory:");
  journal.append("writer", 0, [{
    streamId: "writer", type: "task.integration_observed", correlationId: "trace", causationId: null,
    payload: { verification: "verified", receipt: { taskId: "writer", projectId: "p", outcome: "completed", resultCommit: commit } },
  }]);
  const security = { releaseBoundary, stopAndAskConditions: ["release_boundary"] };
  const project: ProjectConfig = {
    projectId: "p", repositoryPath: "/tmp", worktreeRoot: "/tmp", integrationBranch: "zentra/integration",
    validations: { focused: [process.execPath], full: [process.execPath], focusedTimeoutMs: 1_000, fullTimeoutMs: 1_000 },
    releasePreparation: {
      build: [process.execPath, "build.mjs"], package: [process.execPath, "package.mjs"], verify: [process.execPath, "verify.mjs"],
      buildTimeoutMs: 1_000, packageTimeoutMs: 1_000, verifyTimeoutMs: 1_000, artifacts: ["dist/package.tgz"],
    },
  };
  let milestone: any = {
    milestoneId: "m", projectId: "p", lifecycle: "running", terminalOutcome: null,
    attention: null, releaseOperation: null,
    authorityEnvelope: { securityDigest: digestCanonical(security), envelope: "durable" },
    tasks: {
      writer: { status: "completed", terminalOutcome: "completed", admissionDigest: "d".repeat(64) },
      verifier: { status: "ready", terminalOutcome: null, admissionDigest: "c".repeat(64) },
    },
    writerOwnership: { writer: { status: "integrated" } },
    plan: { milestoneId: "m", projectId: "p", tasks: [
      { taskId: "writer", roleAssignment: { role: "implementer", harness: "deterministic", agentId: "writer" }, risk: { authority: "workspace_write" } },
      { taskId: "verifier", roleAssignment: { role: "verifier", harness: "deterministic", agentId: "verifier" }, risk: { authority: "local_release_preparation" } },
    ] },
  };
  const transitions: string[] = [];
  const registry = {
    inspect: () => milestone,
    bindReleaseOperation: (_id: string, binding: unknown) => {
      transitions.push("bound"); milestone = { ...milestone, releaseOperation: binding }; fixture.milestone = milestone; return milestone;
    },
    startTask: () => {
      transitions.push("started"); milestone = { ...milestone, tasks: { ...milestone.tasks, verifier: { ...milestone.tasks.verifier, status: "running" } } }; fixture.milestone = milestone; return milestone;
    },
    completeTask: (_milestoneId: string, _taskId: string, outcome: string, evidence: unknown) => {
      if (milestone.tasks.verifier.status !== "completed") {
        transitions.push(`completed:${outcome}`);
        journal.append("m", journal.readStream("m").length, [{
          streamId: "m", type: "milestone.task_completed", payload: {
            taskId: "verifier", actorId: "verifier", role: "verifier", outcome, evidence,
          }, causationId: null, correlationId: "trace",
        }]);
      }
      fixture.completionEvidence = evidence;
      milestone = { ...milestone, tasks: { ...milestone.tasks, verifier: { ...milestone.tasks.verifier, status: "completed", terminalOutcome: outcome } } }; fixture.milestone = milestone; return milestone;
    },
    pauseForReleaseBoundary: () => {
      transitions.push("paused"); milestone = { ...milestone, lifecycle: "paused", attention: { reason: "release_boundary" } }; fixture.milestone = milestone; return milestone;
    },
  };
  const fixture: any = { journal, commit, security, project, milestone, transitions, registry, projects: { get: () => project }, completionEvidence: null };
  return fixture;
}

function coordinatorWithRunner(fixture: any, runner: unknown): LocalReleaseCoordinator {
  const coordinator = new LocalReleaseCoordinator(fixture.journal, fixture.registry as never, fixture.projects as never);
  (coordinator as unknown as { runner: unknown }).runner = runner;
  return coordinator;
}

function knownOutcomeRunner(journal: SqliteEventJournal, step: "build" | "package" | "verify", outcome: "failed" | "cancelled" | "timed_out") {
  return { run: vi.fn(async ({ packet }: any) => {
    const streamId = `release:${packet.releaseId}`;
    if (journal.readStream(streamId).length === 0) {
      const packetDigest = digestCanonical(packet);
      journal.append(streamId, 0, [{
        streamId, type: "release.created", payload: { schemaVersion: 1, packet, packetDigest }, causationId: null, correlationId: packet.milestoneId,
      }, {
        streamId, type: "release.step_started", payload: { schemaVersion: 1, name: step, argvSha256: digestCanonical(packet.commands[step].argv) }, causationId: null, correlationId: packet.milestoneId,
      }, {
        streamId, type: "release.step_observed", payload: {
          schemaVersion: 1, name: step, argvSha256: digestCanonical(packet.commands[step].argv), outcome,
          exitCode: outcome === "failed" ? 1 : null, stdout: "", stderr: "", outputSha256: "e".repeat(64),
        }, causationId: null, correlationId: packet.milestoneId,
      }]);
    }
    return { ...preparedResult(), status: outcome, steps: [{ name: step, outcome }], artifacts: [] };
  }) };
}

function successfulOutcomeRunner(journal: SqliteEventJournal, release: any) {
  return { run: vi.fn(async ({ packet }: any) => {
    const streamId = `release:${packet.releaseId}`;
    if (journal.readStream(streamId).length === 0) {
      const packetDigest = digestCanonical(packet);
      journal.append(streamId, 0, [{
        streamId, type: "release.created", payload: { schemaVersion: 1, packet, packetDigest }, causationId: null, correlationId: packet.milestoneId,
      }, {
        streamId, type: "release.prepared_local_only", payload: {
          schemaVersion: 1, status: "prepared_local_only", blockedOperations: RELEASE_BLOCKED_OPERATIONS,
          message: RELEASE_PREPARED_MESSAGE, authorityModel: "trusted_project_config",
          trustedProjectCodeNotice: RELEASE_TRUSTED_PROJECT_NOTICE,
        }, causationId: null, correlationId: packet.milestoneId,
      }]);
    }
    return { ...release, releaseId: packet.releaseId };
  }) };
}

function knownValidationFailureRunner(journal: SqliteEventJournal, stage: "artifact" | "refs") {
  return { run: vi.fn(async ({ packet }: any) => {
    const streamId = `release:${packet.releaseId}`;
    const packetDigest = digestCanonical(packet);
    journal.append(streamId, 0, [{
      streamId, type: "release.created", payload: { schemaVersion: 1, packet, packetDigest }, causationId: null, correlationId: packet.milestoneId,
    }, {
      streamId, type: "release.failed", payload: {
        schemaVersion: 1, stage, reason: stage === "artifact" ? "unsafe_artifact" : "ref_mutation",
      }, causationId: null, correlationId: packet.milestoneId,
    }]);
    return { ...preparedResult(), releaseId: packet.releaseId, status: "failed", artifacts: [] };
  }) };
}

function request(security: any, releaseId = "release-1") {
  return { releaseId, milestoneId: "m", security, signal: new AbortController().signal };
}

function preparedResult(): any {
  return {
    releaseId: "release-1", status: "prepared_local_only", worktreePath: "/release", steps: [],
    artifacts: [{ path: "dist/package.tgz", size: 1, sha256: "b".repeat(64) }],
    blockedOperations: RELEASE_BLOCKED_OPERATIONS, message: RELEASE_PREPARED_MESSAGE,
    authorityModel: "trusted_project_config", trustedProjectCodeNotice: RELEASE_TRUSTED_PROJECT_NOTICE,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
