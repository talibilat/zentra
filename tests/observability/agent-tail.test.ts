import { describe, expect, it } from "vitest";

import type { StoredEvent } from "../../src/contracts/event.js";
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

  it("maps review denial terminal events to the reviewer actor", () => {
    const exported = storedEventToAgentTailEvent(storedEvent({
      type: "task.denied",
      payload: { review: { reviewerId: "opencode-reviewer-3" } },
    }));

    expect(exported.actor).toEqual({ id: "opencode-reviewer-3", role: "reviewer" });
    expect(exported.operation).toEqual({ name: "review", status: "denied" });
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
