import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenCodeReadOnlyAgent,
  type OpenCodeReadOnlyCapsule,
} from "../../src/agents/opencode-read-only-agent.js";
import type { ModelBroker } from "../../src/capsule/model-broker.js";
import type { ModelBrokerReceipt } from "../../src/capsule/model-broker.js";
import type { OpenCodeReadOnlyCapsuleResult } from "../../src/agents/opencode-read-only-agent.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import type { ModelSheet } from "../../src/policy/model-sheet.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCodeReadOnlyAgent milestone path", () => {
  it("runs a brokered planning role without a writable worktree and journals trace evidence", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-read-only-agent-")));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/context.ts"), "allowed context\n");
    writeFileSync(path.join(root, "unrelated.txt"), "must not be mounted\n");
    const sqlite = new SqliteEventJournal(":memory:");
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"));
    const journal = new ProjectingEventJournal(sqlite, sink);
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-18",
      projectId: "zentra",
      title: "Plan issue 18",
      correlationId: "trace-18",
      plan: {
        milestoneId: "milestone-18",
        projectId: "zentra",
        goal: "Produce a bounded implementation plan.",
        tasks: [{
          taskId: "plan-18",
          title: "Plan",
          description: "Inspect the supplied context and produce a plan.",
          dependencies: [],
          ownedPaths: ["src/**"],
          forbiddenPaths: [".env"],
          acceptanceCriteria: ["Evidence-backed plan is recorded."],
          roleAssignment: { role: "planner", agentId: "opencode-planner", harness: "opencode" },
          risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
          budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
        }],
      },
    });
    journal.append("milestone-18", 2, [{
      streamId: "milestone-18",
      type: "milestone.task_ready",
      payload: { taskId: "plan-18" },
      causationId: null,
      correlationId: "trace-18",
    }]);

    const broker: ModelBroker = {
      execute: vi.fn(async (request): Promise<ModelBrokerReceipt> => ({
        outcome: "completed",
        response: { type: "text", text: "1. Inspect contracts.\n2. Add the bounded adapter." },
        model: { id: request.modelId, provider: "fixture", name: "planner-v1" },
        usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.01 },
      })),
    };
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: vi.fn(async (request, receivedBroker, signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
        expect(signal.aborted).toBe(false);
        expect(request).not.toHaveProperty("worktree");
        expect(request).not.toHaveProperty("workspace");
        expect(request.repositoryPath).not.toBe(root);
        expect(readFileSync(path.join(request.repositoryPath, "src/context.ts"), "utf8")).toBe("allowed context\n");
        expect(existsSync(path.join(request.repositoryPath, "unrelated.txt"))).toBe(false);
        expect(request.securityBoundary).toEqual({
          repository: "sanitized_read_only_bind_mount",
          scratch: "bounded_ephemeral",
          network: "model_broker_only",
          home: "ephemeral",
          credentials: "none",
          shell: "none",
          readableScopes: ["src/**"],
          forbiddenPaths: [".env"],
          repositoryRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        observe?.({ type: "resources_prepared", payload: {
          capsuleId: request.capsuleId,
          resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath,
          repositoryRevision: request.securityBoundary.repositoryRevision,
        } });
        const receipt = await receivedBroker.execute({
          modelId: request.transportModelId,
          prompt: request.rolePrompt,
          maxInputTokens: request.budget.maxInputTokens,
          maxOutputTokens: request.budget.maxOutputTokens,
          maxCostUsd: request.budget.maxCostUsd,
        }, signal);
        observe?.({ type: "cleanup_observed", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: "b".repeat(64),
          imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
          repositoryViewPath: request.repositoryPath,
          repositoryRevision: request.securityBoundary.repositoryRevision,
          outcome: "completed",
          containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
        } });
        return {
          outcome: receipt.outcome === "completed" ? "completed" : "failed",
          openCode: { version: "1.18.1", executableSha256: "b83305b14e233483aba7027a9dd6a18716b8786b3fe13261e0afce96f4418b17" },
          model: receipt.model,
          evidence: [{ kind: "plan", summary: receipt.response?.type === "text" ? receipt.response.text : "" }],
          cleanup: "completed",
          brokerTransport: "completed",
        };
      }),
    };

    const result = await new OpenCodeReadOnlyAgent(journal, capsule, broker, modelSheet("planner")).run({
      milestoneId: "milestone-18",
      taskId: "plan-18",
      repositoryPath: root,
      role: "planner",
      rolePrompt: "Plan the bounded change and cite the supplied evidence.",
      budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
      timeoutMs: 20_000,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("completed");
    expect(result.trace).toEqual({ outcome: "emitted" });
    expect(registry.inspect("milestone-18")?.tasks["plan-18"]).toMatchObject({
      status: "completed",
      terminalOutcome: "completed",
    });
    expect(journal.readStream("milestone-18").slice(-5).map((event) => event.type)).toEqual([
      "milestone.agent_resource_intent",
      "milestone.task_running",
      "milestone.agent_resources_prepared",
      "milestone.agent_cleanup_observed",
      "milestone.task_completed",
    ]);
    sink.close();
    const lines = (await import("node:fs")).readFileSync(path.join(root, "trace.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const agentLines = lines.filter((line) => line.kind === "milestone.task_running" || line.kind === "milestone.task_completed");
    expect(agentLines).toEqual([
      expect.objectContaining({
        actor: { id: "opencode-planner", role: "planner" },
        operation: { name: "opencode_agent", status: "running" },
        payload: expect.objectContaining({ requestedModel: {
          capabilityId: "opencode-planner", transportModelId: "fixture/model",
        } }),
      }),
      expect.objectContaining({
        actor: { id: "opencode-planner", role: "planner" },
        operation: { name: "opencode_agent", status: "completed" },
        payload: expect.objectContaining({
          capabilityId: "opencode-planner",
          transportModelId: "fixture/model",
          model: { id: "fixture/model", provider: "fixture", name: "planner-v1" },
          evidence: [expect.objectContaining({
            kind: "plan",
            summary: "1. Inspect contracts.\n2. Add the bounded adapter.",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            provenance: expect.objectContaining({ harness: "opencode" }),
          })],
        }),
      }),
    ]);
    sqlite.close();
  });

  it.each(["cancelled", "timed_out"] as const)("preserves thrown %s with uncertain cleanup", async (expected) => {
    const journal = new SqliteEventJournal(":memory:");
    readyMilestone(journal, `milestone-thrown-${expected}`);
    const controller = new AbortController();
    if (expected === "cancelled") controller.abort();
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async (_request, _broker, signal) => {
        if (expected === "timed_out") await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error(expected);
      },
    };
    const result = await new OpenCodeReadOnlyAgent(journal, capsule, { execute: vi.fn() }, modelSheet("researcher")).run({
      milestoneId: `milestone-thrown-${expected}`, taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: expected === "timed_out" ? 10 : 1_000, signal: controller.signal,
    });
    expect(result).toMatchObject({ outcome: expected, cleanup: "uncertain" });
    journal.close();
  });

  it("surfaces synchronous Agent Tail projection failure without rewriting journal truth", async () => {
    const sqlite = new SqliteEventJournal(":memory:");
    const journal = new ProjectingEventJournal(sqlite, { append: () => { throw new Error("trace failed"); } });
    readyMilestone(journal as unknown as SqliteEventJournal, "milestone-trace-failed");
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async (request, _broker, _signal, observe) => {
        observe?.({ type: "cleanup_observed", payload: {
          capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
          containerName: request.resources.containerName, containerId: null,
          imageName: request.resources.imageName, imageId: null,
          repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
          outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
        } });
        return {
          outcome: "completed" as const,
          openCode: { version: "1.18.1" as const, executableSha256: "a".repeat(64) },
          model: { id: "fixture/model", provider: "fixture", name: "model" },
          evidence: [{ kind: "plan" as const, summary: "Retained journal evidence." }], cleanup: "completed" as const, brokerTransport: "completed" as const,
        };
      },
    };
    const result = await new OpenCodeReadOnlyAgent(journal, capsule, { execute: vi.fn() }, modelSheet("researcher")).run({
      milestoneId: "milestone-trace-failed", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: "completed", trace: { outcome: "failed" } });
    expect(new MilestoneRegistry(sqlite).inspect("milestone-trace-failed")?.tasks["task-1"]?.terminalOutcome).toBe("completed");
    sqlite.close();
  });

  it("runs an OpenCode reviewer with review authority inside the read-only capsule boundary", async () => {
    const journal = new SqliteEventJournal(":memory:");
    readyMilestone(journal, "milestone-reviewer", "reviewer");
    const execute = vi.fn(async (request, _broker, _signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
      expect(request.role).toBe("reviewer");
      expect(request).not.toHaveProperty("worktree");
      expect(request.securityBoundary).toMatchObject({
        repository: "sanitized_read_only_bind_mount",
        credentials: "none",
        shell: "none",
      });
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId,
        resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName,
        containerId: null,
        imageName: request.resources.imageName,
        imageId: null,
        repositoryViewPath: request.repositoryPath,
        repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed",
        containerAbsent: true,
        imageAbsent: true,
        repositoryViewAbsent: false,
      } });
      return {
        outcome: "completed",
        openCode: { version: "1.18.1", executableSha256: "a".repeat(64) },
        model: { id: "fixture/model", provider: "fixture", name: "reviewer-v1" },
        evidence: [{ kind: "review", summary: "{\"decision\":\"approve\"}" }],
        cleanup: "completed",
        brokerTransport: "completed",
      };
    });

    const result = await new OpenCodeReadOnlyAgent(
      journal,
      { execute },
      { execute: vi.fn() },
      modelSheet("reviewer"),
    ).run({
      milestoneId: "milestone-reviewer",
      taskId: "task-1",
      repositoryPath: process.cwd(),
      role: "reviewer",
      rolePrompt: "Review the digest-bound evidence.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("completed");
    expect(journal.readStream("milestone-reviewer").find((event) =>
      event.type === "milestone.task_running")?.payload).toMatchObject({
      actorId: "opencode-reviewer",
      role: "reviewer",
    });
    journal.close();
  });

  it("rejects a symlink in planned readable scope before capsule execution", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-agent-symlink-")));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, path.join(root, "src/escape.ts"));
    const journal = new SqliteEventJournal(":memory:");
    readyMilestone(journal, "milestone-symlink");
    const execute = vi.fn();

    await expect(new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, modelSheet("researcher")).run({
      milestoneId: "milestone-symlink", taskId: "task-1", repositoryPath: root,
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    })).rejects.toThrow("symbolic links");
    expect(execute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-symlink").at(-1)?.type).toBe("milestone.agent_resource_intent");
    journal.close();
  });

  it("rejects a task-assigned model whose parsed capability exceeds the capsule boundary", async () => {
    const journal = new SqliteEventJournal(":memory:");
    readyMilestone(journal, "milestone-model-policy");
    const execute = vi.fn();
    const models = modelSheet("researcher");
    const incompatible: ModelSheet = { models: [{ ...models.models[0]!, network: "declared" }] };
    await expect(new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, incompatible).run({
      milestoneId: "milestone-model-policy", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    })).rejects.toThrow("not approved");
    expect(execute).not.toHaveBeenCalled();
    journal.close();
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
  ] as const)("maps capsule %s to the canonical milestone task outcome", async (capsuleOutcome, expected) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      readyMilestone(journal, `milestone-${capsuleOutcome}`);
      const capsule: OpenCodeReadOnlyCapsule = {
        execute: vi.fn(async (): Promise<OpenCodeReadOnlyCapsuleResult> => ({
          outcome: capsuleOutcome,
          openCode: null,
          model: null,
          evidence: [],
          cleanup: "uncertain",
          brokerTransport: "completed",
        })),
      };
      const broker: ModelBroker = { execute: vi.fn() };
      const result = await new OpenCodeReadOnlyAgent(journal, capsule, broker, modelSheet("researcher")).run({
        milestoneId: `milestone-${capsuleOutcome}`,
        taskId: "task-1",
        repositoryPath: process.cwd(),
        role: "researcher",
        rolePrompt: "Research the bounded question.",
        budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      });
      expect(result.outcome).toBe(expected);
      expect(result.trace).toEqual({ outcome: "not_configured" });
      expect(new MilestoneRegistry(journal).inspect(`milestone-${capsuleOutcome}`)?.tasks["task-1"]?.terminalOutcome).toBe(expected);
    } finally {
      journal.close();
    }
  });
});

function readyMilestone(
  journal: SqliteEventJournal | ProjectingEventJournal,
  milestoneId: string,
  role: "researcher" | "reviewer" = "researcher",
): void {
  new MilestoneRegistry(journal).register({
    milestoneId,
    projectId: "zentra",
    title: "Research",
    correlationId: milestoneId,
    plan: {
      milestoneId,
      projectId: "zentra",
      goal: "Research",
      tasks: [{
        taskId: "task-1", title: "Research", description: "Research.", dependencies: [],
        ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence."],
        roleAssignment: {
          role,
          agentId: role === "reviewer" ? "opencode-reviewer" : "opencode-researcher",
          harness: "opencode",
        },
        risk: {
          level: "low",
          authority: role === "reviewer" ? "review" : "read_only",
          requiresReview: false,
          requiresApproval: false,
        },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }],
    },
  });
  journal.append(milestoneId, 2, [{
    streamId: milestoneId, type: "milestone.task_ready", payload: { taskId: "task-1" },
    causationId: null, correlationId: milestoneId,
  }]);
}

function modelSheet(role: "planner" | "researcher" | "reviewer"): ModelSheet {
  return {
    models: [{
      id: role === "planner"
        ? "opencode-planner"
        : role === "reviewer"
        ? "opencode-reviewer"
        : "opencode-researcher",
      harness: "opencode",
      model: "fixture/model",
      roles: [role],
      specialties: ["planning"],
      costTier: "low",
      contextTokens: 10_000,
      maxConcurrency: 1,
      toolPermissions: role === "reviewer"
        ? ["review_diff", "read_repository"]
        : ["read_repository"],
      network: "denied",
      fallbackOrder: [],
      qualityHistory: { successes: 1, attempts: 1 },
    }],
  };
}
