import { z } from "zod";
import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import { controlIdentitySha256 } from "../scheduling/dispatch-grant-service.js";
import type { SchedulerControlIdentity } from "../scheduling/scheduler-contracts.js";

export const DAEMON_LEASE_DURATION_MS = 30_000;
const Owner = z.strictObject({ schedulerId: z.string().min(1), processIncarnation: z.string().min(1),
  pid: z.number().int().positive(), processStartIdentity: z.string().min(1) });
const Lease = z.strictObject({ schemaVersion: z.literal(1), owner: Owner,
  acquiredAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive() });
const Renewed = z.strictObject({ schemaVersion: z.literal(1), owner: Owner,
  renewedAtMs: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive() });
const Ended = z.strictObject({ schemaVersion: z.literal(1), owner: Owner,
  occurredAtMs: z.number().int().nonnegative(), reason: z.string().min(1) });

export interface DaemonLeaseOwner extends z.infer<typeof Owner> {}
export interface DaemonLeaseView {
  readonly owner: DaemonLeaseOwner;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly status: "active" | "released" | "replaced";
  readonly streamVersion: number;
}
export type DaemonOwnerLiveness = (owner: DaemonLeaseOwner) => "alive" | "dead" | "unknown";

export class DaemonLeaseService {
  constructor(private readonly journal: EventJournal, private readonly identity: SchedulerControlIdentity,
    private readonly now: () => number, private readonly liveness: DaemonOwnerLiveness) {}

  acquire(owner: DaemonLeaseOwner): DaemonLeaseView {
    const current = this.inspect();
    if (current?.status === "active") {
      if (sameOwner(current.owner, owner) && this.now() < current.expiresAtMs) return current;
      if (this.liveness(current.owner) !== "dead") {
        throw new Error("healthy or unverified scheduler daemon lease cannot be taken over");
      }
      this.append("daemon_lease.replaced", { schemaVersion: 1, owner: current.owner,
        occurredAtMs: this.now(), reason: "prior owner was proven dead" }, current.streamVersion);
    }
    const version = this.inspect()?.streamVersion ?? 0;
    this.append("daemon_lease.acquired", { schemaVersion: 1, owner, acquiredAtMs: this.now(),
      expiresAtMs: this.now() + DAEMON_LEASE_DURATION_MS }, version);
    return this.inspect()!;
  }

  renew(owner: DaemonLeaseOwner): DaemonLeaseView {
    const current = this.requireActive(owner);
    if (this.now() >= current.expiresAtMs) throw new Error("scheduler daemon lease expired before renewal");
    this.append("daemon_lease.renewed", { schemaVersion: 1, owner, renewedAtMs: this.now(),
      expiresAtMs: this.now() + DAEMON_LEASE_DURATION_MS }, current.streamVersion);
    return this.inspect()!;
  }

  release(owner: DaemonLeaseOwner, reason: string): DaemonLeaseView {
    const current = this.requireActive(owner);
    this.append("daemon_lease.released", { schemaVersion: 1, owner, occurredAtMs: this.now(), reason }, current.streamVersion);
    return this.inspect()!;
  }

  assertActive(owner: DaemonLeaseOwner): void {
    const current = this.requireActive(owner);
    if (this.now() >= current.expiresAtMs) throw new Error("scheduler daemon lease is expired");
  }

  inspect(): DaemonLeaseView | null {
    return projectDaemonLease(readStreamEvents(this.journal, daemonLeaseStreamId(this.identity)));
  }

  private requireActive(owner: DaemonLeaseOwner): DaemonLeaseView {
    const current = this.inspect();
    if (current?.status !== "active" || !sameOwner(current.owner, owner)) throw new Error("stale scheduler daemon lease owner");
    return current;
  }
  private append(type: string, payload: unknown, expectedVersion: number): void {
    const streamId = daemonLeaseStreamId(this.identity);
    const event: NewEvent<string, unknown> = { streamId, type, payload, causationId: null,
      correlationId: controlIdentitySha256(this.identity) };
    this.journal.append(streamId, expectedVersion, [event]);
  }
}

export function projectDaemonLease(events: readonly StoredEvent[]): DaemonLeaseView | null {
  let view: DaemonLeaseView | null = null;
  for (const event of events) {
    if (event.type === "daemon_lease.acquired") {
      const payload = Lease.parse(event.payload);
      if (view?.status === "active") throw new Error("daemon lease acquired while active");
      view = { ...payload, status: "active", streamVersion: event.streamVersion };
    } else if (event.type === "daemon_lease.renewed") {
      const payload = Renewed.parse(event.payload);
      if (view?.status !== "active" || !sameOwner(view.owner, payload.owner) || payload.renewedAtMs >= view.expiresAtMs) throw new Error("invalid daemon lease renewal");
      const active = view as DaemonLeaseView;
      view = { ...active, expiresAtMs: payload.expiresAtMs, streamVersion: event.streamVersion };
    } else if (event.type === "daemon_lease.released" || event.type === "daemon_lease.replaced") {
      const payload = Ended.parse(event.payload);
      if (view?.status !== "active" || !sameOwner(view.owner, payload.owner)) throw new Error("invalid daemon lease end");
      const active = view as DaemonLeaseView;
      view = { ...active, status: event.type.endsWith("released") ? "released" : "replaced", streamVersion: event.streamVersion };
    } else throw new Error(`unknown daemon lease event ${event.type}`);
  }
  return view === null ? null : Object.freeze(view);
}
export function daemonLeaseStreamId(identity: SchedulerControlIdentity): string {
  return `daemon-lease:${controlIdentitySha256(identity)}`;
}
function sameOwner(left: DaemonLeaseOwner, right: DaemonLeaseOwner): boolean {
  return left.schedulerId === right.schedulerId && left.processIncarnation === right.processIncarnation &&
    left.pid === right.pid && left.processStartIdentity === right.processStartIdentity;
}
