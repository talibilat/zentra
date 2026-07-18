import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import type { NewEvent } from "../../src/contracts/event.js";
import type { EventJournal } from "../../src/journal/journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";

describe("evidence-backed milestone terminalization", () => {
  it("replays historical plan-only completion with an empty payload through inspect and list", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    const historicalPlan = {
      ...plan("milestone-historical-plan"),
      tasks: [
        plan("milestone-historical-plan").tasks[0]!,
        {
          ...plan("milestone-historical-plan").tasks[0]!,
          taskId: "research",
          dependencies: ["plan"],
          roleAssignment: { role: "researcher" as const, agentId: "researcher", harness: "opencode" as const },
        },
      ],
    };
    registry.register({
      milestoneId: "milestone-historical-plan", projectId: "project", title: "Historical plan",
      correlationId: "trace-historical-plan", plan: historicalPlan,
    });
    journal.append("milestone-historical-plan", 2, [
      historicalEvent("milestone.task_ready", { taskId: "plan", admissionDigest: "a".repeat(64) }),
      historicalEvent("milestone.task_running", { taskId: "plan", actorId: "planner", role: "planner" }),
      historicalEvent("milestone.task_completed", { taskId: "plan", actorId: "planner", role: "planner", outcome: "completed" }),
      historicalEvent("milestone.task_ready", { taskId: "research", admissionDigest: "b".repeat(64) }),
      historicalEvent("milestone.task_running", { taskId: "research", actorId: "researcher", role: "researcher" }),
      historicalEvent("milestone.task_completed", { taskId: "research", actorId: "researcher", role: "researcher", outcome: "completed" }),
      historicalEvent("milestone.completed", {}),
    ]);

    expect(registry.inspect("milestone-historical-plan")).toMatchObject({
      lifecycle: "terminal", terminalOutcome: "completed", result: null,
    });
    expect(registry.list()).toEqual([
      expect.objectContaining({ milestoneId: "milestone-historical-plan", terminalOutcome: "completed", result: null }),
    ]);
    journal.close();
  });

  it("converges repeated and competing completion onto one canonical terminal event", () => {
    const inner = new SqliteEventJournal(":memory:");
    const competing = new MilestoneRegistry(inner);
    competing.register({
      milestoneId: "milestone-converge",
      projectId: "project",
      title: "Converge",
      correlationId: "trace-converge",
      plan: plan("milestone-converge"),
    });
    inner.append("milestone-converge", 2, [
      milestoneEvent("milestone.task_ready", { taskId: "plan", admissionDigest: "a".repeat(64) }),
      milestoneEvent("milestone.task_running", { taskId: "plan", actorId: "planner", role: "planner" }),
      milestoneEvent("milestone.task_completed", { taskId: "plan", actorId: "planner", role: "planner", outcome: "completed" }),
    ]);
    let injected = false;
    const racing: EventJournal = {
      readStream: (...args) => inner.readStream(...args),
      readAll: (...args) => inner.readAll(...args),
      append: (streamId, version, events) => {
        if (!injected && events[0]?.type === "milestone.completed") {
          injected = true;
          competing.completeFromEvidence("milestone-converge");
        }
        return inner.append(streamId, version, events);
      },
    };

    const first = new MilestoneRegistry(racing).completeFromEvidence("milestone-converge");
    const repeated = competing.completeFromEvidence("milestone-converge");

    expect(first).toEqual(repeated);
    expect(first.result).toMatchObject({ outcome: "completed", tasks: [{ taskId: "plan", outcome: "completed" }] });
    expect(inner.readStream("milestone-converge").filter((event) => event.type === "milestone.completed")).toHaveLength(1);
    inner.close();
  });

  it.each(["cancelled", "denied", "timed_out", "failed"] as const)(
    "rejects caller-asserted %s without retained terminal evidence",
    (outcome) => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-partial",
      projectId: "project",
      title: "Partial",
      correlationId: "trace-partial",
      plan: plan("milestone-partial"),
    });

    expect(() => registry.finishFromEvidence("milestone-partial", outcome))
      .toThrow("non-success milestone outcome requires matching retained task evidence");
    expect(registry.inspect("milestone-partial")).toMatchObject({ lifecycle: "ready", terminalOutcome: null });
    journal.close();
    },
  );

  it("rejects a forged caller outcome that differs from deterministic retained task evidence", () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-forged", projectId: "project", title: "Forged", correlationId: "trace-forged", plan: plan("milestone-forged") });
    journal.append("milestone-forged", 2, [
      { ...milestoneEvent("milestone.task_ready", { taskId: "plan", admissionDigest: "a".repeat(64) }), streamId: "milestone-forged", correlationId: "trace-forged" },
      { ...milestoneEvent("milestone.task_running", { taskId: "plan", actorId: "planner", role: "planner" }), streamId: "milestone-forged", correlationId: "trace-forged" },
      { ...milestoneEvent("milestone.task_completed", { taskId: "plan", actorId: "planner", role: "planner", outcome: "failed" }), streamId: "milestone-forged", correlationId: "trace-forged" },
    ]);

    expect(() => registry.finishFromEvidence("milestone-forged", "cancelled"))
      .toThrow("retained task evidence selects failed, not cancelled");
    expect(registry.finishFromEvidence("milestone-forged", "failed").result).toMatchObject({
      outcome: "failed", tasks: [{ taskId: "plan", outcome: "failed" }],
    });
    journal.close();
  });

  it("rebuilds paired read-only cleanup uncertainty and reconciliation references after reopen", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-result-reconcile-"));
    const database = path.join(root, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-reconcile", projectId: "project", title: "Reconcile", correlationId: "trace-reconcile", plan: plan("milestone-reconcile") });
    const identity = {
      taskId: "plan", capsuleId: "capsule-plan-1", resourceLabel: "zentra.plan.1",
      containerName: "zentra-plan-1", imageName: "zentra-plan-1:local", repositoryViewPath: "/tmp/zentra-plan-view",
    };
    const repositoryRevision = "a".repeat(64);
    journal.append("milestone-reconcile", 2, [
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.task_ready", { taskId: "plan", admissionDigest: "b".repeat(64) }),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.agent_resource_intent", identity),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.agent_resources_prepared", {
        ...identity, containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, repositoryRevision,
      }),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.task_running", {
        taskId: "plan", capsuleId: identity.capsuleId, actorId: "planner", role: "planner", harness: "opencode",
        requestedModel: { capabilityId: "planner", transportModelId: "fixture/model" },
        budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 30_000,
        securityBoundary: {
          repository: "sanitized_read_only_bind_mount", scratch: "bounded_ephemeral", network: "model_broker_only",
          home: "ephemeral", credentials: "none", shell: "none", readableScopes: ["src/**"], forbiddenPaths: [".env"], repositoryRevision,
        },
      }),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.agent_cleanup_observed", {
        ...identity, containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, repositoryRevision,
        outcome: "uncertain", containerAbsent: false, imageAbsent: false, repositoryViewAbsent: true,
      }),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.agent_cleanup_observed", {
        ...identity, containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
      }),
      milestoneFor("milestone-reconcile", "trace-reconcile", "milestone.task_completed", {
        taskId: "plan", capsuleId: identity.capsuleId, outcome: "completed", actorId: "planner", role: "planner", harness: "opencode",
        capabilityId: "planner", transportModelId: "fixture/model",
        measuredHarness: { version: "1.18.3", executableSha256: "e".repeat(64) },
        model: { id: "fixture/model", provider: "fixture", name: "model" },
        evidence: [{
          kind: "plan", summary: "Reconciled plan evidence.",
          sha256: createHash("sha256").update("Reconciled plan evidence.").digest("hex"),
          provenance: { harness: "opencode", capabilityId: "planner", transportModelId: "fixture/model", repositoryRevision },
        }],
        cleanup: "completed", brokerTransport: "completed",
      }),
    ]);
    const terminal = registry.completeFromEvidence("milestone-reconcile");
    expect(terminal.result).toMatchObject({
      uncertainties: [{ taskId: "plan", boundary: "cleanup", resolved: true, resolution: { eventType: "milestone.agent_cleanup_observed" } }],
      decisions: [{ kind: "milestone.agent_cleanup_reconciled", evidence: { eventType: "milestone.agent_cleanup_observed" } }],
    });
    const occurrence = terminal.result!.uncertainties[0]!;
    expect(occurrence.evidence.eventId).not.toBe(occurrence.resolution?.eventId);
    journal.close();

    const reopened = SqliteEventJournal.openReadOnly(database);
    expect(new MilestoneRegistry(reopened).inspect("milestone-reconcile")).toEqual(terminal);
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });
});

function plan(milestoneId: string) {
  return {
    milestoneId,
    projectId: "project",
    goal: "Produce a plan.",
    tasks: [{
      taskId: "plan",
      title: "Plan",
      description: "Produce a bounded plan.",
      dependencies: [],
      ownedPaths: ["src/**"],
      forbiddenPaths: [".env"],
      acceptanceCriteria: ["Plan evidence is retained."],
      roleAssignment: { role: "planner" as const, agentId: "planner", harness: "opencode" as const },
      risk: { level: "low" as const, authority: "read_only" as const, requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
    }],
  };
}

function milestoneEvent(type: string, payload: unknown): NewEvent<string, unknown> {
  return { streamId: "milestone-converge", type, payload, causationId: null, correlationId: "trace-converge" };
}

function milestoneFor(streamId: string, correlationId: string, type: string, payload: unknown): NewEvent<string, unknown> {
  return { streamId, type, payload, causationId: null, correlationId };
}

function historicalEvent(type: string, payload: unknown): NewEvent<string, unknown> {
  return { streamId: "milestone-historical-plan", type, payload, causationId: null, correlationId: "trace-historical-plan" };
}
