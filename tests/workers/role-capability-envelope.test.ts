import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { digestCanonical } from "../../src/contracts/authority-attention.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { TaskService } from "../../src/tasks/task-service.js";
import { capabilityTaskHead, createCapabilityBoundaryOccurrence, verifyCapabilityBoundaryOccurrence } from "../../src/contracts/capability-boundary.js";
import {
  RoleCapabilityEnvelopeService,
  buildRoleCapabilityBinding,
  roleCapabilityStreamId,
  roleToolPermissions,
  type RoleCapabilityBindingInput,
} from "../../src/workers/role-capability-envelope.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical role capability envelopes", () => {
  it.each([
    ["planner", "read", true], ["planner", "search", true], ["planner", "write", false],
    ["researcher", "read", true], ["researcher", "network", false],
    ["implementer", "read", true], ["implementer", "write", true], ["implementer", "validation", false],
    ["reviewer", "read", true], ["reviewer", "review", true], ["reviewer", "write", false],
  ] as const)("evaluates %s %s as allowed=%s", (role, operation, allowed) => {
    const binding = buildRoleCapabilityBinding(input(role));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    const decision = service.evaluate(binding, request(operation));
    expect(decision.status === "allowed").toBe(allowed);
    if (!allowed) expect(decision.status).toMatch(/attention|replan/);
    journal.close();
  });

  it("rejects a forged capability pause occurrence before task state changes", () => {
    const journal = new SqliteEventJournal(":memory:");
    const tasks = new TaskService(journal);
    tasks.create({ taskId: "task-1", projectId: "project-1", title: "Bounded task", correlationId: "trace-1" });
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    const decision = service.evaluate(binding, { kind: "external_effect" });
    const event = service.evaluationEvent(binding, decision.decisionId);
    const occurrence = createCapabilityBoundaryOccurrence({ binding, decision, evaluationEvent: event, phase: "pre_effect",
      taskHead: capabilityTaskHead(tasks.readStream(binding.taskId)) });
    const { attentionId: _attentionId, ...forgedBody } = occurrence;
    const forgedHead = { ...forgedBody, taskHead: { ...forgedBody.taskHead, eventId: "forged-task-head" } };
    expect(() => verifyCapabilityBoundaryOccurrence(journal, { ...forgedHead, attentionId: digestCanonical(forgedHead) })).toThrow(/task head/i);
    const forgedLifecycle = { ...forgedBody, priorTaskLifecycle: "leased" as const,
      taskHead: { ...forgedBody.taskHead, lifecycle: "leased" as const } };
    expect(() => verifyCapabilityBoundaryOccurrence(journal, { ...forgedLifecycle, attentionId: digestCanonical(forgedLifecycle) })).toThrow(/task head/i);
    expect(() => tasks.pauseForCapabilityBoundary(binding.taskId, { occurrence, evidence: null })).toThrow(/authoritative milestone/i);
    authoritativePause(journal, occurrence, null);
    const forged = { ...occurrence, evaluation: { ...occurrence.evaluation, eventId: "forged-event" } };
    expect(() => tasks.pauseForCapabilityBoundary(binding.taskId, { occurrence: forged, evidence: null })).toThrow();
    expect(tasks.get(binding.taskId)).toMatchObject({ paused: false, terminalOutcome: null });
    journal.append(binding.taskId, 1, [{ streamId: binding.taskId, type: "task.capability_boundary_paused", payload: { occurrence, evidence: null }, causationId: null, correlationId: binding.correlationId }]);
    expect(() => tasks.get(binding.taskId)).toThrow(/causation/i);
    journal.close();
  });

  it("gives readers broad configured repository context without approval requests", () => {
    const binding = buildRoleCapabilityBinding(input("researcher"));
    expect(binding.access.readPaths).toEqual(["docs/**", "src/**"]);
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    expect(service.evaluate(binding, { kind: "read", path: "src/unowned/file.ts" })).toMatchObject({ status: "allowed" });
    expect(service.evaluate(binding, { kind: "search", path: "docs/design/orchestrator.md" })).toMatchObject({ status: "allowed" });
    expect(journal.readStream(roleCapabilityStreamId(binding)).map((event) => event.type)).toEqual([
      "capability_envelope.accepted", "capability_envelope.evaluated", "capability_envelope.evaluated",
    ]);
    journal.close();
  });

  it("enforces exact and recursive scopes using Darwin-equivalent path identity", () => {
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    expect(service.evaluate(binding, { kind: "write", path: "src/owned.ts" })).toMatchObject({ status: "allowed" });
    expect(service.evaluate(binding, { kind: "write", path: "src/lib/nested.ts" })).toMatchObject({ status: "allowed" });
    expect(service.evaluate(binding, { kind: "write", path: "SRC/LIB/NESTED.TS" })).toMatchObject({ status: "allowed" });
    expect(service.evaluate(binding, { kind: "write", path: "src/owned.ts/child" })).toMatchObject({ status: "replan" });
    expect(service.evaluate(binding, { kind: "write", path: ".env" })).toMatchObject({ status: "attention", reason: "forbidden_path" });
    journal.close();
  });

  it("binds reviewers to another worker and exact evidence", () => {
    const binding = buildRoleCapabilityBinding(input("reviewer"));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    expect(service.evaluate(binding, { kind: "review", workerId: "writer-1", diffSha256: DIGEST_A, validationSha256: DIGEST_B })).toMatchObject({ status: "allowed" });
    expect(service.evaluate(binding, { kind: "review", workerId: "reviewer-1", diffSha256: DIGEST_A, validationSha256: DIGEST_B })).toMatchObject({ status: "attention", reason: "self_review" });
    expect(service.evaluate(binding, { kind: "review", workerId: "writer-1", diffSha256: DIGEST_B, validationSha256: DIGEST_B })).toMatchObject({ status: "attention", reason: "stale_evidence" });
    journal.close();
  });

  it("rejects substitution and stale policy digests before an effect", () => {
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    expect(() => service.verify({ ...binding, admissionDigest: DIGEST_B }, expected(input("implementer")))).toThrow(/binding digest|substitution/i);
    expect(() => service.verify(binding, { ...expected(input("implementer")), securityDigest: DIGEST_B })).toThrow(/stale/i);
    expect(() => service.evaluate({ ...binding, digest: DIGEST_B }, { kind: "write", path: "src/owned.ts" })).toThrow(/digest/i);
    journal.close();
  });

  it("records typed attention before any out-of-envelope effect", () => {
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    const decision = service.evaluate(binding, { kind: "integration" });
    expect(decision).toMatchObject({ status: "attention", reason: "forbidden_effect", effectPerformed: false });
    const event = journal.readStream(roleCapabilityStreamId(binding)).at(-1)!;
    expect(event.type).toBe("capability_envelope.evaluated");
    expect(event.payload).toMatchObject({ decision: { effectPerformed: false } });
    journal.close();
  });

  it("replays accepted bindings and decisions after restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zentra-role-envelope-"));
    roots.push(root);
    const database = path.join(root, "events.sqlite");
    const binding = buildRoleCapabilityBinding(input("planner"));
    const first = new SqliteEventJournal(database);
    const service = new RoleCapabilityEnvelopeService(first);
    service.accept(binding);
    service.evaluate(binding, { kind: "read", path: "src/a.ts" });
    first.close();
    const second = new SqliteEventJournal(database);
    expect(new RoleCapabilityEnvelopeService(second).inspect(binding)).toMatchObject({ binding, evaluationCount: 1 });
    second.close();
  });

  it("projects digests and counts to Agent Tail without policy paths or prose", () => {
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const journal = new SqliteEventJournal(":memory:");
    new RoleCapabilityEnvelopeService(journal).accept(binding);
    const projected = storedEventToAgentTailEvent(journal.readStream(roleCapabilityStreamId(binding))[0]!);
    expect(projected.payload).toMatchObject({
      bindingDigest: binding.digest,
      envelopeDigest: binding.envelope.digest,
      readScopeCount: 2,
      writeScopeCount: 2,
      forbiddenScopeCount: 1,
    });
    expect(JSON.stringify(projected)).not.toContain("src/**");
    expect(JSON.stringify(projected)).not.toContain(".env");
    journal.close();
  });

  it("keeps provider transport separate and web research reserved", () => {
    expect(roleToolPermissions("planner")).toEqual(["read_repository"]);
    const binding = buildRoleCapabilityBinding(input("planner"));
    expect(binding.providerTransport).toBe("host_model_provider");
    expect(binding.envelope.network).toBe("model_provider_only");
    expect(binding.envelope.capabilities).not.toContain("web_research");
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    expect(service.evaluate(binding, { kind: "network", destination: "https://example.com" })).toMatchObject({ status: "attention", reason: "network_disabled" });
    journal.close();
  });

  it("rejects forged replay decisions even when the attacker recomputes public digests", () => {
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    const request = { kind: "write" as const, path: "src/owned.ts" };
    const requestDigest = digestCanonical(request);
    const forged = {
      schemaVersion: 1 as const,
      decisionId: digestCanonical({ bindingDigest: binding.digest, requestDigest, status: "attention", reason: "forbidden_effect" }),
      bindingDigest: binding.digest,
      requestDigest,
      effectPerformed: false as const,
      status: "attention" as const,
      reason: "forbidden_effect" as const,
    };
    const streamId = roleCapabilityStreamId(binding);
    journal.append(streamId, 1, [{ streamId, type: "capability_envelope.evaluated", payload: { bindingDigest: binding.digest, request, decision: forged }, causationId: null, correlationId: binding.correlationId }]);
    expect(() => service.inspect(binding)).toThrow(/forged/i);
    journal.close();
  });

  it("rejects request, binding, decision identity, and effectPerformed forgeries", () => {
    const binding = buildRoleCapabilityBinding(input("planner"));
    const variants = [
      { requestDigest: DIGEST_B },
      { bindingDigest: DIGEST_B },
      { decisionId: DIGEST_B },
      { effectPerformed: true },
    ];
    for (const mutation of variants) {
      const journal = new SqliteEventJournal(":memory:");
      const service = new RoleCapabilityEnvelopeService(journal);
      service.accept(binding);
      const request = { kind: "read" as const, path: "src/owned.ts" };
      const valid = service.evaluate(binding, request);
      const streamId = roleCapabilityStreamId(binding);
      const events = journal.readStream(streamId);
      const payload = structuredClone(events[1]!.payload) as any;
      Object.assign(payload.decision, mutation);
      const hostile = new SqliteEventJournal(":memory:");
      hostile.append(streamId, 0, [{ ...events[0]!, streamId }]);
      hostile.append(streamId, 1, [{ ...events[1]!, streamId, payload }]);
      expect(() => new RoleCapabilityEnvelopeService(hostile).inspect(binding)).toThrow();
      journal.close(); hostile.close();
    }
  });

  it("namespaces identical task IDs across milestones and retains revised bindings immutably", () => {
    const first = buildRoleCapabilityBinding(input("planner"));
    const second = buildRoleCapabilityBinding({ ...input("planner"), milestoneId: "milestone-2", correlationId: "trace-2" });
    const revised = buildRoleCapabilityBinding({ ...input("planner"), planDigest: DIGEST_B, admissionDigest: DIGEST_B });
    expect(new Set([roleCapabilityStreamId(first), roleCapabilityStreamId(second), roleCapabilityStreamId(revised)]).size).toBe(3);
    const journal = new SqliteEventJournal(":memory:");
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(first); service.accept(second); service.accept(revised);
    expect(service.inspect(first).binding?.digest).toBe(first.digest);
    expect(service.inspect(second).binding?.digest).toBe(second.digest);
    expect(service.inspect(revised).binding?.digest).toBe(revised.digest);
    expect(journal.readStream(roleCapabilityStreamId(first))).toHaveLength(1);
    journal.close();
  });

  it("accepts a revised immutable binding only after the matching durable admission", () => {
    const first = buildRoleCapabilityBinding(input("planner"));
    const revised = buildRoleCapabilityBinding({ ...input("planner"), planDigest: DIGEST_B, admissionDigest: DIGEST_B });
    const journal = new SqliteEventJournal(":memory:");
    journal.append("milestone-1", 0, [
      { streamId: "milestone-1", type: "milestone.created", payload: {}, causationId: null, correlationId: "trace-1" },
      { streamId: "milestone-1", type: "milestone.task_ready", payload: { taskId: "task-1", admissionDigest: DIGEST_A }, causationId: null, correlationId: "trace-1" },
    ]);
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(first);
    expect(() => service.accept(revised)).toThrow(/current durable task admission/i);
    journal.append("milestone-1", 2, [{ streamId: "milestone-1", type: "milestone.task_ready", payload: { taskId: "task-1", admissionDigest: DIGEST_B }, causationId: null, correlationId: "trace-1" }]);
    expect(service.accept(revised).digest).toBe(revised.digest);
    expect(service.inspect(first).binding?.digest).toBe(first.digest);
    journal.close();
  });

  it.each([
    ["attention", { kind: "external_effect" as const }],
    ["replan", { kind: "write" as const, path: "docs/outside.md" }],
  ])("pauses pre-effect %s requests nonterminal with an exact evaluation occurrence", (_status, request) => {
    const journal = new SqliteEventJournal(":memory:");
    const tasks = new TaskService(journal);
    tasks.create({ taskId: "task-1", projectId: "project-1", title: "Bounded task", correlationId: "trace-1" });
    const binding = buildRoleCapabilityBinding(input("implementer"));
    const service = new RoleCapabilityEnvelopeService(journal);
    service.accept(binding);
    const decision = service.evaluate(binding, request);
    const occurrence = createCapabilityBoundaryOccurrence({
      binding, decision, evaluationEvent: service.evaluationEvent(binding, decision.decisionId), phase: "pre_effect",
      taskHead: capabilityTaskHead(tasks.readStream(binding.taskId)),
    });
    const source = authoritativePause(journal, occurrence, null);
    const paused = tasks.pauseForCapabilityBoundary(binding.taskId, { occurrence, evidence: null }, source.eventId);
    expect(paused).toMatchObject({ paused: true, lifecycle: "queued", terminalOutcome: null,
      capabilityBoundary: { status: _status, phase: "pre_effect" },
    });
    expect(() => tasks.append(binding.taskId, "task.leased", { leaseOwner: "worker" }, null)).toThrow(/paused/i);
    expect(tasks.get(binding.taskId)?.capabilityBoundary?.evaluation.eventId).toBe(service.evaluationEvent(binding, decision.decisionId).eventId);
    journal.close();
  });
});

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function input(role: "planner" | "researcher" | "implementer" | "reviewer"): RoleCapabilityBindingInput {
  return {
    milestoneId: "milestone-1", taskId: "task-1", projectId: "project-1", correlationId: "trace-1", role,
    actorId: role === "reviewer" ? "reviewer-1" : "agent-1", repository: "/repo",
    planDigest: DIGEST_A, securityDigest: digestCanonical({ security: 1 }),
    model: { capabilityId: "model-1", transportModelId: "provider/model", digest: DIGEST_A, harness: "opencode", roles: [role], toolPermissions: roleToolPermissions(role), network: "denied" },
    budget: { budgetId: "budget-1", maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 },
    admissionDigest: DIGEST_A,
    configuredReadPaths: ["src/**", "docs/**"], ownedPaths: ["src/owned.ts", "src/lib/**"],
    forbiddenPaths: [".env"],
    ...(role === "reviewer" ? { review: { workerId: "writer-1", diffSha256: DIGEST_A, validationSha256: DIGEST_B } } : {}),
  };
}

function expected(value: RoleCapabilityBindingInput) {
  return {
    planDigest: value.planDigest, securityDigest: value.securityDigest,
    modelDigest: value.model.digest, repositoryDigest: digestCanonical(value.repository),
    ownershipDigest: digestCanonical({ readPaths: [...value.configuredReadPaths].sort(), writePaths: value.role === "implementer" ? [...value.ownedPaths].sort() : [], forbiddenPaths: [...value.forbiddenPaths].sort() }),
    budgetDigest: digestCanonical(value.budget), admissionDigest: value.admissionDigest,
  };
}

function request(operation: string): any {
  if (operation === "read" || operation === "search" || operation === "write") return { kind: operation, path: "src/owned.ts" };
  if (operation === "review") return { kind: "review", workerId: "writer-1", diffSha256: DIGEST_A, validationSha256: DIGEST_B };
  if (operation === "network") return { kind: "network", destination: "https://example.com" };
  return { kind: operation };
}

function authoritativePause(journal: SqliteEventJournal, occurrence: ReturnType<typeof createCapabilityBoundaryOccurrence>, evidence: unknown) {
  return journal.append(occurrence.milestoneId, 0, [
    { streamId: occurrence.milestoneId, type: "milestone.created", payload: { projectId: occurrence.projectId, title: "Capability authority" }, causationId: null, correlationId: "trace-1" },
    { streamId: occurrence.milestoneId, type: "milestone.capability_boundary_paused", payload: { occurrence, evidence }, causationId: null, correlationId: "trace-1" },
  ])[1]!;
}
