import path from "node:path";

import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { uncertainEffectPayload } from "../../src/contracts/uncertain-effect.js";
import {
  cleanupFailureStoreReference,
  type CleanupFailureRecord,
} from "../../src/integration/cleanup-failure-store.js";
import { projectTaskDiagnostic } from "../../src/tasks/task-diagnostics.js";

function event(
  streamVersion: number,
  type: string,
  payload: unknown,
): StoredEvent {
  return {
    streamId: "task-diagnostic",
    eventId: `event-${streamVersion}`,
    streamVersion,
    globalPosition: streamVersion,
    recordedAt: "2026-07-20T00:00:00.000Z",
    type,
    payload,
    causationId: null,
    correlationId: "task-diagnostic",
  };
}

function failedEvents(reason: string): readonly StoredEvent[] {
  const workspace = path.resolve("/tmp/zentra-diagnostics/worktrees/task-diagnostic");
  return [
    event(1, "task.created", { projectId: "project-1", title: "Diagnostic task" }),
    event(2, "task.leased", { leaseOwner: "worker-1", workspace }),
    event(3, "task.started", { workerId: "worker-1" }),
    event(4, "task.failed", { stage: "worker", reason }),
  ];
}

describe("projectTaskDiagnostic", () => {
  it.each([
    "setup",
    "worker",
    "artifact",
    "validation",
    "review",
    "commit",
    "integration",
    "cleanup",
    "recovery",
  ] as const)("reports the stable %s failure stage", (stage) => {
    const workspace = path.resolve("/tmp/zentra-diagnostics/worktrees/task-diagnostic");
    const events: StoredEvent[] = [
      event(1, "task.created", { projectId: "project-1", title: "Diagnostic task" }),
    ];
    if (!["setup", "recovery"].includes(stage)) {
      events.push(event(events.length + 1, "task.leased", { leaseOwner: "worker-1", workspace }));
      events.push(event(events.length + 1, "task.started", { workerId: "worker-1" }));
    }
    if (["validation", "review", "commit", "integration", "cleanup"].includes(stage)) {
      events.push(event(events.length + 1, "task.validation_started", {}));
    }
    if (["review", "commit", "integration", "cleanup"].includes(stage)) {
      events.push(event(events.length + 1, "task.review_requested", {}));
    }
    if (["commit", "integration", "cleanup"].includes(stage)) {
      events.push(event(events.length + 1, "task.review_approved", {}));
    }
    if (["integration", "cleanup"].includes(stage)) {
      events.push(event(events.length + 1, "task.integration_started", {}));
    }
    events.push(event(events.length + 1, "task.failed", { stage, reason: "untrusted detail" }));

    expect(projectTaskDiagnostic(events, {
      recoveryAction: "record_failure",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
    })).toMatchObject({ stage, reasonCode: `${stage}_failed` });
  });

  it("derives a bounded stable failure view without reflecting raw reasons", () => {
    const canary = "sk-live-DIAGNOSTIC-SECRET";
    const diagnostic = projectTaskDiagnostic(failedEvents(
      `${canary}\u0000\nError at /Users/private/project: ${"x".repeat(8_000)}`,
    ), {
      recoveryAction: "record_failure",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
    });

    expect(diagnostic).toMatchObject({
      taskId: "task-diagnostic",
      stage: "worker",
      reasonCode: "worker_failed",
      message: "The task failed during worker execution.",
      recoveryAction: "record_failure",
      validation: null,
      artifacts: [],
      worktree: {
        branch: "ticket/task-diagnostic",
        path: path.resolve("/tmp/zentra-diagnostics/worktrees/task-diagnostic"),
      },
    });
    const output = JSON.stringify(diagnostic);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(2_048);
    expect(output).not.toContain(canary);
    expect(output).not.toContain("/Users/private");
    expect(output).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("omits a retained worktree path that is outside the configured identity", () => {
    const events = [...failedEvents("failed")];
    events[1] = event(2, "task.leased", {
      leaseOwner: "worker-1",
      workspace: "/Users/private/unintended-worktree",
    });

    expect(projectTaskDiagnostic(events, {
      recoveryAction: "record_failure",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
    }).worktree).toBeNull();
  });

  it("is deterministic across replay and does not require the worktree to exist", () => {
    const options = {
      recoveryAction: "await_reconciliation" as const,
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/missing-worktrees"),
    };
    expect(projectTaskDiagnostic(failedEvents("worker failed"), options)).toEqual(
      projectTaskDiagnostic(failedEvents("different raw failure"), options),
    );
  });

  it("fails closed on malformed event payloads", () => {
    const events = [...failedEvents("failed")];
    events[3] = event(4, "task.failed", { stage: "worker", reason: 42 });

    expect(() => projectTaskDiagnostic(events, {
      recoveryAction: "record_failure",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
    })).toThrow(/diagnostic event payload is invalid/i);
  });

  it("reports durable unacknowledged candidate cleanup evidence specifically", () => {
    const cleanupFailure = cleanupRecord();
    const events = integrationEvents({
      cleanupFailures: [cleanupFailure],
      cleanupFailureStore: cleanupFailureStoreReference([cleanupFailure]),
    }, true);

    expect(projectTaskDiagnostic(events, {
      recoveryAction: "await_reconciliation",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
      cleanupFailureHistory: [cleanupFailure],
    })).toMatchObject({
      stage: "cleanup",
      reasonCode: "candidate_cleanup_unacknowledged",
      message: "Candidate cleanup has durable unacknowledged failure evidence.",
      cleanup: { recordCount: 1, unacknowledgedCount: 1, acknowledgedCount: 0 },
    });
  });

  it("reports acknowledged cleanup as historical disposition evidence", () => {
    const retained = cleanupRecord();
    const acknowledged: CleanupFailureRecord = {
      ...retained,
      acknowledgement: {
        actor: "operator",
        acknowledgedAt: "2026-07-20T01:00:00.000Z",
        dispositionEvidence: "candidate absence verified with secret sk-live-HIDDEN",
      },
    };
    const events = integrationEvents({
      cleanupFailures: [retained],
      cleanupFailureStore: cleanupFailureStoreReference([retained]),
    }, true);

    const diagnostic = projectTaskDiagnostic(events, {
      recoveryAction: "await_reconciliation",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
      cleanupFailureHistory: [acknowledged],
    });
    expect(diagnostic).toMatchObject({
      reasonCode: "candidate_cleanup_acknowledged",
      recoveryAction: "await_reconciliation",
      cleanup: {
        recordCount: 1,
        unacknowledgedCount: 0,
        acknowledgedCount: 1,
        dispositions: [{
          recordId: retained.recordId,
          acknowledgedAt: "2026-07-20T01:00:00.000Z",
          dispositionEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }],
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("sk-live-HIDDEN");
  });

  it("rejects malformed cleanup evidence with a cleanup-specific diagnosis", () => {
    const cleanupFailure = cleanupRecord();
    const events = integrationEvents({
      cleanupFailures: [{ ...cleanupFailure, candidatePath: "relative" }],
      cleanupFailureStore: cleanupFailureStoreReference([cleanupFailure]),
    });

    expect(() => projectTaskDiagnostic(events, {
      recoveryAction: "await_reconciliation",
      worktreeRoot: path.resolve("/tmp/zentra-diagnostics/worktrees"),
    })).toThrow(/cleanup failure diagnostic evidence is invalid/i);
  });
});

function integrationEvents(payload: unknown, uncertain = false): readonly StoredEvent[] {
  const workspace = path.resolve("/tmp/zentra-diagnostics/worktrees/task-diagnostic");
  const events = [
    event(1, "task.created", { projectId: "project-1", title: "Diagnostic task" }),
    event(2, "task.leased", { leaseOwner: "worker-1", workspace }),
    event(3, "task.started", { workerId: "worker-1" }),
    event(4, "task.validation_started", {}),
    event(5, "task.review_requested", {}),
    event(6, "task.review_approved", {}),
    event(7, "task.integration_started", {}),
    event(8, "task.integration_observed", payload),
  ];
  if (uncertain) events.push(event(9, "task.effect_uncertain", uncertainEffectPayload({
    boundary: "cleanup",
    operation: "integration candidate cleanup",
    reason: "integration candidate cleanup was not proven complete",
    requestedBy: "zentra-integration-controller",
    workspace: null,
  })));
  return events;
}

function cleanupRecord(): CleanupFailureRecord {
  return {
    recordId: "9ca3d4e9-5413-4a0b-bf77-791bd8f7847d",
    projectId: "project-1",
    taskId: "task-diagnostic",
    commonDirectory: "/tmp/zentra-diagnostics/repository/.git",
    repositoryIdentitySha256: "a".repeat(64),
    integrationRef: "refs/heads/zentra/integration",
    candidateId: "candidate-1",
    candidatePath: "/tmp/zentra-diagnostics/candidate-1",
    reason: "candidate cleanup failed",
    recordedAt: "2026-07-20T00:00:00.000Z",
    lease: {
      ownerToken: "lease-token",
      acquiredAt: 1_700_000_000_000,
      expiresAt: 1_700_000_010_000,
      pid: 123,
      hostname: "host-a",
      authority: "historical_evidence_only",
    },
    acknowledgement: null,
  };
}
