import { createHash } from "node:crypto";
import path from "node:path";

import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import {
  ProjectRevisionSchema,
  type IntakeClosureReference,
  type ProjectRevision,
} from "../runs/run-contracts.js";
import type { RunView } from "../runs/run-projection.js";
import type { RunService } from "../runs/run-service.js";
import {
  IntakeArtifactStore,
  prepareIntakeArtifactVerification,
  type IntakeArtifactVerificationCapability,
  type PreparedIntakeArtifact,
} from "./intake-artifact-store.js";
import {
  IntakeSnapshotClosedPayloadSchema,
  SourceDiscoveredPayloadSchema,
  SourceRejectedPayloadSchema,
  computeIntakeSnapshotSha256,
  type SourceDiscoveredPayload,
  type SourceRejectedPayload,
} from "./intake-contracts.js";
import {
  BoundedTicketIntake,
  IntakeError,
  resolveTicketIntakeLimits,
  type DiscoveredTicketSource,
  type RejectedTicketSource,
  type SourceIntakeEvent,
  type TicketIntakeLimits,
  type TicketIntakeSnapshot,
  type TicketIntakeSource,
} from "./ticket-intake.js";

export interface IntakeServiceRequest {
  readonly runId: string;
  readonly projectRevision: ProjectRevision;
  readonly source: TicketIntakeSource;
  readonly limits: TicketIntakeLimits;
  readonly commandId: string;
}

export interface IntakeServiceResult {
  readonly run: RunView;
  readonly snapshot: TicketIntakeSnapshot;
  readonly closure: IntakeClosureReference;
}

export interface IntakeAnalysisResult {
  readonly run: RunView;
  readonly snapshot: TicketIntakeSnapshot;
}

export interface RetainedAnalysisSnapshot {
  readonly snapshot: TicketIntakeSnapshot;
  readonly artifactVerification: IntakeArtifactVerificationCapability;
}

type DurableEvidence =
  | { readonly type: "source.discovered"; readonly payload: SourceDiscoveredPayload }
  | { readonly type: "source.rejected"; readonly payload: SourceRejectedPayload };

export class IntakeService {
  constructor(
    private readonly journal: EventJournal,
    private readonly runs: RunService,
    private readonly scanner: BoundedTicketIntake,
    private readonly artifacts: IntakeArtifactStore,
    private readonly hooks: {
      readonly afterEvidenceAppended?: (count: number) => void | Promise<void>;
      readonly afterSnapshotClosed?: () => void | Promise<void>;
    } = {},
  ) {}

  async intake(input: IntakeServiceRequest): Promise<IntakeServiceResult> {
    assertCommandId(input.commandId);
    let run = this.requireAuthoritativeRun(input);
    const requestSha256 = intakeRequestDigest(input);
    const streamId = intakeStreamId(run.runId);
    let stored = readStreamEvents(this.journal, streamId);
    const closureEvent = stored.find((event) => event.type === "intake.snapshot_closed");

    if (closureEvent !== undefined) {
      if (closureEvent !== stored.at(-1)) throw new Error("intake closure must be the final source event");
      const evidence = parseEvidence(stored.slice(0, -1), this.runs, run, input, requestSha256);
      const snapshot = await materializeSnapshot(this.artifacts, run, evidence);
      const closure = verifiedClosure(streamId, closureEvent, input, run, requestSha256, snapshot);
      if (run.lifecycle === "intake") {
        run = this.runs.completeIntake(run.runId, run.streamVersion, completionCommandId(input.commandId), closure);
      } else if (run.lifecycle !== "analyzing" && run.lifecycle !== "planning") {
        throw new Error(`intake cannot reopen run from ${run.lifecycle}`);
      }
      return Object.freeze({ run, snapshot, closure });
    }
    if (run.lifecycle !== "intake") throw new Error(`intake requires authoritative run lifecycle intake, got ${run.lifecycle}`);

    let evidence: readonly DurableEvidence[];
    let prepared: readonly PreparedIntakeArtifact[] = [];
    if (stored.length > 0 && completeEvidenceCount(stored) === stored.length) {
      evidence = parseEvidence(stored, this.runs, run, input, requestSha256);
      if (!evidence.some((event) => event.type === "source.discovered")) {
        throw new IntakeError("no_accepted_sources", "ticket intake has no accepted text sources");
      }
    } else {
      let scanned: TicketIntakeSnapshot;
      try {
        scanned = await this.scanner.collect(
          { run, source: input.source, limits: input.limits },
          this.artifacts.reservedSourceRoots(),
        );
      } catch (error) {
        if (error instanceof IntakeError && error.rejections.length > 0) {
          evidence = rejectedEvidence(run, input, requestSha256, error.rejections, error.bytesRead);
          await appendEvidenceEvents(this.journal, this.runs, this.hooks, run.runId, streamId, stored, evidence);
        }
        throw error;
      }
      const preparedByDigest = new Map<string, PreparedIntakeArtifact>();
      const preparedBySourceId = new Map<string, PreparedIntakeArtifact>();
      for (const source of scanned.sources) {
        const normalizedDigest = createHash("sha256").update(Buffer.from(source.quotedText, "utf8")).digest("hex");
        let staged = preparedByDigest.get(normalizedDigest);
        if (staged === undefined) {
          staged = await this.artifacts.stage(source.quotedText);
          preparedByDigest.set(normalizedDigest, staged);
        }
        preparedBySourceId.set(source.sourceId, staged);
      }
      prepared = [...preparedByDigest.values()];
      evidence = scannedEvidence(run, input, requestSha256, scanned, preparedBySourceId);
      stored = await appendEvidenceEvents(
        this.journal,
        this.runs,
        this.hooks,
        run.runId,
        streamId,
        stored,
        evidence,
      );
    }

    for (const artifact of prepared) await this.artifacts.publish(artifact);
    const parsed = parseEvidence(stored, this.runs, run, input, requestSha256);
    const snapshot = await materializeSnapshot(this.artifacts, run, parsed);
    const closurePayload = IntakeSnapshotClosedPayloadSchema.parse({
      schemaVersion: 1,
      runId: run.runId,
      projectId: run.projectId,
      projectRevision: run.projectRevision,
      commandId: input.commandId,
      requestSha256,
      sourceKind: snapshot.sourceKind,
      limits: snapshot.limits,
      snapshotSha256: snapshot.snapshotSha256,
      sourceCount: snapshot.sources.length,
      rejectedCount: snapshot.rejected.length,
      totalBytes: snapshot.totalBytes,
      evidenceCount: snapshot.events.length,
    });
    const closed = this.journal.append(streamId, stored.length, [{
      streamId,
      type: "intake.snapshot_closed",
      payload: closurePayload,
      causationId: stored.at(-1)?.eventId ?? intakeCausationId(this.runs, run.runId),
      correlationId: run.runId,
    }])[0]!;
    await this.hooks.afterSnapshotClosed?.();
    const closure = verifiedClosure(streamId, closed, input, run, requestSha256, snapshot);
    run = this.runs.completeIntake(run.runId, run.streamVersion, completionCommandId(input.commandId), closure);
    return Object.freeze({ run, snapshot, closure });
  }

  async loadRetainedAnalysisSnapshot(runId: string): Promise<RetainedAnalysisSnapshot> {
    const run = this.runs.get(runId);
    if (run === null) throw new Error(`run ${runId} not found`);
    if (run.lifecycle !== "analyzing" && run.lifecycle !== "waiting") {
      throw new Error(`analysis snapshot cannot load run from ${run.lifecycle}`);
    }
    const streamId = intakeStreamId(runId);
    const events = readStreamEvents(this.journal, streamId);
    const closureEvent = events.at(-1);
    if (closureEvent?.type !== "intake.snapshot_closed") throw new Error("analysis requires durable intake closure");
    const closure = IntakeSnapshotClosedPayloadSchema.parse(closureEvent.payload);
    const evidence = parseEvidenceExpected(events.slice(0, -1), this.runs, run, {
      commandId: closure.commandId,
      requestSha256: closure.requestSha256,
      sourceKind: closure.sourceKind,
      limits: closure.limits,
      totalBytes: closure.totalBytes,
    });
    const snapshot = await materializeSnapshot(this.artifacts, run, evidence);
    if (snapshot.snapshotSha256 !== closure.snapshotSha256
      || snapshot.sources.length !== closure.sourceCount
      || snapshot.rejected.length !== closure.rejectedCount
      || snapshot.events.length !== closure.evidenceCount) {
      throw new Error("analysis snapshot contradicts durable intake closure");
    }
    const artifactVerification = prepareIntakeArtifactVerification(this.artifacts, snapshot, streamId, closureEvent.eventId);
    return Object.freeze({ snapshot, artifactVerification });
  }

  async completeAnalysis(
    _runId: string,
    _expectedVersion: number,
    _commandId: string,
  ): Promise<IntakeAnalysisResult> {
    throw new Error("analysis completion is available only through AnalysisCoordinator replay evidence");
  }

  private requireAuthoritativeRun(input: IntakeServiceRequest): RunView {
    const run = this.runs.get(input.runId);
    if (run === null) throw new Error(`run ${input.runId} not found`);
    const revision = ProjectRevisionSchema.parse(input.projectRevision);
    if (JSON.stringify(revision) !== JSON.stringify(run.projectRevision)) throw new Error("intake project revision is stale");
    if (run.source.kind !== input.source.kind) throw new Error("intake source kind contradicts the authoritative run");
    const reference = input.source.kind === "inline_goal"
      ? Buffer.from(input.source.goal, "utf8")
      : Buffer.from(path.resolve(input.source.root), "utf8");
    if (run.source.referenceSha256 !== createHash("sha256").update(reference).digest("hex")
      || run.source.declaredBytes !== reference.length) {
      throw new Error("intake source reference contradicts the authoritative run");
    }
    return run;
  }
}

export function intakeStreamId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(runId)) throw new Error("invalid run identity");
  return `source-intake:${createHash("sha256").update(runId).digest("hex")}`;
}

function scannedEvidence(
  run: RunView,
  input: IntakeServiceRequest,
  requestSha256: string,
  snapshot: TicketIntakeSnapshot,
  preparedBySourceId: ReadonlyMap<string, PreparedIntakeArtifact>,
): readonly DurableEvidence[] {
  return snapshot.events.map((event, eventIndex): DurableEvidence => {
    const common = {
      schemaVersion: 1 as const,
      runId: run.runId,
      projectId: run.projectId,
      commandId: input.commandId,
      requestSha256,
      eventIndex,
      evidenceCount: snapshot.events.length,
      sourceKind: snapshot.sourceKind,
      limits: snapshot.limits,
      snapshotTotalBytes: snapshot.totalBytes,
      path: event.payload.path,
      provenance: event.payload.provenance,
    };
    if (event.type === "source.discovered") {
      const artifact = preparedBySourceId.get(event.payload.sourceId)?.artifact;
      if (artifact === undefined) throw new Error("staged intake artifact is missing for source identity");
      return {
        type: event.type,
        payload: SourceDiscoveredPayloadSchema.parse({
          ...common,
          sourceId: event.payload.sourceId,
          sizeBytes: event.payload.sizeBytes,
          digest: event.payload.digest,
          trust: event.payload.trust,
          mediaType: "text/plain; charset=utf-8",
          artifact,
        }),
      };
    }
    return {
      type: event.type,
      payload: SourceRejectedPayloadSchema.parse({
        ...common,
        reason: event.payload.reason,
        sizeBytes: event.payload.sizeBytes,
        bytesRead: event.payload.bytesRead,
        digest: event.payload.digest,
      }),
    };
  });
}

function rejectedEvidence(
  run: RunView,
  input: IntakeServiceRequest,
  requestSha256: string,
  rejected: readonly RejectedTicketSource[],
  totalBytes: number,
): readonly DurableEvidence[] {
  const limits = resolveTicketIntakeLimits(run, input.limits);
  return rejected.map((source, eventIndex) => ({
    type: "source.rejected" as const,
    payload: SourceRejectedPayloadSchema.parse({
      schemaVersion: 1,
      runId: run.runId,
      projectId: run.projectId,
      commandId: input.commandId,
      requestSha256,
      eventIndex,
      evidenceCount: rejected.length,
      sourceKind: run.source.kind,
      limits,
      snapshotTotalBytes: totalBytes,
      path: source.relativePath,
      provenance: source.provenance,
      reason: source.reason,
      sizeBytes: source.sizeBytes,
      bytesRead: source.bytesRead,
      digest: source.digest,
    }),
  }));
}

function parseEvidence(
  events: readonly StoredEvent[],
  runs: RunService,
  run: RunView,
  input: IntakeServiceRequest,
  requestSha256: string,
): readonly DurableEvidence[] {
  return parseEvidenceExpected(events, runs, run, {
    commandId: input.commandId,
    requestSha256,
    sourceKind: run.source.kind,
    limits: resolveTicketIntakeLimits(run, input.limits),
    totalBytes: null,
  });
}

function parseEvidenceExpected(
  events: readonly StoredEvent[],
  runs: RunService,
  run: RunView,
  expected: {
    readonly commandId: string;
    readonly requestSha256: string;
    readonly sourceKind: "inline_goal" | "ticket_directory";
    readonly limits: TicketIntakeSnapshot["limits"];
    readonly totalBytes: number | null;
  },
): readonly DurableEvidence[] {
  const parsed = events.map((event): DurableEvidence => {
    if (event.type === "source.discovered") return { type: event.type, payload: SourceDiscoveredPayloadSchema.parse(event.payload) };
    if (event.type === "source.rejected") return { type: event.type, payload: SourceRejectedPayloadSchema.parse(event.payload) };
    throw new Error(`unexpected intake evidence event ${event.type}`);
  });
  const expectedRootIdentity = parsed[0]?.payload.provenance.rootIdentitySha256;
  const expectedTotalBytes = expected.totalBytes ?? parsed[0]?.payload.snapshotTotalBytes;
  for (let index = 0; index < parsed.length; index += 1) {
    const event = events[index]!;
    const payload = parsed[index]!.payload;
    const prior = index === 0 ? intakeCausationId(runs, run.runId) : events[index - 1]!.eventId;
    if (event.streamVersion !== index + 1
      || event.correlationId !== run.runId
      || event.causationId !== prior
      || payload.eventIndex !== index
      || payload.evidenceCount !== parsed.length
      || payload.runId !== run.runId
      || payload.projectId !== run.projectId
      || payload.commandId !== expected.commandId
      || payload.requestSha256 !== expected.requestSha256
      || payload.sourceKind !== expected.sourceKind
      || payload.snapshotTotalBytes !== expectedTotalBytes
      || JSON.stringify(payload.limits) !== JSON.stringify(expected.limits)
      || JSON.stringify(payload.provenance.projectRevision) !== JSON.stringify(run.projectRevision)
      || payload.provenance.runId !== run.runId
      || payload.provenance.projectId !== run.projectId
      || payload.provenance.sourceKind !== expected.sourceKind) {
      throw new Error("durable intake evidence contradicts the authoritative request");
    }
    if (payload.provenance.rootIdentitySha256 !== expectedRootIdentity) {
      throw new Error("durable intake provenance root identity is inconsistent");
    }
    if (index > 0 && compareEvidence(parsed[index - 1]!, parsed[index]!) >= 0) {
      throw new Error("durable intake evidence order is not deterministic");
    }
  }
  return parsed;
}

async function materializeSnapshot(
  artifacts: IntakeArtifactStore,
  run: RunView,
  evidence: readonly DurableEvidence[],
): Promise<TicketIntakeSnapshot> {
  if (evidence.length === 0) throw new Error("closed intake requires source evidence");
  const discoveredPayloads = evidence.filter((item): item is Extract<DurableEvidence, { type: "source.discovered" }> => item.type === "source.discovered").map((item) => item.payload);
  const rejectedPayloads = evidence.filter((item): item is Extract<DurableEvidence, { type: "source.rejected" }> => item.type === "source.rejected").map((item) => item.payload);
  const common = evidence[0]!.payload;
  if (discoveredPayloads.length === 0) throw new Error("closed intake requires at least one accepted source");
  const expectedTotal = discoveredPayloads.reduce((sum, item) => sum + item.sizeBytes, 0)
    + rejectedPayloads.reduce((sum, item) => sum + item.bytesRead, 0);
  if (expectedTotal !== common.snapshotTotalBytes) throw new Error("intake byte evidence does not match snapshot total");
  const sources: DiscoveredTicketSource[] = [];
  for (const payload of discoveredPayloads) {
    const loaded = await artifacts.load(payload.artifact);
    sources.push(Object.freeze({
      sourceId: payload.sourceId,
      relativePath: payload.path,
      quotedText: loaded.quotedText,
      trust: payload.trust,
      mediaType: payload.mediaType,
      sizeBytes: payload.sizeBytes,
      sha256: payload.digest,
      artifact: payload.artifact,
      provenance: payload.provenance,
    }));
  }
  const rejected: RejectedTicketSource[] = rejectedPayloads.map((payload) => Object.freeze({
    relativePath: payload.path,
    reason: payload.reason,
    sizeBytes: payload.sizeBytes,
    bytesRead: payload.bytesRead,
    digest: payload.digest,
    provenance: payload.provenance,
  }));
  const closureBase = {
    schemaVersion: 1 as const,
    runId: run.runId,
    projectId: run.projectId,
    projectRevision: run.projectRevision,
    commandId: common.commandId,
    requestSha256: common.requestSha256,
    sourceKind: common.sourceKind,
    limits: common.limits,
    totalBytes: common.snapshotTotalBytes,
  };
  const snapshotSha256 = computeIntakeSnapshotSha256({
    closure: closureBase,
    discovered: discoveredPayloads,
    rejected: rejectedPayloads,
  });
  const snapshotEvents: SourceIntakeEvent[] = evidence.map((item) => item.type === "source.discovered"
    ? { type: item.type, payload: {
        schemaVersion: 1, runId: item.payload.runId, projectId: item.payload.projectId,
        sourceId: item.payload.sourceId, path: item.payload.path, sizeBytes: item.payload.sizeBytes,
        digest: item.payload.digest, trust: item.payload.trust, provenance: item.payload.provenance,
      } }
    : { type: item.type, payload: {
        schemaVersion: 1, runId: item.payload.runId, projectId: item.payload.projectId,
        path: item.payload.path, reason: item.payload.reason, sizeBytes: item.payload.sizeBytes,
        bytesRead: item.payload.bytesRead, digest: item.payload.digest, provenance: item.payload.provenance,
      } });
  return freezeDeep({
    schemaVersion: 1 as const,
    closed: true as const,
    runId: run.runId,
    projectId: run.projectId,
    projectRevision: { ...run.projectRevision },
    sourceKind: common.sourceKind,
    limits: common.limits,
    sources,
    rejected,
    events: snapshotEvents,
    totalBytes: common.snapshotTotalBytes,
    snapshotSha256,
  });
}

async function appendEvidenceEvents(
  journal: EventJournal,
  runs: RunService,
  hooks: { readonly afterEvidenceAppended?: (count: number) => void | Promise<void> },
  runId: string,
  streamId: string,
  existingEvents: readonly StoredEvent[],
  evidence: readonly DurableEvidence[],
): Promise<readonly StoredEvent[]> {
  let stored = [...existingEvents];
  if (stored.length > evidence.length) throw new Error("partial intake stream has unexpected events before closure");
  for (let index = 0; index < evidence.length; index += 1) {
    const desired: NewEvent<string, unknown> = {
      streamId,
      type: evidence[index]!.type,
      payload: evidence[index]!.payload,
      causationId: index === 0 ? intakeCausationId(runs, runId) : stored[index - 1]!.eventId,
      correlationId: runId,
    };
    const existing = stored[index];
    if (existing !== undefined) assertSameEvent(existing, desired);
    else {
      const appended = journal.append(streamId, stored.length, [desired])[0]!;
      stored.push(appended);
      await hooks.afterEvidenceAppended?.(stored.length);
    }
  }
  return stored;
}

function verifiedClosure(
  sourceStreamId: string,
  event: StoredEvent,
  input: IntakeServiceRequest,
  run: RunView,
  requestSha256: string,
  snapshot: TicketIntakeSnapshot,
): IntakeClosureReference {
  const payload = IntakeSnapshotClosedPayloadSchema.parse(event.payload);
  if (event.streamId !== sourceStreamId
    || event.correlationId !== run.runId
    || payload.runId !== run.runId
    || payload.projectId !== run.projectId
    || payload.commandId !== input.commandId
    || payload.requestSha256 !== requestSha256
    || payload.snapshotSha256 !== snapshot.snapshotSha256
    || payload.sourceCount !== snapshot.sources.length
    || payload.rejectedCount !== snapshot.rejected.length
    || payload.totalBytes !== snapshot.totalBytes
    || payload.evidenceCount !== snapshot.events.length
    || JSON.stringify(payload.projectRevision) !== JSON.stringify(run.projectRevision)
    || JSON.stringify(payload.limits) !== JSON.stringify(snapshot.limits)) {
    throw new Error("durable intake closure contradicts canonical source evidence");
  }
  return Object.freeze({
    sourceStreamId,
    closureEventId: event.eventId,
    snapshotSha256: payload.snapshotSha256,
    sourceCount: payload.sourceCount,
    rejectedCount: payload.rejectedCount,
    totalBytes: payload.totalBytes,
  });
}

function completeEvidenceCount(events: readonly StoredEvent[]): number | null {
  if (events.length === 0) return null;
  const payload = events[0]!.type === "source.discovered"
    ? SourceDiscoveredPayloadSchema.safeParse(events[0]!.payload)
    : SourceRejectedPayloadSchema.safeParse(events[0]!.payload);
  return payload.success ? payload.data.evidenceCount : null;
}

function compareEvidence(left: DurableEvidence, right: DurableEvidence): number {
  if (left.payload.path !== right.payload.path) return left.payload.path < right.payload.path ? -1 : 1;
  return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
}

function assertSameEvent(existing: StoredEvent, desired: NewEvent<string, unknown>): void {
  if (existing.type !== desired.type
    || existing.streamId !== desired.streamId
    || existing.correlationId !== desired.correlationId
    || existing.causationId !== desired.causationId
    || JSON.stringify(existing.payload) !== JSON.stringify(desired.payload)) {
    throw new Error("partial intake evidence contradicts the current immutable snapshot");
  }
}

function completionCommandId(commandId: string): string {
  return `intake-close:${commandId}`;
}

function assertCommandId(commandId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(commandId)) throw new Error("invalid intake command identity");
}

function intakeCausationId(runs: RunService, runId: string): string {
  const event = runs.readStream(runId).findLast((candidate) => candidate.type === "preflight.completed");
  if (event === undefined) throw new Error("intake requires durable completed preflight causation");
  return event.eventId;
}

function intakeRequestDigest(input: IntakeServiceRequest): string {
  return createHash("sha256").update(JSON.stringify({
    runId: input.runId,
    projectRevision: input.projectRevision,
    source: input.source,
    limits: input.limits,
    commandId: input.commandId,
  })).digest("hex");
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}
