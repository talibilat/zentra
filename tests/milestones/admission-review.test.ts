import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NewEvent } from "../../src/contracts/event.js";
import type { MilestonePlan } from "../../src/contracts/milestone.js";
import type { PagedEventJournal as EventJournal } from "../../src/journal/journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import {
  MilestoneRegistry,
  type OpenCodeTaskAdmissionContext,
} from "../../src/milestones/milestone-registry.js";
import { projectMilestone } from "../../src/milestones/milestone-projection.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-admission-review-"));
  roots.push(root);
  return realpathSync.native(root);
}

function plan(authority: MilestonePlan["tasks"][number]["risk"]["authority"] = "read_only"): MilestonePlan {
  return {
    milestoneId: "milestone-admission",
    projectId: "zentra",
    goal: "Admit one bounded task.",
    tasks: [{
      taskId: "task-admission",
      title: "Bounded task",
      description: "Perform bounded work.",
      dependencies: [],
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Boundary remains intact."],
      roleAssignment: { role: "researcher", agentId: "research-capability", harness: "opencode" },
      risk: { level: "low", authority, requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50 },
    }],
  };
}

function security(allowedRepository: string, overrides: Partial<SecuritySheet> = {}): SecuritySheet {
  return {
    allowedRepositories: [allowedRepository],
    allowedFileScopes: ["src/**"],
    forbiddenPaths: [".env"],
    network: { default: "denied", allowedDestinations: [] },
    secretHandling: ["ATTACKER_CANARY_POLICY_PROSE"],
    approvalRequiredOperations: [],
    releaseBoundary: "local_preparation_only",
    stopAndAskConditions: [],
    ...overrides,
  };
}

function context(repositoryPath: string, overrides: Partial<OpenCodeTaskAdmissionContext> = {}): OpenCodeTaskAdmissionContext {
  return {
    kind: "opencode",
    repositoryPath,
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
    requestedBudget: {
      maxSeconds: 30,
      maxCostUsd: 1,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      timeoutMs: 30_000,
    },
    ...overrides,
  };
}

function registered(journal: EventJournal): MilestoneRegistry {
  const registry = new MilestoneRegistry(journal);
  registry.register({
    milestoneId: "milestone-admission",
    projectId: "zentra",
    title: "Admission",
    correlationId: "trace-admission",
    plan: plan(),
  });
  return registry;
}

describe("reviewed authority admission packet", () => {
  it("durably pauses a registered milestone whose plan is not ready", () => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-admission", projectId: "zentra", title: "Needs plan",
      correlationId: "trace-admission",
    });

    const result = registry.admitTask(
      "milestone-admission", "task-admission", security(repo), context(repo),
    );

    expect(result).toMatchObject({
      status: "paused",
      attention: { reason: "plan_not_ready", taskId: "task-admission" },
      milestone: { lifecycle: "paused", plan: null },
    });
    expect(journal.readStream("milestone-admission").map((event) => event.type)).toEqual([
      "milestone.created", "milestone.paused",
    ]);
    journal.close();
  });

  it("canonicalizes and binds the exact allowed repository into task readiness", () => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const result = registered(journal).admitTask(
      "milestone-admission",
      "task-admission",
      security(repo),
      context(path.join(repo, ".")),
    );
    if (result.status !== "admitted") throw new Error("expected admission");

    expect(result).toMatchObject({
      status: "admitted",
      admission: {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        packet: {
          schemaVersion: 1,
          milestoneId: "milestone-admission",
          taskId: "task-admission",
          repository: repo,
          actorId: "research-capability",
          harness: "opencode",
          capabilityId: "research-capability",
          transportModelId: "fixture/research-model",
          authority: "read_only",
          requestedBudget: { timeoutMs: 30_000 },
        },
      },
    });
    expect(journal.readStream("milestone-admission").at(-1)).toMatchObject({
      type: "milestone.task_ready",
      payload: { taskId: "task-admission", admissionDigest: result.admission.digest },
    });
    journal.close();
  });

  it("durably pauses a canonical repository outside the exact allowlist without exposing paths or prose", () => {
    const allowed = repository();
    const requested = repository();
    const journal = new SqliteEventJournal(":memory:");
    const result = registered(journal).admitTask(
      "milestone-admission", "task-admission", security(allowed), context(requested),
    );
    if (result.status !== "paused") throw new Error("expected pause");

    expect(result).toMatchObject({
      status: "paused",
      attention: {
        reason: "forbidden_file_scope",
        classification: "hard_stop",
        configuredStopCondition: false,
        admissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const serialized = JSON.stringify(result.attention);
    expect(serialized).not.toContain(allowed);
    expect(serialized).not.toContain(requested);
    expect(serialized).not.toContain("ATTACKER_CANARY");
    expect(journal.readStream("milestone-admission").map((event) => event.type)).toEqual([
      "milestone.created", "milestone.plan_created", "milestone.paused",
    ]);
    journal.close();
  });

  it.each([
    [{ requestedBudget: { maxSeconds: 31, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50, timeoutMs: 30_000 } }, "maxSeconds"],
    [{ requestedBudget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50, timeoutMs: 30_001 } }, "timeoutMs"],
  ] as const)("durably pauses over-budget admission for %s", (override, _field) => {
    const repo = repository();
    const journal = new SqliteEventJournal(":memory:");
    const result = registered(journal).admitTask(
      "milestone-admission", "task-admission", security(repo), context(repo, override),
    );

    expect(result).toMatchObject({
      status: "paused",
      attention: { reason: "budget_exceeded", classification: "hard_stop" },
    });
    expect(journal.readStream("milestone-admission").some((event) => event.type === "milestone.task_ready")).toBe(false);
    journal.close();
  });

  it.each(["same", "other"] as const)(
    "does not append a late pause when %s-task resource intent wins the CAS race",
    (whichTask) => {
      const repo = repository();
      const inner = new SqliteEventJournal(":memory:");
      const twoTaskPlan: MilestonePlan = {
        ...plan(),
        tasks: [
          plan().tasks[0]!,
          { ...plan().tasks[0]!, taskId: "task-other", dependencies: [] },
        ],
      };
      const registry = new MilestoneRegistry(inner);
      registry.register({
        milestoneId: "milestone-admission", projectId: "zentra", title: "Race",
        correlationId: "trace-admission", plan: twoTaskPlan,
      });
      registry.admitTask("milestone-admission", "task-admission", security(repo), context(repo));
      if (whichTask === "other") {
        registry.admitTask(
          "milestone-admission",
          "task-other",
          security(repo),
          context(repo, { actorId: "research-capability", capabilityId: "research-capability" }),
        );
      }
      let injected = false;
      const racingJournal: EventJournal = {
        readStream: (...args) => inner.readStream(...args),
        readAll: (...args) => inner.readAll(...args),
        readStreamPage: (...args) => inner.readStreamPage(...args),
        readAllPage: (...args) => inner.readAllPage(...args),
        append: (streamId, expectedVersion, events) => {
          if (!injected && events[0]?.type === "milestone.paused") {
            injected = true;
            const taskId = whichTask === "same" ? "task-admission" : "task-other";
            const intent: NewEvent<string, unknown> = {
              streamId,
              type: "milestone.agent_resource_intent",
              payload: {
                taskId,
                capsuleId: `capsule-${taskId}`,
                resourceLabel: `org.zentra.capsule-id=capsule-${taskId}`,
                containerName: `container-${taskId}`,
                imageName: `image-${taskId}`,
                repositoryViewPath: path.join(repo, `view-${taskId}`),
              },
              causationId: null,
              correlationId: "trace-admission",
            };
            inner.append(streamId, expectedVersion, [intent]);
          }
          return inner.append(streamId, expectedVersion, events);
        },
      };

      expect(() => new MilestoneRegistry(racingJournal).admitTask(
        "milestone-admission",
        "task-admission",
        security(repo, { forbiddenPaths: [".env", "src/**"] }),
        context(repo),
      )).toThrow("authority pause must precede active or uncertain milestone effects");
      const events = inner.readStream("milestone-admission");
      expect(events.filter((event) => event.type === "milestone.paused")).toHaveLength(0);
      expect(projectMilestone(events)?.lifecycle).not.toBe("paused");
      inner.close();
    },
  );
});
