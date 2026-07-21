import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { PodRegistry } from "../../src/pods/pod-registry.js";
import { projectPod } from "../../src/pods/pod-projection.js";
import type { PodAssignment, PodLease } from "../../src/pods/pod-contracts.js";
import { charter, grant, lease, usage, workspaceLease } from "./pod-fixtures.js";

function assign(registry: PodRegistry, assignment: PodAssignment, authority: PodLease): void {
  registry.receiveLease("pod-1", authority);
  registry.receiveWorkspaceLease("pod-1", workspaceLease({ workspaceLeaseId: authority.workspaceLeaseId,
    podLeaseId: authority.leaseId, taskId: authority.taskId, path: `/tmp/zentra-worktrees/${authority.workspaceLeaseId}`,
    branch: `refs/heads/ticket/${authority.taskId}` }));
  const current = registry.inspect("pod-1")!;
  const bindings = { assignmentDigest: digestCanonical(assignment), charterDigest: digestCanonical(current.charter),
    grantDigest: digestCanonical(current.grant), leaseDigest: digestCanonical(authority) };
  registry.assign("pod-1", assignment, { ...bindings, proposalId: digestCanonical({ podId: "pod-1",
    charterRevision: current.revision, workspaceLeaseId: authority.workspaceLeaseId, ...bindings }) });
}

const halfBudget = { ...grant().budget, maxSeconds: 300, maxRetries: 0, maxCostUsd: 2,
  maxInputTokens: 5_000, maxOutputTokens: 2_500 };

function bindExecution(registry: PodRegistry, assignmentId: string, dispatchId: string): void {
  registry.bindExecution("pod-1", { assignmentId, dispatchId, executionId: `execution-${dispatchId}`,
    processId: `process-${dispatchId}`, processIncarnation: `incarnation-${dispatchId}` });
}

function startReserved(registry: PodRegistry, assignmentId: string, dispatchId: string, authorizedAt = "2026-07-20T10:30:00.000Z"): void {
  const assignment = registry.inspect("pod-1")!.assignments[assignmentId]!;
  registry.startReservedInvocation("pod-1", { assignmentId, dispatchId, authorizedAt,
    executionId: `execution-${dispatchId}`, charterRevision: assignment.charterRevision });
}

describe("PodRegistry", () => {
  it("replays and restores charter, grant, assignments, checkpoints, evidence, and terminal projection after restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-pod-"));
    const database = path.join(root, "journal.sqlite");
    try {
      const journal = new SqliteEventJournal(database);
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const research = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget } satisfies PodAssignment;
      assign(registry, research, lease({ leaseId: "lease-research", assignmentId: "assignment-research", workspaceLeaseId: "workspace-research",
        taskId: "research", agentId: "agent-read", capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      registry.claimDispatch("pod-1", { assignmentId: "assignment-research", proposalId: registry.inspect("pod-1")!.assignments["assignment-research"]!.proposalId!, dispatchId: "dispatch-research" });
      startReserved(registry, "assignment-research", "dispatch-research");
      bindExecution(registry, "assignment-research", "dispatch-research");
      registry.recordEvidence("pod-1", { evidenceId: "research-evidence", taskId: "research", kind: "research-report", sha256: "b".repeat(64), sourceEventId: null });
      registry.observeDispatch("pod-1", { assignmentId: "assignment-research", dispatchId: "dispatch-research", outcome: "completed", evidenceIds: ["research-evidence"], usage: { ...usage, elapsedMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 } });
      assign(registry, {
        assignmentId: "assignment-1", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["src/pods/**"], budget: halfBudget,
      }, lease({ budget: halfBudget }));
      registry.recordOwnershipIntent("pod-1", { assignmentId: "assignment-1", taskId: "implement", ownedPaths: ["src/pods/**"] });
      registry.recordEvidence("pod-1", { evidenceId: "evidence-1", taskId: "implement", kind: "test-report", sha256: "a".repeat(64), sourceEventId: null });
      expect(() => registry.checkpoint("pod-1", { checkpointId: "focused", evidenceIds: ["evidence-1"], status: "passed" }))
        .toThrow(/precede/);
      registry.claimDispatch("pod-1", { assignmentId: "assignment-1", proposalId: registry.inspect("pod-1")!.assignments["assignment-1"]!.proposalId!, dispatchId: "dispatch-implement" });
      startReserved(registry, "assignment-1", "dispatch-implement");
      bindExecution(registry, "assignment-1", "dispatch-implement");
      registry.observeDispatch("pod-1", { assignmentId: "assignment-1", dispatchId: "dispatch-implement", outcome: "completed", evidenceIds: ["evidence-1"], usage });
      registry.checkpoint("pod-1", { checkpointId: "focused", evidenceIds: ["evidence-1"], status: "passed" });
      registry.complete("pod-1");
      const before = registry.inspect("pod-1");
      journal.close();

      const reopened = new SqliteEventJournal(database);
      expect(new PodRegistry(reopened).inspect("pod-1")).toEqual(before);
      expect(before).toMatchObject({
        lifecycle: "terminal", terminalOutcome: "completed", revision: 1,
        leases: { "lease-1": { status: "active" } },
        terminal: { outcome: "completed", tasks: [{ taskId: "research" }, { taskId: "implement" }] },
        budgetUsage: { elapsedMs: 20_001 },
      });
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains revision causation and invalidates stale assignments", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      const source = registry.recordEvidence("pod-1", {
        evidenceId: "revision-evidence", taskId: "research", kind: "research-report",
        sha256: "b".repeat(64), sourceEventId: null,
      });
      assign(registry, { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget },
      lease({ leaseId: "lease-research", assignmentId: "assignment-research", workspaceLeaseId: "workspace-research", taskId: "research",
        agentId: "agent-read", capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      const revised = charter({ revision: 2, outcome: "Implement the revised pod aggregate." });
      registry.revise("pod-1", {
        revisionId: "revision-2", priorRevision: 1, charter: revised,
        cause: { eventId: source.eventId, streamVersion: source.streamVersion, eventType: source.type, payloadDigest: digestCanonical(source.payload) },
      });
      const revisionLength = journal.readStream("pod-1").length;
      registry.revise("pod-1", {
        revisionId: "revision-2", priorRevision: 1, charter: revised,
        cause: { eventId: source.eventId, streamVersion: source.streamVersion, eventType: source.type, payloadDigest: digestCanonical(source.payload) },
      });
      expect(journal.readStream("pod-1")).toHaveLength(revisionLength);
      expect(journal.readStream("pod-1").slice(-2).map((event) => event.type)).toEqual(["pod.revised", "pod.task_relationships_recorded"]);
      expect(() => projectPod(journal.readStream("pod-1").slice(0, -1))).toThrow(/missing atomic task relationships/);

      expect(registry.inspect("pod-1")).toMatchObject({
        revision: 2,
        lifecycle: "registered",
        grant: null,
        revisions: [{ revisionId: "revision-2", priorRevision: 1, causationEventId: source.eventId }],
        assignments: { "assignment-research": { status: "stale", invalidatedByRevision: 2 } },
      });
      expect(journal.readStream("pod-1").find((event) => event.type === "pod.revised")?.causationId).toBe(source.eventId);
      registry.admit("pod-1", grant({ grantId: "grant-2", charterRevision: 2, charterDigest: digestCanonical(revised) }), "2026-07-20T10:02:00.000Z");
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "admitted", grant: { charterRevision: 2 } });
    } finally {
      journal.close();
    }
  });

  it("keeps cancellation durable", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      registry.requestCancellation("pod-1", { requestedBy: "parent", reason: "stop" });
      registry.cancel("pod-1");
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "terminal", terminalOutcome: "cancelled" });
      expect(() => registry.start("pod-1")).toThrow(/terminal/);
    } finally {
      journal.close();
    }
  });

  it.each(["intent", "invocation", "observation"] as const)("reconciles a crash after durable %s without retry", (stage) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const assignment = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget: halfBudget };
      const authority = lease({ leaseId: "lease-research", assignmentId: assignment.assignmentId, workspaceLeaseId: "workspace-research",
        taskId: "research", agentId: "agent-read", capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget });
      assign(registry, assignment, authority);
      const proposalId = registry.inspect("pod-1")!.assignments[assignment.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: assignment.assignmentId, proposalId, dispatchId: "dispatch-crash" });
      if (stage !== "intent") startReserved(registry, assignment.assignmentId, "dispatch-crash");
      if (stage === "observation") bindExecution(registry, assignment.assignmentId, "dispatch-crash");
      if (stage === "observation") registry.observeDispatch("pod-1", { assignmentId: assignment.assignmentId,
        dispatchId: "dispatch-crash", outcome: "uncertain", evidenceIds: [], usage: { ...usage, elapsedMs: 1, costUsd: 0, inputTokens: 1, outputTokens: 1 } });
      registry.reconcileInterruptedDispatch("pod-1", assignment.assignmentId);
      registry.resolveReconciliation("pod-1", { reconciliationId: "reconcile-dispatch-crash", assignmentId: assignment.assignmentId,
        dispatchId: "dispatch-crash", resolution: "no_effect", evidenceIds: [], decidedBy: "central-reconciler",
        ...(stage !== "intent" ? { executionId: "execution-dispatch-crash",
          processId: stage === "observation" ? "process-dispatch-crash" : null,
          processIncarnation: stage === "observation" ? "incarnation-dispatch-crash" : null,
          terminationEvidenceSha256: "a".repeat(64), effectEvidenceSha256: "b".repeat(64) } : {}) });
      expect(registry.inspect("pod-1")).toMatchObject({ lifecycle: "running", reconciliationRequired: false,
        assignments: { "assignment-research": { status: "failed" } } });
    } finally { journal.close(); }
  });

  it("never replays an invoking state without its atomic execution reservation", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const assignment = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget: halfBudget };
      assign(registry, assignment, lease({ leaseId: "lease-research", assignmentId: assignment.assignmentId,
        workspaceLeaseId: "workspace-research", taskId: "research", agentId: "agent-read", capabilities: ["read_repository"],
        ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      const proposalId = registry.inspect("pod-1")!.assignments[assignment.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: assignment.assignmentId, proposalId, dispatchId: "dispatch-atomic" });
      startReserved(registry, assignment.assignmentId, "dispatch-atomic");
      const events = journal.readStream("pod-1");
      expect(events.slice(-2).map((event) => event.type)).toEqual(["pod.assignment_invocation_started", "pod.execution_reserved"]);
      expect(() => projectPod(events.slice(0, -1))).toThrow(/missing its atomic execution reservation/);
    } finally { journal.close(); }
  });

  it.each(["completed", "failed"] as const)("centrally resolves uncertain dispatch as %s", (resolution) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const assignment = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget: halfBudget };
      assign(registry, assignment, lease({ leaseId: "lease-research", assignmentId: assignment.assignmentId, workspaceLeaseId: "workspace-research",
        taskId: "research", agentId: "agent-read", capabilities: ["read_repository"], ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      const proposalId = registry.inspect("pod-1")!.assignments[assignment.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: assignment.assignmentId, proposalId, dispatchId: "dispatch-uncertain" });
      startReserved(registry, assignment.assignmentId, "dispatch-uncertain");
      bindExecution(registry, assignment.assignmentId, "dispatch-uncertain");
      const evidenceIds = resolution === "completed" ? ["reconciled-evidence"] : [];
      if (resolution === "completed") registry.recordEvidence("pod-1", { evidenceId: evidenceIds[0]!, taskId: "research",
        kind: "research-report", sha256: "f".repeat(64), sourceEventId: null });
      registry.reconcileInterruptedDispatch("pod-1", assignment.assignmentId);
      registry.resolveReconciliation("pod-1", { reconciliationId: "reconcile-dispatch-uncertain", assignmentId: assignment.assignmentId,
        dispatchId: "dispatch-uncertain", resolution, evidenceIds, decidedBy: "central-reconciler",
        executionId: "execution-dispatch-uncertain", processId: "process-dispatch-uncertain",
        processIncarnation: "incarnation-dispatch-uncertain", terminationEvidenceSha256: "a".repeat(64),
        effectEvidenceSha256: "b".repeat(64) });
      expect(registry.inspect("pod-1")?.assignments[assignment.assignmentId]?.status).toBe(resolution);
      expect(registry.inspect("pod-1")?.reconciliationRequired).toBe(false);
    } finally { journal.close(); }
  });

  it("keeps cancellation nonterminal and blocks revision until an invoking effect is reconciled", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const assignment = { assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget: halfBudget };
      assign(registry, assignment, lease({ leaseId: "lease-research", assignmentId: assignment.assignmentId,
        workspaceLeaseId: "workspace-research", taskId: "research", agentId: "agent-read", capabilities: ["read_repository"],
        ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      const proposalId = registry.inspect("pod-1")!.assignments[assignment.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: assignment.assignmentId, proposalId, dispatchId: "dispatch-active" });
      startReserved(registry, assignment.assignmentId, "dispatch-active");
      const source = registry.recordEvidence("pod-1", { evidenceId: "revision-source", taskId: "research", kind: "research-report",
        sha256: "9".repeat(64), sourceEventId: null });
      expect(() => registry.revise("pod-1", { revisionId: "blocked-revision", priorRevision: 1, charter: charter({ revision: 2 }),
        cause: { eventId: source.eventId, streamVersion: source.streamVersion, eventType: source.type, payloadDigest: digestCanonical(source.payload) } }))
        .toThrow(/active or uncertain/);
      registry.requestCancellation("pod-1", { requestedBy: "parent", reason: "stop" });
      expect(registry.cancel("pod-1")).toMatchObject({ lifecycle: "blocked", terminalOutcome: null, reconciliationRequired: true });
      const reconciliation = registry.inspect("pod-1")!.reconciliation!;
      registry.resolveReconciliation("pod-1", { reconciliationId: reconciliation.reconciliationId,
        assignmentId: assignment.assignmentId, dispatchId: "dispatch-active", resolution: "no_effect", evidenceIds: [], decidedBy: "central",
        executionId: "execution-dispatch-active", processId: null, processIncarnation: null,
        terminationEvidenceSha256: "a".repeat(64), effectEvidenceSha256: "b".repeat(64) });
      expect(registry.inspect("pod-1")?.lifecycle).toBe("cancel_requested");
      expect(registry.cancel("pod-1")).toMatchObject({ lifecycle: "terminal", terminalOutcome: "cancelled" });
    } finally { journal.close(); }
  });

  it("rejects aggregate assignment budget expansion and duplicate task assignment", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      const researchBudget = { ...grant().budget, maxSeconds: 1, maxRetries: 0, maxCostUsd: 0, maxInputTokens: 1, maxOutputTokens: 1 };
      assign(registry, {
        assignmentId: "assignment-research", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"], ownedPaths: ["src/pods/**"], budget: researchBudget,
      }, lease({ leaseId: "lease-research", assignmentId: "assignment-research", workspaceLeaseId: "workspace-research", taskId: "research",
        agentId: "agent-read", capabilities: ["read_repository"], budget: researchBudget }));
      expect(() => assign(registry, {
        assignmentId: "assignment-duplicate", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"], ownedPaths: ["src/pods/**"], budget: researchBudget,
      }, lease({ leaseId: "lease-duplicate", assignmentId: "assignment-duplicate", workspaceLeaseId: "workspace-duplicate", taskId: "research",
        agentId: "agent-read", capabilities: ["read_repository"], budget: researchBudget }))).toThrow(/already has/);
      expect(() => assign(registry, {
        assignmentId: "assignment-implement", taskId: "implement", roleId: "implementer", agentId: "agent-write",
        charterRevision: 1, capabilities: ["write_worktree"], ownedPaths: ["tests/pods/**"], budget: grant().budget,
      }, lease({ leaseId: "lease-implement", assignmentId: "assignment-implement", workspaceLeaseId: "workspace-implement",
        budget: grant().budget, ownedPaths: ["tests/pods/**"] }))).toThrow(/DAG order|aggregate budget/);
    } finally {
      journal.close();
    }
  });

  it("binds workspace leases to the exact project repository and normalized protected refs", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant({ sharedIntegrationRefs: ["refs/heads/release"] }), "2026-07-20T10:01:00.000Z");
      registry.receiveLease("pod-1", lease());
      expect(() => registry.receiveWorkspaceLease("pod-1", workspaceLease({ repositoryPath: "/tmp/other" }))).toThrow(/project/);
      expect(() => registry.receiveWorkspaceLease("pod-1", workspaceLease({ branch: "release" }))).toThrow(/protected refs/);
    } finally { journal.close(); }
  });

  it("rejects aggregate usage across revisions even when the current assignment remains within budget", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.start("pod-1");
      const first = { assignmentId: "research-v1", taskId: "research", roleId: "researcher", agentId: "agent-read",
        charterRevision: 1, capabilities: ["read_repository"] as ("read_repository")[], ownedPaths: ["tests/pods/**"], budget: halfBudget };
      assign(registry, first, lease({ leaseId: "lease-v1", grantId: "grant-1", assignmentId: first.assignmentId,
        workspaceLeaseId: "workspace-v1", taskId: "research", agentId: "agent-read", capabilities: ["read_repository"],
        ownedPaths: ["tests/pods/**"], budget: halfBudget }));
      const proposal1 = registry.inspect("pod-1")!.assignments[first.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: first.assignmentId, proposalId: proposal1, dispatchId: "dispatch-v1" });
      startReserved(registry, first.assignmentId, "dispatch-v1");
      bindExecution(registry, first.assignmentId, "dispatch-v1");
      const source = registry.recordEvidence("pod-1", { evidenceId: "evidence-v1", taskId: "research", kind: "research-report", sha256: "7".repeat(64), sourceEventId: null });
      registry.observeDispatch("pod-1", { assignmentId: first.assignmentId, dispatchId: "dispatch-v1", outcome: "completed",
        evidenceIds: ["evidence-v1"], usage: { ...usage, elapsedMs: 300_000, costUsd: 0, inputTokens: 0, outputTokens: 0 } });
      const revised = charter({ revision: 2 });
      registry.revise("pod-1", { revisionId: "revision-usage", priorRevision: 1, charter: revised,
        cause: { eventId: source.eventId, streamVersion: source.streamVersion, eventType: source.type, payloadDigest: digestCanonical(source.payload) } });
      const grant2 = grant({ grantId: "grant-2", charterRevision: 2, charterDigest: digestCanonical(revised) });
      registry.admit("pod-1", grant2, "2026-07-20T10:31:00.000Z");
      registry.start("pod-1");
      const second = { ...first, assignmentId: "research-v2", charterRevision: 2, budget: grant2.budget };
      assign(registry, second, lease({ leaseId: "lease-v2", grantId: "grant-2", assignmentId: second.assignmentId,
        workspaceLeaseId: "workspace-v2", taskId: "research", agentId: "agent-read", capabilities: ["read_repository"],
        ownedPaths: ["tests/pods/**"], charterRevision: 2, budget: grant2.budget }));
      const proposal2 = registry.inspect("pod-1")!.assignments[second.assignmentId]!.proposalId!;
      registry.claimDispatch("pod-1", { assignmentId: second.assignmentId, proposalId: proposal2, dispatchId: "dispatch-v2" });
      startReserved(registry, second.assignmentId, "dispatch-v2", "2026-07-20T10:32:00.000Z");
      bindExecution(registry, second.assignmentId, "dispatch-v2");
      registry.recordEvidence("pod-1", { evidenceId: "evidence-v2", taskId: "research", kind: "research-report", sha256: "8".repeat(64), sourceEventId: null });
      expect(() => registry.observeDispatch("pod-1", { assignmentId: second.assignmentId, dispatchId: "dispatch-v2", outcome: "completed",
        evidenceIds: ["evidence-v2"], usage: { ...usage, elapsedMs: 300_001, costUsd: 0, inputTokens: 0, outputTokens: 0 } }))
        .toThrow(/aggregate budget/);
    } finally { journal.close(); }
  });

  it("rejects forged replay metadata and stale terminal races", () => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const registry = new PodRegistry(journal);
      registry.register({ charter: charter(), correlationId: "trace-1" });
      const events = journal.readStream("pod-1");
      expect(() => projectPod([{ ...events[0]!, streamVersion: 2 }])).toThrow(/contiguous/);
      registry.admit("pod-1", grant(), "2026-07-20T10:01:00.000Z");
      registry.fail("pod-1");
      expect(() => registry.complete("pod-1")).toThrow(/terminal/);
    } finally {
      journal.close();
    }
  });
});
