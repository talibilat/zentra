import { z } from "zod";

import type { StoredEvent } from "../contracts/event.js";

export const MIN_HEARTBEAT_INTERVAL_MS = 60_000;
export const MAX_LEASE_DURATION_MS = 180_000;

const Identity = z.string().min(1).max(256);
export const LeaseGrantedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: Identity,
  taskId: Identity,
  workerId: Identity,
  schedulerId: Identity,
  processIncarnation: Identity,
  scope: z.enum(["task", "worker"]),
  grantedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
export const LeaseHeartbeatPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: Identity,
  processIncarnation: Identity,
  workerIncarnation: Identity,
  observedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
export const LeaseRenewedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: Identity,
  processIncarnation: Identity,
  workerIncarnation: Identity,
  renewedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
});
const LeaseEndedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leaseId: Identity,
  occurredAtMs: z.number().int().nonnegative(),
  reason: z.string().min(1).max(1_024),
});

export interface LeaseView {
  readonly leaseId: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly schedulerId: string;
  readonly processIncarnation: string;
  readonly scope: "task" | "worker";
  readonly workerIncarnation: string | null;
  readonly grantedAtMs: number;
  readonly lastHeartbeatAtMs: number | null;
  readonly expiresAtMs: number;
  readonly status: "active" | "expired" | "released" | "reconciled";
  readonly authority: false;
  readonly streamVersion: number;
}

export function projectLease(events: readonly StoredEvent[]): LeaseView | null {
  let view: LeaseView | null = null;
  for (const event of events) {
    if (event.type === "lease.granted") {
      if (view !== null) throw new Error("lease was granted more than once");
      const payload = LeaseGrantedPayloadSchema.parse(event.payload);
      if (event.streamId !== leaseStreamId(payload.leaseId)) throw new Error("lease stream identity mismatch");
      if (payload.expiresAtMs - payload.grantedAtMs <= 0 ||
        payload.expiresAtMs - payload.grantedAtMs > MAX_LEASE_DURATION_MS) {
        throw new Error("lease duration exceeds 180 seconds");
      }
      view = Object.freeze({ ...payload, workerIncarnation: null, lastHeartbeatAtMs: null,
        status: "active", authority: false, streamVersion: event.streamVersion });
      continue;
    }
    if (view === null) throw new Error("lease event requires a grant");
    if (view.status !== "active") throw new Error("lease is already terminal");
    if (event.type === "lease.heartbeat") {
      const payload = LeaseHeartbeatPayloadSchema.parse(event.payload);
      if (payload.leaseId !== view.leaseId || payload.processIncarnation !== view.processIncarnation) {
        throw new Error("stale scheduler incarnation");
      }
      if (view.workerIncarnation !== null && payload.workerIncarnation !== view.workerIncarnation) {
        throw new Error("stale worker incarnation");
      }
      if (payload.observedAtMs > view.expiresAtMs ||
        payload.expiresAtMs - payload.observedAtMs <= 0 ||
        payload.expiresAtMs - payload.observedAtMs > MAX_LEASE_DURATION_MS) {
        throw new Error("lease heartbeat is outside its bounded lifetime");
      }
      view = Object.freeze({ ...view, workerIncarnation: payload.workerIncarnation,
        lastHeartbeatAtMs: payload.observedAtMs, expiresAtMs: payload.expiresAtMs,
        streamVersion: event.streamVersion });
      continue;
    }
    if (event.type === "lease.renewed") {
      const payload = LeaseRenewedPayloadSchema.parse(event.payload);
      if (payload.leaseId !== view.leaseId || payload.processIncarnation !== view.processIncarnation) {
        throw new Error("stale scheduler incarnation");
      }
      if (view.workerIncarnation !== payload.workerIncarnation ||
        view.lastHeartbeatAtMs !== payload.renewedAtMs ||
        payload.expiresAtMs - payload.renewedAtMs <= 0 ||
        payload.expiresAtMs - payload.renewedAtMs > MAX_LEASE_DURATION_MS) {
        throw new Error("lease renewal is not bound to its exact heartbeat");
      }
      view = Object.freeze({ ...view, expiresAtMs: payload.expiresAtMs,
        streamVersion: event.streamVersion });
      continue;
    }
    if (event.type !== "lease.expired" && event.type !== "lease.released" && event.type !== "lease.reconciled") {
      throw new Error(`unknown lease event type ${event.type}`);
    }
    const payload = LeaseEndedPayloadSchema.parse(event.payload);
    if (payload.leaseId !== view.leaseId) throw new Error("lease end identity mismatch");
    view = Object.freeze({ ...view, status: event.type.slice("lease.".length) as LeaseView["status"],
      streamVersion: event.streamVersion });
  }
  return view;
}

export function leaseStreamId(leaseId: string): string {
  if (!Identity.safeParse(leaseId).success) throw new Error("lease identity is invalid");
  return `lease:${leaseId}`;
}
