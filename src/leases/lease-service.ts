import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  MAX_LEASE_DURATION_MS,
  leaseStreamId,
  projectLease,
  type LeaseView,
} from "./lease-projection.js";

export interface GrantLeaseInput {
  readonly leaseId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly schedulerId: string;
  readonly processIncarnation: string;
  readonly scope?: "task" | "worker";
  readonly durationMs: number;
}

export class LeaseService {
  private readonly now: () => number;

  constructor(private readonly journal: EventJournal, options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  grant(input: GrantLeaseInput): LeaseView {
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0 ||
      input.durationMs > MAX_LEASE_DURATION_MS) throw new Error("lease duration must be at most 180 seconds");
    const now = this.now();
    return this.append(input.leaseId, "lease.granted", {
      schemaVersion: 1, leaseId: input.leaseId, taskId: input.taskId, workerId: input.workerId,
      schedulerId: input.schedulerId, processIncarnation: input.processIncarnation,
      scope: input.scope ?? "worker",
      grantedAtMs: now, expiresAtMs: now + input.durationMs,
    }, input.taskId);
  }

  heartbeat(leaseId: string, processIncarnation: string, workerIncarnation: string): boolean {
    const current = this.require(leaseId);
    const now = this.now();
    if (processIncarnation !== current.processIncarnation) throw new Error("stale scheduler incarnation");
    if (current.workerIncarnation !== null && current.workerIncarnation !== workerIncarnation) {
      throw new Error("stale worker incarnation");
    }
    if (now > current.expiresAtMs) throw new Error("lease is expired");
    if (current.lastHeartbeatAtMs !== null && now - current.lastHeartbeatAtMs < 60_000) return false;
    this.appendMany(leaseId, [{ type: "lease.heartbeat", payload: { schemaVersion: 1, leaseId,
      processIncarnation, workerIncarnation, observedAtMs: now,
      expiresAtMs: now + MAX_LEASE_DURATION_MS } }, { type: "lease.renewed", payload: {
      schemaVersion: 1, leaseId, processIncarnation, workerIncarnation, renewedAtMs: now,
      expiresAtMs: now + MAX_LEASE_DURATION_MS,
    } }], current.taskId);
    return true;
  }

  expire(leaseId: string, reason = "heartbeat deadline elapsed"): LeaseView {
    const current = this.require(leaseId);
    if (current.status !== "active") return current;
    if (this.now() < current.expiresAtMs) throw new Error("active lease has not expired");
    return this.append(leaseId, "lease.expired", { schemaVersion: 1, leaseId,
      occurredAtMs: this.now(), reason }, current.taskId);
  }

  release(leaseId: string, reason = "worker outcome recorded"): LeaseView {
    const current = this.require(leaseId);
    if (current.status !== "active") return current;
    return this.append(leaseId, "lease.released", { schemaVersion: 1, leaseId,
      occurredAtMs: this.now(), reason }, current.taskId);
  }

  reconcile(leaseId: string, reason: string): LeaseView {
    const current = this.require(leaseId);
    if (current.status !== "active") return current;
    return this.append(leaseId, "lease.reconciled", { schemaVersion: 1, leaseId,
      occurredAtMs: this.now(), reason }, current.taskId);
  }

  inspect(leaseId: string): LeaseView {
    return this.require(leaseId);
  }

  private require(leaseId: string): LeaseView {
    const view = projectLease(readStreamEvents(this.journal, leaseStreamId(leaseId)));
    if (view === null) throw new Error(`lease ${leaseId} was not found`);
    return view;
  }

  private append(leaseId: string, type: string, payload: unknown, correlationId: string): LeaseView {
    return this.appendMany(leaseId, [{ type, payload }], correlationId);
  }

  private appendMany(leaseId: string, inputs: readonly { readonly type: string; readonly payload: unknown }[],
    correlationId: string): LeaseView {
    const streamId = leaseStreamId(leaseId);
    const events = readStreamEvents(this.journal, streamId);
    const next: NewEvent<string, unknown>[] = inputs.map(({ type, payload }) =>
      ({ streamId, type, payload, causationId: null, correlationId }));
    const prospective: StoredEvent[] = next.map((event, index) => ({ ...event,
      eventId: `prospective-${index}`, streamVersion: events.length + index + 1,
      globalPosition: events.length + index + 1, recordedAt: new Date(this.now()).toISOString() }));
    const projected = projectLease([...events, ...prospective]);
    if (projected === null) throw new Error("lease projection did not produce a view");
    this.journal.append(streamId, events.length, next);
    return projected;
  }
}
