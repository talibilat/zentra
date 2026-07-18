import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
import { OpenCodeMilestoneRunningPayloadSchema } from "../../src/agents/opencode-agent-events.js";
import { uncertainEffectPayload } from "../../src/contracts/uncertain-effect.js";
import { createAuthorityAttention, createOpenCodeAdmissionPacket, digestCanonical } from "../../src/contracts/authority-attention.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import { capabilityEnvelope } from "../../src/workers/worker-lifecycle.js";
import {
  agentTailEventToJsonLine,
  storedEventToAgentTailEvent,
  storedEventsToAgentTailEvents,
} from "../../src/observability/agent-tail.js";

function storedEvent(input: Partial<StoredEvent> & Pick<StoredEvent, "type">): StoredEvent {
  return {
    eventId: input.eventId ?? `event-${input.globalPosition ?? 1}`,
    streamId: input.streamId ?? "task-1",
    streamVersion: input.streamVersion ?? 1,
    globalPosition: input.globalPosition ?? 1,
    recordedAt: input.recordedAt ?? "2026-07-14T12:00:00.000Z",
    type: input.type,
    payload: input.payload ?? {},
    causationId: input.causationId ?? null,
    correlationId: input.correlationId ?? "milestone-1",
  };
}

describe("Agent Tail event envelope export", () => {
  it("strictly parses and redacts local release command output", () => {
    const mapped = storedEventToAgentTailEvent(storedEvent({
      type: "release.step_observed",
      payload: {
        schemaVersion: 1, name: "build", argvSha256: "a".repeat(64), outcome: "failed",
        exitCode: 1, stdout: "private output", stderr: "secret detail", outputSha256: "b".repeat(64),
      },
    }));

    expect(mapped.operation).toEqual({ name: "release_preparation", status: "failed" });
    expect(JSON.stringify(mapped.payload)).not.toContain("private output");
    expect(JSON.stringify(mapped.payload)).not.toContain("secret detail");
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "release.step_observed", payload: { name: "build", stdout: "untyped" },
    }))).toThrow();
  });
  it("redacts release packet argv and filesystem paths while retaining binding digests", () => {
    const packet = {
      schemaVersion: 1, releaseId: "release-1", milestoneId: "milestone-1", taskId: "verifier", projectId: "project-1",
      repositoryPath: "/private/repository", worktreeRoot: "/private/worktrees", worktreePath: "/private/worktrees/release-1",
      resultCommit: "a".repeat(40), integrationRef: "refs/heads/zentra/integration",
      securityDigest: "b".repeat(64), authorityDigest: "c".repeat(64), verifierAdmissionDigest: "d".repeat(64),
      commands: {
        build: { argv: [process.execPath, "private-build-argument"], timeoutMs: 1_000 },
        package: { argv: [process.execPath, "package.mjs"], timeoutMs: 1_000 },
        verify: { argv: [process.execPath, "verify.mjs"], timeoutMs: 1_000 },
      },
      artifacts: ["private/artifact.tgz"],
    };
    const packetDigest = digestCanonical(packet);

    const mapped = storedEventToAgentTailEvent(storedEvent({
      type: "release.created", payload: { schemaVersion: 1, packet, packetDigest },
    }));
    const serialized = JSON.stringify(mapped.payload);

    expect(serialized).toContain(packetDigest);
    expect(serialized).not.toContain("private-build-argument");
    expect(serialized).not.toContain("/private/repository");
    expect(serialized).not.toContain("private/artifact.tgz");
  });
  it("removes a nested artifact path canary from the complete release JSONL trace", () => {
    const canary = "private/nested/CANARY-release-artifact.tgz";
    const packet = {
      schemaVersion: 1, releaseId: "release-1", milestoneId: "milestone-1", taskId: "verifier", projectId: "project-1",
      repositoryPath: `/repository/${canary}`, worktreeRoot: `/worktrees/${canary}`, worktreePath: `/worktrees/${canary}/release-1`,
      resultCommit: "a".repeat(40), integrationRef: "refs/heads/zentra/integration",
      securityDigest: "b".repeat(64), authorityDigest: "c".repeat(64), verifierAdmissionDigest: "d".repeat(64),
      commands: {
        build: { argv: [process.execPath, canary], timeoutMs: 1_000 },
        package: { argv: [process.execPath, "package.mjs"], timeoutMs: 1_000 },
        verify: { argv: [process.execPath, "verify.mjs"], timeoutMs: 1_000 },
      }, artifacts: [canary],
    };
    const packetDigest = digestCanonical(packet);
    const releaseReference = {
      streamId: "release:release-1", eventId: "release-created", eventType: "release.created",
      streamVersion: 1, payloadDigest: "e".repeat(64),
    };
    const events = [
      storedEvent({ eventId: "release-created", streamId: "release:release-1", type: "release.created", payload: { schemaVersion: 1, packet, packetDigest } }),
      storedEvent({ eventId: "worktree", streamId: "release:release-1", streamVersion: 2, globalPosition: 2, type: "release.worktree_intent", payload: { schemaVersion: 1, path: `/worktrees/${canary}`, resultCommit: "a".repeat(40) } }),
      storedEvent({ eventId: "environment", streamId: "release:release-1", streamVersion: 3, globalPosition: 3, type: "release.environment_intent", payload: { schemaVersion: 1, home: `/home/${canary}`, temporary: `/tmp/${canary}` } }),
      storedEvent({ eventId: "artifact", streamId: "release:release-1", streamVersion: 4, globalPosition: 4, type: "release.artifact_hashed", payload: { schemaVersion: 1, path: canary, size: 42, sha256: "f".repeat(64) } }),
      storedEvent({ eventId: "task-complete", streamId: "milestone-1", streamVersion: 5, globalPosition: 5, type: "milestone.task_completed", payload: {
        taskId: "verifier", actorId: "local-verifier", role: "verifier", outcome: "completed",
        evidence: {
          schemaVersion: 1, releaseStreamId: "release:release-1", packetDigest, resultCommit: "a".repeat(40), status: "prepared_local_only",
          releaseEvents: [releaseReference, { ...releaseReference, eventId: "artifact", eventType: "release.artifact_hashed", streamVersion: 4 }],
          artifacts: [{ pathDigest: digestCanonical(canary), size: 42, sha256: "f".repeat(64) }],
        },
      } }),
    ];

    const jsonl = storedEventsToAgentTailEvents(events).map(agentTailEventToJsonLine).join("");
    expect(jsonl).not.toContain(canary);
    expect(jsonl).not.toContain("/worktrees/");
    expect(jsonl).not.toContain(process.execPath);
  });
  it("fails closed instead of tracing malformed release completion evidence containing a path", () => {
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "milestone.task_completed", payload: {
        taskId: "verifier", actorId: "local-verifier", role: "verifier", outcome: "failed",
        evidence: { releaseStreamId: "release:release-1", artifactPath: "private/CANARY.tgz" },
      },
    }))).toThrow();
  });
  it("maps a stored event to the Agent Tail v1 envelope", () => {
    const event = storedEvent({
      eventId: "event-created",
      type: "task.created",
      payload: { projectId: "zentra", title: "Create trace" },
      globalPosition: 41,
      streamVersion: 1,
    });

    const exported = storedEventToAgentTailEvent(event);

    expectValidAgentTailEnvelope(exported);
    expect(exported).toMatchObject({
      schema_version: "1.0",
      event_id: "event-created",
      trace_id: "milestone-1",
      span_id: "task:task-1",
      parent_span_id: null,
      emitter_id: "zentra:event-journal",
      sequence: 41,
      timestamp: "2026-07-14T12:00:00.000Z",
      kind: "task.created",
      actor: { id: "zentra-orchestrator", role: "orchestrator" },
      operation: { name: "task", status: "completed" },
      attributes: {
        zentra: {
          event_id: "event-created",
          stream_id: "task-1",
          stream_version: 1,
          global_position: 41,
          causation_id: null,
          correlation_id: "milestone-1",
          native_type: "task.created",
        },
      },
      payload: { projectId: "zentra", title: "Create trace" },
    });
  });

  it("uses journal globalPosition as sequence rather than streamVersion", () => {
    const exported = storedEventsToAgentTailEvents([
      storedEvent({ type: "task.created", streamVersion: 1, globalPosition: 100 }),
      storedEvent({ type: "task.started", streamVersion: 2, globalPosition: 250 }),
    ]);

    expect(exported.map((event) => event.sequence)).toEqual([100, 250]);
  });

  it("maps worker, validator, reviewer, integration, recovery, and terminal display actors", () => {
    const exported = storedEventsToAgentTailEvents([
      storedEvent({ type: "task.started", payload: { workerId: "opencode-worker-1" } }),
      storedEvent({ type: "task.validation_started" }),
      storedEvent({ type: "task.review_requested", payload: { reviewerId: "opencode-reviewer-1" } }),
      storedEvent({ type: "task.integration_started" }),
      storedEvent({ type: "task.cleanup_reconciled" }),
      storedEvent({ type: "task.failed", payload: { reason: "validation failed" } }),
    ]);

    expect(exported.map((event) => event.actor)).toEqual([
      { id: "opencode-worker-1", role: "worker" },
      { id: "zentra-validator", role: "validator" },
      { id: "opencode-reviewer-1", role: "reviewer" },
      { id: "zentra-integration-controller", role: "integrator" },
      { id: "zentra-recovery-controller", role: "recovery" },
      { id: "zentra-orchestrator", role: "orchestrator" },
    ]);
    expect(exported.map((event) => event.operation.status)).toEqual([
      "running",
      "running",
      "waiting",
      "running",
      "completed",
      "failed",
    ]);
  });

  it("maps nested review evidence to the reviewer actor", () => {
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "task.review_approved",
      payload: { review: { reviewerId: "opencode-reviewer-2" } },
    }));

    expect(exported.actor).toEqual({ id: "opencode-reviewer-2", role: "reviewer" });
    expect(exported.operation).toEqual({ name: "review", status: "completed" });
  });

  it("maps OpenCode writer and validation completion outcomes", () => {
    const exported = storedEventsToAgentTailEvents([
      storedEvent({
        type: "task.started",
        payload: { workerId: "opencode-writer", harness: "opencode" },
      }),
      storedEvent({
        type: "task.writer_completed",
        payload: { workerId: "opencode-writer", outcome: "failed" },
      }),
      storedEvent({
        type: "task.validation_completed",
        payload: { outcome: "timed_out" },
      }),
    ]);

    expect(exported.map((event) => event.actor)).toEqual([
      { id: "opencode-writer", role: "worker" },
      { id: "opencode-writer", role: "worker" },
      { id: "zentra-validator", role: "validator" },
    ]);
    expect(exported.map((event) => event.operation)).toEqual([
      { name: "writer", status: "running" },
      { name: "writer", status: "failed" },
      { name: "validation", status: "timed_out" },
    ]);
  });

  it("maps review denial terminal events to the reviewer actor", () => {
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "task.denied",
      payload: { review: { reviewerId: "opencode-reviewer-3" } },
    }));

    expect(exported.actor).toEqual({ id: "opencode-reviewer-3", role: "reviewer" });
    expect(exported.operation).toEqual({ name: "review", status: "denied" });
  });

  it("maps ownership denial to the ownership operation", () => {
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "task.denied",
      payload: { stage: "ownership" },
    }));

    expect(exported.operation).toEqual({ name: "ownership", status: "denied" });
  });

  it("renders uncertain effects and legacy observations as waiting diagnostics", () => {
    const uncertain = uncertainEffectPayload({
      boundary: "integration",
      operation: "integration CAS",
      reason: "integration ref is unreadable",
      requestedBy: "zentra-integration-controller",
      workspace: { path: "/work/task-1", branch: "ticket/task-1" },
    });
    const exported = storedEventsToAgentTailEvents([
      storedEvent({ type: "task.effect_uncertain", payload: uncertain }),
      storedEvent({ type: "task.commit_observed" }),
      storedEvent({ type: "task.integration_observed", payload: { reason: "CAS unreadable" } }),
      storedEvent({ type: "task.cleanup_observed", payload: { uncertain: true } }),
      storedEvent({ type: "task.cleanup_observed", payload: { uncertain: false } }),
      storedEvent({
        type: "task.integration_observed",
        payload: { verification: "verified" },
      }),
    ]);

    expect(exported.map((event) => event.operation.status)).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "failed",
      "completed",
    ]);
    expect(exported[0]).toMatchObject({
      actor: { id: "zentra-recovery-controller", role: "recovery" },
      operation: { name: "integration", status: "waiting" },
    });
  });

  it("strictly maps authority pauses to waiting without exposing policy prose", () => {
    const plan = {
      milestoneId: "milestone-1", projectId: "zentra", goal: "Stop safely.", tasks: [{
        taskId: "task-1", title: "Stop", description: "Stop.", dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".env"], acceptanceCriteria: ["Stopped."],
        roleAssignment: { role: "researcher", agentId: "researcher", harness: "opencode" },
        risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
        budget: { maxSeconds: 5, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 10, maxOutputTokens: 10 },
      }],
    } as const;
    const security: SecuritySheet = {
      allowedRepositories: ["/tmp/repository"], allowedFileScopes: ["src/**"], forbiddenPaths: [".env"],
      network: { default: "denied", allowedDestinations: [] }, secretHandling: ["ATTACKER_CANARY"],
      approvalRequiredOperations: [], releaseBoundary: "local_preparation_only", stopAndAskConditions: ["missing_authority"],
    };
    const packet = createOpenCodeAdmissionPacket({
      plan: plan as never, milestoneId: "milestone-1", taskId: "task-1", security, canonicalRepository: "/tmp/repository",
      actorId: "researcher", harness: "opencode", role: "researcher", capabilityId: "researcher", transportModelId: "fixture/model",
      authority: "read_only", roles: ["researcher"], toolPermissions: ["read_repository"], network: "denied", contextTokens: 1_000,
      requestedBudget: { maxSeconds: 5, maxCostUsd: 1, maxInputTokens: 10, maxOutputTokens: 10, timeoutMs: 5_000 },
    });
    const attention = createAuthorityAttention({
      packet,
      reason: "missing_authority",
      classification: "exact_approval_required",
      configuredStopCondition: true,
    });

    const exported = storedEventToAgentTailEvent(storedEvent({
      streamId: "milestone-1", type: "milestone.paused", payload: { attention },
    }));

    expect(exported).toMatchObject({
      kind: "milestone.paused",
      actor: { id: "zentra-authority-gate", role: "authority_gate" },
      operation: { name: "authority_boundary", status: "waiting" },
      payload: { attention: { attentionId: attention.attentionId, reason: "missing_authority" } },
    });
    expect(JSON.stringify(exported)).not.toContain("ATTACKER_CANARY");
    expect(() => storedEventToAgentTailEvent(storedEvent({
      streamId: "milestone-1", type: "milestone.paused", payload: { attention: { ...attention, unexpected: true } },
    }))).toThrow();
  });

  it("maps capsule proxy, worker, cleanup, and terminal events without changing v1", () => {
    const exported = storedEventsToAgentTailEvents([
      storedEvent({ type: "capsule.proxy_interaction_observed", payload: { scheme: "https", method: "GET", host: "example.com", allowed: true, reason: "configured_read" } }),
      storedEvent({ type: "capsule.worker_attested", payload: { readOnlyRoot: true, user: "10001:10001", projectMount: "read_only", scratchBytes: 1, capabilities: "dropped", noNewPrivileges: true, directEgress: "internal_network_only", inheritedSecrets: false, dockerSocket: false } }),
      storedEvent({ type: "capsule.cleanup_observed", payload: { outcome: "completed", containersAbsent: true, networksAbsent: true, imagesAbsent: true, observationsCollected: true } }),
      storedEvent({ type: "capsule.failed", payload: { outcome: "failed", cleanup: "completed" } }),
    ]);

    expect(exported.map((event) => event.actor)).toEqual([
      { id: "zentra-policy-proxy", role: "policy_proxy" },
      { id: "zentra-capsule-controller", role: "worker_controller" },
      { id: "zentra-capsule-controller", role: "worker_controller" },
      { id: "zentra-capsule-controller", role: "worker_controller" },
    ]);
    expect(exported.map((event) => event.operation)).toEqual([
      { name: "network_policy", status: "completed" },
      { name: "capsule", status: "completed" },
      { name: "cleanup", status: "completed" },
      { name: "capsule", status: "failed" },
    ]);
  });

  it("derives capsule statuses from redacted payload outcomes", () => {
    const exported = storedEventsToAgentTailEvents([
      storedEvent({ type: "capsule.started", payload: { projectAccess: "read_only", scratchBytes: 1, policy: { schemaVersion: 1, readMode: "exact_domains", readDomains: 1, readMethods: ["GET"], githubWriteGrants: 0, githubBroker: "disabled", modelBroker: "disabled", tlsInspectionRequired: true, globalWrites: "denied" }, githubEffects: "disabled", modelEffects: "disabled_without_broker", resourceNamespace: "a".repeat(32) } }),
      storedEvent({ type: "capsule.proxy_interaction_observed", payload: { scheme: "https", method: "POST", host: "example.com", allowed: false, reason: "method_denied" } }),
      storedEvent({ type: "capsule.check_observed", payload: { name: "projectReadOnly", passed: false } }),
      storedEvent({ type: "capsule.cleanup_observed", payload: { outcome: "uncertain", containersAbsent: false, networksAbsent: false, imagesAbsent: false, observationsCollected: false } }),
      storedEvent({ type: "capsule.failure_observed", payload: { outcome: "timed_out", reason: "total_deadline" } }),
    ]);

    expect(exported.map((event) => event.operation.status)).toEqual([
      "running", "denied", "failed", "failed", "timed_out",
    ]);
  });

  it("fails closed before projecting an unvalidated capsule payload", () => {
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "capsule.proxy_interaction_observed",
      payload: { authorization: "secret" },
    }))).toThrow();
  });

  it("fails closed on spoofed OpenCode milestone actor payloads", () => {
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "milestone.task_running",
      payload: { harness: "opencode", actorId: "spoofed", role: "planner" },
    }))).toThrow("invalid OpenCode milestone event payload");
  });

  it("attributes read-only OpenCode reviewer activity to the reviewer actor", () => {
    const payload = OpenCodeMilestoneRunningPayloadSchema.parse({
      taskId: "review-task",
      capsuleId: "capsule-review-1",
      actorId: "opencode-reviewer",
      role: "reviewer",
      harness: "opencode",
      requestedModel: {
        capabilityId: "opencode-reviewer",
        transportModelId: "fixture/model",
      },
      budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 500 },
      timeoutMs: 20_000,
      securityBoundary: {
        repository: "sanitized_read_only_bind_mount",
        scratch: "bounded_ephemeral",
        network: "model_broker_only",
        home: "ephemeral",
        credentials: "none",
        shell: "none",
        readableScopes: ["src/**"],
        forbiddenPaths: [".env"],
        repositoryRevision: "a".repeat(64),
      },
    });
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "milestone.task_running",
      payload,
    }));

    expect(exported).toMatchObject({
      actor: { id: "opencode-reviewer", role: "reviewer" },
      operation: { name: "opencode_agent", status: "running" },
    });
  });

  it("projects generic milestone agents into separate child spans", () => {
    const implementer = storedEventToAgentTailEvent(storedEvent({
      streamId: "milestone-1",
      type: "milestone.task_running",
      payload: { taskId: "implement", actorId: "writer-1", role: "implementer" },
    }));
    const reviewer = storedEventToAgentTailEvent(storedEvent({
      streamId: "milestone-1",
      type: "milestone.task_running",
      payload: { taskId: "review", actorId: "reviewer-1", role: "reviewer" },
    }));

    expect(implementer).toMatchObject({
      span_id: "milestone:milestone-1:task:implement",
      parent_span_id: "milestone:milestone-1",
      actor: { id: "writer-1", role: "implementer" },
    });
    expect(reviewer).toMatchObject({
      span_id: "milestone:milestone-1:task:review",
      parent_span_id: "milestone:milestone-1",
      actor: { id: "reviewer-1", role: "reviewer" },
    });
  });

  it("projects generic nested workers as child spans with their own actors", () => {
    const binding = {
      schemaVersion: 1,
      workerId: "research-1",
      taskId: "task-1",
      parentWorkerId: "writer-1",
      harness: "opencode",
      role: "researcher",
      model: { capabilityId: "research-model", modelId: "provider/model" },
      envelope: capabilityEnvelope({
        role: "researcher", authority: "read_only", capabilities: ["read_repository"],
        network: "denied", secrets: "none",
        effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" },
        resources: { repository: "read_only", paths: ["src/**"], forbiddenPaths: [".env"] },
      }),
      budget: {
        budgetId: "budget-1", maxSeconds: 30, maxCostUsd: 1,
        maxInputTokens: 100, maxOutputTokens: 100, maxToolCalls: 10, maxModelTurns: 10,
        maxActiveWorkers: 2, maxConcurrentTools: 1, maxConcurrentModelTurns: 1,
      },
      rootTaskId: "task-1",
      taskContext: { kind: "milestone", milestoneId: "milestone-1" },
      trace: { traceId: "trace-1", correlationId: "milestone-1" },
    };
    const exported = storedEventToAgentTailEvent(storedEvent({
      streamId: "worker:research-1", type: "worker.bound", payload: binding,
    }));

    expect(exported).toMatchObject({
      span_id: "worker:research-1",
      parent_span_id: "worker:writer-1",
      actor: { id: "research-1", role: "researcher" },
      operation: { name: "worker", status: "waiting" },
      payload: { budget: { maxCostUsdNano: 1_000_000_000 }, envelope: { readScopeCount: 1, writeScopeCount: 0, forbiddenScopeCount: 1 } },
    });
    expect(JSON.stringify(exported.payload)).not.toContain("src/**");
    expect(JSON.stringify(exported.payload)).not.toContain(".env");

    const observed = storedEventToAgentTailEvent(storedEvent({
      streamId: "worker-task:task-1", type: "worker.observed", payload: {
        schemaVersion: 1, workerId: "research-1", taskId: "task-1", rootTaskId: "task-1",
        parentWorkerId: "writer-1", role: "researcher", taskContext: { kind: "milestone", milestoneId: "milestone-1" },
        observation: {
          kind: "model", name: "provider/model", phase: "completed", outcome: "completed",
          usage: { seconds: 0, inputTokens: 1, outputTokens: 1, costUsd: 0.3, costUsdNano: 300_000_000, toolCalls: 0, modelTurns: 1 },
        },
      },
    }));
    expect(observed.payload).toMatchObject({ observation: { usage: { costUsd: 0.3, costUsdNano: 300_000_000 } } });
  });

  it("parents top-level workers to the actual standalone or milestone task span", () => {
    const base = {
      schemaVersion: 1, workerId: "writer-1", taskId: "task-1", rootTaskId: "task-1",
      parentWorkerId: null, harness: "deterministic", role: "researcher", model: null,
      envelope: capabilityEnvelope({ role: "researcher", authority: "read_only", capabilities: ["read_repository"], network: "denied", secrets: "none", effects: { worktree: "none", pathExpansion: "none", integration: "none", release: "none", external: "none" }, resources: { repository: "read_only", paths: ["src/**"], forbiddenPaths: [] } }),
      budget: { budgetId: "budget-1", maxSeconds: 1, maxCostUsd: 0, maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1, maxModelTurns: 1, maxActiveWorkers: 1, maxConcurrentTools: 1, maxConcurrentModelTurns: 1 },
      trace: { traceId: "trace-1", correlationId: "trace-1" },
    } as const;
    const standalone = storedEventToAgentTailEvent(storedEvent({ type: "worker.bound", payload: { ...base, taskContext: { kind: "standalone" } } }));
    const milestone = storedEventToAgentTailEvent(storedEvent({ type: "worker.bound", payload: { ...base, taskContext: { kind: "milestone", milestoneId: "milestone-9" } } }));
    expect(standalone.parent_span_id).toBe("task:task-1");
    expect(milestone.parent_span_id).toBe("milestone:milestone-9:task:task-1");
  });

  it("exposes strictly validated chosen-model routing metadata", () => {
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "routing.model_selected",
      payload: {
        schemaVersion: 1,
        executionId: "execution-1",
        taskId: "task-1",
        taskType: "single_file_implementation",
        role: "implementer",
        model: {
          capabilityId: "writer-a",
          harness: "opencode",
          transportModelSha256: "b".repeat(64),
        },
        candidateCapabilityIds: ["writer-a", "writer-b"],
        modelSheetSha256: "a".repeat(64),
        algorithmVersion: "approved-history-v1",
        basis: "outcome_history",
      },
    }));

    expect(exported).toMatchObject({
      actor: { id: "zentra-model-router", role: "scheduler" },
      operation: { name: "model_routing", status: "completed" },
      attributes: { zentra: { chosen_model: {
        capability_id: "writer-a",
        harness: "opencode",
        transport_model_sha256: "b".repeat(64),
        role: "implementer",
        task_type: "single_file_implementation",
        basis: "outcome_history",
      } } },
    });
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "routing.model_selected",
      payload: { model: { capabilityId: "spoofed" } },
    }))).toThrow();
  });

  it("serializes one valid JSONL line without mutating native event payload", () => {
    const payload = { terminalOutcome: "completed" };
    const event = storedEvent({ type: "task.completed", payload });

    const line = agentTailEventToJsonLine(storedEventToAgentTailEvent(event));

    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expectValidAgentTailEnvelope(parsed);
    expect(payload).toEqual({ terminalOutcome: "completed" });
  });

  it("fails closed on timestamps Agent Tail cannot parse", () => {
    expect(() => storedEventToAgentTailEvent(storedEvent({
      type: "task.created",
      recordedAt: "2026-07-14T12:00:00",
    }))).toThrow("Agent Tail timestamp must include a timezone");
  });
});

function expectValidAgentTailEnvelope(event: object): void {
  const envelope = event as Record<string, unknown>;
  expect(envelope.schema_version).toMatch(/^1\.\d+$/);
  expect(typeof envelope.event_id).toBe("string");
  expect(typeof envelope.trace_id).toBe("string");
  expect(typeof envelope.span_id).toBe("string");
  expect(envelope.parent_span_id === null || typeof envelope.parent_span_id === "string").toBe(true);
  expect(typeof envelope.emitter_id).toBe("string");
  expect(Number.isInteger(envelope.sequence)).toBe(true);
  expect(typeof envelope.timestamp).toBe("string");
  expect(typeof envelope.kind).toBe("string");
  expect(envelope.actor).toEqual(expect.objectContaining({ id: expect.any(String) }));
  expect(envelope.operation).toEqual(expect.objectContaining({ status: expect.any(String) }));
}
