import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EventJournal } from "../../src/journal/journal.js";
import type { MilestonePlan, PlannedTask } from "../../src/contracts/milestone.js";
import { createOpenCodeAdmissionPacket } from "../../src/contracts/authority-attention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry, type OpenCodeTaskAdmissionContext } from "../../src/milestones/milestone-registry.js";
import { assessMilestonePlanReadiness } from "../../src/milestones/plan-readiness.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const baseTask: PlannedTask = {
  taskId: "task-authority",
  title: "Inspect authority",
  description: "Inspect only the declared source scope.",
  dependencies: [],
  ownedPaths: ["src/**"],
  forbiddenPaths: [".env"],
  acceptanceCriteria: ["Boundary evidence is retained."],
  roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
  risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
  budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
};

function plan(task: PlannedTask = baseTask): MilestonePlan {
  return {
    milestoneId: "milestone-authority",
    projectId: "zentra",
    goal: "Respect the authority boundary.",
    tasks: [task],
  };
}

function security(overrides: Partial<SecuritySheet> = {}): SecuritySheet {
  return {
    allowedRepositories: [process.cwd()],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env", "secrets/**"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["ATTACKER_CANARY_SECRET_HANDLING"],
    approvalRequiredOperations: [],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: [
      "missing_authority",
      "forbidden_file_scope",
      "undeclared_network",
      "release_boundary",
    ],
    ...overrides,
  };
}

function executionContext(overrides: Partial<OpenCodeTaskAdmissionContext> = {}): OpenCodeTaskAdmissionContext {
  return {
    kind: "opencode", repositoryPath: process.cwd(), actorId: "researcher", harness: "opencode",
    role: "researcher", capabilityId: "researcher", transportModelId: "fixture/model",
    authority: "read_only",
    roles: ["researcher"], toolPermissions: ["read_repository"], network: "denied",
    contextTokens: 10_000,
    requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 30_000 },
    ...overrides,
  };
}

function readiness(taskPlan: MilestonePlan, sheet: SecuritySheet, context = executionContext()) {
  const boundContext = { ...context, authority: taskPlan.tasks[0]?.risk.authority ?? context.authority };
  const packet = createOpenCodeAdmissionPacket({
    plan: taskPlan, milestoneId: taskPlan.milestoneId, taskId: "task-authority", security: sheet,
    canonicalRepository: process.cwd(), actorId: boundContext.actorId, role: boundContext.role,
    harness: boundContext.harness,
    capabilityId: boundContext.capabilityId, transportModelId: boundContext.transportModelId,
    authority: boundContext.authority, roles: boundContext.roles,
    toolPermissions: boundContext.toolPermissions, network: boundContext.network,
    contextTokens: boundContext.contextTokens,
    requestedBudget: boundContext.requestedBudget,
  });
  return assessMilestonePlanReadiness({ plan: taskPlan, taskId: "task-authority", security: sheet, packet, context: boundContext });
}

describe("authority-bound task admission", () => {
  it.each([
    [
      "forbidden_file_scope",
      { ...baseTask, ownedPaths: ["secrets/token.txt"] },
      security(),
      "hard_stop",
    ],
    [
      "undeclared_network",
      { ...baseTask, risk: { ...baseTask.risk, authority: "external_effect", requiresApproval: true } },
      security({ network: { default: "denied", allowedDestinations: ["https://api.github.com"] } }),
      "hard_stop",
    ],
    [
      "missing_authority",
      { ...baseTask, risk: { ...baseTask.risk, requiresApproval: true } },
      security(),
      "exact_approval_required",
    ],
    [
      "release_boundary",
      { ...baseTask, risk: { ...baseTask.risk, authority: "local_release_preparation" } },
      security({ releaseBoundary: "no_release_operations" }),
      "hard_stop",
    ],
  ] as const)("returns a bounded %s decision", (reason, task, sheet, classification) => {
    const decision = readiness(plan(task as PlannedTask), sheet);

    expect(decision).toMatchObject({
      status: classification === "exact_approval_required" ? "requires_approval" : "blocked",
      reason,
      attention: {
        schemaVersion: 1,
        attentionId: expect.stringMatching(/^[a-f0-9]{64}$/),
        milestoneId: "milestone-authority",
        taskId: "task-authority",
        planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        classification,
        reason,
        requestedBy: "zentra-authority-gate",
      },
    });
    expect(JSON.stringify(decision)).not.toContain("ATTACKER_CANARY");
    expect(JSON.stringify(decision)).not.toContain("api.github.com");
  });

  it.each(["local_preparation_only", "approval_required_for_remote"])(
    "allows local release preparation under %s",
    (releaseBoundary) => {
      const sheet = security({ releaseBoundary });
      expect(readiness(
        plan({ ...baseTask, risk: { ...baseTask.risk, authority: "local_release_preparation" } }),
        sheet,
      )).toEqual({ status: "executable", reason: "ready", attention: null });
    },
  );

  it.each([
    [
      "undeclared_network",
      { network: "declared", toolPermissions: ["read_repository"] },
      "hard_stop",
    ],
    [
      "plan_not_ready",
      { network: "denied", toolPermissions: [] },
      "hard_stop",
    ],
  ] as const)("pauses for model capability boundary %s", (reason, modelCapability, classification) => {
    expect(readiness(plan(), security(), executionContext({
      ...modelCapability,
      toolPermissions: [...modelCapability.toolPermissions],
    }))).toMatchObject({
      reason,
      attention: { reason, classification },
    });
  });

  it("durably pauses exactly once, remains idempotent after reopen, and never appends readiness", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-authority-journal-"));
    roots.push(root);
    const database = path.join(root, "journal.sqlite");
    let journal = new SqliteEventJournal(database);
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-authority",
      projectId: "zentra",
      title: "Authority boundary",
      correlationId: "trace-authority",
      plan: plan({ ...baseTask, ownedPaths: ["secrets/token.txt"] }),
    });

    const first = registry.admitTask("milestone-authority", "task-authority", security(), executionContext());
    const second = registry.admitTask("milestone-authority", "task-authority", security(), executionContext());
    expect(first).toMatchObject({ status: "paused", milestone: { lifecycle: "paused" } });
    expect(second).toEqual(first);
    expect(journal.readStream("milestone-authority").map((event) => event.type)).toEqual([
      "milestone.created",
      "milestone.plan_created",
      "milestone.paused",
    ]);
    journal.close();

    journal = new SqliteEventJournal(database);
    const replayed = new MilestoneRegistry(journal).inspect("milestone-authority");
    expect(replayed).toMatchObject({
      lifecycle: "paused",
      attention: { reason: "forbidden_file_scope", taskId: "task-authority" },
      tasks: { "task-authority": { status: "planned" } },
    });
    journal.close();
  });

  it("converges on the durable pause when an admission append loses optimistic concurrency", () => {
    const inner = new SqliteEventJournal(":memory:");
    const sheet = security();
    const competing = new MilestoneRegistry(inner);
    competing.register({
      milestoneId: "milestone-authority",
      projectId: "zentra",
      title: "Concurrent authority boundary",
      correlationId: "trace-authority",
      plan: plan({ ...baseTask, ownedPaths: ["secrets/token.txt"] }),
    });
    let injected = false;
    const staleJournal: EventJournal = {
      readStream: (...args) => inner.readStream(...args),
      readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events) => {
        if (!injected && events[0]?.type === "milestone.paused") {
          injected = true;
          competing.admitTask("milestone-authority", "task-authority", sheet, executionContext());
        }
        return inner.append(streamId, expectedVersion, events);
      },
    };

    const result = new MilestoneRegistry(staleJournal).admitTask(
      "milestone-authority",
      "task-authority",
      sheet,
      executionContext(),
    );

    expect(result).toMatchObject({ status: "paused", milestone: { lifecycle: "paused" } });
    expect(inner.readStream("milestone-authority").filter((event) => event.type === "milestone.paused")).toHaveLength(1);
    inner.close();
  });

  it("converges on one ready event when executable admissions race", () => {
    const inner = new SqliteEventJournal(":memory:");
    const sheet = security();
    const competing = new MilestoneRegistry(inner);
    competing.register({
      milestoneId: "milestone-authority", projectId: "zentra", title: "Concurrent admission",
      correlationId: "trace-authority", plan: plan(),
    });
    let injected = false;
    const staleJournal: EventJournal = {
      readStream: (...args) => inner.readStream(...args),
      readAll: (...args) => inner.readAll(...args),
      append: (streamId, expectedVersion, events) => {
        if (!injected && events[0]?.type === "milestone.task_ready") {
          injected = true;
          competing.admitTask("milestone-authority", "task-authority", sheet, executionContext());
        }
        return inner.append(streamId, expectedVersion, events);
      },
    };

    const result = new MilestoneRegistry(staleJournal).admitTask(
      "milestone-authority", "task-authority", sheet, executionContext(),
    );

    expect(result).toMatchObject({ status: "admitted", milestone: { tasks: { "task-authority": { status: "ready" } } } });
    expect(inner.readStream("milestone-authority").filter((event) => event.type === "milestone.task_ready")).toHaveLength(1);
    inner.close();
  });
});
