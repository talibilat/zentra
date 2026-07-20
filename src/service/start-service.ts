import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, constants, existsSync } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  JournalAgentTrailEvidenceSink,
  agentTrailStreamId,
  type AgentTrailEvidence,
} from "../agenttrail/agenttrail-events.js";
import {
  AgentTrailSupervisor,
  type AgentTrailReady,
  type AgentTrailStartRequest,
} from "../agenttrail/agenttrail-supervisor.js";
import { GatewayLifecycleService } from "../gateway/gateway-events.js";
import { LoopbackGateway } from "../gateway/loopback-gateway.js";
import type { AgentTrailAddress, GatewaySession, LoopbackGatewayOptions } from "../gateway/loopback-gateway.js";
import { ProjectingEventJournal, type StoredEventSink } from "../journal/projecting-journal.js";
import { openAuthoritativeJournal, type ArchivedEventJournal } from "../journal/retention.js";
import { SQLITE_JOURNAL_SCHEMA_VERSION, SqliteEventJournal } from "../journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../observability/agent-tail-file-sink.js";
import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeStateManager,
  discoverProject,
  initializeProjectRuntime,
  type ProjectRuntimeLayout,
  type RuntimeClaim,
} from "../runtime/repository-runtime.js";
import { ServiceLifecycleService } from "../runs/service-lifecycle.js";
import { resolveProjectRevision } from "../runs/project-revision.js";
import {
  createLocalWorkflowSurface,
  type LocalWorkflowSurfaceOptions,
} from "../surfaces/local-workflow.js";
import type { RunAdvancer, WorkflowSurface } from "../surfaces/workflow-surface.js";
import { CLI_CONTROL_TOKEN_FILENAME } from "../surfaces/http-workflow-client.js";
import {
  ProductionRunAdvancer,
  type FirstDeliveryConfiguration,
} from "../first-delivery/production-run-advancer.js";

const DEFAULT_AGENTTRAIL_STARTUP_TIMEOUT_MS = 60_000;

export interface AgentTrailService {
  start(request: AgentTrailStartRequest): Promise<AgentTrailReady>;
  shutdown(): Promise<void>;
}

export interface StartZentraServiceOptions {
  readonly cwd?: string;
  readonly tokenTtlMs?: number;
  readonly agentTrailStartupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StartZentraServiceDependencies {
  readonly now?: () => Date;
  readonly createAgentTrail?: (
    evidence: (event: AgentTrailEvidence) => void | Promise<void>,
  ) => AgentTrailService;
  readonly createRuntime?: (layout: ProjectRuntimeLayout, now: () => Date) => RuntimeStateService;
  readonly createTraceSink?: (traceDirectory: string, tracePath: string, serviceId: string) => ServiceTraceSink;
  readonly createGateway?: (options: LoopbackGatewayOptions) => GatewayService;
  readonly createWorkflowSurface?: (
    options: LocalWorkflowSurfaceOptions,
  ) => WorkflowSurface | Promise<WorkflowSurface>;
  readonly runAdvancer?: RunAdvancer;
  readonly firstDelivery?: FirstDeliveryConfiguration;
  readonly observeAgentTrailEvidence?: (evidence: AgentTrailEvidence) => void | Promise<void>;
}

export interface GatewayService {
  start(): Promise<GatewaySession>;
  rotateSession(): GatewaySession;
  setReadiness(readiness: "starting" | "ready" | "degraded" | "stopping"): void;
  setAgentTrailAddress(address: AgentTrailAddress): void;
  replaceAgentTrailAddress(address: AgentTrailAddress): void;
  setWorkflowSurface?(workflow: WorkflowSurface): void;
  close(): Promise<void>;
}

export interface ServiceTraceSink extends StoredEventSink {
  readonly streamFailed?: boolean;
  close(): void;
}

export interface RuntimeStateService {
  start(input: Parameters<RuntimeStateManager["start"]>[0]): ReturnType<RuntimeStateManager["start"]>;
  publish(...input: Parameters<RuntimeStateManager["publish"]>): ReturnType<RuntimeStateManager["publish"]>;
  read(): ReturnType<RuntimeStateManager["read"]>;
  remove(claim: RuntimeClaim): ReturnType<RuntimeStateManager["remove"]>;
}

export type ServiceShutdownReason =
  | "signal"
  | "operator_requested"
  | "startup_failed"
  | "internal_failure"
  | "test_requested";

export interface RunningZentraService {
  readonly layout: ProjectRuntimeLayout;
  readonly origin: string;
  readonly sessionUrl: string;
  readonly tokenExpiresAt: string;
  readonly closed: Promise<void>;
  shutdown(reason?: ServiceShutdownReason): Promise<void>;
}

export async function startZentraService(
  options: StartZentraServiceOptions = {},
  dependencies: StartZentraServiceDependencies = {},
): Promise<RunningZentraService> {
  options.signal?.throwIfAborted();
  const now = dependencies.now ?? (() => new Date());
  const startupTimeoutMs = boundedTimeout(
    options.agentTrailStartupTimeoutMs ?? DEFAULT_AGENTTRAIL_STARTUP_TIMEOUT_MS,
  );
  const discovery = await discoverProject(options.cwd ?? process.cwd());
  const layout = await initializeProjectRuntime(discovery);
  const cliControlToken = randomBytes(32).toString("base64url");
  const cliControlTokenPath = path.join(layout.runtimeDirectory, CLI_CONTROL_TOKEN_FILENAME);
  const gatewayOptions = {
    now,
    cliControlTokenDigest: createHash("sha256").update(cliControlToken, "utf8").digest(),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
  } satisfies LoopbackGatewayOptions;
  let gateway: GatewayService;
  let rawJournal: ArchivedEventJournal;
  try {
    const defaultGateway = new LoopbackGateway(gatewayOptions);
    gateway = dependencies.createGateway?.(gatewayOptions) ?? defaultGateway;
    rawJournal = openServiceJournal(layout.databasePath);
  } catch (error) {
    throw error;
  }
  const runtime = dependencies.createRuntime?.(layout, now) ?? new RuntimeStateManager(layout, { now });
  const serviceId = `zentra-local-${randomUUID()}`;
  const tracePath = path.join(layout.traceDirectory, `agenttrail-${serviceId}.jsonl`);
  let sink: ServiceTraceSink | undefined;
  let journal: ProjectingEventJournal;
  try {
    sink = dependencies.createTraceSink?.(layout.traceDirectory, tracePath, serviceId) ??
      AgentTailJsonlFileSink.openAll(layout.traceDirectory, tracePath);
    journal = new ProjectingEventJournal(rawJournal, sink);
    if (journal.projectionFailed || sink.streamFailed === true) {
      throw new Error("Service AgentTrail projection initialization failed");
    }
  } catch (error) {
    sink?.close();
    rawJournal.close();
    throw error;
  }
  let claim: RuntimeClaim | null = null;
  let sidecar: AgentTrailService | null = null;
  let lifecycle: ServiceLifecycleService | null = null;
  let processIncarnation: string | null = null;
  let session: GatewaySession | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let runAdvancer: RunAdvancer | null = null;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  let journalClosed = false;
  let sinkClosed = false;
  let removeAbortListener: (() => void) | null = null;
  let cliControlTokenPublished = false;

  const closeJournal = (): void => {
    if (journalClosed) return;
    journalClosed = true;
    rawJournal.close();
  };

  const closeSink = (): void => {
    if (sinkClosed) return;
    sinkClosed = true;
    sink!.close();
  };

  const assertProjectionHealthy = (): void => {
    if (!journal.projectionFailed && sink!.streamFailed !== true) return;
    if (session !== null) {
      try { gateway.setReadiness("degraded"); } catch { /* The gateway may already be stopping. */ }
    }
    throw new Error("Service AgentTrail projection delivery failed");
  };

  const shutdown = (reason: ServiceShutdownReason = "operator_requested"): Promise<void> => {
    shutdownPromise ??= (async () => {
      removeAbortListener?.();
      removeAbortListener = null;
      let firstFailure: unknown;
      let cleanupFailed = false;
      const attemptCleanup = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupFailed = true;
          firstFailure ??= error;
        }
      };
      await attemptCleanup(() => {
        if (session !== null) gateway.setReadiness("stopping");
      });
      await attemptCleanup(() => runAdvancer?.shutdown?.());
      if (lifecycle !== null && claim !== null) {
        try {
          lifecycle.beginShutdown({
            serviceId,
            process: claim,
            observation: "performed",
            occurredAt: now().toISOString(),
            commandId: `stopping-${randomUUID()}`,
          });
          assertProjectionHealthy();
        } catch (error) {
          cleanupFailed = true;
          firstFailure ??= error;
        }
      }
      await attemptCleanup(() => gateway.close());
      if (cliControlTokenPublished) {
        await attemptCleanup(() => removeCliControlToken(cliControlTokenPath));
        cliControlTokenPublished = false;
      }
      await attemptCleanup(() => sidecar?.shutdown());
      if (claim !== null && session !== null) {
        await attemptCleanup(() => runtime.publish(claim!, {
          address: session!.address,
          tokenExpiresAt: session!.expiresAt,
          startupStatus: cleanupFailed || reason === "startup_failed" || reason === "internal_failure" ? "failed" : "stopping",
        }));
      }
      if (claim !== null) await attemptCleanup(() => runtime.remove(claim!));
      if (lifecycle !== null && claim !== null) {
        try {
          const failed = cleanupFailed || reason === "startup_failed" || reason === "internal_failure";
          lifecycle.shutdown({
            serviceId,
            process: claim,
            outcome: failed ? "failed" : "completed",
            reasonCode: cleanupFailed || reason === "internal_failure" ? "internal_failure" : reason,
            observation: "performed",
            occurredAt: now().toISOString(),
            commandId: `shutdown-${randomUUID()}`,
          });
          assertProjectionHealthy();
        } catch (error) {
          firstFailure ??= error;
        }
      }
      try { closeSink(); } catch (error) { firstFailure ??= error; }
      closeJournal();
      if (firstFailure !== undefined) {
        rejectClosed(firstFailure);
        throw firstFailure;
      }
      resolveClosed();
    })();
    return shutdownPromise;
  };

  try {
    session = await gateway.start();
    const ownership = await runtime.start({
      address: session.address,
      tokenExpiresAt: session.expiresAt,
      startupStatus: "starting",
    });
    claim = ownership.claim;
    await publishCliControlToken(layout.runtimeDirectory, cliControlTokenPath, cliControlToken);
    cliControlTokenPublished = true;
    processIncarnation = claim.processIncarnation;
    lifecycle = new ServiceLifecycleService(journal);
    if (ownership.staleEvidence !== null) {
      lifecycle.reconcileStale({
        stalePid: ownership.staleEvidence.stalePid,
        staleProcessIncarnation: ownership.staleEvidence.staleProcessIncarnation,
        detectedAt: ownership.staleEvidence.detectedAt,
        commandId: `reconcile-stale-${randomUUID()}`,
      });
      assertProjectionHealthy();
    }
    const starting = lifecycle.start({
      serviceId,
      process: claim,
      address: session.address,
      tokenExpiresAt: session.expiresAt,
      observation: ownership.evidence[0].observation,
      commandId: `start-${randomUUID()}`,
    });
    assertProjectionHealthy();
    const tracePathSha256 = createHash("sha256").update(tracePath, "utf8").digest("hex");
    const agentTrailStream = agentTrailStreamId(
      `project-${createHash("sha256").update(layout.projectRoot).digest("hex").slice(0, 24)}:${processIncarnation.slice(-16)}`,
    );
    const agentTrailEvidence = new JournalAgentTrailEvidenceSink(journal, {
      streamId: agentTrailStream,
      correlationId: serviceId,
      causationId: starting.eventId,
    });
    const gatewayLifecycle = new GatewayLifecycleService(journal, {
      serviceId,
      processIncarnation,
      correlationId: serviceId,
      agentTrailStreamId: agentTrailStream,
      serviceStartingEventId: starting.eventId,
    });
    let degraded: {
      readonly incarnation: string;
    } | null = null;
    let target: {
      readonly failedIncarnation: string;
      readonly replacementIncarnation: string;
      readonly throughPosition: number;
    } | null = null;
    let initialReadyEvent: { readonly eventId: string; readonly incarnation: string } | null = null;
    const recordEvidence = async (evidence: AgentTrailEvidence): Promise<void> => {
      agentTrailEvidence.record(evidence);
      assertProjectionHealthy();
      const stored = journal.readStream(agentTrailStream).at(-1)!;
      if (evidence.type === "agenttrail.ready" && degraded === null && target === null && initialReadyEvent === null) {
        initialReadyEvent = { eventId: stored.eventId, incarnation: evidence.incarnation };
      }
      if (evidence.type === "agenttrail.failed" && evidence.phase === "runtime") {
        gatewayLifecycle.degradeAndRaiseCritical({
          attentionId: `agenttrail-critical-${createHash("sha256").update(evidence.incarnation).digest("hex").slice(0, 24)}`,
          agentTrailIncarnation: evidence.incarnation,
          agentTrailFailureEventId: stored.eventId,
          tracePathSha256,
          occurredAt: evidence.occurredAt,
        });
        assertProjectionHealthy();
        gateway.setReadiness("degraded");
        degraded = { incarnation: evidence.incarnation };
        target = null;
      } else if (evidence.type === "agenttrail.starting" && degraded !== null &&
        evidence.incarnation !== degraded.incarnation) {
        // The supervisor awaits this callback before spawn; serve parses the complete file before announcing ready.
        const cursor = journal.inspectProjectionCursor(journal.projectionCursorName);
        if (cursor === null || cursor.position < stored.globalPosition) {
          throw new Error("AgentTrail replacement starting evidence was not projected before spawn");
        }
        gatewayLifecycle.targetBackfill({
          failedAgentTrailIncarnation: degraded.incarnation,
          replacementAgentTrailIncarnation: evidence.incarnation,
          agentTrailStartingEventId: stored.eventId,
          tracePathSha256,
          target: { strategy: "journal_projection_high_water", throughPosition: stored.globalPosition },
          occurredAt: evidence.occurredAt,
        });
        assertProjectionHealthy();
        target = {
          failedIncarnation: degraded.incarnation,
          replacementIncarnation: evidence.incarnation,
          throughPosition: stored.globalPosition,
        };
      } else if (evidence.type === "agenttrail.ready" && target !== null &&
        evidence.incarnation === target.replacementIncarnation) {
        gatewayLifecycle.recovered({
          failedAgentTrailIncarnation: target.failedIncarnation,
          readyAgentTrailIncarnation: evidence.incarnation,
          agentTrailReadyEventId: stored.eventId,
          tracePathSha256,
          target: {
            strategy: "journal_projection_high_water",
            throughPosition: target.throughPosition,
          },
          occurredAt: evidence.occurredAt,
        });
        assertProjectionHealthy();
        gateway.replaceAgentTrailAddress(evidence.address);
        degraded = null;
        target = null;
        gateway.setReadiness("ready");
      }
      await dependencies.observeAgentTrailEvidence?.(evidence);
    };
    sidecar = dependencies.createAgentTrail?.(recordEvidence) ?? new AgentTrailSupervisor({
      evidence: recordEvidence,
    });
    if (options.signal !== undefined) {
      const abort = (): void => { void shutdown("signal").catch(() => undefined); };
      options.signal.throwIfAborted();
      options.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => options.signal!.removeEventListener("abort", abort);
    }
    const initialAgentTrailReady = await sidecar.start({ tracePath, runtime: layout, startupTimeoutMs });
    const durableInitialReady = initialReadyEvent as { readonly eventId: string; readonly incarnation: string } | null;
    if (durableInitialReady === null || durableInitialReady.incarnation !== initialAgentTrailReady.incarnation) {
      throw new Error("AgentTrail returned readiness that contradicts its durable ready event");
    }
    gateway.setAgentTrailAddress(initialAgentTrailReady.address);
    session = gateway.rotateSession();
    // service.ready means both mandatory AgentTrail readiness and runtime-ready publication succeeded.
    await runtime.publish(claim, {
      address: session.address,
      tokenExpiresAt: session.expiresAt,
      startupStatus: "ready",
    });
    const ready = lifecycle.ready({
      serviceId,
      process: claim,
      address: session.address,
      runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
      journalSchemaVersion: SQLITE_JOURNAL_SCHEMA_VERSION,
      tokenExpiresAt: session.expiresAt,
      agentTrailStreamId: agentTrailStream,
      agentTrailReadyEventId: durableInitialReady.eventId,
      agentTrailIncarnation: durableInitialReady.incarnation,
      observation: ownership.evidence[0].observation,
      commandId: `ready-${randomUUID()}`,
      causationId: durableInitialReady.eventId,
    });
    assertProjectionHealthy();
    if (ready.type !== "service.ready") throw new Error("Service readiness publication failed");
    if (gateway.setWorkflowSurface === undefined) {
      throw new Error("Gateway cannot accept a workflow surface");
    }
    const projectRevision = await resolveProjectRevision(layout.projectRoot);
    runAdvancer = dependencies.runAdvancer ?? await ProductionRunAdvancer.create({
      journal,
      process: claim,
      serviceReadyEventId: ready.eventId,
      projectRoot: layout.projectRoot,
      ...(dependencies.firstDelivery === undefined ? {} : { configuration: dependencies.firstDelivery }),
    });
    const workflowOptions: LocalWorkflowSurfaceOptions = {
      journal,
      process: claim,
      serviceReadyEventId: ready.eventId,
      projectRoot: layout.projectRoot,
      projectRevision,
      traceProjectionFailed: () => journal.projectionFailed || sink!.streamFailed === true,
      runAdvancer,
    };
    const workflow = await (dependencies.createWorkflowSurface?.(workflowOptions) ??
      createLocalWorkflowSurface(workflowOptions));
    gateway.setWorkflowSurface(workflow);
    await runAdvancer.resumeNonterminalRuns?.();
    assertProjectionHealthy();
    gateway.setReadiness("ready");

    return {
      layout,
      origin: `http://${session.address.host}:${session.address.port}`,
      sessionUrl: session.url,
      tokenExpiresAt: session.expiresAt,
      closed,
      shutdown,
    };
  } catch (error) {
    if (claim === null && session !== null) {
      try {
        claim = (await runtime.start({
          address: session.address,
          tokenExpiresAt: session.expiresAt,
          startupStatus: "starting",
        })).claim;
      } catch {
        // A malformed or foreign owner remains durable for explicit runtime reconciliation.
      }
    }
    try {
      await shutdown("startup_failed");
    } catch {
      // The original startup failure is authoritative; cleanup still attempted every owned resource.
    }
    void closed.catch(() => undefined);
    throw error;
  }
}

function openServiceJournal(databasePath: string): ArchivedEventJournal {
  if (!existsSync(databasePath)) {
    const created = new SqliteEventJournal(databasePath);
    created.close();
    // SQLite respects umask, but the repository runtime requires an exact private identity.
    requirePrivateMode(databasePath);
  }
  return openAuthoritativeJournal(databasePath, "read-write");
}

function requirePrivateMode(databasePath: string): void {
  chmodSync(databasePath, 0o600);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60_000) {
    throw new RangeError("AgentTrail startup timeout must be a positive bounded integer");
  }
  return value;
}

async function publishCliControlToken(runtimeDirectory: string, tokenPath: string, token: string): Promise<void> {
  const temporaryPath = path.join(runtimeDirectory, `.cli-control.${randomUUID()}.tmp`);
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    descriptor = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await descriptor.writeFile(token, "utf8");
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await rename(temporaryPath, tokenPath);
    published = true;
    const metadata = await lstat(tokenPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 || metadata.size !== 43) {
      throw new Error("CLI control token file is not private");
    }
    const directory = await open(runtimeDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await descriptor?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (published) await unlink(tokenPath).catch(() => undefined);
    throw error;
  }
}

async function removeCliControlToken(tokenPath: string): Promise<void> {
  try { await unlink(tokenPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
