import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export const MAX_INTEGRATION_LEASE_MS = 60_000;

export interface IntegrationLeaseKey {
  readonly commonDirectory: string;
  readonly integrationRef: string;
}

export interface IntegrationLease extends IntegrationLeaseKey {
  readonly ownerToken: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly pid: number;
  readonly hostname: string;
}

interface LeaseRow {
  readonly common_directory: string;
  readonly integration_ref: string;
  readonly owner_token: string;
  readonly acquired_at: number;
  readonly expires_at: number;
  readonly pid: number;
  readonly hostname: string;
}

export class IntegrationLeaseStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath, { timeout: 1_000 });
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS integration_leases (
          common_directory TEXT NOT NULL,
          integration_ref TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          pid INTEGER NOT NULL,
          hostname TEXT NOT NULL,
          PRIMARY KEY (common_directory, integration_ref)
        ) WITHOUT ROWID;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  acquire(
    key: IntegrationLeaseKey,
    durationMs: number,
    now = Date.now(),
  ): IntegrationLease | null {
    assertKey(key);
    assertDuration(durationMs);
    const lease: IntegrationLease = {
      ...key,
      ownerToken: randomUUID(),
      acquiredAt: now,
      expiresAt: now + durationMs,
      pid: process.pid,
      hostname: hostname(),
    };
    const result = this.db.prepare(`
      INSERT INTO integration_leases (
        common_directory, integration_ref, owner_token, acquired_at,
        expires_at, pid, hostname
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (common_directory, integration_ref) DO UPDATE SET
        owner_token = excluded.owner_token,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        pid = excluded.pid,
        hostname = excluded.hostname
      WHERE integration_leases.expires_at <= ?
    `).run(
      lease.commonDirectory,
      lease.integrationRef,
      lease.ownerToken,
      lease.acquiredAt,
      lease.expiresAt,
      lease.pid,
      lease.hostname,
      now,
    );
    return result.changes === 1 ? lease : null;
  }

  renew(
    lease: IntegrationLease,
    durationMs: number,
    now = Date.now(),
  ): IntegrationLease | null {
    assertKey(lease);
    assertDuration(durationMs);
    const expiresAt = now + durationMs;
    const result = this.db.prepare(`
      UPDATE integration_leases
      SET expires_at = ?
      WHERE common_directory = ? AND integration_ref = ?
        AND owner_token = ? AND expires_at > ?
    `).run(
      expiresAt,
      lease.commonDirectory,
      lease.integrationRef,
      lease.ownerToken,
      now,
    );
    return result.changes === 1 ? { ...lease, expiresAt } : null;
  }

  release(lease: IntegrationLease): boolean {
    assertKey(lease);
    return this.db.prepare(`
      DELETE FROM integration_leases
      WHERE common_directory = ? AND integration_ref = ? AND owner_token = ?
    `).run(lease.commonDirectory, lease.integrationRef, lease.ownerToken).changes === 1;
  }

  read(key: IntegrationLeaseKey): IntegrationLease | null {
    assertKey(key);
    const row = this.db.prepare(`
      SELECT common_directory, integration_ref, owner_token, acquired_at,
        expires_at, pid, hostname
      FROM integration_leases
      WHERE common_directory = ? AND integration_ref = ?
    `).get(key.commonDirectory, key.integrationRef) as LeaseRow | undefined;
    return row === undefined ? null : {
      commonDirectory: row.common_directory,
      integrationRef: row.integration_ref,
      ownerToken: row.owner_token,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      pid: row.pid,
      hostname: row.hostname,
    };
  }

  close(): void {
    this.db.close();
  }
}

function assertKey(key: IntegrationLeaseKey): void {
  if (!path.isAbsolute(key.commonDirectory) || !key.integrationRef.startsWith("refs/")) {
    throw new Error("integration lease key must contain an absolute common directory and full ref");
  }
}

function assertDuration(durationMs: number): void {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_INTEGRATION_LEASE_MS
  ) {
    throw new Error("integration lease duration is out of bounds");
  }
}
