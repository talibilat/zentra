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
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import { projectWorkerLifecycle } from "../../src/workers/worker-lifecycle.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";
import { GovernedWebResearch } from "../../src/research/web-research.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { EventJournal } from "../../src/journal/journal.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCodeReadOnlyAgent milestone path", () => {
  it("runs a journaled cold-preparation and model turn within one bounded deadline", async () => {
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
    const admission = registry.admitTask(
      "milestone-18", "plan-18", admissionSecurity(root, ["src/**"]),
      admissionContext(root, "opencode-planner", "planner", { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500, timeoutMs: 300 }),
    );
    if (admission.status !== "admitted") throw new Error("expected admission");

    let executionStartedAt = 0;
    let modelStartedAt = 0;
    let modelSignal: AbortSignal | null = null;
    const broker: ModelBroker = {
      execute: vi.fn(async (request, signal): Promise<ModelBrokerReceipt> => {
        modelStartedAt = Date.now();
        modelSignal = signal;
        expect(signal.aborted).toBe(false);
        return {
          outcome: "completed",
          response: { type: "text", text: "1. Inspect contracts.\n2. Add the bounded adapter." },
          model: { id: request.modelId, provider: "fixture", name: "planner-v1" },
          usage: { inputTokens: 12, outputTokens: 14, costUsd: 0.01 },
        };
      }),
    };
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: vi.fn(async (request, receivedBroker, signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
        expect(signal.aborted).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 116));
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
          openCode: { version: "1.18.3", executableSha256: "915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb" },
          model: receipt.model,
          evidence: [{ kind: "plan", summary: receipt.response?.type === "text" ? receipt.response.text : "" }],
          cleanup: "completed",
          brokerTransport: "completed",
          usage: { seconds: 1, inputTokens: 12, outputTokens: 14, costUsd: 0.01, costUsdNano: 10_000_000, toolCalls: 0, modelTurns: 1 },
        };
      }),
    };

    executionStartedAt = Date.now();
    const result = await new OpenCodeReadOnlyAgent(journal, capsule, broker, modelSheet("planner")).run({
      milestoneId: "milestone-18",
      taskId: "plan-18",
      repositoryPath: root,
      role: "planner",
      rolePrompt: "Plan the bounded change and cite the supplied evidence.",
      budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
      timeoutMs: 300,
      signal: new AbortController().signal,
      admission: admission.admission,
    });

    expect(result.outcome).toBe("completed");
    expect(modelStartedAt - executionStartedAt).toBeGreaterThanOrEqual(100);
    expect(modelSignal).not.toBeNull();
    await new Promise<void>((resolve) => {
      if (modelSignal!.aborted) resolve();
      else modelSignal!.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(Date.now() - modelStartedAt).toBeGreaterThan(0);
    expect(Date.now() - modelStartedAt).toBeLessThan(280);
    expect(Date.now() - executionStartedAt).toBeLessThan(500);
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
    const worker = Object.values(projectWorkerLifecycle(journal.readAll()).workers)[0];
    expect(worker).toMatchObject({
      taskId: "plan-18", parentWorkerId: null, harness: "opencode", role: "planner",
      status: "terminal", terminalOutcome: "completed", cleanup: "completed",
      usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0 },
    });
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
    const admission = readyMilestone(
      journal,
      `milestone-thrown-${expected}`,
      process.cwd(),
      expected === "timed_out" ? 10 : 1_000,
    );
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
      admission,
    });
    expect(result).toMatchObject({ outcome: expected, cleanup: "uncertain" });
    journal.close();
  });

  it("surfaces synchronous Agent Tail projection failure without rewriting journal truth", async () => {
    const sqlite = new SqliteEventJournal(":memory:");
    const journal = new ProjectingEventJournal(sqlite, { append: () => { throw new Error("trace failed"); } });
    const admission = readyMilestone(journal, "milestone-trace-failed");
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
          openCode: { version: "1.18.3" as const, executableSha256: "a".repeat(64) },
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
      admission,
    });
    expect(result).toMatchObject({ outcome: "completed", trace: { outcome: "failed" } });
    expect(new MilestoneRegistry(sqlite).inspect("milestone-trace-failed")?.tasks["task-1"]?.terminalOutcome).toBe("completed");
    sqlite.close();
  });

  it("runs an OpenCode reviewer with review authority inside the read-only capsule boundary", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const security = admissionSecurity(process.cwd(), ["docs/**", "src/**"]);
    const admission = readyMilestone(journal, "milestone-reviewer", "reviewer", 1_000, security.allowedFileScopes);
    const execute = vi.fn(async (request, _broker, _signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
      expect(request.role).toBe("reviewer");
      expect(request).not.toHaveProperty("worktree");
      expect(request.securityBoundary).toMatchObject({
        repository: "sanitized_read_only_bind_mount",
        credentials: "none",
        shell: "none",
      });
      expect(request.securityBoundary.readableScopes).toEqual(["src/**"]);
      expect(existsSync(path.join(request.repositoryPath, "docs"))).toBe(false);
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
        openCode: { version: "1.18.3", executableSha256: "a".repeat(64) },
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
      security,
    ).run({
      milestoneId: "milestone-reviewer",
      taskId: "task-1",
      repositoryPath: process.cwd(),
      role: "reviewer",
      rolePrompt: "Review the digest-bound evidence.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      admission,
      reviewEvidence: { workerId: "writer-1", diffSha256: "a".repeat(64), validationSha256: "b".repeat(64) },
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
    const admission = readyMilestone(journal, "milestone-symlink", root);
    const execute = vi.fn();

    await expect(new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, modelSheet("researcher")).run({
      milestoneId: "milestone-symlink", taskId: "task-1", repositoryPath: root,
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
      admission,
    })).rejects.toThrow("symbolic links");
    expect(execute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-symlink").at(-1)?.type).toBe("milestone.agent_resource_intent");
    journal.close();
  });

  it("rejects a task-assigned model whose parsed capability exceeds the capsule boundary", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, "milestone-model-policy");
    const execute = vi.fn();
    const models = modelSheet("researcher");
    const incompatible: ModelSheet = { models: [{ ...models.models[0]!, network: "declared" }] };
    await expect(new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, incompatible).run({
      milestoneId: "milestone-model-policy", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
      admission,
    })).rejects.toThrow("not approved");
    expect(execute).not.toHaveBeenCalled();
    journal.close();
  });

  it("revalidates the exact durable admission packet before resource intent", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, "milestone-admission-tamper");
    const execute = vi.fn();

    await expect(new OpenCodeReadOnlyAgent(
      journal,
      { execute },
      { execute: vi.fn() },
      modelSheet("researcher"),
    ).run({
      milestoneId: "milestone-admission-tamper", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
      admission: { ...admission, packet: { ...admission.packet, transportModelId: "attacker/model" } },
    })).rejects.toThrow("does not match durable task admission");
    expect(execute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-admission-tamper").at(-1)?.type).toBe("milestone.task_ready");
    journal.close();
  });

  it("rejects a stale admission when the canonical model capability snapshot changes", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, "milestone-model-snapshot");
    const execute = vi.fn();
    const changed = modelSheet("researcher");
    const changedModels: ModelSheet = {
      models: [{ ...changed.models[0]!, roles: ["planner", "researcher"] }],
    };

    await expect(new OpenCodeReadOnlyAgent(
      journal,
      { execute },
      { execute: vi.fn() },
      changedModels,
    ).run({
      milestoneId: "milestone-model-snapshot", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal, admission,
    })).rejects.toThrow("does not match durable task admission");
    expect(execute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-model-snapshot").at(-1)?.type).toBe("milestone.task_ready");
    journal.close();
  });

  it("revalidates admitted context capacity immediately before resource intent", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, "milestone-context-snapshot");
    const execute = vi.fn();
    const changed = modelSheet("researcher");
    const changedModels: ModelSheet = {
      models: [{ ...changed.models[0]!, contextTokens: 20_000 }],
    };

    await expect(new OpenCodeReadOnlyAgent(
      journal,
      { execute },
      { execute: vi.fn() },
      changedModels,
    ).run({
      milestoneId: "milestone-context-snapshot", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal, admission,
    })).rejects.toThrow("does not match durable task admission");
    expect(execute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-context-snapshot").at(-1)?.type).toBe("milestone.task_ready");
    journal.close();
  });

  it("rejects a paused lifecycle before resource intent, repository view, capsule, or broker effects", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-paused-agent", projectId: "zentra", title: "Paused", correlationId: "trace-paused-agent",
      plan: { milestoneId: "milestone-paused-agent", projectId: "zentra", goal: "Stop", tasks: [{
        taskId: "task-1", title: "Stop", description: "Stop.", dependencies: [], ownedPaths: ["secrets/token.txt"], forbiddenPaths: [".env"], acceptanceCriteria: ["No effect."],
        roleAssignment: { role: "researcher", agentId: "opencode-researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const security: SecuritySheet = {
      allowedRepositories: [process.cwd()], allowedFileScopes: ["src/**"], forbiddenPaths: [".env", "secrets/**"],
      network: { default: "denied", allowedDestinations: [] }, secretHandling: ["Do not expose secrets."],
      approvalRequiredOperations: [], releaseBoundary: "local_preparation_only", stopAndAskConditions: ["forbidden_file_scope"],
    };
    registry.admitTask(
      "milestone-paused-agent", "task-1", security,
      admissionContext(process.cwd(), "opencode-researcher", "researcher"),
    );
    const execute = vi.fn();
    const brokerExecute = vi.fn();

    await expect(new OpenCodeReadOnlyAgent(
      journal,
      { execute },
      { execute: brokerExecute },
      modelSheet("researcher"),
    ).run({
      milestoneId: "milestone-paused-agent", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
      admission: { packet: {} as never, digest: "a".repeat(64) },
    })).rejects.toThrow("milestone is paused");
    expect(execute).not.toHaveBeenCalled();
    expect(brokerExecute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-paused-agent").at(-1)?.type).toBe("milestone.paused");
    journal.close();
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
  ] as const)("maps capsule %s to the canonical milestone task outcome", async (capsuleOutcome, expected) => {
    const journal = new SqliteEventJournal(":memory:");
    try {
      const admission = readyMilestone(journal, `milestone-${capsuleOutcome}`);
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
        admission,
      });
      expect(result.outcome).toBe(expected);
      expect(result.trace).toEqual({ outcome: "not_configured" });
      expect(new MilestoneRegistry(journal).inspect(`milestone-${capsuleOutcome}`)?.tasks["task-1"]?.terminalOutcome).toBeNull();
      expect(Object.values(projectWorkerLifecycle(journal.readAll()).workers)[0]).toMatchObject({
        status: "uncertain", terminalOutcome: null, cleanup: "uncertain",
      });
    } finally {
      journal.close();
    }
  });

  it("settles and authoritatively pauses before an out-of-policy research effect", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-research-attention-")));
    roots.push(root); mkdirSync(path.join(root, "src")); writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const journal = new SqliteEventJournal(":memory:");
    rmSync(openCodeResourceIdentity("milestone-attention", "research-task", 1).repositoryViewPath, { recursive: true, force: true });
    const registry = new MilestoneRegistry(journal);
    registry.register({ milestoneId: "milestone-attention", projectId: "zentra", title: "Research", correlationId: "trace-attention",
      plan: { milestoneId: "milestone-attention", projectId: "zentra", goal: "Research", tasks: [{
        taskId: "research-task", title: "Research", description: "Research approved sources.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Cited evidence."],
        roleAssignment: { role: "researcher", agentId: "opencode-researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 10, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] } });
    const security = { ...admissionSecurity(root, ["src/**"]), network: { default: "denied" as const, allowedDestinations: ["https://docs.example.com"] } };
    const context = { ...admissionContext(root, "opencode-researcher", "researcher", { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 10_000 }),
      toolPermissions: ["read_repository", "web_research"], network: "declared" as const };
    const admission = registry.admitTask("milestone-attention", "research-task", security, context);
    if (admission.status !== "admitted") throw new Error("expected research admission");
    let executions = 0;
    const capsule: OpenCodeReadOnlyCapsule = { execute: vi.fn(async (request, _broker, signal, observe, research) => {
      executions += 1;
      const attention = await research!.execute({ schemaVersion: 1, requestId: "outside-1", taskId: request.taskId, workerId: request.capsuleId,
        role: "researcher", modelId: request.transportModelId, tool: "zentra_web_research", method: "GET",
        url: "https://outside.example/path?secret=hidden", envelopeDigest: request.webResearchEnvelopeDigest,
        policyDigest: request.webResearch!.digest, trace: request.trace }, request.webResearch, signal);
      expect(attention).toMatchObject({ outcome: "denied", reason: "capability_attention" });
      observe?.({ type: "research_started", requestId: "outside-1" });
      observe?.({ type: "research_completed", requestId: "outside-1", result: attention });
      observe?.({ type: "cleanup_observed", payload: { capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: null, imageName: request.resources.imageName, imageId: null,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false } });
      return { outcome: "failed" as const, openCode: { version: "1.18.3" as const, executableSha256: "a".repeat(64) }, model: null,
        evidence: [], cleanup: "completed" as const, brokerTransport: "completed" as const };
    }) };
    const models: ModelSheet = { models: [{ id: "opencode-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: ["research"],
      costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository", "web_research"], network: "declared",
      fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };
    const agent = new OpenCodeReadOnlyAgent(journal, capsule, { execute: vi.fn() }, models, security);
    const run = () => agent.run({ milestoneId: "milestone-attention", taskId: "research-task", repositoryPath: root, role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 10_000,
      signal: new AbortController().signal, admission: admission.admission });
    await expect(run()).resolves.toMatchObject({ outcome: "failed", cleanup: "completed" });
    expect(registry.inspect("milestone-attention")).toMatchObject({ lifecycle: "paused", capabilityBoundary: { phase: "pre_effect", reason: "network_destination_not_allowed" } });
    expect(journal.readStream("research-task").map((event) => event.type)).toEqual(["task.created", "task.capability_boundary_paused"]);
    expect(JSON.stringify(journal.readAll())).not.toContain("secret=hidden");
    await expect(run()).rejects.toThrow(/paused|retained durable worker/i);
    expect(executions).toBe(1);
    journal.close();
  });

  it("invalidates completion when retained source evidence is removed or substituted", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-research-replay-")));
    roots.push(root); mkdirSync(path.join(root, "src")); writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const journal = new SqliteEventJournal(":memory:");
    const fixture = readyWebMilestone(journal, root, "milestone-replay", "research-replay");
    const governed = new GovernedWebResearch(journal, { dispatch: async () => ({ status: 200, headers: { "content-type": "text/plain" },
      body: Buffer.from("retained fact"), compressedBytes: 13, decompressedBytes: 13, resolvedAddress: "93.184.216.34", tls: true, dispatched: true }) });
    const capsule: OpenCodeReadOnlyCapsule = { execute: vi.fn(async (request, _broker, signal, observe, research) => {
      const source = await research!.execute({ schemaVersion: 1, requestId: "source-1", taskId: request.taskId, workerId: request.capsuleId,
        role: "researcher", modelId: request.transportModelId, tool: "zentra_web_research", method: "GET", url: "https://docs.example.com/fact",
        envelopeDigest: request.webResearchEnvelopeDigest, policyDigest: request.webResearch!.digest,
        trace: request.trace }, request.webResearch, signal);
      observe?.({ type: "cleanup_observed", payload: { capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: null, imageName: request.resources.imageName, imageId: null,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false } });
      return { outcome: "completed" as const, openCode: { version: "1.18.3" as const, executableSha256: "a".repeat(64) },
        model: { id: request.transportModelId, provider: "fixture", name: "researcher" },
        evidence: [{ kind: "research" as const, summary: `Finding [source:${source.evidence!.evidenceId}]`, sourceEvidenceIds: [source.evidence!.evidenceId] }],
        cleanup: "completed" as const, brokerTransport: "completed" as const };
    }) };
    await new OpenCodeReadOnlyAgent(journal, capsule, { execute: vi.fn() }, fixture.models, fixture.security, governed).run({
      milestoneId: "milestone-replay", taskId: "research-replay", repositoryPath: root, role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 10_000,
      signal: new AbortController().signal, admission: fixture.admission,
    });
    expect(fixture.registry.inspect("milestone-replay")?.tasks["research-replay"]).toMatchObject({ status: "completed" });
    for (const mode of ["removed", "substituted", "trace_substituted", "correlation_substituted"] as const) {
      const hostile = new SqliteEventJournal(":memory:");
      const versions = new Map<string, number>();
      for (const event of journal.readAll()) {
        if (mode === "removed" && event.type === "web_research.observed") continue;
        let payload = mode === "substituted" && event.type === "web_research.observed"
          ? { ...(event.payload as any), evidence: { ...(event.payload as any).evidence, contentSha256: "b".repeat(64) } }
          : event.payload;
        if (mode === "trace_substituted" && event.type === "web_research.observed") {
          const { eventDigest: _digest, ...body } = payload as any;
          const forgedBody = { ...body, identity: { ...body.identity,
            trace: { traceId: "forged-trace", correlationId: "forged-trace" } } };
          payload = { ...forgedBody, eventDigest: digestCanonical(forgedBody) };
        }
        const version = versions.get(event.streamId) ?? 0;
        hostile.append(event.streamId, version, [{ streamId: event.streamId, type: event.type, payload,
          causationId: event.causationId,
          correlationId: mode === "correlation_substituted" && event.type === "web_research.observed" ? "forged-trace" : event.correlationId }]);
        versions.set(event.streamId, version + 1);
      }
      expect(() => new MilestoneRegistry(hostile).inspect("milestone-replay")).toThrow(/source|evidence|digest/i);
      hostile.close();
    }
    const partial = new SqliteEventJournal(":memory:");
    const partialVersions = new Map<string, number>();
    for (const event of journal.readAll()) {
      const payload = event.type === "milestone.task_completed" && typeof event.payload === "object" && event.payload !== null && (event.payload as any).harness === "opencode"
        ? { ...(event.payload as any), outcome: "failed", evidence: [] }
        : event.payload;
      const version = partialVersions.get(event.streamId) ?? 0;
      partial.append(event.streamId, version, [{ streamId: event.streamId, type: event.type, payload, causationId: event.causationId, correlationId: event.correlationId }]);
      partialVersions.set(event.streamId, version + 1);
    }
    expect(new MilestoneRegistry(partial).inspect("milestone-replay")?.tasks["research-replay"]).toMatchObject({ status: "completed", terminalOutcome: "failed" });
    partial.close();
    journal.close();
  });

  it.each([
    ["substituted model", "provider_model_mismatch", 3, 10_000_000, 1],
    ["cumulative cost overflow", "cost_budget_exceeded", 3, 2_000_000_000, 1],
    ["cumulative token overflow", "token_budget_exceeded", 101, 0, 1],
  ] as const)("settles %s before cleanup, terminal failure, replay, and blocked redispatch", async (
    _name,
    failureReason,
    inputTokens,
    costUsdNano,
    modelTurns,
  ) => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, `milestone-${failureReason}`);
    const execute = vi.fn(async (request, _broker, _signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
      observe?.({ type: "model_started", modelId: request.transportModelId });
      observe?.({ type: "model_completed", modelId: request.transportModelId, outcome: "failed", failureReason,
        usage: { seconds: 0, inputTokens, outputTokens: 0, costUsd: costUsdNano / 1_000_000_000,
          costUsdNano, toolCalls: 0, modelTurns } });
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: null,
        imageName: request.resources.imageName, imageId: null,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
      } });
      return {
        outcome: "failed", openCode: { version: "1.18.3", executableSha256: "a".repeat(64) },
        model: null, evidence: [], cleanup: "completed", brokerTransport: "completed",
        brokerFailureReason: failureReason,
        usage: { seconds: 0, inputTokens, outputTokens: 0, costUsd: costUsdNano / 1_000_000_000,
          costUsdNano, toolCalls: 0, modelTurns },
      };
    });
    const agent = new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, modelSheet("researcher"));
    const request = {
      milestoneId: `milestone-${failureReason}`, taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher" as const, rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal, admission,
    };
    await expect(agent.run(request)).resolves.toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: failureReason });
    const worker = Object.values(projectWorkerLifecycle(journal.readAll()).workers)[0]!;
    expect(worker).toMatchObject({ status: "terminal", terminalOutcome: "failed", cleanup: "completed",
      activeModelTurns: 0 });
    expect(journal.readAll().filter((event) => event.type === "worker.observed" &&
      (event.payload as any).observation?.kind === "model").map((event) => (event.payload as any).observation.phase))
      .toEqual(["started", "completed"]);
    expect(new MilestoneRegistry(journal).inspect(`milestone-${failureReason}`)?.tasks["task-1"])
      .toMatchObject({ status: "completed", terminalOutcome: "failed" });
    await expect(agent.run(request)).rejects.toThrow(/task must be ready|retained durable worker/i);
    expect(execute).toHaveBeenCalledTimes(1);
    journal.close();
  });

  it("fails a pre-effect model-turn denial without creating a model reservation or retry", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const admission = readyMilestone(journal, "milestone-model-turn-pre-effect");
    const execute = vi.fn(async (request, _broker, _signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: null,
        imageName: request.resources.imageName, imageId: null,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
      } });
      return { outcome: "failed", openCode: { version: "1.18.3", executableSha256: "a".repeat(64) },
        model: null, evidence: [], cleanup: "completed", brokerTransport: "completed",
        brokerFailureReason: "model_turn_budget_exceeded",
        usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUsdNano: 0,
          toolCalls: 0, modelTurns: 32 } };
    });
    const agent = new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, modelSheet("researcher"));
    const request = { milestoneId: "milestone-model-turn-pre-effect", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher" as const, rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 1_000,
      signal: new AbortController().signal, admission };
    await expect(agent.run(request)).resolves.toMatchObject({ outcome: "failed", cleanup: "completed",
      brokerFailureReason: "model_turn_budget_exceeded" });
    expect(journal.readAll().filter((event) => event.type === "worker.observed" &&
      (event.payload as any).observation?.kind === "model")).toEqual([]);
    const worker = Object.values(projectWorkerLifecycle(journal.readAll()).workers)[0]!;
    expect(worker).toMatchObject({ activeModelTurns: 0, cleanup: "completed", status: "terminal", terminalOutcome: "failed" });
    expect(new MilestoneRegistry(journal).inspect("milestone-model-turn-pre-effect")?.tasks["task-1"])
      .toMatchObject({ status: "completed", terminalOutcome: "failed" });
    await expect(agent.run(request)).rejects.toThrow(/task must be ready|retained durable worker/i);
    expect(execute).toHaveBeenCalledTimes(1);
    journal.close();
  });

  it("retries an identical model completion after append-then-throw without duplicating the durable observation", async () => {
    const sqlite = new SqliteEventJournal(":memory:");
    let completionAppendThrew = false;
    const journal: EventJournal = {
      append: (streamId, expectedVersion, events) => {
        const stored = sqlite.append(streamId, expectedVersion, events);
        if (!completionAppendThrew && events.some((event) => event.type === "worker.observed" &&
          typeof event.payload === "object" && event.payload !== null &&
          (event.payload as any).observation?.kind === "model" && (event.payload as any).observation?.phase === "completed")) {
          completionAppendThrew = true;
          throw new Error("simulated observer append acknowledgement loss");
        }
        return stored;
      },
      readStream: (streamId, afterVersion) => sqlite.readStream(streamId, afterVersion),
      readAll: (afterPosition) => sqlite.readAll(afterPosition),
    };
    const admission = readyMilestone(journal, "milestone-observer-retry");
    const execute = vi.fn(async (request, _broker, _signal, observe): Promise<OpenCodeReadOnlyCapsuleResult> => {
      observe?.({ type: "model_started", modelId: request.transportModelId });
      const completion = { type: "model_completed" as const, modelId: request.transportModelId,
        outcome: "failed" as const, failureReason: "provider_model_mismatch" as const,
        usage: { seconds: 0, inputTokens: 1, outputTokens: 1, costUsd: 0, costUsdNano: 0, toolCalls: 0, modelTurns: 1 } };
      try { observe?.(completion); } catch { observe?.(completion); }
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: null,
        imageName: request.resources.imageName, imageId: null,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
      } });
      return { outcome: "failed", openCode: { version: "1.18.3", executableSha256: "a".repeat(64) },
        model: null, evidence: [], cleanup: "completed", brokerTransport: "completed",
        brokerFailureReason: "provider_model_mismatch" };
    });
    const agent = new OpenCodeReadOnlyAgent(journal, { execute }, { execute: vi.fn() }, modelSheet("researcher"));
    const runRequest = { milestoneId: "milestone-observer-retry", taskId: "task-1", repositoryPath: process.cwd(),
      role: "researcher" as const, rolePrompt: "Research.",
      budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 1_000,
      signal: new AbortController().signal, admission };
    await expect(agent.run(runRequest)).resolves.toMatchObject({ outcome: "failed", cleanup: "completed" });
    const modelPhases = sqlite.readAll().filter((event) => event.type === "worker.observed" &&
      (event.payload as any).observation?.kind === "model").map((event) => (event.payload as any).observation.phase);
    expect(modelPhases).toEqual(["started", "completed"]);
    const worker = Object.values(projectWorkerLifecycle(sqlite.readAll()).workers)[0]!;
    expect(worker).toMatchObject({ activeModelTurns: 0, cleanup: "completed", status: "terminal", terminalOutcome: "failed" });
    expect(new MilestoneRegistry(sqlite).inspect("milestone-observer-retry")?.tasks["task-1"])
      .toMatchObject({ status: "completed", terminalOutcome: "failed" });
    await expect(agent.run(runRequest)).rejects.toThrow(/task must be ready|retained durable worker/i);
    expect(execute).toHaveBeenCalledTimes(1);
    sqlite.close();
  });
});

function readyWebMilestone(journal: SqliteEventJournal, root: string, milestoneId: string, taskId: string) {
  const registry = new MilestoneRegistry(journal);
  registry.register({ milestoneId, projectId: "zentra", title: "Research", correlationId: milestoneId,
    plan: { milestoneId, projectId: "zentra", goal: "Research", tasks: [{ taskId, title: "Research", description: "Research.", dependencies: [],
      ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Cited evidence."],
      roleAssignment: { role: "researcher", agentId: "opencode-researcher", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 10, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 } }] } });
  const security = { ...admissionSecurity(root, ["src/**"]), network: { default: "denied" as const, allowedDestinations: ["https://docs.example.com"] } };
  const context = { ...admissionContext(root, "opencode-researcher", "researcher", { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 10_000 }),
    toolPermissions: ["read_repository", "web_research"], network: "declared" as const };
  const admitted = registry.admitTask(milestoneId, taskId, security, context);
  if (admitted.status !== "admitted") throw new Error("expected web research admission");
  const models: ModelSheet = { models: [{ id: "opencode-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: ["research"],
    costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository", "web_research"], network: "declared", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };
  return { registry, security, models, admission: admitted.admission };
}

function readyMilestone(
  journal: EventJournal,
  milestoneId: string,
  roleOrRepository: "researcher" | "reviewer" | string = "researcher",
  timeoutMs = 1_000,
  scopes: readonly string[] = ["src/**"],
) {
  const role = roleOrRepository === "researcher" || roleOrRepository === "reviewer"
    ? roleOrRepository
    : "researcher";
  const repositoryPath = role === roleOrRepository ? process.cwd() : roleOrRepository;
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
  const result = new MilestoneRegistry(journal).admitTask(
    milestoneId,
    "task-1",
    admissionSecurity(repositoryPath, scopes),
    admissionContext(repositoryPath, role === "reviewer" ? "opencode-reviewer" : "opencode-researcher", role, {
      maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs,
    }),
  );
  if (result.status !== "admitted") throw new Error("expected test task admission");
  return result.admission;
}

function admissionSecurity(repositoryPath: string, scopes: readonly string[]): SecuritySheet {
  return {
    allowedRepositories: [realpathSync.native(repositoryPath)], allowedFileScopes: [...scopes], forbiddenPaths: [".env"],
    network: { default: "denied", allowedDestinations: [] }, secretHandling: ["Do not expose secrets."],
    approvalRequiredOperations: [], releaseBoundary: "local_preparation_only", stopAndAskConditions: [],
  };
}

function admissionContext(
  repositoryPath: string,
  actorId: string,
  role: "planner" | "researcher" | "reviewer",
  requestedBudget = { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 1_000 },
) {
  return {
    kind: "opencode" as const, repositoryPath, actorId, harness: "opencode" as const, role,
    capabilityId: actorId, transportModelId: "fixture/model", roles: [role],
    authority: role === "reviewer" ? "review" as const : "read_only" as const,
    contextTokens: 10_000,
    toolPermissions: role === "reviewer" ? ["read_repository", "review_diff"] : ["read_repository"],
    network: "denied" as const, requestedBudget,
  };
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
