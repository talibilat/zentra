import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../src/contracts/event.js";

import {
  LocalReleaseCoordinator,
  AgentTailJsonlFileSink,
  MilestonePlanSchema,
  MilestoneRegistry,
  OpenCodeReadOnlyProgram,
  OpenCodeReviewerAdapter,
  OpenCodeTaskAdmissionContextSchema,
  PlanReplacementPayloadSchema,
  JournalOutcomeHistoryStore,
  routeApprovedModel,
  RoutedOpenCodeExecution,
  SqliteEventJournal,
  ProjectingEventJournal,
  DURABLE_PAGED_EVENT_JOURNAL,
  isDurablePagedEventJournal,
  JournalRetentionService,
  ArchivedEventJournal,
  openAuthoritativeJournal,
  AgentTailSegmentStore,
  AgentTailTraceService,
  createSegmentedAgentTailProjection,
  CapsuleBackedAnalysisAdapter,
  GitAnalysisRepositorySnapshotProvider,
  createCapsuleBackedAnalysisAdapter,
  DisabledModelBroker,
} from "../../src/index.js";
import type {
  ArchiveManifest,
  ArchiveResult,
  DurablePagedEventJournal,
  GlobalEventPage,
  JournalPageLimits,
  ProjectionClaim,
  ProjectionCursor,
  StreamEventPage,
  EventJournal,
  PagedEventJournal,
  PruneRequest,
  RetentionPolicy,
  RetentionRecovery,
  RetentionReconcileResult,
  VacuumEvidence,
  AgentTailSegmentDescriptor,
  AgentTailSegmentLimits,
  AgentTailTraceReport,
} from "../../src/index.js";
import * as packageApi from "../../src/index.js";

describe("package-root programmatic API", () => {
  it("exports milestone preparation and OpenCode composition contracts", () => {
    expect(MilestoneRegistry).toBeTypeOf("function");
    expect(MilestoneRegistry.prototype.admitTask).toBeTypeOf("function");
    expect(MilestonePlanSchema.parse).toBeTypeOf("function");
    expect(OpenCodeReadOnlyProgram).toBeTypeOf("function");
    expect(OpenCodeReviewerAdapter).toBeTypeOf("function");
    expect(OpenCodeTaskAdmissionContextSchema.parse).toBeTypeOf("function");
    expect(PlanReplacementPayloadSchema.parse).toBeTypeOf("function");
    expect(MilestoneRegistry.prototype.replacePlan).toBeTypeOf("function");
    expect(JournalOutcomeHistoryStore).toBeTypeOf("function");
    expect(routeApprovedModel).toBeTypeOf("function");
    expect(RoutedOpenCodeExecution).toBeTypeOf("function");
    expect(SqliteEventJournal).toBeTypeOf("function");
    expect(SqliteEventJournal.prototype.readAllPage).toBeTypeOf("function");
    expect(SqliteEventJournal.prototype.inspectProjectionCursor).toBeTypeOf("function");
    expect(JournalRetentionService.prototype.archive).toBeTypeOf("function");
    expect(ArchivedEventJournal.prototype.readAllPage).toBeTypeOf("function");
    expect(openAuthoritativeJournal).toBeTypeOf("function");
    expect(AgentTailSegmentStore).toBeTypeOf("function");
    expect(AgentTailTraceService).toBeTypeOf("function");
    expect(createSegmentedAgentTailProjection).toBeTypeOf("function");
    expect(LocalReleaseCoordinator).toBeTypeOf("function");
    expect(CapsuleBackedAnalysisAdapter).toBeTypeOf("function");
    expect(GitAnalysisRepositorySnapshotProvider).toBeTypeOf("function");
    expect(createCapsuleBackedAnalysisAdapter).toBeTypeOf("function");
    const adapter = createCapsuleBackedAnalysisAdapter({
      capsule: { execute: async () => ({ outcome: "failed", openCode: null, model: null, evidence: [], cleanup: "completed", brokerTransport: "completed" }) },
      broker: new DisabledModelBroker(),
      snapshots: { prepare: async () => ({
        view: { path: "/tmp/sanitized", revision: "a".repeat(64), readableScopes: ["src/**"], forbiddenPaths: [".git/**"] },
        sourceBundleSha256: "b".repeat(64), sourceManifestPath: ".analysis-sources/manifest.json", release: () => {},
      }) },
      capabilityId: "analysis", transportModelId: "zentra/analysis", imageName: "zentra-opencode-readonly:analysis",
    });
    expect(adapter).toBeInstanceOf(CapsuleBackedAnalysisAdapter);
    expect("InstalledMilestoneRunner" in packageApi).toBe(false);
    expect("AzureOpenAIModelBroker" in packageApi).toBe(false);
    expect("azureOpenAIModelBrokerForTest" in packageApi).toBe(false);
    expect("nodeAzureOpenAITransportForTest" in packageApi).toBe(false);
    expect("createInstalledModelBroker" in packageApi).toBe(false);
    expect("runCli" in packageApi).toBe(false);
    expect("ProviderConfigSchema" in packageApi).toBe(false);
    expect("loadProviderConfig" in packageApi).toBe(false);
    expect("loadInstalledProviderConfig" in packageApi).toBe(false);
    expect("LocalReleaseRunner" in packageApi).toBe(false);
    expect("createLocalReleasePacket" in packageApi).toBe(false);
    expect("ReleasePacketSchema" in packageApi).toBe(false);
  });

  it("exports durable paging and projection cursor contract types", () => {
    const contracts: [
      DurablePagedEventJournal?,
      GlobalEventPage?,
      JournalPageLimits?,
      ProjectionClaim?,
      ProjectionCursor?,
      StreamEventPage?,
      PagedEventJournal?,
      ArchiveManifest?,
      ArchiveResult?,
      PruneRequest?,
      RetentionPolicy?,
      RetentionRecovery?,
      RetentionReconcileResult?,
      VacuumEvidence?,
      AgentTailSegmentDescriptor?,
      AgentTailSegmentLimits?,
      AgentTailTraceReport?,
    ] = [];
    expect(contracts).toEqual([]);
  });

  it("exports the complete durable attention event contract", () => {
    for (const name of [
      "ApprovalAcceptedPayloadSchema",
      "ApprovalPacketSchema",
      "ApprovalReservationConsumedPayloadSchema",
      "ApprovalReservationPayloadSchema",
      "ApprovalStalePayloadSchema",
      "AttemptPayloadSchema",
      "AttentionRaisedPayloadSchema",
      "AttentionResolvedPayloadSchema",
      "AttentionIndexRaisedPayloadSchema",
      "AttentionIndexResolvedPayloadSchema",
      "AttentionIdentityReservationPayloadSchema",
      "DecisionAcceptedPayloadSchema",
      "DecisionExpiredPayloadSchema",
      "DecisionRejectedPayloadSchema",
      "DecisionRequestedPayloadSchema",
      "QuestionPacketSchema",
      "ScopeAdmissionPayloadSchema",
    ] as const) {
      expect(packageApi[name].parse).toBeTypeOf("function");
    }
    expect(packageApi.AttentionControlledDispatcher).toBeTypeOf("function");
    expect(packageApi.isAtomicEventJournal).toBeTypeOf("function");
    expect(packageApi.RunPlanRevisedPayloadSchema.parse).toBeTypeOf("function");
    expect("markApprovedAndReadyForExecution" in packageApi.RunService.prototype).toBe(false);
  });

  it("keeps the stable EventJournal contract compatible with legacy adapters", () => {
    const legacy: EventJournal = {
      append: () => [],
      readStream: () => [],
      readAll: () => [],
    };
    expect(legacy.readAll()).toEqual([]);
  });

  it("accepts a legacy EventJournal in previously public milestone composition", () => {
    const streams = new Map<string, StoredEvent[]>();
    const all: StoredEvent[] = [];
    const legacy: EventJournal = {
      append: (streamId, expectedVersion, events) => {
        const stream = streams.get(streamId) ?? [];
        if (stream.length !== expectedVersion) throw new Error("stale version");
        const stored = events.map((event, index): StoredEvent => ({
          ...event,
          eventId: `legacy-${all.length + index + 1}`,
          streamVersion: expectedVersion + index + 1,
          globalPosition: all.length + index + 1,
          recordedAt: "2026-07-01T00:00:00.000Z",
        }));
        stream.push(...stored);
        all.push(...stored);
        streams.set(streamId, stream);
        return stored;
      },
      readStream: (streamId, afterVersion = 0) =>
        (streams.get(streamId) ?? []).filter((event) => event.streamVersion > afterVersion),
      readAll: (afterPosition = 0) =>
        all.filter((event) => event.globalPosition > afterPosition),
    };

    const registry = new MilestoneRegistry(legacy);
    registry.register({
      milestoneId: "legacy-milestone",
      projectId: "legacy-project",
      title: "Legacy adapter",
      correlationId: "legacy-trace",
    });
    expect(registry.inspect("legacy-milestone")).toMatchObject({
      milestoneId: "legacy-milestone",
      lifecycle: "planning",
    });
  });

  it("backfills same-trace history through the package-root composition", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-package-journal-")));
    try {
      const journal = new SqliteEventJournal(path.join(root, "journal.db"));
      journal.append("before-attachment", 0, [{
        streamId: "before-attachment",
        type: "task.created",
        payload: { projectId: "package-project", title: "Before attachment" },
        causationId: null,
        correlationId: "package-trace",
      }]);
      journal.append("other", 0, [{
        streamId: "other",
        type: "task.created",
        payload: { projectId: "package-project", title: "Other trace" },
        causationId: null,
        correlationId: "other-trace",
      }]);
      const tracePath = path.join(root, "trace.jsonl");
      const sink = AgentTailJsonlFileSink.open(root, tracePath, "package-trace");

      new ProjectingEventJournal(journal, sink);

      const lines = readFileSync(tracePath, "utf8").trim().split("\n").map((line) =>
        JSON.parse(line) as { readonly trace_id: string; readonly sequence: number }
      );
      expect(lines).toEqual([expect.objectContaining({ trace_id: "package-trace", sequence: 1 })]);
      expect(journal.inspectProjectionCursor(sink.projectionCursorName)).toMatchObject({ position: 2 });
      sink.close();
      journal.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves the legacy Agent Tail direct-append overloads", () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-package-agent-tail-")));
    try {
      const twoArgument = AgentTailJsonlFileSink.open(root, path.join(root, "two-argument.jsonl"));
      const threeArgument = AgentTailJsonlFileSink.open(
        root,
        path.join(root, "three-argument.jsonl"),
        (_line: string): void => {},
      );
      const first: StoredEvent = {
        streamId: "task", type: "task.started", payload: { workerId: "worker-1" },
        causationId: null, correlationId: "legacy-trace", eventId: "event-1",
        streamVersion: 1, globalPosition: 1, recordedAt: "2026-07-01T00:00:00.000Z",
      };

      twoArgument.append([first]);
      threeArgument.append([first]);
      expect(() => twoArgument.append([{ ...first, eventId: "event-2", streamVersion: 2,
        globalPosition: 2, correlationId: "other-trace" }])).toThrow(/trace/i);
      expect(() => twoArgument.projectionCursorName).toThrow(/explicit trace|unscoped/i);
      twoArgument.close();
      threeArgument.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes an externally implemented branded durable journal", () => {
    const external = {
      [DURABLE_PAGED_EVENT_JOURNAL]: true as const,
      append: () => [], readStream: () => [], readAll: () => [],
      readStreamPage: () => ({ events: [], nextVersion: 0, hasMore: false, bytes: 0 }),
      readAllPage: () => ({ events: [], nextPosition: 0, hasMore: false, bytes: 0 }),
      inspectProjectionCursor: () => null, inspectProjectionClaim: () => null,
      ensureProjectionCursor: () => ({ name: "external", position: 0, highWaterPosition: 0, lag: 0, replayCount: 0, activeClaimId: null }),
      claimProjection: () => null,
      recoverProjectionClaim: () => { throw new Error("none"); },
      commitProjection: () => ({ name: "external", position: 0, highWaterPosition: 0, lag: 0, replayCount: 0, activeClaimId: null }),
    };
    expect(isDurablePagedEventJournal(external)).toBe(true);
  });
});
