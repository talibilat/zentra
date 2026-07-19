import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import {
  JournalRetentionService,
  openAuthoritativeJournal,
} from "../../src/journal/retention.js";
import { ProjectingEventJournal, type StoredEventSink } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(count = 24) {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-retention-"));
  directories.push(directory);
  const databasePath = path.join(directory, "journal.sqlite");
  const journal = new SqliteEventJournal(databasePath);
  const versions = new Map<string, number>();
  for (let position = 1; position <= count; position += 1) {
    const streamId = `stream-${position % 3}`;
    const version = versions.get(streamId) ?? 0;
    journal.append(streamId, version, [{
      streamId,
      type: "test.event",
      payload: { position },
      causationId: null,
      correlationId: "retention-test",
    }]);
    versions.set(streamId, version + 1);
  }
  journal.close();
  return { directory, databasePath };
}

describe("JournalRetentionService", () => {
  it("opens a pristine authoritative journal read-only without creating archive state", () => {
    const { databasePath } = fixture();
    const archiveRoot = `${realpathPath(databasePath)}.archives`;
    expect(existsSync(archiveRoot)).toBe(false);
    const journal = openAuthoritativeJournal(realpathPath(databasePath), "read-only");
    expect(journal.readAllPage().events).toHaveLength(24);
    journal.close();
    expect(existsSync(archiveRoot)).toBe(false);
  });

  it("rejects every projection mutation through a read-only authoritative journal", () => {
    const { databasePath } = fixture();
    const writable = openAuthoritativeJournal(realpathPath(databasePath), "read-write");
    writable.ensureProjectionCursor("existing", 0);
    writable.close();

    const journal = openAuthoritativeJournal(realpathPath(databasePath), "read-only");
    const claimant = "process:1:00000000-0000-4000-8000-000000000001";
    expect(() => journal.ensureProjectionCursor("new", 0)).toThrow(/read-only/i);
    expect(() => journal.claimProjection("existing", claimant)).toThrow(/read-only/i);
    expect(() => journal.recoverProjectionClaim("existing", "claim", claimant)).toThrow(/read-only/i);
    expect(() => journal.commitProjection("existing", "claim", claimant)).toThrow(/read-only/i);
    journal.close();

    const inspect = SqliteEventJournal.openReadOnly(databasePath);
    expect(inspect.inspectProjectionCursor("new")).toBeNull();
    inspect.close();
  });

  it("retains forever by default and never deletes during archive or maintenance", async () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);

    expect(retention.policy()).toEqual({ mode: "retain_forever", automaticDeletion: false });
    const archived = retention.archive({ throughPosition: 12, maxEvents: 12 });
    expect(archived).toMatchObject({ fromPosition: 1, throughPosition: 12, eventCount: 12 });
    expect(retention.verify()).toMatchObject({ verified: true, throughPosition: 12 });
    await retention.maintain({ checkpoint: true });

    const active = SqliteEventJournal.openReadOnly(databasePath);
    expect(active.readAllPage(0, { maxEvents: 100, maxBytes: 1024 * 1024 }).events.length)
      .toBeGreaterThanOrEqual(27);
    active.close();
    expect(statSync(retention.archiveRoot).mode & 0o777).toBe(0o700);
    expect(statSync(archived.segmentPath).mode & 0o777).toBe(0o400);
    expect(statSync(archived.manifestPath).mode & 0o777).toBe(0o400);
  });

  it("requires a verified archive, cursor safety, an audited request, and exact confirmation", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 12, maxEvents: 12 });
    const cursorJournal = new SqliteEventJournal(databasePath);
    cursorJournal.ensureProjectionCursor("blocked", 4);
    cursorJournal.close();

    const request = retention.requestPrune({ throughPosition: 12, operatorId: "operator-1" });
    expect(() => retention.prune({ ...request, operatorId: "operator-1", confirmation: "yes" }))
      .toThrow(/confirmation/i);
    expect(() => retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation }))
      .toThrow(/cursor.*blocked/i);

    const advance = new SqliteEventJournal(databasePath);
    let claim = advance.claimProjection("blocked", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 100, maxBytes: 1024 * 1024 });
    while (claim !== null) {
      advance.commitProjection("blocked", claim.claimId, claim.claimantId);
      claim = advance.claimProjection("blocked", "process:1:00000000-0000-4000-8000-000000000001", { maxEvents: 100, maxBytes: 1024 * 1024 });
    }
    advance.close();

    const result = retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    expect(result).toMatchObject({ throughPosition: 12, deletedEvents: 12 });
    const combined = retention.openCombinedJournal("read-write");
    const replay = combined.readAllPage(0, { maxEvents: 100, maxBytes: 1024 * 1024 }).events;
    expect(replay.map((event) => event.globalPosition)).toEqual(
      Array.from({ length: replay.length }, (_, index) => index + 1),
    );
    expect(new Set(replay.slice(0, 12).map((event) => event.eventId)).size).toBe(12);
    expect(replay.some((event) => event.type === "journal.prune.completed")).toBe(true);
    expect(combined.readStream("stream-1").map((event) => (event.payload as { position: number }).position))
      .toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
    const atomic = combined.appendAtomically([
      {
        streamId: "stream-1", expectedVersion: 8,
        events: [{ streamId: "stream-1", type: "after.archive", payload: { position: 25 }, causationId: null, correlationId: "retention-test" }],
      },
      {
        streamId: "stream-2", expectedVersion: 8,
        events: [{ streamId: "stream-2", type: "after.archive", payload: { position: 26 }, causationId: null, correlationId: "retention-test" }],
      },
    ]);
    expect(atomic).toHaveLength(2);
    expect(combined.readStream("stream-1").at(-1)).toMatchObject({ streamVersion: 9, type: "after.archive" });
    combined.close();
  });

  it("detects archive tampering and manifest gaps before replay, prune, or restore", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    const first = retention.archive({ throughPosition: 8, maxEvents: 8 });
    retention.archive({ throughPosition: 16, maxEvents: 8 });
    chmodSync(first.segmentPath, 0o600);
    writeFileSync(first.segmentPath, `${readFileSync(first.segmentPath, "utf8")} `, "utf8");
    chmodSync(first.segmentPath, 0o400);

    expect(() => retention.verify()).toThrow(/checksum|tamper/i);
    expect(() => retention.openCombinedJournal()).toThrow(/checksum|tamper/i);
    expect(() => retention.restore({ name: "restored.sqlite" })).toThrow(/checksum|tamper/i);
  });

  it("rejects permissive archive roots and owner-writable archive files on reopen", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 8, maxEvents: 8 });
    chmodSync(retention.archiveRoot, 0o755);
    expect(() => JournalRetentionService.openReadOnly(databasePath)).toThrow(/permission|private/i);

    chmodSync(retention.archiveRoot, 0o700);
    const manifest = readdirSync(retention.archiveRoot).find((name) => name.endsWith(".manifest.json"))!;
    chmodSync(path.join(retention.archiveRoot, manifest), 0o600);
    expect(() => JournalRetentionService.openReadOnly(databasePath).verify())
      .toThrow(/permission|mode|permissive/i);
  });

  it("detects a missing manifest as an archive gap instead of silently shortening history", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 8, maxEvents: 8 });
    const second = retention.archive({ throughPosition: 16, maxEvents: 8 });
    unlinkSync(second.manifestPath);

    expect(() => retention.verify()).toThrow(/orphan|gap/i);
    expect(() => retention.openCombinedJournal()).toThrow(/orphan|gap/i);
  });

  it("requires the filesystem chain to match the SQLite anchor even when every archive file is missing", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    const archived = retention.archive({ throughPosition: 8, maxEvents: 8 });
    unlinkSync(archived.segmentPath);
    unlinkSync(archived.manifestPath);

    expect(() => retention.verify()).toThrow(/anchor|missing|truncated/i);
  });

  it("binds manifests to one journal and rejects a replacement archive", () => {
    const first = fixture();
    const second = fixture();
    const source = new JournalRetentionService(first.databasePath);
    const archived = source.archive({ throughPosition: 8, maxEvents: 8 });
    const target = new JournalRetentionService(second.databasePath);
    const targetSegment = path.join(target.archiveRoot, path.basename(archived.segmentPath));
    const targetManifest = path.join(target.archiveRoot, path.basename(archived.manifestPath));
    writeFileSync(targetSegment, readFileSync(archived.segmentPath), { mode: 0o400 });
    writeFileSync(targetManifest, readFileSync(archived.manifestPath), { mode: 0o400 });

    expect(() => target.verify()).toThrow(/journal identity|anchor|unexpected/i);
  });

  it("rejects database/archive hard links and archive-directory identity replacement", () => {
    const first = fixture();
    linkSync(first.databasePath, path.join(first.directory, "journal-hardlink.sqlite"));
    expect(() => new JournalRetentionService(first.databasePath)).toThrow(/without links|private/i);

    const second = fixture();
    const retention = new JournalRetentionService(second.databasePath);
    const archived = retention.archive({ throughPosition: 8, maxEvents: 8 });
    linkSync(archived.segmentPath, path.join(second.directory, "segment-hardlink"));
    expect(() => retention.verify()).toThrow(/linked/i);
    unlinkSync(path.join(second.directory, "segment-hardlink"));

    const displaced = `${retention.archiveRoot}.displaced`;
    renameSync(retention.archiveRoot, displaced);
    mkdirSync(retention.archiveRoot, { mode: 0o700 });
    expect(() => retention.verify()).toThrow(/archive directory identity changed/i);

    const third = fixture();
    const marker = path.join(third.directory, "marker");
    writeFileSync(marker, "marker", "utf8");
    symlinkSync(marker, `${third.databasePath}-wal`);
    expect(() => new JournalRetentionService(third.databasePath)).toThrow(/sidecar identity is unsafe/i);
  });

  it("exports and restores active plus archived history with stable identities", () => {
    const { directory, databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 12, maxEvents: 12 });
    const request = retention.requestPrune({ throughPosition: 12, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });

    const exported = retention.export({ name: "journal-export.jsonl" });
    expect(exported.eventCount).toBeGreaterThan(24);
    expect(statSync(exported.path).mode & 0o777).toBe(0o400);
    const restored = retention.restore({ name: "restored.sqlite" });
    expect(path.dirname(restored.path)).toBe(path.dirname(retention.databasePath));
    expect(restored).toMatchObject({
      eventCount: exported.eventCount,
      throughPosition: exported.throughPosition,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const journal = SqliteEventJournal.openReadOnly(restored.path);
    const events = journal.readAllPage(0, { maxEvents: 100, maxBytes: 1024 * 1024 }).events;
    expect(events).toHaveLength(exported.eventCount);
    const exportedFirst = JSON.parse(readFileSync(exported.path, "utf8").split("\n")[0]!) as {
      readonly eventId: string;
    };
    expect(events[0]).toMatchObject({ globalPosition: 1, eventId: exportedFirst.eventId });
    journal.close();
    const source = SqliteEventJournal.openReadOnly(databasePath);
    expect(source.readStream("journal:retention").map((event) => event.type))
      .toEqual(expect.arrayContaining(["journal.restore.started", "journal.restore.completed"]));
    source.close();
  });

  it("rejects path escapes and records an interrupted prune as uncertain without retrying it", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 8, maxEvents: 8 });
    expect(() => retention.export({ name: "../escape.jsonl" })).toThrow(/safe file name/i);
    expect(() => retention.restore({ name: "/tmp/escape.sqlite" })).toThrow(/safe file name/i);
    expect(() => retention.export({ name: "journal.sqlite-wal" })).toThrow(/reserved/i);
    expect(() => retention.restore({ name: "journal.sqlite-shm" })).toThrow(/reserved/i);
    expect(() => retention.export({ name: "journal.sqlite.archives" })).toThrow(/reserved/i);
    expect(() => retention.export({ name: "JOURNAL.SQLITE-WAL" })).toThrow(/reserved/i);
    expect(() => retention.restore({ name: "journal.sqlite-journal" })).toThrow(/reserved/i);

    const request = retention.requestPrune({ throughPosition: 8, operatorId: "operator-1" });
    expect(() => retention.prune({
      ...request,
      operatorId: "operator-1",
      confirmation: request.confirmation,
      crashPoint: "after_authorization",
    })).toThrow(/simulated crash/i);
    expect(retention.recover()).toMatchObject({ outcome: "uncertain", requestId: request.requestId });
    expect(() => retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation }))
      .toThrow(/uncertain.*must not be retried/i);
  });

  it("rejects a future prune boundary before writing its request audit event", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    expect(() => retention.requestPrune({ throughPosition: 25, operatorId: "operator-1" }))
      .toThrow(/ahead of.*head/i);
    const journal = SqliteEventJournal.openReadOnly(databasePath);
    expect(journal.readStream("journal:retention")).toEqual([]);
    journal.close();
  });

  it("reconciles archive publication and prune deletion crash states read-only", () => {
    const first = fixture();
    const archive = new JournalRetentionService(first.databasePath);
    expect(() => archive.archive({
      throughPosition: 8,
      maxEvents: 8,
      crashPoint: "after_manifest",
    })).toThrow(/simulated crash/i);
    expect(archive.recover()).toMatchObject({
      outcome: "uncertain",
      kind: "archive",
      state: "fully_published_missing_completion",
    });
    expect(archive.verify()).toMatchObject({ throughPosition: 0, segmentCount: 0 });
    expect(() => archive.archive({ throughPosition: 8, maxEvents: 8 })).toThrow(/operation.*active/i);

    const segmentOnlyFixture = fixture();
    const segmentOnly = new JournalRetentionService(segmentOnlyFixture.databasePath);
    expect(() => segmentOnly.archive({
      throughPosition: 8,
      maxEvents: 8,
      crashPoint: "after_segment",
    })).toThrow(/simulated crash/i);
    expect(segmentOnly.recover()).toMatchObject({
      outcome: "uncertain",
      kind: "archive",
      state: "segment_only_orphan",
    });

    const second = fixture();
    const prune = new JournalRetentionService(second.databasePath);
    prune.archive({ throughPosition: 8, maxEvents: 8 });
    const request = prune.requestPrune({ throughPosition: 8, operatorId: "operator-1" });
    expect(() => prune.prune({
      ...request,
      operatorId: "operator-1",
      confirmation: request.confirmation,
      crashPoint: "after_delete",
    })).toThrow(/simulated crash/i);
    expect(prune.recover()).toMatchObject({
      outcome: "uncertain",
      requestId: request.requestId,
      kind: "prune",
      state: "effect_applied_missing_completion",
    });
  });

  it("settles proven incomplete archive and prune operations only with exact operator reconciliation", () => {
    const archiveFixture = fixture();
    const archive = new JournalRetentionService(archiveFixture.databasePath);
    expect(() => archive.archive({ throughPosition: 8, maxEvents: 8, crashPoint: "after_manifest" }))
      .toThrow(/simulated crash/i);
    const archiveInspection = archive.inspectRecovery();
    expect(() => archive.reconcile({ operationId: archiveInspection.operationId!, confirmation: "yes" }))
      .toThrow(/confirmation/i);
    const archiveConfirmation = `RECONCILE OPERATION ${archiveInspection.operationId} STATE ${archiveInspection.state}`;
    expect(archive.reconcile({
      operationId: archiveInspection.operationId!,
      confirmation: archiveConfirmation,
    })).toMatchObject({ outcome: "completed", state: "recovered_archive_completion", repeated: false });
    expect(archive.verify()).toMatchObject({ throughPosition: 8, segmentCount: 1 });
    expect(archive.reconcile({
      operationId: archiveInspection.operationId!,
      confirmation: archiveConfirmation,
    })).toMatchObject({ outcome: "completed", repeated: true });

    const pruneFixture = fixture();
    const prune = new JournalRetentionService(pruneFixture.databasePath);
    prune.archive({ throughPosition: 8, maxEvents: 8 });
    const request = prune.requestPrune({ throughPosition: 8, operatorId: "operator-1" });
    expect(() => prune.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation,
      crashPoint: "after_delete" })).toThrow(/simulated crash/i);
    const pruneInspection = prune.inspectRecovery();
    const pruneConfirmation = `RECONCILE OPERATION ${pruneInspection.operationId} STATE ${pruneInspection.state}`;
    expect(prune.reconcile({ operationId: pruneInspection.operationId!, confirmation: pruneConfirmation }))
      .toMatchObject({ outcome: "completed", state: "recovered_prune_completion" });
    expect(prune.reconcile({ operationId: pruneInspection.operationId!, confirmation: pruneConfirmation }))
      .toMatchObject({ outcome: "completed", repeated: true });
  });

  it("reconciles a restore published before completion without repeating the effect", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    expect(() => retention.restore({ name: "recovered.sqlite", crashPoint: "after_publish" }))
      .toThrow(/simulated crash/i);
    const inspection = retention.inspectRecovery();
    expect(inspection).toMatchObject({
      outcome: "uncertain",
      kind: "restore",
      state: "restore_published_missing_completion",
    });
    const result = retention.reconcile({
      operationId: inspection.operationId!,
      confirmation: inspection.confirmation!,
    });
    expect(result).toMatchObject({ outcome: "completed", state: "recovered_restore_completion" });
    expect(retention.inspectRecovery()).toMatchObject({ outcome: "clean" });
    const restored = SqliteEventJournal.openReadOnly(path.join(path.dirname(databasePath), "recovered.sqlite"));
    expect(restored.readAllPage().events).toHaveLength(24);
    restored.close();
  });

  it("cancels proven no-effect prune authorization and explicitly cleans segment-only publication", () => {
    const pruneFixture = fixture();
    const prune = new JournalRetentionService(pruneFixture.databasePath);
    prune.archive({ throughPosition: 8, maxEvents: 8 });
    const request = prune.requestPrune({ throughPosition: 8, operatorId: "operator-1" });
    expect(() => prune.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation,
      crashPoint: "after_authorization" })).toThrow(/simulated crash/i);
    const pruneInspection = prune.inspectRecovery();
    expect(prune.reconcile({
      operationId: pruneInspection.operationId!,
      confirmation: `RECONCILE OPERATION ${pruneInspection.operationId} STATE ${pruneInspection.state}`,
    })).toMatchObject({ outcome: "failed", state: "authorization_cancelled_no_effect" });

    const archiveFixture = fixture();
    const archive = new JournalRetentionService(archiveFixture.databasePath);
    expect(() => archive.archive({ throughPosition: 8, maxEvents: 8, crashPoint: "after_segment" }))
      .toThrow(/simulated crash/i);
    const archiveInspection = archive.inspectRecovery();
    const safeReader = openAuthoritativeJournal(archiveFixture.databasePath, "read-only");
    expect(safeReader.readAllPage(0, { maxEvents: 2, maxBytes: 1024 * 1024 }).events)
      .toHaveLength(2);
    safeReader.close();
    const confirmation = `RECONCILE OPERATION ${archiveInspection.operationId} STATE ${archiveInspection.state}`;
    expect(archive.reconcile({ operationId: archiveInspection.operationId!, confirmation }))
      .toMatchObject({ outcome: "failed", state: "operator_cleanup_completed" });
    expect(readdirSync(archive.archiveRoot).filter((name) => name.endsWith(".events.jsonl"))).toEqual([]);
    expect(archive.verify()).toMatchObject({ throughPosition: 0, segmentCount: 0 });
  });

  it("consumes each prune request exactly once", () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 8, maxEvents: 8 });
    const request = retention.requestPrune({ throughPosition: 8, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    expect(() => retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation }))
      .toThrow(/already been consumed/i);
  });

  it("publishes restrictive mode before visibility and cleans injected link-boundary failures", () => {
    for (const crashPoint of ["segment_chmod", "segment_before_link", "segment_after_link"] as const) {
      const { databasePath } = fixture();
      const retention = new JournalRetentionService(databasePath);
      expect(() => retention.archive({ throughPosition: 8, maxEvents: 8, crashPoint }))
        .toThrow(/injected publication failure/i);
      expect(readdirSync(retention.archiveRoot).filter((name) => name.endsWith(".events.jsonl") ||
        name.includes(".tmp-"))).toEqual([]);
      expect(retention.inspectRecovery()).toMatchObject({ outcome: "clean" });
    }

    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    expect(() => retention.archive({ throughPosition: 8, maxEvents: 8, crashPoint: "manifest_after_link" }))
      .toThrow(/injected publication failure/i);
    const visible = readdirSync(retention.archiveRoot).filter((name) => !name.includes(".tmp-"));
    expect(visible).toHaveLength(1);
    expect(statSync(path.join(retention.archiveRoot, visible[0]!)).mode & 0o777).toBe(0o400);
    expect(retention.inspectRecovery()).toMatchObject({ state: "segment_only_orphan" });
  });

  it("archives and prunes a large journal while readers and writers continue safely", () => {
    const { databasePath } = fixture(2_000);
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 1_000, maxEvents: 1_000 });
    const request = retention.requestPrune({ throughPosition: 1_000, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });

    const reader = retention.openCombinedJournal();
    const first = reader.readAllPage(0, { maxEvents: 127, maxBytes: 1024 * 1024 });
    const writer = new SqliteEventJournal(databasePath);
    const version = writer.readStream("live").length;
    const appended = writer.append("live", version, [{
      streamId: "live", type: "test.live", payload: {}, causationId: null,
      correlationId: "retention-test",
    }])[0]!;
    writer.close();

    let position = first.nextPosition;
    const observed = [...first.events];
    while (true) {
      const page = reader.readAllPage(position, { maxEvents: 127, maxBytes: 1024 * 1024 });
      observed.push(...page.events);
      if (!page.hasMore) break;
      position = page.nextPosition;
    }
    expect(observed.map((event) => event.globalPosition)).toEqual(
      Array.from({ length: observed.length }, (_, index) => index + 1),
    );
    expect(observed.at(-1)?.eventId).toBe(appended.eventId);
    reader.close();

    const active = new SqliteEventJournal(databasePath);
    expect(() => active.ensureProjectionCursor("too-old", 0)).toThrow(/below retained journal position/i);
    active.close();
  });

  it("uses the authoritative adapter for post-prune appends and bounded stream/global pages", () => {
    const { databasePath } = fixture(90);
    const retention = new JournalRetentionService(databasePath);
    for (const throughPosition of [10, 20, 30]) {
      retention.archive({ throughPosition, maxEvents: 10 });
    }
    const request = retention.requestPrune({ throughPosition: 30, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });

    const journal = openAuthoritativeJournal(databasePath, "read-write");
    const before = journal.readStream("stream-1");
    const stored = journal.append("stream-1", before.at(-1)!.streamVersion, [{
      streamId: "stream-1",
      type: "test.after_prune",
      payload: {},
      causationId: null,
      correlationId: "retention-test",
    }]);
    expect(stored[0]?.streamVersion).toBe(before.length + 1);
    expect(journal.readStreamPage("stream-1", 0, { maxEvents: 2, maxBytes: 1024 }).events)
      .toHaveLength(2);
    expect(journal.readAllPage(0, { maxEvents: 3, maxBytes: 2048 })).toMatchObject({
      events: [
        expect.objectContaining({ globalPosition: 1 }),
        expect.objectContaining({ globalPosition: 2 }),
        expect.objectContaining({ globalPosition: 3 }),
      ],
      hasMore: true,
    });
    expect(journal.readStream("stream-1").at(-1)?.eventId).toBe(stored[0]?.eventId);
    journal.close();
  });

  it("reports combined hasMore when an archive exactly fills row and byte limits", () => {
    const { databasePath } = fixture(12);
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 6, maxEvents: 6 });
    const request = retention.requestPrune({ throughPosition: 6, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    const journal = openAuthoritativeJournal(databasePath, "read-only");

    const rows = journal.readAllPage(0, { maxEvents: 6, maxBytes: 1024 * 1024 });
    expect(rows.events).toHaveLength(6);
    expect(rows.nextPosition).toBe(6);
    expect(rows.hasMore).toBe(true);
    const one = journal.readAllPage(0, { maxEvents: 1, maxBytes: 1024 * 1024 });
    const bytes = journal.readAllPage(0, { maxEvents: 100, maxBytes: one.bytes });
    expect(bytes.events).toHaveLength(1);
    expect(bytes.hasMore).toBe(true);

    const streamRows = journal.readStreamPage("stream-1", 0, {
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    });
    expect(streamRows.events).toHaveLength(2);
    expect(streamRows.hasMore).toBe(true);
    const streamOne = journal.readStreamPage("stream-1", 0, {
      maxEvents: 1,
      maxBytes: 1024 * 1024,
    });
    expect(journal.readStreamPage("stream-1", 0, {
      maxEvents: 100,
      maxBytes: streamOne.bytes,
    })).toMatchObject({ events: [expect.any(Object)], hasMore: true });
    journal.close();
  });

  it("verifies complete segments even when a global or sparse-stream page fills early", () => {
    const { databasePath } = fixture(12);
    const retention = new JournalRetentionService(databasePath);
    const archived = retention.archive({ throughPosition: 12, maxEvents: 12 });
    const journal = openAuthoritativeJournal(databasePath, "read-only");
    chmodSync(archived.segmentPath, 0o600);
    writeFileSync(archived.segmentPath, `${readFileSync(archived.segmentPath, "utf8")}corrupt`, "utf8");
    chmodSync(archived.segmentPath, 0o400);

    expect(() => journal.readAllPage(0, { maxEvents: 1, maxBytes: 1024 * 1024 }))
      .toThrow(/checksum|canonical|tampered|incomplete/i);
    expect(() => journal.readStreamPage("stream-1", 0, { maxEvents: 1, maxBytes: 1024 * 1024 }))
      .toThrow(/checksum|canonical|tampered|incomplete/i);
    journal.close();
  });

  it("claims combined history from zero after prune and replays an uncommitted claim", () => {
    const { databasePath } = fixture(18);
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 9, maxEvents: 9 });
    const request = retention.requestPrune({ throughPosition: 9, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    const claimant = `process:${process.pid}:00000000-0000-4000-8000-000000000001`;

    const first = openAuthoritativeJournal(databasePath, "read-write");
    expect(first.ensureProjectionCursor("combined-zero", 0)).toMatchObject({ position: 0 });
    const claim = first.claimProjection("combined-zero", claimant, {
      maxEvents: 4,
      maxBytes: 1024 * 1024,
    })!;
    expect(claim.events.map((event) => event.globalPosition)).toEqual([1, 2, 3, 4]);
    first.close();

    const reopened = openAuthoritativeJournal(databasePath, "read-write");
    expect(() => reopened.claimProjection(
      "combined-zero",
      "process:2:00000000-0000-4000-8000-000000000002",
    )).toThrow(/owned by another claimant/i);
    const replay = reopened.claimProjection("combined-zero", claimant, {
      maxEvents: 100,
      maxBytes: 1024 * 1024,
    })!;
    expect(replay).toMatchObject({ claimId: claim.claimId, replayed: true, replayCount: 1 });
    expect(replay.events.map((event) => event.eventId)).toEqual(claim.events.map((event) => event.eventId));
    reopened.commitProjection("combined-zero", claim.claimId, claimant);
    let positions: number[] = [];
    while (true) {
      const next = reopened.claimProjection("combined-zero", claimant, {
        maxEvents: 5,
        maxBytes: 1024 * 1024,
      });
      if (next === null) break;
      positions = positions.concat(next.events.map((event) => event.globalPosition));
      reopened.commitProjection("combined-zero", next.claimId, claimant);
    }
    expect(positions[0]).toBe(5);
    expect(positions.at(-1)).toBe(reopened.inspectProjectionCursor("combined-zero")?.highWaterPosition);
    reopened.close();
  });

  it("recovers a dead combined claimant and rejects corrupted claim evidence", () => {
    const { databasePath } = fixture(12);
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 6, maxEvents: 6 });
    const request = retention.requestPrune({ throughPosition: 6, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    const journal = openAuthoritativeJournal(databasePath, "read-write");
    const dead = "process:99999999:00000000-0000-4000-8000-000000000001";
    const claim = journal.claimProjection("combined-recovery", dead, {
      maxEvents: 3,
      maxBytes: 1024 * 1024,
    })!;
    const recovered = journal.recoverProjectionClaim(
      "combined-recovery",
      claim.claimId,
      `process:${process.pid}:00000000-0000-4000-8000-000000000003`,
    );
    expect(recovered.events.map((event) => event.eventId)).toEqual(claim.events.map((event) => event.eventId));
    journal.close();

    const raw = new Database(databasePath);
    raw.prepare("UPDATE projection_cursors SET claim_digest = ? WHERE name = ?")
      .run("0".repeat(64), "combined-recovery");
    raw.close();
    const corrupt = openAuthoritativeJournal(databasePath, "read-write");
    expect(() => corrupt.inspectProjectionClaim("combined-recovery")).toThrow(/digest.*corrupt/i);
    corrupt.close();
  });

  it("rebuilds a new Agent Trail-style projection from zero across archive and active history", () => {
    const { databasePath } = fixture(15);
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 6, maxEvents: 6 });
    const request = retention.requestPrune({ throughPosition: 6, operatorId: "operator-1" });
    retention.prune({ ...request, operatorId: "operator-1", confirmation: request.confirmation });
    const inner = openAuthoritativeJournal(databasePath, "read-write");
    const delivered: number[] = [];
    const cursorName = "agent-trail:post-prune-rebuild";
    const sink: StoredEventSink = {
      projectionCursorName: cursorName,
      append: (events) => { delivered.push(...events.map((event) => event.globalPosition)); },
    };
    const projecting = new ProjectingEventJournal(
      inner,
      sink,
      cursorName,
      0,
      `process:${process.pid}:00000000-0000-4000-8000-000000000002`,
    );
    expect(projecting.projectionFailed).toBe(false);
    expect(delivered).toEqual(Array.from({ length: inner.inspectProjectionCursor(
      cursorName,
    )!.highWaterPosition }, (_, index) => index + 1));
    expect(inner.inspectProjectionCursor(cursorName)?.lag).toBe(0);
    inner.close();
  });

  it("does not expose export or restore artifacts when a verified source fails mid-operation", () => {
    const { directory, databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    retention.archive({ throughPosition: 8, maxEvents: 8 });

    expect(() => retention.export({ name: "failed-export.jsonl", failurePoint: "after_write" }))
      .toThrow(/injected export failure/i);
    expect(() => retention.restore({ name: "failed-restore.sqlite", failurePoint: "after_write" }))
      .toThrow(/injected restore failure/i);
    expect(existsSync(path.join(directory, "failed-export.jsonl"))).toBe(false);
    expect(existsSync(path.join(directory, "failed-restore.sqlite"))).toBe(false);
    expect(readdirSync(directory).filter((name) => name.includes("failed-") || name.includes(".tmp-")))
      .toEqual([]);
  });

  it("reports exact WAL checkpoint frames and makes vacuum explicitly opt-in", async () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    const report = await retention.maintain({ checkpoint: true });
    expect(report.checkpoint).toEqual({
      busy: expect.any(Number),
      logFrames: expect.any(Number),
      checkpointedFrames: expect.any(Number),
    });
    expect(report.checkpointed).toBe(
      report.checkpoint!.busy === 0 &&
      report.checkpoint!.checkpointedFrames === report.checkpoint!.logFrames,
    );
    expect(report.vacuum).toMatchObject({ status: "not_requested", requestedPages: 0 });
    expect(report).toMatchObject({
      backupSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      backupBytes: expect.any(Number),
    });
    expect(statSync(report.backupPath).mode & 0o777).toBe(0o400);
    const journal = openAuthoritativeJournal(databasePath, "read-only");
    const completed = journal.readStream("journal:retention").findLast((event) =>
      event.type === "journal.maintenance.completed");
    expect(completed?.payload).toMatchObject({
      backupPath: report.backupPath,
      backupSha256: report.backupSha256,
      backupBytes: report.backupBytes,
      checkpointed: report.checkpointed,
    });
    journal.close();
  });

  it("reports an incomplete passive checkpoint accurately with a concurrent WAL reader and writer", async () => {
    const { databasePath } = fixture();
    const reader = new Database(databasePath);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM events").get();
    const writer = new SqliteEventJournal(databasePath);
    writer.append("wal-writer", 0, [{
      streamId: "wal-writer",
      type: "test.wal",
      payload: {},
      causationId: null,
      correlationId: "wal",
    }]);
    writer.close();

    const report = await new JournalRetentionService(databasePath).maintain({
      checkpoint: true,
    });
    reader.exec("ROLLBACK");
    reader.close();
    expect(report.checkpoint).not.toBeNull();
    expect(report.checkpointed).toBe(
      report.checkpoint!.busy === 0 &&
      report.checkpoint!.checkpointedFrames === report.checkpoint!.logFrames,
    );
    if (report.checkpoint!.checkpointedFrames < report.checkpoint!.logFrames || report.checkpoint!.busy > 0) {
      expect(report.checkpointed).toBe(false);
    }
  });

  it("reconciles a proven published maintenance backup without rerunning maintenance", async () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    await expect(retention.maintain({ checkpoint: true, crashPoint: "after_backup_publish" }))
      .rejects.toThrow(/injected maintenance crash/i);
    const inspection = retention.inspectRecovery();
    expect(inspection).toMatchObject({
      outcome: "uncertain",
      kind: "maintenance",
      state: "maintenance_backup_published",
      confirmation: expect.any(String),
    });
    const reconciled = retention.reconcile({
      operationId: inspection.operationId!,
      confirmation: inspection.confirmation!,
    });
    expect(reconciled).toMatchObject({ outcome: "completed", state: "recovered_maintenance_completion" });
    expect(retention.reconcile({
      operationId: inspection.operationId!,
      confirmation: inspection.confirmation!,
    })).toMatchObject({ outcome: "completed", repeated: true });
    expect(() => retention.archive({ throughPosition: 4, maxEvents: 4 })).not.toThrow();
  });

  it("cleans only exact private maintenance temp residue during explicit reconciliation", async () => {
    const { databasePath } = fixture();
    const retention = new JournalRetentionService(databasePath);
    await expect(retention.maintain({ checkpoint: true, crashPoint: "after_backup_fsync" }))
      .rejects.toThrow(/injected maintenance crash/i);
    const inspection = retention.inspectRecovery();
    expect(inspection).toMatchObject({ state: "maintenance_temp_only", confirmation: expect.any(String) });
    const tempName = `backup-${inspection.operationId}.sqlite.tmp-${inspection.operationId}`;
    expect(readdirSync(retention.archiveRoot).filter((name) => name.includes(".tmp-"))).toEqual([tempName]);
    const tempPath = path.join(retention.archiveRoot, tempName);
    chmodSync(tempPath, 0o644);
    expect(() => retention.inspectRecovery()).toThrow(/permissive|unsafe/i);
    chmodSync(tempPath, 0o600);
    const unknown = path.join(retention.archiveRoot, "unknown.tmp-residue");
    writeFileSync(unknown, "unknown", { mode: 0o600 });
    expect(() => retention.inspectRecovery()).toThrow(/unknown retention temporary/i);
    unlinkSync(unknown);
    expect(retention.reconcile({
      operationId: inspection.operationId!,
      confirmation: inspection.confirmation!,
    })).toMatchObject({ outcome: "failed", state: "maintenance_temp_cleaned" });
    expect(readdirSync(retention.archiveRoot).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("uses bounded incremental vacuum only when supported and honors cancellation", async () => {
    const { databasePath } = fixture();
    const unsupported = await new JournalRetentionService(databasePath).maintain({
      checkpoint: true,
      vacuumPages: 16,
      vacuumDeadlineMs: 1_000,
    });
    expect(unsupported.vacuum).toMatchObject({
      status: "not_supported",
      requestedPages: 16,
      beforeFreelist: expect.any(Number),
      afterFreelist: expect.any(Number),
    });

    const cancelledFixture = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(new JournalRetentionService(cancelledFixture.databasePath).maintain({
      checkpoint: true,
      vacuumPages: 1,
      signal: controller.signal,
    })).rejects.toThrow(/cancel/i);
    expect(new JournalRetentionService(cancelledFixture.databasePath).inspectRecovery().outcome).toBe("clean");

    const incrementalDirectory = mkdtempSync(path.join(tmpdir(), "zentra-incremental-vacuum-"));
    directories.push(incrementalDirectory);
    const incrementalPath = path.join(incrementalDirectory, "journal.sqlite");
    const raw = new Database(incrementalPath);
    raw.pragma("auto_vacuum = INCREMENTAL");
    raw.exec("VACUUM");
    raw.close();
    const incrementalJournal = new SqliteEventJournal(incrementalPath);
    incrementalJournal.append("event", 0, [{
      streamId: "event", type: "test.event", payload: {}, causationId: null, correlationId: "vacuum",
    }]);
    incrementalJournal.close();
    const clock = vi.spyOn(process.hrtime, "bigint");
    clock.mockReturnValueOnce(0n).mockReturnValue(2_000_000n);
    await expect(new JournalRetentionService(realpathSync.native(incrementalPath)).maintain({
      checkpoint: true,
      vacuumPages: 1,
      vacuumDeadlineMs: 1,
    })).rejects.toThrow(/timed out/i);
    expect(new JournalRetentionService(realpathSync.native(incrementalPath)).inspectRecovery().outcome).toBe("clean");
  });

  it("classifies and reconciles a real child killed after archive temp fsync", () => {
    const { databasePath } = fixture();
    const prepared = new JournalRetentionService(databasePath);
    const archiveOperationId = "00000000-0000-4000-8000-000000000091";
    const segmentId = "0000000000000001-0000000000000008";
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { closeSync, chmodSync, fsyncSync, openSync, writeSync } from "node:fs";
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(databasePath)});
      db.prepare(\`INSERT INTO retention_operations (
        operation_id, kind, state, from_position, through_position, segment_id, created_at
      ) VALUES (?, 'archive', 'publishing', 1, 8, ?, ?)\`).run(
        ${JSON.stringify(archiveOperationId)}, ${JSON.stringify(segmentId)}, new Date().toISOString()
      );
      db.close();
      const file = ${JSON.stringify(path.join(prepared.archiveRoot, `${segmentId}.events.jsonl.tmp-${archiveOperationId}`))};
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, "private-temp");
      chmodSync(file, 0o400);
      fsyncSync(fd);
      closeSync(fd);
      process.kill(process.pid, "SIGKILL");
    `], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 10_000 });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const retention = new JournalRetentionService(databasePath);
    const inspection = retention.inspectRecovery();
    expect(inspection).toMatchObject({ state: "archive_temp_only", confirmation: expect.any(String) });
    expect(retention.reconcile({ operationId: inspection.operationId!, confirmation: inspection.confirmation! }))
      .toMatchObject({ outcome: "failed", state: "operator_cleanup_completed" });
    expect(retention.verify()).toMatchObject({ throughPosition: 0 });

    const maintenanceFixture = fixture();
    const maintenancePrepared = new JournalRetentionService(maintenanceFixture.databasePath);
    const maintenanceOperationId = "00000000-0000-4000-8000-000000000092";
    const maintenanceChild = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
      import Database from "better-sqlite3";
      const db = new Database(${JSON.stringify(maintenanceFixture.databasePath)});
      db.prepare(\`INSERT INTO retention_operations (
        operation_id, kind, state, through_position, created_at
      ) VALUES (?, 'maintenance', 'publishing', 24, ?)\`).run(
        ${JSON.stringify(maintenanceOperationId)}, new Date().toISOString()
      );
      db.close();
      const file = ${JSON.stringify(path.join(maintenancePrepared.archiveRoot, `backup-${maintenanceOperationId}.sqlite.tmp-${maintenanceOperationId}`))};
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, "private-temp");
      fsyncSync(fd);
      closeSync(fd);
      process.kill(process.pid, "SIGKILL");
    `], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 10_000 });
    expect(maintenanceChild.signal, maintenanceChild.stderr).toBe("SIGKILL");
    const maintenance = new JournalRetentionService(maintenanceFixture.databasePath);
    const maintenanceInspection = maintenance.inspectRecovery();
    expect(maintenanceInspection).toMatchObject({ state: "maintenance_temp_only" });
    expect(maintenance.reconcile({
      operationId: maintenanceInspection.operationId!,
      confirmation: maintenanceInspection.confirmation!,
    })).toMatchObject({ outcome: "failed", state: "maintenance_temp_cleaned" });
  });
});

function realpathPath(candidate: string): string {
  return realpathSync.native(candidate);
}
