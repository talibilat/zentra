import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NewEvent, StoredEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import type { MilestonePlan, PlannedTask } from "../../src/contracts/milestone.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import type { OpenCodeTaskAdmissionContext } from "../../src/milestones/milestone-registry.js";
import { projectMilestone } from "../../src/milestones/milestone-projection.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";
import { createMilestoneAuthorityEnvelope, createReplanningPolicyBinding } from "../../src/contracts/replanning.js";
import { uncertainEffectPayload } from "../../src/contracts/uncertain-effect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const budget = { maxSeconds: 100, maxRetries: 1, maxCostUsd: 2, maxInputTokens: 1_000, maxOutputTokens: 500 };
const completedTask: PlannedTask = {
  taskId: "task-completed", title: "Inspect", description: "Inspect the current implementation.", dependencies: [],
  ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence retained."],
  roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
  risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false }, budget,
};
const pendingTask: PlannedTask = {
  taskId: "task-pending", title: "Implement", description: "Implement the evidence-informed change.", dependencies: ["task-completed"],
  ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Focused tests pass."],
  roleAssignment: { role: "implementer", agentId: "implementer", harness: "opencode" },
  risk: { level: "medium", authority: "workspace_write", requiresReview: true, requiresApproval: false }, budget,
};

function plan(tasks: readonly PlannedTask[] = [completedTask, pendingTask]): MilestonePlan {
  return { milestoneId: "milestone-replan", projectId: "zentra", goal: "Deliver bounded replanning.", tasks: [...tasks] };
}

function security(overrides: Partial<SecuritySheet> = {}): SecuritySheet {
  return {
    allowedRepositories: [process.cwd()], allowedFileScopes: ["src/**"], forbiddenPaths: [".env"],
    network: { default: "denied", allowedDestinations: [] }, secretHandling: ["ATTACKER_SECRET_CANARY"],
    approvalRequiredOperations: [], releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["missing_authority", "forbidden_file_scope", "uncertain_effect"], ...overrides,
  };
}

function models(): ModelSheet {
  return { models: [
    {
      id: "researcher", harness: "opencode", model: "fixture/research", roles: ["researcher"], specialties: [],
      costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository"],
      network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
    },
    {
      id: "implementer", harness: "opencode", model: "fixture/implement", roles: ["implementer"], specialties: [],
      costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository", "write_worktree"],
      network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
    },
    {
      id: "unused-verifier", harness: "opencode", model: "fixture/verify", roles: ["verifier"], specialties: [],
      costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository"],
      network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
    },
  ] };
}

function authority() {
  return { security: security(), modelSheet: models() };
}

function admissionContext(overrides: Partial<OpenCodeTaskAdmissionContext> = {}): OpenCodeTaskAdmissionContext {
  return {
    kind: "opencode", repositoryPath: process.cwd(), actorId: "researcher", harness: "opencode",
    role: "researcher", capabilityId: "researcher", transportModelId: "fixture/research",
    authority: "read_only", roles: ["researcher"], toolPermissions: ["read_repository"], network: "denied",
    contextTokens: 10_000,
    requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50, timeoutMs: 30_000 },
    ...overrides,
  };
}

function append(journal: SqliteEventJournal | ProjectingEventJournal, type: string, payload: unknown): StoredEvent {
  const events = journal.readStream("milestone-replan");
  return journal.append("milestone-replan", events.length, [{
    streamId: "milestone-replan", type, payload, causationId: null, correlationId: "trace-replan",
  }])[0]!;
}

function completeFirstTask(journal: SqliteEventJournal | ProjectingEventJournal): StoredEvent {
  append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
  const intent = {
    taskId: "task-completed", capsuleId: "capsule-completed",
    resourceLabel: "org.zentra.capsule-id=capsule-completed", containerName: "container-completed",
    imageName: "image-completed", repositoryViewPath: "/tmp/view-completed",
  };
  append(journal, "milestone.agent_resource_intent", intent);
  append(journal, "milestone.task_running", { taskId: "task-completed" });
  append(journal, "milestone.agent_cleanup_observed", {
    ...intent, containerId: null, imageId: null, repositoryRevision: null, outcome: "completed",
    containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
  });
  return append(journal, "milestone.task_completed", { taskId: "task-completed", outcome: "completed" });
}

function evidenceReference(event: StoredEvent) {
  return {
    eventId: event.eventId, streamId: event.streamId, streamVersion: event.streamVersion,
    eventType: event.type, payloadDigest: digestCanonical(event.payload),
  };
}

function revisedPlan(overrides: Partial<PlannedTask> = {}): MilestonePlan {
  return plan([completedTask, {
    ...pendingTask, ...overrides, taskId: overrides.taskId ?? "task-revised",
    dependencies: overrides.dependencies ?? ["task-completed"],
    budget: overrides.budget ?? { ...budget, maxSeconds: 100, maxRetries: 0 },
  }]);
}

describe("bounded milestone replanning", () => {
  it("revises after completed evidence, persists ancestry, and emits ordered Agent Tail JSONL", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-replan-")));
    roots.push(root);
    const database = path.join(root, "journal.sqlite");
    const trace = path.join(root, "trace.jsonl");
    const inner = new SqliteEventJournal(database);
    const sink = AgentTailJsonlFileSink.open(root, trace);
    const journal = new ProjectingEventJournal(inner, sink);
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan",
      plan: plan(), authority: authority(),
    });
    const completed = completeFirstTask(journal);
    const priorPlanDigest = digestCanonical(plan());

    const result = registry.revisePlan({
      revisionId: "revision-1", milestoneId: "milestone-replan", priorPlanDigest,
      candidatePlan: revisedPlan({ description: "REVISION_SECRET_CANARY" }), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });

    expect(result).toMatchObject({
      status: "accepted", traceProjectionFailed: false,
      milestone: {
        plan: { tasks: [{ taskId: "task-completed" }, { taskId: "task-revised" }] },
        tasks: { "task-completed": { status: "completed", terminalOutcome: "completed" }, "task-revised": { status: "planned" } },
        revisions: [{ revisionId: "revision-1", revisionNumber: 1, priorPlanDigest }],
      },
    });
    expect(journal.readStream("milestone-replan").at(-1)?.type).toBe("milestone.plan_revised");
    expect(journal.readStream("milestone-replan").slice(0, 4).map((event) => event.type)).toEqual([
      "milestone.created", "milestone.plan_created", "milestone.replanning_policy_bound", "milestone.authority_envelope_established",
    ]);
    expect(journal.readStream("milestone-replan").find((event) => event.eventId === completed.eventId)).toEqual(completed);
    sink.close();
    inner.close();

    const reopened = new SqliteEventJournal(database);
    expect(new MilestoneRegistry(reopened).inspect("milestone-replan")).toMatchObject({
      revisions: [{ revisionId: "revision-1" }], tasks: { "task-completed": { terminalOutcome: "completed" } },
    });
    reopened.close();
    const lines = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({
      kind: "milestone.plan_revised", actor: { id: "planner-1", role: "replanning_controller" },
      operation: { name: "milestone_replanning", status: "completed" },
    });
    expect(JSON.stringify(lines.at(-1))).not.toContain("ATTACKER_SECRET_CANARY");
    expect(JSON.stringify(lines.at(-1))).not.toContain("REVISION_SECRET_CANARY");
    const policyLine = lines.find((line) => line["kind"] === "milestone.replanning_policy_bound");
    const envelopeLine = lines.find((line) => line["kind"] === "milestone.authority_envelope_established");
    expect(policyLine).toMatchObject({ payload: { milestoneId: "milestone-replan", projectId: "zentra", modelCount: 3 } });
    expect(envelopeLine).toMatchObject({ payload: { milestoneId: "milestone-replan", projectId: "zentra", capabilityCount: 3 } });
    expect(JSON.stringify([policyLine, envelopeLine])).not.toMatch(/ATTACKER_SECRET_CANARY|src\/\*\*|fixture\/research/);
  });

  it.each(["milestone.replanning_policy_bound", "milestone.authority_envelope_established"])(
    "strictly rejects malformed %s before Agent Tail writes",
    (type) => {
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-replan-tail-")));
      roots.push(root);
      const trace = path.join(root, `${type.split(".").at(-1)}.jsonl`);
      const sink = AgentTailJsonlFileSink.open(root, trace);
      expect(() => sink.append([stored(type, 1, { arbitrary: "ATTACKER_SECRET_CANARY" })])).toThrow();
      sink.close();
      expect(readFileSync(trace, "utf8")).toBe("");
    },
  );

  it.each([
    ["goal", () => ({ ...revisedPlan(), goal: "A different goal." })],
    ["ownership", () => revisedPlan({ ownedPaths: ["docs/**"] })],
    ["forbidden_scope", () => plan([{ ...pendingTask, taskId: "task-revised", dependencies: [], forbiddenPaths: [] }])],
    ["authority", () => revisedPlan({ risk: { ...pendingTask.risk, authority: "integration" } })],
    ["budget", () => revisedPlan({ budget: { ...budget, maxSeconds: 101 } })],
    ["dependency_graph", () => plan([{ ...completedTask, dependencies: ["task-revised"] }, { ...pendingTask, taskId: "task-revised", dependencies: ["task-completed"] }])],
    ["executed_task", () => plan([{ ...completedTask, title: "Changed" }, pendingTask])],
  ] as const)("pauses once for an out-of-bound %s revision", (reason, candidate) => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const input = {
      revisionId: "revision-bad", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: candidate(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    };

    const first = registry.revisePlan(input);
    const second = registry.revisePlan(input);

    expect(first).toMatchObject({ status: "paused", attention: { reason, candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(second).toEqual(first);
    expect(journal.readStream("milestone-replan").filter((event) => event.type === "milestone.paused")).toHaveLength(1);
    expect(journal.readStream("milestone-replan").some((event) => event.type === "milestone.plan_revised")).toBe(false);
    journal.close();
  });

  it("fails closed for stale or forged evidence and changed security", () => {
    for (const variation of ["stale-plan", "forged-evidence", "changed-security"] as const) {
      const journal = new SqliteEventJournal(":memory:");
      const registry = new MilestoneRegistry(journal);
      registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
      const completed = completeFirstTask(journal);
      const reference = evidenceReference(completed);
      const result = registry.revisePlan({
        revisionId: `revision-${variation}`, milestoneId: "milestone-replan",
        priorPlanDigest: variation === "stale-plan" ? "0".repeat(64) : digestCanonical(plan()),
        candidatePlan: revisedPlan(), security: variation === "changed-security" ? security({ releaseBoundary: "no_release_operations" }) : security(), modelSheet: models(),
        requestedBy: "planner-1", evidence: [{ ...reference, payloadDigest: variation === "forged-evidence" ? "0".repeat(64) : reference.payloadDigest }],
        linkedTaskStreamIds: [],
      });
      expect(result).toMatchObject({ status: "paused", attention: { reason: variation === "changed-security" ? "release" : variation === "stale-plan" ? "stale_plan" : "evidence" } });
      journal.close();
    }
  });

  it("durably pauses when baseline authority was never established", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan() });
    const completed = completeFirstTask(journal);

    const result = registry.revisePlan({
      revisionId: "revision-no-envelope", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });

    expect(result).toMatchObject({ status: "paused", attention: { reason: "baseline_authority_unproven" } });
    journal.close();
  });

  it.each([
    ["network", () => security({ network: { default: "denied", allowedDestinations: ["https://api.github.com"] } })],
    ["release", () => security({ releaseBoundary: "no_release_operations" })],
    ["security", () => security({ approvalRequiredOperations: ["external_effect"] })],
  ] as const)("classifies a changed %s boundary canonically", (reason, changedSecurity) => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const result = registry.revisePlan({
      revisionId: `revision-${reason}`, milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: changedSecurity(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    expect(result).toMatchObject({ status: "paused", attention: { reason } });
    journal.close();
  });

  it("pauses without another effect while milestone work is active", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-completed" });

    const result = registry.revisePlan({
      revisionId: "revision-active", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1", evidence: [], linkedTaskStreamIds: [],
    });

    expect(result).toMatchObject({ status: "paused", attention: { reason: "active_effect" } });
    expect(journal.readStream("milestone-replan").at(-1)?.type).toBe("milestone.paused");
    expect(journal.readStream("milestone-replan").slice(-1).map((event) => event.type)).toEqual(["milestone.paused"]);
    journal.close();
  });

  it("fails closed when correlated task streams are omitted or contain uncertainty", () => {
    for (const [linkedTaskStreamIds, reason] of [[[], "uncertain_effect"], [["task-external"], "evidence"]] as const) {
      const journal = new SqliteEventJournal(":memory:");
      const registry = new MilestoneRegistry(journal);
      registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
      const completed = completeFirstTask(journal);
      journal.append("task-external", 0, [
        { streamId: "task-external", type: "task.created", payload: { projectId: "zentra", title: "External task" }, causationId: null, correlationId: "trace-replan" },
        { streamId: "task-external", type: "task.effect_uncertain", payload: uncertainEffectPayload({ boundary: "integration", operation: "integrate", reason: "Unknown result", requestedBy: "recovery", workspace: null }), causationId: null, correlationId: "trace-replan" },
      ]);
      const result = registry.revisePlan({
        revisionId: `revision-uncertain-${linkedTaskStreamIds.length}`, milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
        candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
        evidence: [evidenceReference(completed)], linkedTaskStreamIds,
      });
      expect(result).toMatchObject({ status: "paused", attention: { reason } });
      journal.close();
    }
  });

  it.each(["active", "malformed_reconciliation", "reconciled_terminal"] as const)(
    "strictly projects a correlated %s task stream before replanning",
    (variation) => {
      const journal = new SqliteEventJournal(":memory:");
      const registry = new MilestoneRegistry(journal);
      registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
      const completed = completeFirstTask(journal);
      const taskEvents: NewEvent<string, unknown>[] = [{
        streamId: "task-correlated", type: "task.created", payload: { projectId: "zentra", title: "Correlated" },
        causationId: null, correlationId: "trace-replan",
      }];
      if (variation === "active") {
        taskEvents.push(
          { streamId: "task-correlated", type: "task.leased", payload: { leaseOwner: "worker-1" }, causationId: null, correlationId: "trace-replan" },
          { streamId: "task-correlated", type: "task.started", payload: { workerId: "worker-1" }, causationId: null, correlationId: "trace-replan" },
        );
      } else {
        taskEvents.push({
          streamId: "task-correlated", type: "task.effect_uncertain",
          payload: uncertainEffectPayload({ boundary: "integration", operation: "integrate", reason: "Unknown", requestedBy: "recovery", workspace: null }),
          causationId: null, correlationId: "trace-replan",
        }, {
          streamId: "task-correlated", type: "task.effect_reconciled",
          payload: { schemaVersion: 1, boundary: variation === "malformed_reconciliation" ? "commit" : "integration", resolution: "effect_absent", reason: "Inspected", decidedBy: "operator", decisionId: "reconcile-1" },
          causationId: null, correlationId: "trace-replan",
        });
        if (variation === "reconciled_terminal") {
          taskEvents.push({ streamId: "task-correlated", type: "task.failed", payload: {}, causationId: null, correlationId: "trace-replan" });
        }
      }
      journal.append("task-correlated", 0, taskEvents);
      const result = registry.revisePlan({
        revisionId: `revision-correlated-${variation}`, milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
        candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
        evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
      });
      if (variation === "reconciled_terminal") expect(result.status).toBe("accepted");
      else expect(result).toMatchObject({ status: "paused", attention: { reason: variation === "active" ? "active_effect" : "evidence" } });
      journal.close();
    },
  );

  it("is idempotent and converges when the accepted append loses optimistic concurrency", () => {
    const inner = new SqliteEventJournal(":memory:");
    const competing = new MilestoneRegistry(inner);
    competing.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(inner);
    const input = {
      revisionId: "revision-race", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    };
    let injected = false;
    const stale: EventJournal = {
      readStream: (...args) => inner.readStream(...args), readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events: readonly NewEvent<string, unknown>[]) => {
        if (!injected && events[0]?.type === "milestone.plan_revised") {
          injected = true;
          competing.revisePlan(input);
        }
        return inner.append(streamId, expectedVersion, events);
      },
    };

    const first = new MilestoneRegistry(stale).revisePlan(input);
    const second = competing.revisePlan(input);

    expect(first).toEqual(second);
    expect(inner.readStream("milestone-replan").filter((event) => event.type === "milestone.plan_revised")).toHaveLength(1);
    inner.close();
  });

  it("uses only the latest plan for completion while carrying prior completion", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    registry.revisePlan({
      revisionId: "revision-complete", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    append(journal, "milestone.task_ready", { taskId: "task-revised", admissionDigest: "b".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-revised" });
    append(journal, "milestone.task_completed", { taskId: "task-revised", outcome: "completed" });
    registry.completeFromEvidence("milestone-replan");

    expect(registry.inspect("milestone-replan")).toMatchObject({ lifecycle: "terminal", terminalOutcome: "completed" });
    journal.close();
  });

  it("keeps failed attempts historical and requires a new task identity", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-completed" });
    const failed = append(journal, "milestone.task_completed", { taskId: "task-completed", outcome: "failed" });
    const superseding = { ...completedTask, taskId: "task-superseding", title: "Inspect again" };

    const result = registry.revisePlan({
      revisionId: "revision-supersede", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([superseding]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(failed)], linkedTaskStreamIds: [],
      supersessions: [{ priorTaskId: "task-completed", replacementTaskId: "task-superseding" }],
    });

    expect(result).toMatchObject({
      status: "accepted",
      milestone: {
        tasks: { "task-superseding": { status: "planned" } },
        historicalTasks: { "task-completed": { terminalOutcome: "failed" } },
      },
    });
    expect(result.milestone.tasks["task-completed"]).toBeUndefined();
    journal.close();
  });

  it("rejects failed-task replacement without an exact supersession relation", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-completed" });
    const failed = append(journal, "milestone.task_completed", { taskId: "task-completed", outcome: "failed" });
    const result = registry.revisePlan({
      revisionId: "revision-missing-supersession", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([{ ...completedTask, taskId: "task-new" }]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(failed)], linkedTaskStreamIds: [],
    });
    expect(result).toMatchObject({ status: "paused", attention: { reason: "executed_task" } });
    journal.close();
  });

  it("rejects supersession to an existing historical task identity", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-completed" });
    const failed = append(journal, "milestone.task_completed", { taskId: "task-completed", outcome: "failed" });
    const result = registry.revisePlan({
      revisionId: "revision-existing-supersession", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([{ ...pendingTask, dependencies: [] }]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(failed)], linkedTaskStreamIds: [],
      supersessions: [{ priorTaskId: "task-completed", replacementTaskId: "task-pending" }],
    });
    expect(result).toMatchObject({ status: "paused", attention: { reason: "executed_task" } });
    journal.close();
  });

  it("reserves completed ceilings so task splitting cannot multiply aggregate budget", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const split = (taskId: string): PlannedTask => ({
      ...pendingTask, taskId, dependencies: [], budget: { ...budget, maxSeconds: 60, maxCostUsd: 1.1, maxInputTokens: 600, maxOutputTokens: 300 },
    });

    const result = registry.revisePlan({
      revisionId: "revision-split", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([completedTask, split("task-split-a"), split("task-split-b")]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });

    expect(result).toMatchObject({ status: "paused", attention: { reason: "budget" } });
    journal.close();
  });

  it("keeps the journal authoritative and reports an Agent Tail sink failure separately", () => {
    const inner = new SqliteEventJournal(":memory:");
    const journal = new ProjectingEventJournal(inner, { append: () => { throw new Error("trace unavailable"); } });
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);

    const result = registry.revisePlan({
      revisionId: "revision-trace-failed", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });

    expect(result).toMatchObject({ status: "accepted", traceProjectionFailed: true });
    expect(inner.readStream("milestone-replan").at(-1)?.type).toBe("milestone.plan_revised");
    inner.close();
  });

  it.each(["goal", "ownership", "forbidden", "authority", "role", "budget"] as const)(
    "rejects a directly forged %s authority envelope during replay",
    (field) => {
      const envelope = createMilestoneAuthorityEnvelope({ plan: plan(), security: security(), modelSheet: models() });
      const policy = createReplanningPolicyBinding({ milestoneId: "milestone-replan", projectId: "zentra", security: security(), modelSheet: models() });
      const forged = {
        ...envelope,
        ...(field === "goal" ? { goalDigest: "0".repeat(64) } : {}),
        ...(field === "ownership" ? { aggregateOwnedPaths: ["docs/**"] } : {}),
        ...(field === "forbidden" ? { forbiddenPaths: [] } : {}),
        ...(field === "authority" ? { authorityCategories: ["integration"] } : {}),
        ...(field === "role" ? { roleBoundaries: [{ role: "integrator", harness: "opencode" }] } : {}),
        ...(field === "budget" ? { aggregateBudgetCeiling: { ...envelope.aggregateBudgetCeiling, maxSeconds: 999 } } : {}),
      };
      const events: StoredEvent[] = [
        stored("milestone.created", 1, { projectId: "zentra", title: "Replan" }),
        stored("milestone.plan_created", 2, { plan: plan() }),
        stored("milestone.replanning_policy_bound", 3, { policy }),
        stored("milestone.authority_envelope_established", 4, { envelope: forged }),
      ];
      expect(() => projectMilestone(events)).toThrow(/authority envelope/);
    },
  );

  it("rejects missing or contradictory policy binding and exact capability extras or omissions", () => {
    const envelope = createMilestoneAuthorityEnvelope({ plan: plan(), security: security(), modelSheet: models() });
    const policy = createReplanningPolicyBinding({ milestoneId: "milestone-replan", projectId: "zentra", security: security(), modelSheet: models() });
    const prefix = [
      stored("milestone.created", 1, { projectId: "zentra", title: "Replan" }),
      stored("milestone.plan_created", 2, { plan: plan() }),
    ];
    expect(() => projectMilestone([...prefix, stored("milestone.authority_envelope_established", 3, { envelope })]))
      .toThrow("must bind the unexecuted baseline");
    const contradictory = createReplanningPolicyBinding({
      milestoneId: "milestone-replan", projectId: "zentra",
      security: security({ approvalRequiredOperations: ["external_effect"] }), modelSheet: models(),
    });
    expect(() => projectMilestone([
      ...prefix, stored("milestone.replanning_policy_bound", 3, { policy: contradictory }),
      stored("milestone.authority_envelope_established", 4, { envelope }),
    ])).toThrow("authority envelope derivation");
    for (const capabilities of [envelope.capabilities.slice(1), [...envelope.capabilities, { ...envelope.capabilities[0]!, capabilityId: "extra" }]]) {
      expect(() => projectMilestone([
        ...prefix, stored("milestone.replanning_policy_bound", 3, { policy }),
        stored("milestone.authority_envelope_established", 4, { envelope: { ...envelope, capabilities } }),
      ])).toThrow();
    }
  });

  it("rejects a directly forged out-of-bound revision during replay", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    registry.revisePlan({
      revisionId: "revision-forge", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    const events = journal.readStream("milestone-replan");
    const revision = events.at(-1)!;
    const payload = revision.payload as Record<string, unknown>;
    const forgedPlan = revisedPlan({ ownedPaths: ["outside/**"] });
    const forged = events.map((event) => event === revision ? {
      ...event,
      payload: { ...payload, revisedPlan: forgedPlan, revisedPlanDigest: digestCanonical(forgedPlan) },
    } : event);
    expect(() => projectMilestone(forged)).toThrow("violates ownership");
    journal.close();
  });

  it("prevents removal of a started blocked task", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    append(journal, "milestone.task_ready", { taskId: "task-completed", admissionDigest: "a".repeat(64) });
    append(journal, "milestone.task_running", { taskId: "task-completed" });
    append(journal, "milestone.task_blocked", { taskId: "task-completed", reason: "waiting" });
    const result = registry.revisePlan({
      revisionId: "revision-blocked", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([{ ...pendingTask, dependencies: [] }]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [], linkedTaskStreamIds: [],
    });
    expect(result).toMatchObject({ status: "paused", attention: { reason: "active_effect" } });
    journal.close();
  });

  it("requires exact scope semantics for ownership and recursive forbidden scope", () => {
    const scopeCases: Array<[PlannedTask, PlannedTask, "ownership" | "forbidden_scope"]> = [
      [{ ...pendingTask, ownedPaths: ["src"] }, { ...pendingTask, taskId: "task-revised", ownedPaths: ["src/**"] }, "ownership"],
      [{ ...pendingTask, forbiddenPaths: ["config/**"] }, { ...pendingTask, taskId: "task-revised", forbiddenPaths: ["config"] }, "forbidden_scope"],
    ];
    for (const [baselinePending, candidatePending, reason] of scopeCases) {
      const journal = new SqliteEventJournal(":memory:");
      const registry = new MilestoneRegistry(journal);
      const scopedCompleted = { ...completedTask, ownedPaths: ["docs/**"] };
      const baseline = plan([scopedCompleted, baselinePending]);
      registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: baseline, authority: { security: security(), modelSheet: models() } });
      const completed = completeFirstTask(journal);
      const result = registry.revisePlan({
        revisionId: `revision-scope-${reason}`, milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(baseline),
        candidatePlan: plan([scopedCompleted, candidatePending]), security: security(), modelSheet: models(), requestedBy: "planner-1",
        evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
      });
      expect(result).toMatchObject({ status: "paused", attention: { reason } });
      journal.close();
    }
  });

  it("resolves an exact replanning pause only by abandoning the candidate", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const paused = registry.revisePlan({
      revisionId: "revision-abandon", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: { ...revisedPlan(), goal: "Expanded goal" }, security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    expect(paused).toMatchObject({ status: "paused", attention: { requiredDecision: "abandon_candidate" } });
    if (paused.status !== "paused") throw new Error("expected pause");
    const occurrence = paused.milestone.replanningPauseOccurrence!;
    const decision = {
      milestoneId: "milestone-replan", attentionId: paused.attention.attentionId,
      priorPlanDigest: paused.attention.priorPlanDigest, candidateDigest: paused.attention.candidateDigest,
      pauseEventId: occurrence.eventId, pauseStreamVersion: occurrence.streamVersion,
      decisionId: "decision-abandon", decidedBy: "operator-1", action: "abandon_candidate" as const,
    };
    const resolved = registry.resolveReplanning(decision);
    expect(resolved).toMatchObject({
      lifecycle: "ready", plan: plan(), replanningAttention: null,
      replanningAttentionHistory: [{ attentionId: paused.attention.attentionId }],
      replanningResolutions: [{ decisionId: "decision-abandon", action: "abandon_candidate" }],
    });
    expect(registry.resolveReplanning(decision)).toEqual(resolved);
    expect(() => registry.resolveReplanning({ ...decision, decisionId: "decision-stale", candidateDigest: "0".repeat(64) }))
      .toThrow("binding is stale");
    const repeated = registry.revisePlan({
      revisionId: "revision-abandon", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: { ...revisedPlan(), goal: "Expanded goal" }, security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    expect(repeated).toMatchObject({ status: "paused" });
    expect(() => registry.resolveReplanning(decision)).toThrow("decision identity is already bound");
    journal.close();
  });

  it("converges on one replanning resolution under optimistic concurrency", () => {
    const inner = new SqliteEventJournal(":memory:");
    const competing = new MilestoneRegistry(inner);
    competing.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(inner);
    const paused = competing.revisePlan({
      revisionId: "revision-resolve-race", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: { ...revisedPlan(), goal: "Expanded goal" }, security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    if (paused.status !== "paused") throw new Error("expected pause");
    const occurrence = paused.milestone.replanningPauseOccurrence!;
    const decision = {
      milestoneId: "milestone-replan", attentionId: paused.attention.attentionId,
      priorPlanDigest: paused.attention.priorPlanDigest, candidateDigest: paused.attention.candidateDigest,
      pauseEventId: occurrence.eventId, pauseStreamVersion: occurrence.streamVersion,
      decisionId: "decision-race", decidedBy: "operator-1", action: "abandon_candidate" as const,
    };
    let injected = false;
    const stale: EventJournal = {
      readStream: (...args) => inner.readStream(...args), readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events) => {
        if (!injected && events[0]?.type === "milestone.replanning_resolved") {
          injected = true;
          competing.resolveReplanning(decision);
        }
        return inner.append(streamId, expectedVersion, events);
      },
    };
    expect(new MilestoneRegistry(stale).resolveReplanning(decision)).toEqual(competing.resolveReplanning(decision));
    expect(inner.readStream("milestone-replan").filter((event) => event.type === "milestone.replanning_resolved")).toHaveLength(1);
    inner.close();
  });

  it("requires same-stream authenticated completion evidence", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    completeFirstTask(journal);
    const unrelated = journal.append("other-milestone", 0, [{
      streamId: "other-milestone", type: "milestone.task_completed",
      payload: { taskId: "task-completed", outcome: "completed" }, causationId: null, correlationId: "trace-other",
    }])[0]!;
    const result = registry.revisePlan({
      revisionId: "revision-unrelated-evidence", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(unrelated)], linkedTaskStreamIds: [],
    });
    expect(result).toMatchObject({ status: "paused", attention: { reason: "evidence" } });
    journal.close();
  });

  it("rejects malformed same-stream completion and forged cross-stream revision evidence on replay", () => {
    const envelope = createMilestoneAuthorityEnvelope({ plan: plan(), security: security(), modelSheet: models() });
    const policy = createReplanningPolicyBinding({ milestoneId: "milestone-replan", projectId: "zentra", security: security(), modelSheet: models() });
    const malformed = [
      stored("milestone.created", 1, { projectId: "zentra", title: "Replan" }),
      stored("milestone.plan_created", 2, { plan: plan() }),
      stored("milestone.replanning_policy_bound", 3, { policy }),
      stored("milestone.authority_envelope_established", 4, { envelope }),
      stored("milestone.task_ready", 5, { taskId: "task-completed", admissionDigest: "a".repeat(64) }),
      stored("milestone.task_running", 6, { taskId: "task-completed" }),
      stored("milestone.task_completed", 7, { taskId: "task-completed", outcome: "not_terminal" }),
    ];
    expect(() => projectMilestone(malformed)).toThrow("invalid planned task terminal outcome");

    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    registry.revisePlan({
      revisionId: "revision-valid-evidence", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    const events = journal.readStream("milestone-replan");
    const revision = events.at(-1)!;
    const forged = events.map((event) => event === revision ? {
      ...event,
      payload: {
        ...(revision.payload as Record<string, unknown>),
        priorEvidence: [{ ...evidenceReference(completed), streamId: "unrelated-task" }],
      },
    } : event);
    expect(() => projectMilestone(forged)).toThrow(/authority evidence/);
    journal.close();
  });

  it.each(["security", "model", "missing-model"] as const)(
    "pins post-revision admission to the durable %s capability boundary",
    (variation) => {
      const journal = new SqliteEventJournal(":memory:");
      const registry = new MilestoneRegistry(journal);
      registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
      const completed = completeFirstTask(journal);
      const readTask: PlannedTask = {
        ...pendingTask, taskId: "task-revised", dependencies: ["task-completed"],
        roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      };
      registry.revisePlan({
        revisionId: `revision-admission-${variation}`, milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
        candidatePlan: plan([completedTask, readTask]), security: security(), modelSheet: models(), requestedBy: "planner-1",
        evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
      });
      const changedModels: ModelSheet = {
        models: models().models.map((model) => model.id === "researcher" ? { ...model, model: "fixture/forged" } : model),
      };
      const admitted = registry.admitTask(
        "milestone-replan",
        "task-revised",
        variation === "security" ? security({ approvalRequiredOperations: ["external_effect"] }) : security(),
        admissionContext({ transportModelId: variation === "model" ? "fixture/forged" : "fixture/research" }),
        variation === "missing-model" ? undefined : variation === "model" ? changedModels : models(),
      );
      expect(admitted.status).toBe("paused");
      journal.close();
    },
  );

  it("requires the exact whole current Model Sheet even when only an unused capability changed", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const changed: ModelSheet = {
      models: models().models.map((model) => model.id === "unused-verifier" ? { ...model, model: "fixture/changed-unused" } : model),
    };
    expect(registry.revisePlan({
      revisionId: "revision-whole-sheet", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: revisedPlan(), security: security(), modelSheet: changed, requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    })).toMatchObject({ status: "paused", attention: { reason: "model_sheet" } });
    journal.close();
  });

  it("admits a revised task only with the exact pinned current capability", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-replan", projectId: "zentra", title: "Replan", correlationId: "trace-replan", plan: plan(), authority: authority() });
    const completed = completeFirstTask(journal);
    const readTask: PlannedTask = {
      ...pendingTask, taskId: "task-revised", dependencies: ["task-completed"],
      roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
    };
    registry.revisePlan({
      revisionId: "revision-admit", milestoneId: "milestone-replan", priorPlanDigest: digestCanonical(plan()),
      candidatePlan: plan([completedTask, readTask]), security: security(), modelSheet: models(), requestedBy: "planner-1",
      evidence: [evidenceReference(completed)], linkedTaskStreamIds: [],
    });
    expect(registry.admitTask("milestone-replan", "task-revised", security(), admissionContext(), models())).toMatchObject({
      status: "admitted", milestone: { tasks: { "task-revised": { status: "ready" } } },
    });
    journal.close();
  });
});

function stored(type: string, streamVersion: number, payload: unknown): StoredEvent {
  return {
    streamId: "milestone-replan", type, payload, causationId: null, correlationId: "trace-replan",
    eventId: `event-${streamVersion}`, streamVersion, globalPosition: streamVersion,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}
