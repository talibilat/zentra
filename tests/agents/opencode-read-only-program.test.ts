import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { OpenCodeReadOnlyProgram } from "../../src/agents/opencode-read-only-program.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { MultiAgentMilestoneCoordinator } from "../../src/orchestration/multi-agent-milestone.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import { buildRoleCapabilityBinding, RoleCapabilityEnvelopeService, roleToolPermissions } from "../../src/workers/role-capability-envelope.js";
import { WorkerLifecycleService, projectWorkerLifecycle } from "../../src/workers/worker-lifecycle.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";

const security: SecuritySheet = {
  allowedRepositories: ["/tmp/repository"],
  allowedFileScopes: ["src/**", "missing/**"],
  forbiddenPaths: [".env"],
  network: { default: "denied", allowedDestinations: [] },
  secretHandling: ["Do not inherit parent secrets."],
  approvalRequiredOperations: [],
  releaseBoundary: "local_preparation_only",
  stopAndAskConditions: ["missing_authority", "forbidden_file_scope", "undeclared_network", "release_boundary"],
};

describe("OpenCodeReadOnlyProgram", () => {
  it.each([
    ["claude_code", 1_000, "matching non-OpenCode harness"],
    ["opencode", 150, "insufficient context capacity"],
  ] as const)("durably pauses %s before every effect", async (harness, contextTokens, _case) => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-model-boundary-")));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const journal = new SqliteEventJournal(":memory:");
    new MilestoneRegistry(journal).register({
      milestoneId: "milestone-model-boundary", projectId: "zentra", title: "Model boundary", correlationId: "trace-model-boundary",
      plan: { milestoneId: "milestone-model-boundary", projectId: "zentra", goal: "Research", tasks: [{
        taskId: "task-model-boundary", title: "Research", description: "Research.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["No effect."],
        roleAssignment: { role: "researcher", agentId: "boundary-model", harness },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "boundary.jsonl"), "trace-model-boundary");
    const execute = vi.fn();
    const brokerExecute = vi.fn();
    const program = new OpenCodeReadOnlyProgram(
      journal,
      sink,
      { execute: brokerExecute },
      { models: [{ id: "boundary-model", harness, model: "fixture/model", roles: ["researcher"], specialties: [], costTier: "low", contextTokens, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] },
      { ...security, allowedRepositories: [root] },
      { execute },
    );

    const result = await program.run({
      milestoneId: "milestone-model-boundary", taskId: "task-model-boundary", repositoryPath: root,
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "paused",
      attention: { reason: "plan_not_ready", classification: "hard_stop" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(brokerExecute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-model-boundary").map((event) => event.type)).toEqual([
      "milestone.created", "milestone.plan_created",
    ]);
    sink.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("purely rejects a disallowed canonical repository before journal, capsule, or broker effects", async () => {
    const allowed = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-allowed-")));
    const requested = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-disallowed-")));
    mkdirSync(path.join(requested, "src"));
    writeFileSync(path.join(requested, "src/context.ts"), "context\n");
    const journal = new SqliteEventJournal(":memory:");
    new MilestoneRegistry(journal).register({
      milestoneId: "milestone-repository", projectId: "zentra", title: "Repository", correlationId: "trace-repository",
      plan: { milestoneId: "milestone-repository", projectId: "zentra", goal: "Research", tasks: [{
        taskId: "task-repository", title: "Research", description: "Research.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["No effect."],
        roleAssignment: { role: "researcher", agentId: "approved-researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const sink = AgentTailJsonlFileSink.open(requested, path.join(requested, "repository.jsonl"), "trace-repository");
    const execute = vi.fn();
    const brokerExecute = vi.fn();
    const program = new OpenCodeReadOnlyProgram(
      journal,
      sink,
      { execute: brokerExecute },
      { models: [{ id: "approved-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: [], costTier: "low", contextTokens: 1_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] },
      { ...security, allowedRepositories: [allowed] },
      { execute },
    );

    const result = await program.run({
      milestoneId: "milestone-repository", taskId: "task-repository", repositoryPath: requested,
      role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "paused", attention: { reason: "forbidden_file_scope" } });
    expect(execute).not.toHaveBeenCalled();
    expect(brokerExecute).not.toHaveBeenCalled();
    expect(journal.readStream("milestone-repository").map((event) => event.type)).toEqual([
      "milestone.created", "milestone.plan_created",
    ]);
    sink.close();
    journal.close();
    rmSync(allowed, { recursive: true, force: true });
    rmSync(requested, { recursive: true, force: true });
  });

  it.each([[false, "emitted"], [true, "failed"]] as const)(
    "purely rejects before every agent effect when the trace sink is closed=%s",
    async (sinkClosed, traceOutcome) => {
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-boundary-")));
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src/context.ts"), "context\n");
      const journal = new SqliteEventJournal(":memory:");
      new MilestoneRegistry(journal).register({
        milestoneId: "milestone-boundary", projectId: "zentra", title: "Boundary", correlationId: "trace-boundary",
        plan: { milestoneId: "milestone-boundary", projectId: "zentra", goal: "Stop", tasks: [{
          taskId: "task-boundary", title: "Stop", description: "Stop.", dependencies: [], ownedPaths: ["secrets/token.txt"], forbiddenPaths: [".env"], acceptanceCriteria: ["No effect."],
          roleAssignment: { role: "researcher", agentId: "approved-researcher", harness: "opencode" },
          risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
          budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
        }] },
      });
      journal.append("milestone-boundary", 2, [{
        streamId: "milestone-boundary", type: "milestone.task_ready",
        payload: { taskId: "task-boundary", admissionDigest: "a".repeat(64) },
        causationId: null, correlationId: "trace-boundary",
      }]);
      const sink = AgentTailJsonlFileSink.open(root, path.join(root, "boundary.jsonl"), "trace-boundary");
      if (sinkClosed) sink.close();
      const execute = vi.fn();
      const brokerExecute = vi.fn();
      const boundarySecurity: SecuritySheet = { ...security, allowedRepositories: [root], forbiddenPaths: [".env", "secrets/**"] };
      const program = new OpenCodeReadOnlyProgram(
        journal,
        sink,
        { execute: brokerExecute },
        { models: [{ id: "approved-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: [], costTier: "low", contextTokens: 1_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] },
        boundarySecurity,
        { execute },
      );

      const result = await program.run({
        milestoneId: "milestone-boundary", taskId: "task-boundary", repositoryPath: root,
        role: "researcher", rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
        timeoutMs: 1_000, signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        status: "paused", operationOutcome: "paused", trace: { outcome: traceOutcome },
        attention: { reason: "forbidden_file_scope", classification: "hard_stop" },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(brokerExecute).not.toHaveBeenCalled();
      expect(journal.readStream("milestone-boundary").map((event) => event.type)).toEqual([
        "milestone.created", "milestone.plan_created", "milestone.task_ready",
      ]);
      if (!sinkClosed) {
        sink.close();
        const retained = (await import("node:fs")).readFileSync(
          path.join(root, "boundary.jsonl"),
          "utf8",
        ).trim().split("\n");
        expect(retained).toHaveLength(3);
      }
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  );

  it.each([
    [false, "emitted", "completed"],
    [true, "failed", "failed"],
  ] as const)("durably records required Agent Tail status when sinkClosed=%s", async (sinkClosed, trace, operationOutcome) => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-program-")));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const databasePath = path.join(root, "program.sqlite");
    const journal = new SqliteEventJournal(databasePath);
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-program", projectId: "zentra", title: "Program", correlationId: "trace-program",
      plan: { milestoneId: "milestone-program", projectId: "zentra", goal: "Plan", tasks: [{
        taskId: "task-program", title: "Plan", description: "Plan.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence."],
        roleAssignment: { role: "planner", agentId: "approved-planner", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"), "trace-program");
    if (sinkClosed) sink.close();
    const capsule: OpenCodeReadOnlyCapsule = { execute: async (request, broker, signal, observe) => {
      observe?.({ type: "resources_prepared", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: "b".repeat(64),
        imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
      } });
      const receipt = await broker.execute({
        modelId: request.transportModelId, prompt: request.rolePrompt,
        maxInputTokens: request.budget.maxInputTokens, maxOutputTokens: request.budget.maxOutputTokens,
        maxCostUsd: request.budget.maxCostUsd,
      }, signal);
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: "b".repeat(64),
        imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "completed", containerAbsent: true, imageAbsent: true, repositoryViewAbsent: false,
      } });
      return {
        outcome: "completed", cleanup: "completed", brokerTransport: "completed",
        openCode: { version: "1.18.3", executableSha256: "a".repeat(64) },
        model: receipt.model,
        evidence: [{ kind: "plan", summary: "Plan evidence." }],
      };
    } };
    const broker = { execute: async (request: { modelId: string }) => {
      expect(request.modelId).toBe("fixture/transport-model");
      return {
        outcome: "completed" as const,
        response: { type: "text" as const, text: "Plan evidence." },
        model: { id: request.modelId, provider: "fixture", name: "transport-model" },
        usage: { inputTokens: 10, outputTokens: 3, costUsd: 0 },
      };
    } };
    const program = new OpenCodeReadOnlyProgram(journal, sink, broker, {
      models: [{ id: "approved-planner", harness: "opencode", model: "fixture/transport-model", roles: ["planner"], specialties: [], costTier: "low", contextTokens: 1_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }],
    }, { ...security, allowedRepositories: [root] }, capsule);

    const runRequest = {
      milestoneId: "milestone-program", taskId: "task-program", repositoryPath: root,
      role: "planner" as const, rolePrompt: "Plan.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    };
    const result = await program.run(runRequest);

    expect(result).toMatchObject({ outcome: "completed", trace: { outcome: trace }, operationOutcome });
    expect(journal.readStream("milestone-program").at(-1)).toMatchObject({
      type: "milestone.agent_trace_observed", payload: { taskId: "task-program", outcome: trace },
    });
    expect(journal.readStream("milestone-program").find((event) => event.type === "milestone.task_running")?.payload).toMatchObject({
      requestedModel: { capabilityId: "approved-planner", transportModelId: "fixture/transport-model" },
    });
    expect(journal.readStream("milestone-program").find((event) => event.type === "milestone.task_completed")?.payload).toMatchObject({
      capabilityId: "approved-planner", transportModelId: "fixture/transport-model",
      model: { id: "fixture/transport-model" },
    });
    if (sinkClosed) {
      expect(() => registry.completeFromEvidence("milestone-program")).toThrow("trace projection failed");
      let redispatches = 0;
      const coordinator = new MultiAgentMilestoneCoordinator(
        registry,
        { run: async () => { redispatches += 1; throw new Error("must not redispatch"); } } as never,
        { run: async () => { throw new Error("writers must remain blocked"); } } as never,
      );
      const request = {
        milestoneId: "milestone-program",
        readOnlyTasks: [{ taskId: "task-program", request: runRequest }],
        writerSchedule: {} as never,
      };
      const terminal = await coordinator.run(request);
      expect(terminal).toMatchObject({
        lifecycle: "terminal", terminalOutcome: "failed",
        result: { trace: { outcome: "failed" } },
      });
      expect(terminal.result?.decisions.map((decision) => decision.kind)).toContain("milestone.agent_trace_failed");
      expect(await coordinator.run(request)).toEqual(terminal);
      expect(redispatches).toBe(0);
      const reopened = SqliteEventJournal.openReadOnly(databasePath);
      const restarted = new MultiAgentMilestoneCoordinator(
        new MilestoneRegistry(reopened),
        { run: async () => { redispatches += 1; throw new Error("must not redispatch after reopen"); } } as never,
        { run: async () => { throw new Error("writers must remain blocked after reopen"); } } as never,
      );
      expect(await restarted.run(request)).toEqual(terminal);
      expect(redispatches).toBe(0);
      reopened.close();
    }
    if (!sinkClosed) sink.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reconciles deterministic intent after a crash before resources were prepared", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-prepared-crash-")));
    const journal = new SqliteEventJournal(":memory:");
    const registry = new MilestoneRegistry(journal);
    registry.register({
      milestoneId: "milestone-reconcile", projectId: "zentra", title: "Reconcile", correlationId: "trace-reconcile",
      plan: { milestoneId: "milestone-reconcile", projectId: "zentra", goal: "Plan", tasks: [{
        taskId: "task-reconcile", title: "Plan", description: "Plan.", dependencies: [], ownedPaths: ["missing/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence."],
        roleAssignment: { role: "planner", agentId: "approved-planner", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"), "trace-reconcile");
    let reconciliations = 0;
    const capsule = {
      execute: async () => { throw new Error("must not execute"); },
      reconcile: async (prepared: { containerId: string | null; imageId: string | null; repositoryViewPath: string }) => {
        reconciliations += 1;
        expect(prepared.containerId).toBeNull();
        expect(prepared.imageId).toBeNull();
        expect(prepared.repositoryViewPath).toMatch(/zentra-read-only-views\/[a-f0-9]{64}$/);
        return reconciliations === 1
          ? { outcome: "uncertain" as const, containerId: null, imageId: null, containerAbsent: false, imageAbsent: false, repositoryViewAbsent: true }
          : { outcome: "completed" as const, containerId: null, imageId: null, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true };
      },
    };
    const program = new OpenCodeReadOnlyProgram(journal, sink, { execute: async () => { throw new Error("unused"); } }, {
      models: [{ id: "approved-planner", harness: "opencode", model: "fixture/transport", roles: ["planner"], specialties: [], costTier: "low", contextTokens: 1_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }],
    }, { ...security, allowedRepositories: [root] }, capsule);
    const runRequest = {
      milestoneId: "milestone-reconcile", taskId: "task-reconcile", repositoryPath: root,
      role: "planner" as const, rolePrompt: "Plan.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      timeoutMs: 1_000, signal: new AbortController().signal,
    };

    await expect(program.run(runRequest)).rejects.toThrow("does not exist");
    const firstIntent = journal.readStream("milestone-reconcile").at(-1)!;
    expect(firstIntent.type).toBe("milestone.agent_resource_intent");
    expect(await program.reconcile({ milestoneId: "milestone-reconcile", taskId: "task-reconcile" })).toEqual({ outcome: "uncertain", trace: "emitted" });
    await expect(program.run(runRequest)).rejects.toThrow("retained durable worker state");
    expect(await program.reconcile({ milestoneId: "milestone-reconcile", taskId: "task-reconcile" })).toEqual({ outcome: "completed", trace: "emitted" });
    expect(journal.readStream("milestone-reconcile").at(-1)?.type).toBe("milestone.agent_cleanup_observed");
    await expect(program.run(runRequest)).rejects.toThrow("retained durable worker state");
    expect(journal.readStream("milestone-reconcile").at(-1)?.type).toBe("milestone.agent_cleanup_observed");
    expect(reconciliations).toBe(2);

    sink.close();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("never redispatches an uncertain worker after cleanup reconciliation, including after restart", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-uncertain-restart-")));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const database = path.join(root, "events.sqlite");
    const journal = new SqliteEventJournal(database);
    new MilestoneRegistry(journal).register({
      milestoneId: "milestone-uncertain", projectId: "zentra", title: "Uncertain", correlationId: "trace-uncertain",
      plan: { milestoneId: "milestone-uncertain", projectId: "zentra", goal: "Research", tasks: [{
        taskId: "task-uncertain", title: "Research", description: "Research.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence."],
        roleAssignment: { role: "researcher", agentId: "approved-researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
      }] },
    });
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"), "trace-uncertain");
    const execute = vi.fn(async (request, _broker, _signal, observe) => {
      observe?.({ type: "resources_prepared", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: "b".repeat(64),
        imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
      } });
      observe?.({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId, resourceLabel: request.resources.resourceLabel,
        containerName: request.resources.containerName, containerId: "b".repeat(64),
        imageName: request.resources.imageName, imageId: `sha256:${"c".repeat(64)}`,
        repositoryViewPath: request.repositoryPath, repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: "uncertain", containerAbsent: false, imageAbsent: false, repositoryViewAbsent: false,
      } });
      return { outcome: "failed" as const, openCode: null, model: null, evidence: [], cleanup: "uncertain" as const, brokerTransport: "uncertain" as const };
    });
    const capsule = {
      execute,
      reconcile: async () => ({ outcome: "completed" as const, containerId: "b".repeat(64), imageId: `sha256:${"c".repeat(64)}`, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true }),
    };
    const models = { models: [{ id: "approved-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: [], costTier: "low", contextTokens: 1_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };
    const request = { milestoneId: "milestone-uncertain", taskId: "task-uncertain", repositoryPath: root, role: "researcher" as const, rolePrompt: "Research.", budget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 1_000, signal: new AbortController().signal };
    const first = new OpenCodeReadOnlyProgram(journal, sink, { execute: vi.fn() }, models, { ...security, allowedRepositories: [root] }, capsule);
    await expect(first.run(request)).resolves.toMatchObject({ status: "executed", outcome: "failed" });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(first.reconcile({ milestoneId: "milestone-uncertain", taskId: "task-uncertain" })).resolves.toMatchObject({ outcome: "completed" });
    await expect(first.run(request)).rejects.toThrow("retained durable worker state");
    journal.close();

    const restartedJournal = new SqliteEventJournal(database);
    const restarted = new OpenCodeReadOnlyProgram(restartedJournal, sink, { execute: vi.fn() }, models, { ...security, allowedRepositories: [root] }, capsule);
    await expect(restarted.run(request)).rejects.toThrow("retained durable worker state");
    expect(execute).toHaveBeenCalledTimes(1);
    sink.close();
    restartedJournal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reopens after evaluation-before-pause and converges without redispatch", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-research-attention-restart-")));
    mkdirSync(path.join(root, "src")); writeFileSync(path.join(root, "src/context.ts"), "context\n");
    const database = path.join(root, "events.sqlite");
    const first = new SqliteEventJournal(database);
    const registry = new MilestoneRegistry(first);
    registry.register({ milestoneId: "milestone-attention-restart", projectId: "zentra", title: "Research", correlationId: "trace-attention-restart",
      plan: { milestoneId: "milestone-attention-restart", projectId: "zentra", goal: "Research", tasks: [{ taskId: "task-attention-restart", title: "Research", description: "Research.", dependencies: [],
        ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Evidence."], roleAssignment: { role: "researcher", agentId: "approved-researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 10, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 } }] } });
    const webSecurity: SecuritySheet = { ...security, allowedRepositories: [root], network: { default: "denied", allowedDestinations: ["https://docs.example.com"] } };
    const models = { models: [{ id: "approved-researcher", harness: "opencode", model: "fixture/model", roles: ["researcher"], specialties: [], costTier: "low", contextTokens: 1_000,
      maxConcurrency: 1, toolPermissions: ["read_repository", "web_research"], network: "declared", fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };
    const admitted = registry.admitTask("milestone-attention-restart", "task-attention-restart", webSecurity, {
      kind: "opencode", repositoryPath: root, actorId: "approved-researcher", harness: "opencode", role: "researcher", capabilityId: "approved-researcher", transportModelId: "fixture/model",
      authority: "read_only", roles: ["researcher"], toolPermissions: ["read_repository", "web_research"], network: "declared", contextTokens: 1_000,
      requestedBudget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 10_000 },
    }, models);
    if (admitted.status !== "admitted") throw new Error("expected admitted research task");
    const model = models.models[0]!;
    const binding = buildRoleCapabilityBinding({ milestoneId: "milestone-attention-restart", taskId: "task-attention-restart", projectId: "zentra", correlationId: "trace-attention-restart",
      role: "researcher", actorId: "approved-researcher", repository: root, planDigest: admitted.admission.packet.planDigest, securityDigest: digestCanonical(webSecurity),
      model: { capabilityId: model.id, transportModelId: model.model, digest: digestCanonical(model), harness: model.harness, roles: model.roles,
        toolPermissions: roleToolPermissions("researcher", true), network: model.network },
      budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100, timeoutMs: 10_000 }, admissionDigest: admitted.admission.digest,
      configuredReadPaths: ["src/**"], ownedPaths: ["src/**"], forbiddenPaths: [".env"],
      webResearch: { allowedDestinations: ["https://docs.example.com"], timeoutMs: 10_000 } });
    const policy = new RoleCapabilityEnvelopeService(first); policy.accept(binding);
    const decision = policy.evaluate(binding, { kind: "network", destination: "https://outside.example/path", method: "GET", capability: "web_research" });
    expect(decision.status).toBe("attention");
    const identity = openCodeResourceIdentity("milestone-attention-restart", "task-attention-restart", 1);
    first.append("milestone-attention-restart", first.readStream("milestone-attention-restart").length, [{ streamId: "milestone-attention-restart", type: "milestone.agent_resource_intent",
      payload: { taskId: "task-attention-restart", ...identity }, causationId: null, correlationId: "trace-attention-restart" }]);
    const workers = new WorkerLifecycleService(first);
    workers.bind({ schemaVersion: 1, workerId: identity.capsuleId, taskId: "task-attention-restart", rootTaskId: "task-attention-restart", parentWorkerId: null, harness: "opencode", role: "researcher",
      model: { capabilityId: model.id, modelId: model.model }, envelope: binding.envelope,
      budget: { budgetId: "milestone-attention-restart/task-attention-restart", maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100,
        maxToolCalls: 10, maxModelTurns: 10, maxActiveWorkers: 1, maxConcurrentTools: 1, maxConcurrentModelTurns: 1 },
      taskContext: { kind: "milestone", milestoneId: "milestone-attention-restart" }, trace: { traceId: "trace-attention-restart", correlationId: "trace-attention-restart" } });
    workers.start("task-attention-restart", identity.capsuleId);
    workers.observe("task-attention-restart", identity.capsuleId, { kind: "tool", name: "zentra_web_research", phase: "started", outcome: null,
      usage: { seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelTurns: 0 } });
    first.close();

    const reopened = new SqliteEventJournal(database);
    const sink = AgentTailJsonlFileSink.open(root, path.join(root, "trace.jsonl"), "trace-attention-restart");
    const execute = vi.fn(); const reconcile = vi.fn(async () => ({ outcome: "completed" as const, containerId: null, imageId: null, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true }));
    const program = new OpenCodeReadOnlyProgram(reopened, sink, { execute: vi.fn() }, models, webSecurity, { execute, reconcile } as never);
    await expect(program.reconcile({ milestoneId: "milestone-attention-restart", taskId: "task-attention-restart" })).resolves.toEqual({ outcome: "completed", trace: "emitted" });
    expect(new MilestoneRegistry(reopened).inspect("milestone-attention-restart")).toMatchObject({ lifecycle: "paused", capabilityBoundary: { decisionId: decision.decisionId } });
    expect(projectWorkerLifecycle(reopened.readStream("worker-task:task-attention-restart")).workers[identity.capsuleId]).toMatchObject({ status: "terminal", terminalOutcome: "denied", activeTools: 0, cleanup: "completed" });
    const milestonePause = reopened.readAll().find((event) => event.type === "milestone.capability_boundary_paused")!;
    const taskPause = reopened.readAll().find((event) => event.type === "task.capability_boundary_paused")!;
    expect(milestonePause.globalPosition).toBeLessThan(taskPause.globalPosition);
    expect(reconcile).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    await expect(program.run({ milestoneId: "milestone-attention-restart", taskId: "task-attention-restart", repositoryPath: root, role: "researcher", rolePrompt: "Research.",
      budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 }, timeoutMs: 10_000, signal: new AbortController().signal })).rejects.toThrow(/retained durable worker|paused/i);
    expect(execute).not.toHaveBeenCalled();
    sink.close(); reopened.close(); rmSync(root, { recursive: true, force: true });
  });
});
