import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admissionPacketDigest,
  createOpenCodeAdmissionPacket,
} from "../../src/contracts/authority-attention.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  MilestoneRegistry,
  type OpenCodeTaskAdmissionContext,
} from "../../src/milestones/milestone-registry.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-second-review-"));
  roots.push(root);
  return realpathSync.native(root);
}

function twoTaskPlan(secondOwnedPath = "src/b/**"): MilestonePlan {
  const task = (taskId: string, ownedPath: string, dependencies: string[] = []): MilestonePlan["tasks"][number] => ({
    taskId,
    title: taskId,
    description: `Execute ${taskId}.`,
    dependencies,
    ownedPaths: [ownedPath],
    forbiddenPaths: [".env"],
    acceptanceCriteria: [`${taskId} is complete.`],
    roleAssignment: { role: "researcher", agentId: "research-capability", harness: "opencode" },
    risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
    budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50 },
  });
  return {
    milestoneId: "milestone-second-review",
    projectId: "zentra",
    goal: "Execute two bounded tasks.",
    tasks: [task("task-a", "src/a/**"), task("task-b", secondOwnedPath, ["task-a"])],
  };
}

function security(repo: string): SecuritySheet {
  return {
    allowedRepositories: [repo],
    allowedFileScopes: ["src/**", "secrets/**"],
    forbiddenPaths: [".env", "secrets/**"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["Do not expose secrets."],
    approvalRequiredOperations: [],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["forbidden_file_scope", "plan_not_ready"],
  };
}

function context(repo: string, overrides: Partial<OpenCodeTaskAdmissionContext> = {}): OpenCodeTaskAdmissionContext {
  return {
    kind: "opencode",
    repositoryPath: repo,
    actorId: "research-capability",
    harness: "opencode",
    role: "researcher",
    capabilityId: "research-capability",
    transportModelId: "fixture/research-model",
    authority: "read_only",
    roles: ["researcher"],
    toolPermissions: ["read_repository"],
    network: "denied",
    contextTokens: 1_000,
    requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50, timeoutMs: 30_000 },
    ...overrides,
  };
}

function appendCompletedAndCleanedTaskA(journal: SqliteEventJournal): void {
  const events = journal.readStream("milestone-second-review");
  const version = events.at(-1)!.streamVersion;
  const intent = {
    taskId: "task-a",
    capsuleId: "capsule-a",
    resourceLabel: "org.zentra.capsule-id=capsule-a",
    containerName: "container-a",
    imageName: "image-a",
    repositoryViewPath: "/tmp/view-a",
  };
  journal.append("milestone-second-review", version, [
    { streamId: "milestone-second-review", type: "milestone.agent_resource_intent", payload: intent, causationId: null, correlationId: "trace-second-review" },
    { streamId: "milestone-second-review", type: "milestone.task_running", payload: { taskId: "task-a" }, causationId: null, correlationId: "trace-second-review" },
    { streamId: "milestone-second-review", type: "milestone.agent_cleanup_observed", payload: { ...intent, containerId: null, imageId: null, repositoryRevision: null, outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true }, causationId: null, correlationId: "trace-second-review" },
    { streamId: "milestone-second-review", type: "milestone.task_completed", payload: { taskId: "task-a", outcome: "completed" }, causationId: null, correlationId: "trace-second-review" },
    { streamId: "milestone-second-review", type: "milestone.agent_trace_observed", payload: { taskId: "task-a", outcome: "emitted" }, causationId: null, correlationId: "trace-second-review" },
  ]);
}

describe("second-review authority boundaries", () => {
  it("durably pauses task B after task A completed with proven cleanup and trace", () => {
    const root = repository();
    const database = path.join(root, "journal.sqlite");
    let journal = new SqliteEventJournal(database);
    let registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Second review",
      correlationId: "trace-second-review", plan: twoTaskPlan("secrets/token/**"),
    });
    const admitted = registry.admitTask("milestone-second-review", "task-a", security(root), context(root));
    expect(admitted.status).toBe("admitted");
    appendCompletedAndCleanedTaskA(journal);

    const paused = registry.admitTask("milestone-second-review", "task-b", security(root), context(root));
    expect(paused).toMatchObject({
      status: "paused",
      milestone: {
        lifecycle: "paused",
        tasks: { "task-a": { status: "completed", terminalOutcome: "completed" }, "task-b": { status: "planned" } },
      },
      attention: { reason: "forbidden_file_scope" },
    });
    journal.close();

    journal = new SqliteEventJournal(database);
    registry = new MilestoneRegistry(journal);
    expect(registry.inspect("milestone-second-review")).toMatchObject({
      lifecycle: "paused",
      attention: { reason: "forbidden_file_scope" },
      tasks: { "task-a": { status: "completed" }, "task-b": { status: "planned" } },
    });
    journal.close();
  });

  it.each(["active", "uncertain"] as const)("rejects a pause while a resource is %s", (cleanupState) => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    const activePlan = twoTaskPlan("secrets/token/**");
    activePlan.tasks[1]!.dependencies = [];
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Active",
      correlationId: "trace-second-review", plan: activePlan,
    });
    registry.admitTask("milestone-second-review", "task-a", security(repo), context(repo));
    const version = journal.readStream("milestone-second-review").at(-1)!.streamVersion;
    const intent = { taskId: "task-a", capsuleId: "capsule-a", resourceLabel: "org.zentra.capsule-id=capsule-a", containerName: "container-a", imageName: "image-a", repositoryViewPath: "/tmp/view-a" };
    journal.append("milestone-second-review", version, [
      { streamId: "milestone-second-review", type: "milestone.agent_resource_intent", payload: intent, causationId: null, correlationId: "trace-second-review" },
      ...(cleanupState === "uncertain" ? [{ streamId: "milestone-second-review", type: "milestone.agent_cleanup_observed", payload: { ...intent, containerId: null, imageId: null, repositoryRevision: null, outcome: "uncertain", containerAbsent: false, imageAbsent: false, repositoryViewAbsent: false }, causationId: null, correlationId: "trace-second-review" }] : []),
    ]);

    expect(() => registry.admitTask("milestone-second-review", "task-b", security(repo), context(repo)))
      .toThrow("authority pause must precede active or uncertain milestone effects");
    expect(journal.readStream("milestone-second-review").some((event) => event.type === "milestone.paused")).toBe(false);
    journal.close();
  });

  it("canonicalizes model capability set ordering and binds every capability field into the digest", () => {
    const repo = repository();
    const plan = twoTaskPlan();
    const sheet = security(repo);
    const packet = (overrides: Partial<OpenCodeTaskAdmissionContext>) => createOpenCodeAdmissionPacket({
      plan,
      milestoneId: plan.milestoneId,
      taskId: "task-a",
      security: sheet,
      canonicalRepository: repo,
      ...context(repo, overrides),
    });
    const first = packet({ roles: ["researcher", "planner"], toolPermissions: ["read_repository", "review_diff"] });
    const reordered = packet({ roles: ["planner", "researcher"], toolPermissions: ["review_diff", "read_repository"] });
    expect(first.roles).toEqual(["planner", "researcher"]);
    expect(first.toolPermissions).toEqual(["read_repository", "review_diff"]);
    expect(admissionPacketDigest(reordered)).toBe(admissionPacketDigest(first));
    expect(admissionPacketDigest(packet({ roles: ["researcher"] }))).not.toBe(admissionPacketDigest(first));
    expect(admissionPacketDigest(packet({ toolPermissions: ["read_repository"] }))).not.toBe(admissionPacketDigest(first));
    expect(admissionPacketDigest(packet({ network: "declared" }))).not.toBe(admissionPacketDigest(first));
    expect(admissionPacketDigest(packet({ contextTokens: 2_000 }))).not.toBe(admissionPacketDigest(first));
  });

  it.each([
    ["wrong actor", { actorId: "other", capabilityId: "other" }],
    ["wrong capability", { capabilityId: "other" }],
    ["unsupported role", { roles: ["planner"] }],
    ["writable tools", { toolPermissions: ["read_repository", "write_worktree"] }],
  ] as const)("classifies %s as non-approvable plan_not_ready", (_name, override) => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Identity",
      correlationId: "trace-second-review", plan: twoTaskPlan(),
    });
    const result = registry.admitTask(
      "milestone-second-review", "task-a", security(repo), context(repo, override as Partial<OpenCodeTaskAdmissionContext>),
    );
    expect(result).toMatchObject({
      status: "paused",
      attention: { reason: "plan_not_ready", classification: "hard_stop" },
    });
    journal.close();
  });

  it("classifies a contradictory harness as a non-approvable hard stop", () => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    const contradictory = twoTaskPlan();
    contradictory.tasks[0]!.roleAssignment.harness = "deterministic";
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Harness",
      correlationId: "trace-second-review", plan: contradictory,
    });

    expect(registry.admitTask("milestone-second-review", "task-a", security(repo), context(repo)))
      .toMatchObject({ status: "paused", attention: { reason: "plan_not_ready", classification: "hard_stop" } });
    journal.close();
  });

  it("replaces an unstarted paused plan only with exact durable attention binding and requires re-admission", () => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    const initial = twoTaskPlan("secrets/token/**");
    initial.tasks[1]!.dependencies = [];
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Replacement",
      correlationId: "trace-second-review", plan: initial,
    });
    const paused = registry.admitTask("milestone-second-review", "task-b", security(repo), context(repo));
    if (paused.status !== "paused") throw new Error("expected pause");
    const replacement = twoTaskPlan("src/b/**");
    replacement.tasks[1]!.dependencies = [];

    expect(() => registry.replacePlan({
      milestoneId: "milestone-second-review",
      attentionId: "f".repeat(64),
      priorPlanDigest: paused.attention.planDigest,
      priorSecurityDigest: paused.attention.policyDigest,
      replacementPlan: replacement,
    })).toThrow("paused plan replacement binding is stale");
    const replaced = registry.replacePlan({
      milestoneId: "milestone-second-review",
      attentionId: paused.attention.attentionId,
      priorPlanDigest: paused.attention.planDigest,
      priorSecurityDigest: paused.attention.policyDigest,
      replacementPlan: replacement,
    });
    expect(replaced).toMatchObject({
      lifecycle: "planning",
      attention: null,
      tasks: { "task-a": { status: "planned", admissionDigest: null }, "task-b": { status: "planned", admissionDigest: null } },
    });
    expect(registry.admitTask("milestone-second-review", "task-a", security(repo), context(repo)))
      .toMatchObject({ status: "admitted" });
    journal.close();
  });

  it("requires a new milestone instead of replacing a plan after historical task execution", () => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-second-review", projectId: "zentra", title: "Historical",
      correlationId: "trace-second-review", plan: twoTaskPlan("secrets/token/**"),
    });
    registry.admitTask("milestone-second-review", "task-a", security(repo), context(repo));
    appendCompletedAndCleanedTaskA(journal);
    const paused = registry.admitTask("milestone-second-review", "task-b", security(repo), context(repo));
    if (paused.status !== "paused") throw new Error("expected pause");

    expect(() => registry.replacePlan({
      milestoneId: "milestone-second-review",
      attentionId: paused.attention.attentionId,
      priorPlanDigest: paused.attention.planDigest,
      priorSecurityDigest: paused.attention.policyDigest,
      replacementPlan: twoTaskPlan(),
    })).toThrow("create a new milestone after task execution has started");
    journal.close();
  });
});
