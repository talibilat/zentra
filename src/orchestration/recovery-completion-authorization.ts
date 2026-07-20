import { randomUUID } from "node:crypto";

import type { IntegrationLease, IntegrationLeaseStore } from "../integration/integration-lease.js";

export type RecoveryCompletionPath =
  | "integration_prepared"
  | "integration_observed"
  | "cleanup_started"
  | "cleanup_observed"
  | "cleanup_reconciled"
  | "cleanup_completed";

export interface RecoveryCompletionSnapshot {
  readonly taskId: string;
  readonly streamVersion: number;
  readonly lastEventType: string;
  readonly commonDirectory: string;
  readonly integrationRef: string;
  readonly integrationCommit: string;
  readonly worktreePath: string;
  readonly worktreeRegistered: boolean;
  readonly worktreePathExists: boolean;
  readonly ticketRefExists: boolean;
  readonly ticketCommit: string | null;
  readonly worktreeDirty: boolean | null;
  readonly worktreeDiffSha256: string | null;
}

export interface RecoveryCompletionAuthorization extends RecoveryCompletionSnapshot {
  readonly authorizationId: string;
  readonly path: RecoveryCompletionPath;
  readonly lease: IntegrationLease;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const issuedAuthorizations = new WeakSet<RecoveryCompletionAuthorization>();
const consumedAuthorizations = new WeakSet<RecoveryCompletionAuthorization>();
const MAX_LEASE_DIAGNOSTIC_LENGTH = 512;

export interface RecoveryIntegrationLeaseDiagnostics {
  readonly lossCause: string | null;
  readonly releaseFailure: string | null;
}

export class RecoveryIntegrationLeaseAuthority {
  private leaseValue: IntegrationLease;
  private readonly controller = new AbortController();
  private readonly renewal: NodeJS.Timeout;
  private closed = false;
  private lossCause: string | null = null;
  private releaseFailure: string | null = null;

  constructor(
    private readonly leaseStore: IntegrationLeaseStore,
    lease: IntegrationLease,
    private readonly durationMs: number,
    renewalMs: number,
    private readonly now: () => number,
  ) {
    if (
      !Number.isSafeInteger(durationMs) ||
      !Number.isSafeInteger(renewalMs) ||
      durationMs <= 1 ||
      renewalMs <= 0 ||
      renewalMs > Math.floor(durationMs / 2)
    ) {
      throw new Error("recovery integration lease renewal interval is not safely below expiry");
    }
    this.leaseValue = lease;
    this.renewal = setInterval(() => {
      try {
        this.renewSafely();
      } catch (error) {
        // The timer is a process-level boundary. No lease-store or abort
        // listener failure may escape it as an uncaught exception.
        this.lose(error);
      }
    }, renewalMs);
    this.renewal.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  current(): IntegrationLease {
    this.assertActive();
    return this.leaseValue;
  }

  assertActive(): void {
    if (this.closed || this.controller.signal.aborted) {
      throw this.lostError();
    }
    let current: IntegrationLease | null;
    try {
      current = this.leaseStore.read(this.leaseValue);
    } catch (error) {
      this.lose(error);
      throw this.lostError();
    }
    if (!sameLease(current, this.leaseValue) || current.expiresAt <= this.now()) {
      this.lose(new Error("durable lease identity changed or expired"));
      throw new Error("recovery completion integration lease changed or expired");
    }
  }

  close(): RecoveryIntegrationLeaseDiagnostics {
    if (this.closed) return this.diagnostics();
    this.closed = true;
    clearInterval(this.renewal);
    try {
      if (!this.leaseStore.release(this.leaseValue)) {
        this.releaseFailure = boundedCause("durable lease release did not match the current owner");
      }
    } catch (error) {
      this.releaseFailure = boundedCause(error);
    }
    return this.diagnostics();
  }

  diagnostics(): RecoveryIntegrationLeaseDiagnostics {
    return Object.freeze({
      lossCause: this.lossCause,
      releaseFailure: this.releaseFailure,
    });
  }

  private renewSafely(): void {
    if (this.closed || this.controller.signal.aborted) return;
    try {
      const renewed = this.leaseStore.renew(this.leaseValue, this.durationMs, this.now());
      if (renewed === null) {
        this.lose(new Error("durable lease renewal lost ownership or expired"));
        return;
      }
      this.leaseValue = renewed;
    } catch (error) {
      this.lose(error);
    }
  }

  private lose(error: unknown): void {
    if (this.lossCause === null) this.lossCause = boundedCause(error);
    if (!this.controller.signal.aborted) {
      try {
        this.controller.abort(this.lostError());
      } catch {
        // Abort is best-effort here; loss state still fails every later guard.
      }
    }
  }

  private lostError(): Error {
    return new Error(
      this.lossCause === null
        ? "recovery completion integration lease authority was lost"
        : `recovery completion integration lease authority was lost: ${this.lossCause}`,
    );
  }
}

export class RecoveryCompletionAuthorizer {
  constructor(
    private readonly leaseStore: IntegrationLeaseStore,
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 5_000) {
      throw new Error("recovery completion authorization TTL is out of bounds");
    }
  }

  issue(
    path: RecoveryCompletionPath,
    snapshot: RecoveryCompletionSnapshot,
    lease: IntegrationLease,
  ): RecoveryCompletionAuthorization {
    this.assertLease(lease);
    const issuedAt = this.now();
    const expiresAt = Math.min(issuedAt + this.ttlMs, lease.expiresAt);
    if (expiresAt <= issuedAt) throw new Error("recovery completion lease expired before authorization");
    const authorization: RecoveryCompletionAuthorization = Object.freeze({
      ...snapshot,
      authorizationId: randomUUID(),
      path,
      lease: Object.freeze({ ...lease }),
      issuedAt,
      expiresAt,
    });
    issuedAuthorizations.add(authorization);
    return authorization;
  }

  consume(
    authorization: RecoveryCompletionAuthorization,
    expectedPath: RecoveryCompletionPath,
    current: RecoveryCompletionSnapshot,
  ): void {
    if (authorization.path !== expectedPath) {
      throw new Error("recovery completion authorization path changed");
    }
    if (!issuedAuthorizations.has(authorization) || authorization.lease.pid !== process.pid) {
      throw new Error("recovery completion authorization was not issued to this process");
    }
    if (consumedAuthorizations.has(authorization)) {
      throw new Error("recovery completion authorization was already consumed");
    }
    const now = this.now();
    if (now >= authorization.expiresAt) {
      throw new Error("recovery completion authorization expired");
    }
    this.assertLease(authorization.lease);
    if (canonicalSnapshot(authorization) !== canonicalSnapshot(current)) {
      throw new Error("recovery completion authorization evidence changed");
    }
    consumedAuthorizations.add(authorization);
  }

  private assertLease(expected: IntegrationLease): void {
    const current = this.leaseStore.read(expected);
    const now = this.now();
    if (
      !sameLeaseOwner(current, expected) ||
      current.expiresAt < expected.expiresAt ||
      current.expiresAt <= now
    ) {
      throw new Error("recovery completion integration lease changed or expired");
    }
  }
}

function sameLease(current: IntegrationLease | null, expected: IntegrationLease): current is IntegrationLease {
  return sameLeaseOwner(current, expected) && current.expiresAt === expected.expiresAt;
}

function sameLeaseOwner(current: IntegrationLease | null, expected: IntegrationLease): current is IntegrationLease {
  return current !== null &&
    current.commonDirectory === expected.commonDirectory &&
    current.integrationRef === expected.integrationRef &&
    current.ownerToken === expected.ownerToken &&
    current.acquiredAt === expected.acquiredAt &&
    current.pid === expected.pid &&
    current.hostname === expected.hostname;
}

function boundedCause(error: unknown): string {
  try {
    const value = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    return value.slice(0, MAX_LEASE_DIAGNOSTIC_LENGTH);
  } catch {
    return "lease-store failure cause was not safely serializable";
  }
}

function canonicalSnapshot(value: RecoveryCompletionSnapshot): string {
  return JSON.stringify({
    taskId: value.taskId,
    streamVersion: value.streamVersion,
    lastEventType: value.lastEventType,
    commonDirectory: value.commonDirectory,
    integrationRef: value.integrationRef,
    integrationCommit: value.integrationCommit,
    worktreePath: value.worktreePath,
    worktreeRegistered: value.worktreeRegistered,
    worktreePathExists: value.worktreePathExists,
    ticketRefExists: value.ticketRefExists,
    ticketCommit: value.ticketCommit,
    worktreeDirty: value.worktreeDirty,
    worktreeDiffSha256: value.worktreeDiffSha256,
  });
}
