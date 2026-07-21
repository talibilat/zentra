import { digestCanonical } from "../contracts/authority-attention.js";
import type { StoredEvent } from "../contracts/event.js";
import { isAgentTailProjectableEventType } from "../observability/agent-tail.js";

type ResourceName = "writers" | "heavyValidation" | "review" | "integration";

export interface AgentTrailJournalEntry {
  readonly eventId: string;
  readonly position: number;
  readonly digest: string;
}

export interface ThreePodConformanceReport {
  readonly schemaVersion: 1;
  readonly pods: { readonly durable: number; readonly completed: number; readonly cancelled: number };
  readonly throughput: { readonly verifiedUnits: number; readonly elapsedMs: number; readonly unitsPerSecond: number };
  readonly waits: { readonly samples: number; readonly neverDispatched: number; readonly totalMs: number;
    readonly averageMs: number; readonly maximumMs: number; readonly backpressuredSamples: number;
    readonly minimumBackpressuredMs: number };
  readonly conflicts: { readonly observed: number; readonly rate: number };
  readonly backpressure: { readonly observations: number; readonly resources: number; readonly budget: number };
  readonly capacities: {
    readonly configured: Record<ResourceName, number>;
    readonly peak: Record<ResourceName, number>;
    readonly respected: boolean;
  };
  readonly evidence: {
    readonly requiredTypes: readonly string[];
    readonly observedTypes: readonly string[];
    readonly missingTypes: readonly string[];
    readonly causationComplete: boolean;
    readonly causationGaps: readonly string[];
    readonly assignments: { readonly total: number; readonly complete: number; readonly missing: readonly string[] };
    readonly units: { readonly total: number; readonly complete: number; readonly missing: readonly string[] };
    readonly complete: boolean;
  };
}

export function buildThreePodConformanceReport(events: readonly StoredEvent[], options: {
  readonly expectedPods: number;
  readonly expectedWriterCapacity: number;
  readonly expectedIntegrationCapacity: number;
  readonly expectedValidationCapacity?: number;
  readonly expectedReviewCapacity?: number;
  readonly trustedNowMs?: number;
  readonly requiredEvidenceTypes: readonly string[];
}): ThreePodConformanceReport {
  const ordered = [...events].sort((left, right) => left.globalPosition - right.globalPosition);
  assertEventSequence(ordered);
  const started = ordered.find((event) => event.type === "conformance.started");
  const configured = configuredCapacities(ordered, options);
  if (configured.writers !== options.expectedWriterCapacity ||
    configured.integration !== options.expectedIntegrationCapacity ||
    (options.expectedValidationCapacity !== undefined && configured.heavyValidation !== options.expectedValidationCapacity) ||
    (options.expectedReviewCapacity !== undefined && configured.review !== options.expectedReviewCapacity)) {
    throw new Error("conformance scheduler capacities do not match the expected target");
  }

  const active = zeroCapacities();
  const peak = zeroCapacities();
  for (const event of ordered) {
    if (event.type !== "scheduler.resources_acquired" && event.type !== "scheduler.resources_released") continue;
    const resources = object(object(event.payload, event.type)["resources"], `${event.type} resources`);
    const direction = event.type === "scheduler.resources_acquired" ? 1 : -1;
    for (const name of resourceNames) {
      active[name] += direction * nonnegative(resources[name] ?? 0, `${event.type} ${name}`);
      if (active[name] < 0) throw new Error(`conformance ${name} capacity was released without acquisition`);
      peak[name] = Math.max(peak[name], active[name]);
    }
  }
  const respected = resourceNames.every((name) => peak[name] <= configured[name]);
  if (!respected) throw new Error("conformance resource capacity was exceeded");

  const submittedAt = new Map<string, number>();
  const dispatchedAt = new Map<string, number>();
  const acquiredAt = new Map<string, number>();
  const backpressuredTaskIds = new Set<string>();
  for (const event of ordered) {
    const payload = object(event.payload, event.type);
    if (event.type === "scheduler.task_submitted") {
      const task = object(payload["task"], "scheduler task");
      submittedAt.set(identifier(task["taskId"]), timestamp(payload["submittedAtMs"], event.recordedAt));
    } else if (event.type === "scheduler.resources_acquired") {
      acquiredAt.set(identifier(payload["taskId"]), timestamp(payload["acquiredAtMs"], event.recordedAt));
    } else if (event.type === "scheduler.dispatch_started") {
      const taskId = identifier(payload["taskId"]);
      if (submittedAt.has(taskId)) dispatchedAt.set(taskId, timestamp(payload["startedAtMs"], event.recordedAt));
    } else if (event.type === "scheduler.backpressure") {
      backpressuredTaskIds.add(identifier(payload["taskId"]));
    }
  }

  const terminalPods = new Map<string, "completed" | "cancelled">();
  for (const event of ordered) {
    if (event.type !== "pod.completed" && event.type !== "pod.cancelled") continue;
    const payload = object(event.payload, event.type);
    terminalPods.set(optionalIdentifier(payload["podId"]) ?? event.streamId,
      event.type.slice("pod.".length) as "completed" | "cancelled");
  }
  if (terminalPods.size !== options.expectedPods) throw new Error("conformance did not retain exactly the expected durable pods");

  const units = new Set(ordered.filter((event) => event.type === "integration.unit_formed")
    .map((event) => identifier(object(event.payload, event.type)["unitId"])));
  const verified = new Set(ordered.filter((event) => event.type === "final_acceptance.accepted")
    .map((event) => identifier(object(event.payload, event.type)["unitId"])));
  if ([...verified].some((unitId) => !units.has(unitId))) throw new Error("final acceptance lacks a durable integration unit");
  const conflicts = ordered.filter((event) =>
    event.type === "conflict.observed" || event.type === "ownership.conflict_observed").length;
  const conflictDenominator = verified.size + conflicts;
  const firstMs = started === undefined ? Date.parse(ordered[0]?.recordedAt ?? new Date(0).toISOString())
    : timestamp(object(started.payload, started.type)["submittedAtMs"], started.recordedAt);
  const lastMs = ordered.length === 0 ? firstMs : Date.parse(ordered.at(-1)!.recordedAt);
  const elapsedMs = Math.max(0, lastMs - firstMs);
  const trustedNowMs = options.trustedNowMs ?? lastMs;
  if (!Number.isSafeInteger(trustedNowMs) || trustedNowMs < lastMs) throw new Error("conformance trusted clock precedes journal evidence");
  const waits = [...submittedAt].map(([taskId, submitted]) =>
    Math.max(0, (acquiredAt.get(taskId) ?? dispatchedAt.get(taskId) ?? trustedNowMs) - submitted));
  const neverDispatched = [...submittedAt.keys()].filter((taskId) => !acquiredAt.has(taskId) && !dispatchedAt.has(taskId)).length;
  const backpressuredWaits = [...backpressuredTaskIds].map((taskId) =>
    Math.max(0, (acquiredAt.get(taskId) ?? dispatchedAt.get(taskId) ?? trustedNowMs) -
      (submittedAt.get(taskId) ?? trustedNowMs)));

  const eventTypes = new Set(ordered.map((event) => event.type));
  const requiredTypes = [...new Set(options.requiredEvidenceTypes)].sort();
  const observedTypes = requiredTypes.filter((type) => eventTypes.has(type));
  const missingTypes = requiredTypes.filter((type) => !eventTypes.has(type));
  const causalEvents = ordered.filter((event) => event.type === "conformance.started" || isAgentTailProjectableEventType(event.type));
  const eventIds = new Set(causalEvents.map((event) => event.eventId));
  const causationGaps = causalEvents.flatMap((event, index) => {
    const valid = index === 0 ? event.type === "conformance.started" && event.causationId === null :
      event.causationId !== null && eventIds.has(event.causationId) &&
      causalEvents.slice(0, index).some((candidate) => candidate.eventId === event.causationId);
    return valid ? [] : [`${event.streamId}:${event.type}:${event.eventId}`];
  });
  const causationComplete = causationGaps.length === 0;
  const pressure = ordered.filter((event) => event.type === "scheduler.backpressure")
    .map((event) => object(event.payload, event.type)["kind"]);
  const totalWait = waits.reduce((sum, value) => sum + value, 0);
  const assignments = new Map<string, boolean>();
  for (const event of ordered) {
    if (event.type === "pod.assignment_recorded") {
      const assignment = object(object(event.payload, event.type)["assignment"], "pod assignment");
      assignments.set(identifier(assignment["assignmentId"]), false);
    } else if (event.type === "pod.assignment_observed") {
      const payload = object(event.payload, event.type);
      const evidenceIds = payload["evidenceIds"];
      assignments.set(identifier(payload["assignmentId"]), Array.isArray(evidenceIds) && evidenceIds.length > 0);
    } else if (event.type === "pod.reconciliation_resolved") {
      const payload = object(event.payload, event.type);
      const evidenceIds = payload["evidenceIds"];
      if (payload["resolution"] === "completed") assignments.set(identifier(payload["assignmentId"]),
        Array.isArray(evidenceIds) && evidenceIds.length > 0);
    }
  }
  const missingAssignments = [...assignments].filter(([, complete]) => !complete).map(([id]) => id).sort();
  const missingUnits = [...units].filter((unitId) => !verified.has(unitId)).sort();

  return Object.freeze({
    schemaVersion: 1,
    pods: Object.freeze({ durable: terminalPods.size,
      completed: [...terminalPods.values()].filter((outcome) => outcome === "completed").length,
      cancelled: [...terminalPods.values()].filter((outcome) => outcome === "cancelled").length }),
    throughput: Object.freeze({ verifiedUnits: verified.size, elapsedMs,
      unitsPerSecond: elapsedMs === 0 ? verified.size : verified.size * 1_000 / elapsedMs }),
    waits: Object.freeze({ samples: waits.length, neverDispatched, totalMs: totalWait,
      averageMs: waits.length === 0 ? 0 : totalWait / waits.length,
      maximumMs: waits.length === 0 ? 0 : Math.max(...waits), backpressuredSamples: backpressuredWaits.length,
      minimumBackpressuredMs: backpressuredWaits.length === 0 ? 0 : Math.min(...backpressuredWaits) }),
    conflicts: Object.freeze({ observed: conflicts, rate: conflictDenominator === 0 ? 0 : conflicts / conflictDenominator }),
    backpressure: Object.freeze({ observations: pressure.length,
      resources: pressure.filter((kind) => kind === "resources").length,
      budget: pressure.filter((kind) => kind === "budget").length }),
    capacities: Object.freeze({ configured: Object.freeze(configured), peak: Object.freeze(peak), respected }),
    evidence: Object.freeze({ requiredTypes: Object.freeze(requiredTypes), observedTypes: Object.freeze(observedTypes),
      missingTypes: Object.freeze(missingTypes), causationComplete,
      causationGaps: Object.freeze(causationGaps),
      assignments: Object.freeze({ total: assignments.size, complete: assignments.size - missingAssignments.length,
        missing: Object.freeze(missingAssignments) }),
      units: Object.freeze({ total: units.size, complete: units.size - missingUnits.length,
        missing: Object.freeze(missingUnits) }),
      complete: missingTypes.length === 0 && causationComplete && missingAssignments.length === 0 && missingUnits.length === 0 }),
  });
}

export function compareAgentTrailJournal(events: readonly StoredEvent[], projected: readonly AgentTrailJournalEntry[]): {
  readonly matched: number;
  readonly complete: true;
} {
  const ordered = [...events].sort((left, right) => left.globalPosition - right.globalPosition);
  assertEventSequence(ordered);
  if (ordered.length !== projected.length) throw new Error("AgentTrail projection event count differs from journal truth");
  for (const [index, event] of ordered.entries()) {
    const candidate = projected[index];
    if (candidate?.eventId !== event.eventId) throw new Error(`AgentTrail event identity mismatch at position ${event.globalPosition}`);
    if (candidate.position !== event.globalPosition) throw new Error(`AgentTrail event position mismatch for ${event.eventId}`);
    if (candidate.digest !== eventDigest(event)) throw new Error(`AgentTrail event digest mismatch for ${event.eventId}`);
  }
  return Object.freeze({ matched: ordered.length, complete: true });
}

compareAgentTrailJournal.digest = eventDigest;

const resourceNames: readonly ResourceName[] = ["writers", "heavyValidation", "review", "integration"];

function configuredCapacities(events: readonly StoredEvent[], options: {
  readonly expectedWriterCapacity: number; readonly expectedIntegrationCapacity: number;
}): Record<ResourceName, number> {
  const started = events.findLast((event) => event.type === "scheduler.daemon_started");
  if (started === undefined) throw new Error("conformance lacks scheduler capacity evidence");
  const limits = object(object(started.payload, started.type)["limits"], "scheduler limits");
  const resources = object(limits["resources"], "scheduler resource limits");
  return {
    writers: nonnegative(resources["writers"] ?? options.expectedWriterCapacity, "writer capacity"),
    heavyValidation: nonnegative(resources["heavyValidation"] ?? 0, "validation capacity"),
    review: nonnegative(resources["review"] ?? 0, "review capacity"),
    integration: nonnegative(resources["integration"] ?? options.expectedIntegrationCapacity, "integration capacity"),
  };
}

function zeroCapacities(): Record<ResourceName, number> {
  return { writers: 0, heavyValidation: 0, review: 0, integration: 0 };
}

function eventDigest(event: StoredEvent): string {
  return digestCanonical({ eventId: event.eventId, streamId: event.streamId, streamVersion: event.streamVersion,
    globalPosition: event.globalPosition, type: event.type, payload: event.payload,
    causationId: event.causationId, correlationId: event.correlationId, recordedAt: event.recordedAt });
}

function assertEventSequence(events: readonly StoredEvent[]): void {
  const ids = new Set<string>();
  let prior = 0;
  for (const event of events) {
    if (event.globalPosition <= prior || ids.has(event.eventId)) throw new Error("conformance journal order or event identity is invalid");
    prior = event.globalPosition;
    ids.add(event.eventId);
  }
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function timestamp(value: unknown, fallback: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  const parsed = Date.parse(fallback);
  if (!Number.isFinite(parsed)) throw new Error("conformance event timestamp is invalid");
  return parsed;
}

function optionalIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function identifier(value: unknown): string {
  const parsed = optionalIdentifier(value);
  if (parsed === null) throw new Error("conformance identity is invalid");
  return parsed;
}
