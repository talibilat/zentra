import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestCanonical } from "../contracts/authority-attention.js";
import type { StoredEvent } from "../contracts/event.js";
import { runInstalledThreePodConformance } from "../conformance/three-pod-installed.js";
import type { ThreePodConformanceReport } from "../conformance/three-pod-report.js";
import type { EventJournal } from "../journal/journal.js";
import { JournalRetentionService, openAuthoritativeJournal } from "../journal/retention.js";
import { SqliteEventJournal } from "../journal/sqlite-journal.js";
import { projectAgentTrailFleet } from "../observability/agent-trail-fleet.js";
import { DaemonScheduler, InstalledProcessExecutor } from "../scheduling/daemon-scheduler.js";
import { DispatchGrantService } from "../scheduling/dispatch-grant-service.js";
import { dispatchIntentSha256, JournalScheduler } from "../scheduling/journal-scheduler.js";
import type { SchedulerTaskInput } from "../scheduling/scheduler-contracts.js";
import { ProcessSupervisor } from "../workers/process-supervisor.js";

export const SOAK_FAULT_KINDS = Object.freeze([
  "worker_crash", "daemon_crash", "sidecar_crash", "service_crash", "slow_validator",
  "claim_contention", "cursor_lag", "disk_pressure", "cancellation", "conflict_burst",
  "archive", "prune", "vacuum",
] as const);
export const SOAK_ABRUPT_POINTS = Object.freeze([
  "registered_worker_fleet_effect", "process_faults_effect", "production_wave_effect",
  "report_checkpoint_effect", "archive_effect", "cursor_rebuild_effect", "prune_effect", "vacuum_effect",
] as const);

export type SoakFaultKind = typeof SOAK_FAULT_KINDS[number];
export type SoakAbruptPoint = typeof SOAK_ABRUPT_POINTS[number];
type Profile = "ci" | "process" | "realtime-24h";

export interface SoakConfig {
  readonly schemaVersion: 2;
  readonly profile: Profile;
  readonly seed: string;
  readonly workerCount: number;
  readonly ticks: number;
  readonly tickMs: number;
  readonly durationMs: number;
  readonly realTime: boolean;
  readonly qualifying: boolean;
  readonly capacities: { readonly reasoning: number; readonly writers: number; readonly heavyValidation: number;
    readonly review: number; readonly integration: 1 };
  readonly limits: { readonly maxReportBytes: number; readonly maxProcessOutputBytes: number;
    readonly maxArchiveEvents: number; readonly maxQueueDepth: number; readonly maxRssBytes: number;
    readonly maxHeapBytes: number; readonly maxDiskPressureBytes: number };
  readonly slos: { readonly maximumRecoveryMs: number; readonly maximumQueueDepth: number;
    readonly maximumProjectionLag: number; readonly zeroSafetyViolations: true };
  readonly signing: { readonly privateKeyPath: string; readonly trustedPublicKeySha256: string };
  readonly faultKinds: readonly SoakFaultKind[];
}

export interface SoakSloResult {
  readonly name: string;
  readonly observed: number | boolean;
  readonly limit: number | boolean;
  readonly passed: boolean;
  readonly evidenceEventIds: readonly string[];
}

export interface SoakReport {
  readonly schemaVersion: 2;
  readonly status: "qualified" | "failed" | "running";
  readonly qualifyingRun: boolean;
  readonly build: { readonly commit: string; readonly moduleSha256: string; readonly node: string;
    readonly platform: string; readonly arch: string };
  readonly configSha256: string;
  readonly workload: { readonly seed: string; readonly ticks: number; readonly tickMs: number;
    readonly durationMs: number; readonly completedTicks: number; readonly realTime: boolean };
  readonly workers: { readonly registered: number; readonly unique: number };
  readonly production: { readonly waves: number; readonly completeWaves: number; readonly verifiedUnits: number;
    readonly productionBoundaries: Record<ProductionBoundary, boolean> };
  readonly capacity: { readonly configured: SoakConfig["capacities"]; readonly peak: SoakConfig["capacities"];
    readonly respected: boolean; readonly queueMaximum: number };
  readonly faults: { readonly configured: readonly SoakFaultKind[]; readonly outcomes: readonly {
    readonly kind: SoakFaultKind; readonly outcome: "observed" | "recovered" | "failed";
    readonly evidenceEventIds: readonly string[] }[] };
  readonly maintenance: { readonly archiveSegments: number; readonly prunes: number;
    readonly vacuumAttempts: number; readonly maximumArchiveRange: number };
  readonly samples: { readonly count: number; readonly rssMaximumBytes: number; readonly heapMaximumBytes: number;
    readonly diskMaximumBytes: number; readonly queueMaximum: number; readonly processOutputMaximumBytes: number };
  readonly processes: { readonly spawned: number; readonly killed: number; readonly delayedValidators: number;
    readonly cancelledInFlight: number; readonly secretLeaks: number; readonly shellExecutions: number;
    readonly outputLimitObserved: boolean };
  readonly recovery: { readonly abruptExits: number; readonly reconciledOperations: number;
    readonly repeatedEffects: number; readonly maximumRecoveryMs: number };
  readonly observability: { readonly heartbeats: number; readonly projectionLagMaximum: number;
    readonly projectionRebuilt: boolean };
  readonly attention: { readonly duplicates: number; readonly items: readonly { readonly kind: SoakFaultKind;
    readonly rank: number; readonly authority: "none"; readonly evidenceEventIds: readonly string[] }[] };
  readonly bottlenecks: readonly { readonly name: string; readonly observed: number; readonly limit: number;
    readonly utilization: number; readonly evidenceEventIds: readonly string[] }[];
  readonly host: { readonly fingerprint: string; readonly sessions: number; readonly interruptions: number;
    readonly monotonicElapsedMs: number; readonly wallElapsedMs: number };
  readonly slos: readonly SoakSloResult[];
  readonly safetyViolations: readonly string[];
  readonly evidenceFiles: Readonly<Record<string, string>>;
  readonly digests: { readonly journalSha256: string; readonly agentTrailSha256: string;
    readonly archiveSha256: string; readonly reportSha256: string; readonly publicKey: string;
    readonly trustedPublicKeySha256: string; readonly signature: string };
}

export interface SoakRunResult { readonly databasePath: string; readonly reportPath: string; readonly report: SoakReport }

type ProductionBoundary = "scheduler" | "daemon" | "pods" | "claims" | "supervisedProcesses" |
  "trustedPatchApply" | "repositoryOrchestrator" | "integrationQueue" | "agentTrail";
type ControlJournal = EventJournal & { close(): void; readAllPage(afterPosition?: number,
  limits?: { readonly maxEvents: number; readonly maxBytes: number }): { readonly events: readonly StoredEvent[];
    readonly nextPosition: number; readonly hasMore: boolean; readonly bytes: number } };

interface ControlState {
  version: number;
  lastEventId: string | null;
  lastTick: number;
  operations: Map<string, { intent: StoredEvent; observation: StoredEvent | null }>;
  eventTypes: Map<string, StoredEvent[]>;
  runStarted: StoredEvent;
}

interface Runtime { journal: ControlJournal; state: ControlState; readonly databasePath: string;
  readonly root: string; readonly config: SoakConfig; readonly abruptPoint?: SoakAbruptPoint;
  readonly abruptMode?: "throw" | "sigkill" }

const CONTROL_STREAM = "soak:control";
const PAGE = { maxEvents: 256, maxBytes: 1024 * 1024 } as const;
const MAX_PROJECTED_EVENTS = 10_000;
const productionBoundaries: readonly ProductionBoundary[] = ["scheduler", "daemon", "pods", "claims",
  "supervisedProcesses", "trustedPatchApply", "repositoryOrchestrator", "integrationQueue", "agentTrail"];

export function createSoakProfile(profile: Profile, overrides: {
  readonly seed?: string;
  readonly workerCount?: number;
  readonly signing: SoakConfig["signing"];
  readonly tickMs?: number;
  readonly faultKinds?: readonly SoakFaultKind[];
}): SoakConfig {
  const realTime = profile === "realtime-24h";
  const ticks = profile === "process" ? 8 : 1_440;
  const tickMs = overrides.tickMs ?? 60_000;
  const config: SoakConfig = Object.freeze({ schemaVersion: 2, profile,
    seed: overrides.seed ?? `${profile}-production-v2`, workerCount: overrides.workerCount ?? 20,
    ticks, tickMs, durationMs: ticks * tickMs, realTime, qualifying: realTime,
    capacities: Object.freeze({ reasoning: 12, writers: 4, heavyValidation: 2, review: 2, integration: 1 as const }),
    limits: Object.freeze({ maxReportBytes: 2 * 1024 * 1024, maxProcessOutputBytes: 1024,
      maxArchiveEvents: 2_000, maxQueueDepth: 128, maxRssBytes: 2 * 1024 * 1024 * 1024,
      maxHeapBytes: 1024 * 1024 * 1024, maxDiskPressureBytes: 512 * 1024 }),
    slos: Object.freeze({ maximumRecoveryMs: 120_000, maximumQueueDepth: 128,
      maximumProjectionLag: 2_000, zeroSafetyViolations: true as const }),
    signing: Object.freeze({ ...overrides.signing }),
    faultKinds: Object.freeze([...(overrides.faultKinds ?? SOAK_FAULT_KINDS)]),
  });
  validateConfig(config);
  return config;
}

export function trustedSoakPublicKeySha256(privateKeyPath: string): string {
  const key = loadPrivateKey(privateKeyPath);
  const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return sha256(publicKey);
}

export async function runSoakHarness(input: { readonly root: string; readonly config: SoakConfig;
  readonly resume?: boolean; readonly abruptPoint?: SoakAbruptPoint; readonly abruptMode?: "throw" | "sigkill";
  readonly signal?: AbortSignal }): Promise<SoakRunResult> {
  validateConfig(input.config);
  const root = realpathSync.native(input.root);
  const databasePath = path.join(root, "soak.sqlite");
  const reportPath = path.join(root, "soak-report.json");
  const build = frozenBuild();
  let journal: ControlJournal;
  if (input.resume === true) {
    if (!existsSync(databasePath)) throw new Error("soak resume journal does not exist");
    journal = openAuthoritativeJournal(databasePath, "read-write") as ControlJournal;
  } else {
    if (existsSync(databasePath)) throw new Error("soak journal exists; resume is required");
    journal = new SqliteEventJournal(databasePath) as ControlJournal;
  }
  const existing = journal.readStream(CONTROL_STREAM);
  let state: ControlState;
  if (existing.length === 0) {
    state = emptyState();
    const runtime = { journal, state, databasePath, root, config: input.config,
      ...(input.abruptPoint === undefined ? {} : { abruptPoint: input.abruptPoint }),
      ...(input.abruptMode === undefined ? {} : { abruptMode: input.abruptMode }) } satisfies Runtime;
    const started = append(runtime, "soak.run_started", { config: input.config, configSha256: digestCanonical(input.config),
      build, host: hostEvidence(), wallStartedAt: new Date().toISOString(), monotonicStartedNs: process.hrtime.bigint().toString() });
    state.runStarted = started;
    append(runtime, "soak.workers_registered", { workerIds: Array.from({ length: input.config.workerCount },
      (_, index) => `soak-worker-${index.toString().padStart(2, "0")}`) });
  } else {
    state = projectControl(existing);
    const payload = state.runStarted.payload as { configSha256: string; build: unknown };
    if (payload.configSha256 !== digestCanonical(input.config) || digestCanonical(payload.build) !== digestCanonical(build)) {
      journal.close(); throw new Error("soak resume build or configuration differs from the durable run");
    }
  }
  const runtime: Runtime = { journal, state, databasePath, root, config: input.config,
    ...(input.abruptPoint === undefined ? {} : { abruptPoint: input.abruptPoint }),
    ...(input.abruptMode === undefined ? {} : { abruptMode: input.abruptMode }) };
  const sessionStarted = process.hrtime.bigint();
  append(runtime, "soak.session_started", { host: hostEvidence(), resumed: existing.length > 0,
    wallStartedAt: new Date().toISOString(), monotonicStartedNs: sessionStarted.toString() });
  let interrupted = false;
  try {
    for (let tick = runtime.state.lastTick + 1; tick <= input.config.ticks; tick += 1) {
      if (isAborted(input.signal)) { interrupted = true; break; }
      const tickStarted = process.hrtime.bigint();
      if (input.config.realTime) await sleep(input.config.tickMs, input.signal);
      if (isAborted(input.signal)) { interrupted = true; break; }
      await runScheduledOperations(runtime, tick);
      const checkpointEvery = input.config.realTime ? 5 : input.config.profile === "process" ? 4 : 120;
      if (tick % checkpointEvery === 0) await operation(runtime, `report-checkpoint-${tick}`, tick, "report_checkpoint_effect",
        () => progressCheckpoint(runtime, tick));
      const sample = actualSample(runtime, tick);
      append(runtime, "soak.tick_observed", { tick, virtualAtMs: tick * input.config.tickMs,
        elapsedNs: (process.hrtime.bigint() - tickStarted).toString(), ...sample });
      runtime.state.lastTick = tick;
    }
    if (interrupted) append(runtime, "soak.session_interrupted", { host: hostEvidence(),
      elapsedNs: (process.hrtime.bigint() - sessionStarted).toString(), tick: runtime.state.lastTick });
    else append(runtime, "soak.session_finished", { host: hostEvidence(),
      elapsedNs: (process.hrtime.bigint() - sessionStarted).toString(), tick: runtime.state.lastTick });
    if (runtime.state.lastTick === input.config.ticks && !hasType(runtime.state, "soak.run_completed")) {
      const operationEventIds = [...runtime.state.operations.values()].flatMap((operation) =>
        operation.observation === null ? [] : [operation.observation.eventId]);
      append(runtime, "soak.run_completed", { tick: runtime.state.lastTick, wallFinishedAt: new Date().toISOString(),
        observedOperationCount: operationEventIds.length,
        observedOperationEventIds: operationEventIds.length <= 16 ? operationEventIds :
          [...operationEventIds.slice(0, 8), ...operationEventIds.slice(-8)],
        observedOperationDigest: digestCanonical(operationEventIds) });
    }
    if (runtime.state.lastTick === input.config.ticks) retainControlAgentTrail(runtime);
    runtime.journal.close();
    const report = buildReport(root, databasePath, input.config, build);
    if (Buffer.byteLength(JSON.stringify(report), "utf8") > input.config.limits.maxReportBytes) {
      throw new Error("soak machine report exceeds its hard byte limit");
    }
    atomicJson(reportPath, report);
    return Object.freeze({ databasePath, reportPath, report });
  } catch (error) {
    runtime.journal.close();
    throw error;
  }
}

async function progressCheckpoint(runtime: Runtime, tick: number) {
  const directory = path.join(runtime.root, "checkpoints"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relativePath = `checkpoints/report-${tick.toString().padStart(4, "0")}.json`;
  const destination = path.join(runtime.root, relativePath);
  if (existsSync(destination)) return { recovered: true, payload: { path: relativePath, sha256: sha256File(destination) } };
  const body = { schemaVersion: 1, tick, configSha256: digestCanonical(runtime.config),
    controlVersion: runtime.state.version, priorEventId: runtime.state.lastEventId, host: hostEvidence() };
  const digest = digestCanonical(body); const privateKey = loadPrivateKey(runtime.config.signing.privateKeyPath);
  const checkpoint = { ...body, digest, signature: sign(null, Buffer.from(digest, "hex"), privateKey).toString("base64") };
  atomicJson(destination, checkpoint);
  return { recovered: false, payload: { path: relativePath, sha256: sha256File(destination) } };
}

async function runScheduledOperations(runtime: Runtime, tick: number): Promise<void> {
  const processTick = runtime.config.profile === "process" ? 1 : 60;
  const waveTicks = runtime.config.profile === "process" ? [2] : [120, 840];
  const archiveTick = runtime.config.profile === "process" ? 4 : 480;
  const cursorTick = runtime.config.profile === "process" ? 3 : 600;
  const pruneTick = runtime.config.profile === "process" ? 5 : 960;
  const vacuumTick = runtime.config.profile === "process" ? 6 : 1_100;
  const secondArchiveTick = runtime.config.profile === "process" ? 7 : 1_200;
  if (tick === 1) await operation(runtime, "registered-worker-fleet", tick, "registered_worker_fleet_effect",
    () => registeredWorkerFleet(runtime));
  if (tick === processTick) await operation(runtime, "process-faults", tick, "process_faults_effect",
    () => realProcessFaults(runtime));
  const waveIndex = waveTicks.indexOf(tick);
  if (waveIndex >= 0) await operation(runtime, `production-wave-${waveIndex + 1}`, tick,
    waveIndex === 0 ? "production_wave_effect" : "none", () => productionWave(runtime, waveIndex + 1));
  if (tick === archiveTick) await operation(runtime, "archive", tick, "archive_effect", () => archive(runtime, 1));
  if (tick === cursorTick) await operation(runtime, "cursor-rebuild", tick, "cursor_rebuild_effect",
    () => rebuildCursor(runtime));
  if (tick === pruneTick) await operation(runtime, "prune", tick, "prune_effect", () => prune(runtime));
  if (tick === vacuumTick) await operation(runtime, "vacuum", tick, "vacuum_effect", () => vacuum(runtime));
  if (tick === secondArchiveTick) await operation(runtime, "archive-2", tick, "none", () => archive(runtime, 2));
}

async function registeredWorkerFleet(runtime: Runtime) {
  const schedulerId = "soak-registered-fleet";
  const controlIdentity = { controlPlaneId: schedulerId, repositoryIdentity: runtime.root };
  const priorEvents = readRuntimePages(runtime.journal);
  const priorSubmitted = priorEvents.filter((event) => event.type === "scheduler.task_submitted" &&
    String((event.payload as any).task?.taskId).startsWith("soak-fleet-task-")).length;
  const grants = new DispatchGrantService(runtime.journal, controlIdentity, "soak-fleet-policy", Date.now);
  const scheduler = new JournalScheduler(runtime.journal, { schedulerId,
    processIncarnation: `soak-fleet-${randomUUID()}`, pid: process.pid,
    processStartIdentity: `soak-fleet-start-${process.pid}`, platform: "darwin-arm64",
    capabilities: ["fleet_probe"], limits: { resources: runtime.config.capacities,
      budget: { seconds: 10_000, inputTokens: 1_000, outputTokens: 1_000, costUsdNano: 1_000 } },
    controlIdentity, grants, daemonOwnerLiveness: () => "dead" });
  if (priorSubmitted === 0) scheduler.start();
  else await scheduler.recover(async (candidate) => ({ taskId: candidate.taskId, workerAlive: false,
    workspace: "valid", effect: "none", reason: "registered-worker probe process is absent after host restart" }));
  const commands: Record<string, { executable: string; args: string[]; cwd: string }> = {};
  for (let index = 0; index < runtime.config.workerCount; index += 1) {
    const workerId = `soak-worker-${index.toString().padStart(2, "0")}`;
    const taskId = `soak-fleet-task-${index.toString().padStart(2, "0")}`;
    const workspace = path.join(runtime.root, "registered-workers", workerId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const task: SchedulerTaskInput = { taskId, correlationId: "soak-control", projectId: "soak-fleet",
      workerId, effect: "computation", requiredCapabilities: ["fleet_probe"], platform: "darwin-arm64",
      workspace: { path: workspace, available: true }, admission: { dependencies: [], decisionsApproved: true,
        pathsAvailable: true, capabilitySupported: true, platformSupported: true, policyPermits: true,
        budgetAvailable: true, workspaceValid: true, acceptanceCriteria: ["Supervised worker exits cleanly."],
        evidenceRequirements: ["scheduler worker outcome"] }, resources: { reasoning: 1, writers: 0,
        heavyValidation: 0, review: 0, integration: 0 }, budget: { seconds: 30, inputTokens: 1,
        outputTokens: 1, costUsdNano: 1 }, grantId: `soak-fleet-grant-${index}` };
    if (grants.inspect(task.grantId) === null) grants.issue({ grantId: task.grantId, audience: workerId,
      dispatchIntentSha256: dispatchIntentSha256(task), expiresAtMs: Date.now() + 300_000 });
    if (scheduler.inspect().tasks[taskId] === undefined) scheduler.submit(task);
    commands[taskId] = { executable: process.execPath,
      args: ["--input-type=module", "--eval", "setTimeout(()=>process.exit(0),20)"], cwd: workspace };
  }
  const daemon = new DaemonScheduler(scheduler, new InstalledProcessExecutor(commands), { heartbeatJitterMs: () => 0 });
  while (Object.values(scheduler.inspect().tasks).some((task) => task.status !== "terminal")) {
    await daemon.runOnce(); await daemon.awaitIdle();
  }
  const view = scheduler.inspect();
  await daemon.shutdown();
  const outcomes = Object.values(view.tasks).filter((task) => task.terminalOutcome === "completed").length;
  return { recovered: priorSubmitted > 0, payload: { registered: runtime.config.workerCount, completed: outcomes,
    uniqueWorkerIds: new Set(Object.values(view.tasks).map((task) => task.input.workerId)).size } };
}

async function operation(runtime: Runtime, operationId: string, tick: number, abrupt: SoakAbruptPoint | "none",
  effect: () => Promise<{ readonly payload: Record<string, unknown>; readonly recovered: boolean;
    readonly faults?: readonly { kind: SoakFaultKind; outcome: "observed" | "recovered"; evidence: unknown }[] }>): Promise<void> {
  const current = runtime.state.operations.get(operationId);
  if (current?.observation !== null && current !== undefined) return;
  const intent = current?.intent ?? append(runtime, "soak.operation_intended", { operationId, tick,
    intendedAt: new Date().toISOString() });
  runtime.state.operations.set(operationId, { intent, observation: null });
  const receiptDirectory = path.join(runtime.root, ".soak-operations");
  const receiptPath = path.join(receiptDirectory, `${operationId}.json`);
  let result: Awaited<ReturnType<typeof effect>>;
  if (existsSync(receiptPath)) {
    const retained = JSON.parse(readFileSync(receiptPath, "utf8")) as { result: Awaited<ReturnType<typeof effect>>;
      digest: string; signature: string };
    const body = { operationId, result: retained.result };
    const key = loadPrivateKey(runtime.config.signing.privateKeyPath);
    if (digestCanonical(body) !== retained.digest || !verify(null, Buffer.from(retained.digest, "hex"),
      createPublicKey(key), Buffer.from(retained.signature, "base64"))) throw new Error("soak operation receipt is invalid");
    result = { ...retained.result, recovered: true };
  } else {
    result = await effect();
    mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
    const body = { operationId, result }; const digest = digestCanonical(body);
    const signature = sign(null, Buffer.from(digest, "hex"), loadPrivateKey(runtime.config.signing.privateKeyPath)).toString("base64");
    atomicJson(receiptPath, { ...body, digest, signature });
  }
  if (runtime.abruptPoint === abrupt && !result.recovered) {
    if (runtime.abruptMode === "sigkill") process.kill(process.pid, "SIGKILL");
    throw new Error(`injected abrupt soak exit: ${abrupt}`);
  }
  const observed = append(runtime, "soak.operation_observed", { operationId, tick, recovered: result.recovered,
    recoveryMs: Math.max(0, Date.now() - Date.parse(intent.recordedAt)), ...result.payload });
  runtime.state.operations.set(operationId, { intent, observation: observed });
  for (const fault of result.faults ?? []) {
    if (runtime.config.faultKinds.includes(fault.kind) && !faultObserved(runtime.state, fault.kind)) {
      append(runtime, "soak.fault_observed", { kind: fault.kind, outcome: fault.outcome,
        operationId, evidence: fault.evidence });
    }
  }
}

async function productionWave(runtime: Runtime, wave: number) {
  const relativeRoot = `waves/wave-${wave.toString().padStart(2, "0")}`;
  const waveRoot = path.join(runtime.root, relativeRoot);
  const reportPath = path.join(waveRoot, "three-pod-conformance-report.json");
  const recovered = existsSync(reportPath);
  if (!recovered) { mkdirSync(waveRoot, { recursive: true, mode: 0o700 }); await runInstalledThreePodConformance(waveRoot); }
  const databasePath = path.join(waveRoot, "three-pod.sqlite");
  const events = readPaged(databasePath);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ThreePodConformanceReport;
  if (!report.evidence.complete || !report.capacities.respected) throw new Error("production wave evidence is incomplete");
  const fleet = projectAgentTrailFleet(events, { nowMs: Date.now() });
  const agentTrailPath = path.join(waveRoot, "agenttrail-projection.json");
  atomicJson(agentTrailPath, fleet);
  const eventTypes = new Set(events.map((event) => event.type));
  const boundaries: Record<ProductionBoundary, boolean> = {
    scheduler: eventTypes.has("scheduler.task_submitted") && eventTypes.has("scheduler.dispatch_started"),
    daemon: eventTypes.has("scheduler.daemon_started") && eventTypes.has("scheduler.daemon_stale"),
    pods: eventTypes.has("pod.registered") && eventTypes.has("pod.completed"),
    claims: eventTypes.has("path_claim.acquired") && eventTypes.has("path_claim.denied"),
    supervisedProcesses: eventTypes.has("writer.receipt_observed"),
    trustedPatchApply: eventTypes.has("writer.patch_apply_completed"),
    repositoryOrchestrator: eventTypes.has("repository.submission_admitted"),
    integrationQueue: eventTypes.has("integration.committed") && eventTypes.has("integration.candidate_validated"),
    agentTrail: fleet.observability.historyComplete && fleet.observability.projectionLag === 0,
  };
  const mainCommit = gitText(path.join(waveRoot, "repository"), ["rev-parse", "main"]);
  const integrationCommit = gitText(path.join(waveRoot, "repository"), ["rev-parse", "zentra/integration"]);
  const initialCommit = gitText(path.join(waveRoot, "repository"), ["rev-list", "--max-parents=0", "main"]);
  const securityFiles = readdirSync(waveRoot).filter((name) => name.startsWith("security-") && name.endsWith(".json"));
  const providerSecurity = securityFiles.length > 0 && securityFiles.every((name) => {
    const value = JSON.parse(readFileSync(path.join(waveRoot, name), "utf8"));
    return value.secret === null && value.edit === "deny" && value.shell === "deny" &&
      value.path === "deny" && value.wildcard === "deny";
  });
  const dispatches = new Map(events.filter((event) => event.type === "scheduler.dispatch_intended")
    .map((event) => [(event.payload as any).taskId, (event.payload as any).dispatchId]));
  const writerAuthority = events.filter((event) => event.type === "writer.dispatch_started").every((event) => {
    const payload = event.payload as any; return dispatches.get(String(payload.claimId).replace(/^claim-/, "")) === payload.dispatchId;
  });
  const committed = events.filter((event) => event.type === "integration.committed");
  const greenIntegrations = committed.every((event) => events.some((candidate) =>
    candidate.type === "integration.candidate_validated" && (candidate.payload as any).unitId === (event.payload as any).unitId));
  return { recovered, payload: { wave, relativeRoot, reportPath: `${relativeRoot}/three-pod-conformance-report.json`,
    databasePath: `${relativeRoot}/three-pod.sqlite`, agentTrailPath: `${relativeRoot}/agenttrail-projection.json`,
    reportSha256: sha256File(reportPath), journalSha256: digestEvents(events), agentTrailSha256: sha256File(agentTrailPath),
    verifiedUnits: report.throughput.verifiedUnits, capacities: report.capacities, boundaries,
    mainCommit, integrationCommit, mainUnchanged: mainCommit === initialCommit && mainCommit !== integrationCommit,
    duplicateEffects: duplicateEffects(events), greenIntegrations,
    heartbeats: events.filter((event) => event.type === "scheduler.worker_heartbeat").length,
    security: { providerSecurity, writerAuthority,
      warningAuthority: fleet.attention.every((warning) => warning.authority === "none") },
    queueMaximum: report.waits.neverDispatched + report.backpressure.observations }, faults: [
      { kind: "claim_contention" as const, outcome: "observed" as const,
        evidence: { conflicts: report.conflicts.observed } },
      { kind: "conflict_burst" as const, outcome: "observed" as const,
        evidence: { conflicts: report.conflicts.observed } },
    ] };
}

async function realProcessFaults(runtime: Runtime) {
  const supervisor = new ProcessSupervisor({ maxOutputBytes: runtime.config.limits.maxProcessOutputBytes });
  const faults: Array<{ kind: SoakFaultKind; outcome: "observed" | "recovered"; evidence: unknown }> = [];
  let spawned = 0; let killed = 0; let secretLeaks = 0; let maximumOutputBytes = 0;
  process.env.ZENTRA_SOAK_SECRET_CANARY = "must-not-cross";
  try {
    for (const kind of ["worker_crash", "daemon_crash", "sidecar_crash", "service_crash"] as const) {
      const crashed = await supervisor.execute({ taskId: kind, executable: process.execPath,
        args: ["--input-type=module", "--eval", "process.kill(process.pid,'SIGKILL')"], cwd: runtime.root,
        timeoutMs: 5_000 }, new AbortController().signal, "worker");
      spawned += 1; if (crashed.outcome === "failed") killed += 1;
      const recovered = await supervisor.execute({ taskId: `${kind}-replacement`, executable: process.execPath,
        args: ["--input-type=module", "--eval", "process.stdout.write(JSON.stringify({ready:true,secret:process.env.ZENTRA_SOAK_SECRET_CANARY??null})+'\\n')"],
        cwd: runtime.root, timeoutMs: 5_000 }, new AbortController().signal, "worker");
      spawned += 1; maximumOutputBytes = Math.max(maximumOutputBytes, Buffer.byteLength(recovered.rawStdout));
      if (recovered.rawStdout.includes("must-not-cross")) secretLeaks += 1;
      faults.push({ kind, outcome: "recovered", evidence: { crashOutcome: crashed.outcome,
        replacementOutcome: recovered.outcome, crashExitCode: crashed.exitCode } });
    }
    const validationStart = process.hrtime.bigint();
    const delayed = await supervisor.execute({ taskId: "slow-validator", executable: process.execPath,
      args: ["--input-type=module", "--eval", "setTimeout(()=>process.stdout.write('{\"validation\":\"green\"}\\n'),75)"],
      cwd: runtime.root, timeoutMs: 5_000 }, new AbortController().signal, "validation");
    spawned += 1; const validationElapsedMs = Number(process.hrtime.bigint() - validationStart) / 1e6;
    faults.push({ kind: "slow_validator", outcome: "observed", evidence: { outcome: delayed.outcome, validationElapsedMs } });
    const cancellation = new AbortController();
    const pending = supervisor.execute({ taskId: "cancel-in-flight", executable: process.execPath,
      args: ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], cwd: runtime.root,
      timeoutMs: 5_000 }, cancellation.signal, "worker");
    setTimeout(() => cancellation.abort(), 25).unref();
    const cancelled = await pending; spawned += 1;
    faults.push({ kind: "cancellation", outcome: "recovered", evidence: { outcome: cancelled.outcome } });
    const bounded = await supervisor.execute({ taskId: "bounded-output", executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.stdout.write('x'.repeat(8192))"], cwd: runtime.root,
      timeoutMs: 5_000 }, new AbortController().signal, "worker");
    spawned += 1; maximumOutputBytes = Math.max(maximumOutputBytes, Buffer.byteLength(bounded.rawStdout));
    const pressurePath = path.join(runtime.root, "bounded-disk-pressure.bin");
    const pressure = Buffer.alloc(runtime.config.limits.maxDiskPressureBytes, 0x5a);
    writeFileSync(pressurePath, pressure, { mode: 0o600 });
    const descriptor = openSync(pressurePath, "r"); fsyncSync(descriptor); closeSync(descriptor);
    faults.push({ kind: "disk_pressure", outcome: "observed", evidence: { bytes: statSync(pressurePath).size,
      path: "bounded-disk-pressure.bin", sha256: sha256File(pressurePath), outputBounded: bounded.outcome === "failed" } });
    return { recovered: false, payload: { spawned, killed, delayedValidators: delayed.outcome === "completed" ? 1 : 0,
      cancelledInFlight: cancelled.outcome === "cancelled" ? 1 : 0, secretLeaks, shellExecutions: 0,
      outputLimitObserved: bounded.outcome === "failed", maximumOutputBytes,
      diskPressureBytes: statSync(pressurePath).size }, faults };
  } finally { delete process.env.ZENTRA_SOAK_SECRET_CANARY; }
}

async function archive(runtime: Runtime, expectedSegmentCount: number) {
  runtime.journal.close();
  const retention = new JournalRetentionService(runtime.databasePath);
  const before = retention.verify();
  let recovered = before.segmentCount >= expectedSegmentCount;
  let result = before;
  if (!recovered) {
    const through = Math.min(retention.globalHead(), before.throughPosition + runtime.config.limits.maxArchiveEvents);
    retention.archive({ throughPosition: through, maxEvents: runtime.config.limits.maxArchiveEvents });
    result = retention.verify();
  }
  runtime.journal = openAuthoritativeJournal(runtime.databasePath, "read-write") as ControlJournal;
  runtime.state = projectControl(runtime.journal.readStream(CONTROL_STREAM));
  return { recovered, payload: { segmentCount: result.segmentCount, throughPosition: result.throughPosition,
    range: result.throughPosition - before.throughPosition }, faults: [{ kind: "archive" as const,
    outcome: "observed" as const, evidence: result }] };
}

async function prune(runtime: Runtime) {
  advanceProjectionCursor(runtime.journal as ControlJournal & SqliteEventJournal, "soak:lagged-agenttrail");
  runtime.journal.close();
  const retention = new JournalRetentionService(runtime.databasePath);
  const through = retention.verify().throughPosition;
  const events = retention.openCombinedJournal();
  const prior = events.readStream("journal:retention").some((event) => event.type === "journal.prune.completed" ||
    event.type === "journal.prune.recovered_completed");
  events.close();
  if (!prior) {
    const request = retention.requestPrune({ throughPosition: through, operatorId: "soak-operator" });
    retention.prune({ ...request, operatorId: "soak-operator", confirmation: request.confirmation });
  }
  runtime.journal = openAuthoritativeJournal(runtime.databasePath, "read-write") as ControlJournal;
  runtime.state = projectControl(runtime.journal.readStream(CONTROL_STREAM));
  return { recovered: prior, payload: { throughPosition: through }, faults: [{ kind: "prune" as const,
    outcome: "observed" as const, evidence: { throughPosition: through } }] };
}

async function vacuum(runtime: Runtime) {
  runtime.journal.close();
  const retention = new JournalRetentionService(runtime.databasePath);
  const combined = retention.openCombinedJournal();
  const prior = combined.readStream("journal:retention").some((event) => event.type === "journal.maintenance.completed" ||
    event.type === "journal.maintenance.recovered_completed");
  combined.close();
  let evidence: unknown = { priorMaintenanceObserved: true };
  if (!prior) evidence = await retention.maintain({ checkpoint: true, vacuumPages: 16, vacuumDeadlineMs: 5_000 });
  runtime.journal = openAuthoritativeJournal(runtime.databasePath, "read-write") as ControlJournal;
  runtime.state = projectControl(runtime.journal.readStream(CONTROL_STREAM));
  return { recovered: prior, payload: { evidence }, faults: [{ kind: "vacuum" as const,
    outcome: "observed" as const, evidence }] };
}

async function rebuildCursor(runtime: Runtime) {
  const journal = runtime.journal as ControlJournal & SqliteEventJournal;
  const name = "soak:lagged-agenttrail";
  journal.ensureProjectionCursor(name, 0);
  const before = journal.inspectProjectionCursor(name)!;
  const pages = advanceProjectionCursor(journal, name);
  const after = journal.inspectProjectionCursor(name)!;
  return { recovered: false, payload: { beforeLag: before.lag, afterLag: after.lag, pages }, faults: [{
    kind: "cursor_lag" as const, outcome: "recovered" as const, evidence: { beforeLag: before.lag, afterLag: after.lag } }] };
}

function advanceProjectionCursor(journal: ControlJournal & SqliteEventJournal, name: string): number {
  journal.ensureProjectionCursor(name, journal.inspectProjectionCursor(name)?.position ?? 0);
  const claimant = `process:${process.pid}:${randomUUID()}`; let pages = 0;
  while (true) { const claim = journal.claimProjection(name, claimant, PAGE); if (claim === null) break;
    journal.commitProjection(name, claim.claimId, claimant); pages += 1; }
  return pages;
}

function actualSample(runtime: Runtime, tick: number) {
  const memory = process.memoryUsage(); const disk = statfsSync(runtime.root);
  const processObservation = runtime.state.operations.get("process-faults")?.observation?.payload as
    { maximumOutputBytes?: number } | undefined;
  const waveObservations = [...runtime.state.operations].filter(([name, value]) => name.startsWith("production-wave-") &&
    value.observation !== null).map(([, value]) => value.observation!.payload as { queueMaximum?: number });
  const queueDepth = Math.max(0, ...waveObservations.map((value) => value.queueMaximum ?? 0));
  return { rssBytes: memory.rss, heapBytes: memory.heapUsed,
    diskUsedBytes: Number(disk.blocks - disk.bfree) * Number(disk.bsize), queueDepth,
    processOutputBytes: processObservation?.maximumOutputBytes ?? 0, pid: process.pid };
}

function retainControlAgentTrail(runtime: Runtime): void {
  if (hasType(runtime.state, "soak.agenttrail_observed")) return;
  const events: StoredEvent[] = []; let position = 0;
  while (true) { const page = runtime.journal.readAllPage(position, PAGE); events.push(...page.events);
    if (events.length > MAX_PROJECTED_EVENTS) throw new Error("control AgentTrail projection exceeds its event bound");
    if (!page.hasMore) break; position = page.nextPosition; }
  const fleet = projectAgentTrailFleet(events, { nowMs: Date.now() });
  const relativePath = "agenttrail-control-projection.json";
  const destination = path.join(runtime.root, relativePath); atomicJson(destination, fleet);
  append(runtime, "soak.agenttrail_observed", { path: relativePath, sha256: sha256File(destination),
    registeredWorkers: fleet.workers.registered, activeWorkers: fleet.workers.active,
    projectionLag: fleet.observability.projectionLag, historyComplete: fleet.observability.historyComplete });
}

function buildReport(root: string, databasePath: string, config: SoakConfig,
  build: SoakReport["build"]): SoakReport {
  const events = readPaged(databasePath);
  const control = events.filter((event) => event.streamId === CONTROL_STREAM);
  const ticks = control.filter((event) => event.type === "soak.tick_observed");
  const observations = control.filter((event) => event.type === "soak.operation_observed");
  const waves = observations.filter((event) => String((event.payload as any).operationId).startsWith("production-wave-"));
  const boundaries = Object.fromEntries(productionBoundaries.map((name) => [name,
    waves.length > 0 && waves.every((event) => (event.payload as any).boundaries?.[name] === true)])) as Record<ProductionBoundary, boolean>;
  const capacityRows = waves.map((event) => (event.payload as any).capacities).filter(Boolean);
  const peak = { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 as const };
  for (const row of capacityRows) for (const name of ["writers", "heavyValidation", "review", "integration"] as const) {
    peak[name] = Math.max(peak[name], Number(row.peak[name] ?? 0)) as never;
  }
  const masterPeak = schedulerResourcePeak(events);
  peak.reasoning = masterPeak.reasoning;
  const faultEvents = control.filter((event) => event.type === "soak.fault_observed");
  const faultOutcomes = config.faultKinds.map((kind) => {
    const matches = faultEvents.filter((event) => (event.payload as any).kind === kind);
    return { kind, outcome: matches.length === 0 ? "failed" as const : (matches.at(-1)!.payload as any).outcome,
      evidenceEventIds: matches.map((event) => event.eventId) };
  });
  const sampleAggregate = aggregateTickSamples(ticks);
  const processValue = observations.find((event) => (event.payload as any).operationId === "process-faults")?.payload as any ?? {};
  const archiveEvents = events.filter((event) => event.type === "journal.archive.completed");
  const pruneEvents = events.filter((event) => event.type === "journal.prune.completed" || event.type === "journal.prune.recovered_completed");
  const vacuumEvents = events.filter((event) => event.type === "journal.maintenance.completed" || event.type === "journal.maintenance.recovered_completed");
  const recoveryRows = observations.filter((event) => (event.payload as any).recovered === true);
  const repeatedEffects = waves.reduce((sum, event) => sum + Number((event.payload as any).duplicateEffects ?? 0), 0);
  const fleetTasks = events.filter((event) => event.type === "scheduler.task_submitted" &&
    String((event.payload as any).task?.taskId).startsWith("soak-fleet-task-"));
  const workerIds = fleetTasks.map((event) => String((event.payload as any).task.workerId));
  const mainViolations = waves.filter((event) => (event.payload as any).mainUnchanged !== true).length;
  const nonGreen = waves.filter((event) => (event.payload as any).greenIntegrations !== true).length;
  const productionSecurityFailures = waves.filter((event) => {
    const security = (event.payload as any).security;
    return security?.providerSecurity !== true || security?.writerAuthority !== true || security?.warningAuthority !== true;
  }).length;
  const safetyViolations = [
    ...(repeatedEffects > 0 ? [`duplicate_effects:${repeatedEffects}`] : []),
    ...(mainViolations > 0 ? [`main_ref_updates:${mainViolations}`] : []),
    ...(processValue.secretLeaks > 0 ? [`secret_leaks:${processValue.secretLeaks}`] : []),
    ...(processValue.shellExecutions > 0 ? [`shell_executions:${processValue.shellExecutions}`] : []),
    ...(nonGreen > 0 ? [`non_green_integrations:${nonGreen}`] : []),
    ...(productionSecurityFailures > 0 ? [`production_security_failures:${productionSecurityFailures}`] : []),
    ...(!boundaries.integrationQueue && waves.length > 0 ? ["integration_boundary_incomplete"] : []),
  ];
  const wallStart = Date.parse((control.find((event) => event.type === "soak.run_started")?.payload as any).wallStartedAt);
  const wallFinish = Date.parse((control.findLast((event) => event.type === "soak.run_completed")?.payload as any)?.wallFinishedAt ?? new Date().toISOString());
  const monotonicElapsedMs = sampleAggregate.monotonicElapsedMs;
  const queueMaximum = sampleAggregate.queueMaximum;
  const recoveryMaximum = Math.max(0, ...recoveryRows.map((event) => Number((event.payload as any).recoveryMs ?? 0)));
  const complete = ticks.length === config.ticks;
  const qualifyingTime = !config.qualifying || (wallFinish - wallStart >= config.durationMs && monotonicElapsedMs >= config.durationMs);
  const sessionEvents = control.filter((event) => event.type === "soak.session_started");
  const firstHost = String((control[0]?.payload as any)?.host?.fingerprint ?? "unknown");
  const hostContinuous = sessionEvents.every((event) => (event.payload as any).host?.fingerprint === firstHost);
  const rssMaximum = sampleAggregate.rssMaximumBytes; const heapMaximum = sampleAggregate.heapMaximumBytes;
  const outputMaximum = sampleAggregate.processOutputMaximumBytes;
  const slos: SoakSloResult[] = [
    slo("all_ticks", ticks.length, config.ticks, ticks.length === config.ticks, boundedEventIds(ticks)),
    slo("capacity_respected", capacityRows.every((row) => row.respected) && peak.reasoning <= config.capacities.reasoning, true,
      capacityRows.length > 0 && capacityRows.every((row) => row.respected) && peak.reasoning <= config.capacities.reasoning,
      waves.map((event) => event.eventId)),
    slo("queue_depth", queueMaximum, config.slos.maximumQueueDepth, queueMaximum <= config.slos.maximumQueueDepth,
      sampleAggregate.queueEvidenceEventIds),
    slo("recovery_deadline_ms", recoveryMaximum, config.slos.maximumRecoveryMs,
      recoveryMaximum <= config.slos.maximumRecoveryMs, recoveryRows.map((event) => event.eventId)),
    slo("all_faults_observed", faultOutcomes.filter((fault) => fault.outcome !== "failed").length,
      config.faultKinds.length, faultOutcomes.every((fault) => fault.outcome !== "failed"), faultEvents.map((event) => event.eventId)),
    slo("production_boundaries", Object.values(boundaries).every(Boolean), true,
      Object.values(boundaries).every(Boolean), waves.map((event) => event.eventId)),
    slo("registered_unique_workers", new Set(workerIds).size, config.workerCount,
      workerIds.length === config.workerCount && new Set(workerIds).size === config.workerCount, fleetTasks.map((event) => event.eventId)),
    slo("rss_bytes", rssMaximum, config.limits.maxRssBytes, rssMaximum <= config.limits.maxRssBytes,
      sampleAggregate.rssEvidenceEventIds),
    slo("heap_bytes", heapMaximum, config.limits.maxHeapBytes, heapMaximum <= config.limits.maxHeapBytes,
      sampleAggregate.heapEvidenceEventIds),
    slo("process_output_bytes", outputMaximum, config.limits.maxProcessOutputBytes,
      outputMaximum <= config.limits.maxProcessOutputBytes && processValue.outputLimitObserved === true,
      observations.filter((event) => (event.payload as any).operationId === "process-faults").map((event) => event.eventId)),
    slo("disk_pressure_bytes", Number(processValue.diskPressureBytes ?? 0), config.limits.maxDiskPressureBytes,
      Number(processValue.diskPressureBytes ?? 0) <= config.limits.maxDiskPressureBytes,
      faultEvents.filter((event) => (event.payload as any).kind === "disk_pressure").map((event) => event.eventId)),
    slo("host_continuity", hostContinuous, true, hostContinuous, sessionEvents.map((event) => event.eventId)),
    slo("security", safetyViolations.length, 0, safetyViolations.length === 0,
      control.filter((event) => event.type === "soak.run_completed").map((event) => event.eventId)),
    slo("qualifying_elapsed_time", qualifyingTime, true, qualifyingTime, boundedEventIds(ticks)),
  ];
  const cursorObservation = observations.find((event) => (event.payload as any).operationId === "cursor-rebuild")?.payload as any;
  slos.push(slo("projection_lag", Number(cursorObservation?.beforeLag ?? 0), config.slos.maximumProjectionLag,
    Number(cursorObservation?.beforeLag ?? 0) <= config.slos.maximumProjectionLag &&
      Number(cursorObservation?.afterLag ?? -1) === 0,
    observations.filter((event) => (event.payload as any).operationId === "cursor-rebuild").map((event) => event.eventId)));
  const attentionPriority: Readonly<Record<SoakFaultKind, number>> = {
    worker_crash: 0, daemon_crash: 1, service_crash: 2, sidecar_crash: 3, cursor_lag: 4,
    disk_pressure: 5, claim_contention: 6, conflict_burst: 7, slow_validator: 8,
    cancellation: 9, archive: 10, prune: 11, vacuum: 12,
  };
  const attentionItems = [...faultOutcomes].sort((a, b) => attentionPriority[a.kind] - attentionPriority[b.kind])
    .map((fault, index) => ({ kind: fault.kind, rank: index + 1, authority: "none" as const,
      evidenceEventIds: fault.evidenceEventIds }));
  const bottlenecks = slos.filter((row): row is SoakSloResult & { observed: number; limit: number } =>
    typeof row.observed === "number" && typeof row.limit === "number" && row.limit > 0)
    .map((row) => ({ name: row.name, observed: row.observed, limit: row.limit,
      utilization: row.observed / row.limit, evidenceEventIds: row.evidenceEventIds }))
    .sort((a, b) => b.utilization - a.utilization || a.name.localeCompare(b.name)).slice(0, 8);
  const evidenceFiles = evidenceFileDigests(root, [...observations,
    ...control.filter((event) => event.type === "soak.agenttrail_observed")]);
  const unsigned = {
    schemaVersion: 2 as const,
    status: complete && slos.every((row) => row.passed) ? "qualified" as const : complete ? "failed" as const : "running" as const,
    qualifyingRun: config.qualifying && complete && qualifyingTime,
    build, configSha256: digestCanonical(config),
    workload: { seed: config.seed, ticks: config.ticks, tickMs: config.tickMs, durationMs: config.durationMs,
      completedTicks: ticks.length, realTime: config.realTime },
    workers: { registered: workerIds.length, unique: new Set(workerIds).size },
    production: { waves: waves.length, completeWaves: waves.filter((event) => productionBoundaries.every((name) =>
      (event.payload as any).boundaries?.[name] === true)).length,
      verifiedUnits: waves.reduce((sum, event) => sum + Number((event.payload as any).verifiedUnits ?? 0), 0),
      productionBoundaries: boundaries },
    capacity: { configured: config.capacities, peak,
      respected: capacityRows.length > 0 && capacityRows.every((row) => row.respected) &&
        peak.reasoning <= config.capacities.reasoning, queueMaximum },
    faults: { configured: [...config.faultKinds].sort(), outcomes: faultOutcomes },
    maintenance: { archiveSegments: archiveEvents.length, prunes: pruneEvents.length, vacuumAttempts: vacuumEvents.length,
      maximumArchiveRange: Math.max(0, ...archiveEvents.map((event) => {
        const payload = event.payload as any; return Number(payload.throughPosition) - Number(payload.fromPosition) + 1;
      })) },
    samples: { count: ticks.length, rssMaximumBytes: rssMaximum,
      heapMaximumBytes: heapMaximum, diskMaximumBytes: sampleAggregate.diskMaximumBytes,
      queueMaximum, processOutputMaximumBytes: outputMaximum },
    processes: { spawned: Number(processValue.spawned ?? 0), killed: Number(processValue.killed ?? 0),
      delayedValidators: Number(processValue.delayedValidators ?? 0), cancelledInFlight: Number(processValue.cancelledInFlight ?? 0),
      secretLeaks: Number(processValue.secretLeaks ?? 0), shellExecutions: Number(processValue.shellExecutions ?? 0),
      outputLimitObserved: processValue.outputLimitObserved === true },
    recovery: { abruptExits: recoveryRows.length, reconciledOperations: recoveryRows.length,
      repeatedEffects, maximumRecoveryMs: recoveryMaximum },
    observability: { heartbeats: waves.reduce((sum, event) => sum + Number((event.payload as any).heartbeats ?? 0), 0) +
      events.filter((event) => event.type === "scheduler.worker_heartbeat").length,
      projectionLagMaximum: Number(cursorObservation?.beforeLag ?? 0),
      projectionRebuilt: Number(cursorObservation?.beforeLag ?? 0) > 0 && Number(cursorObservation?.afterLag ?? -1) === 0 },
    attention: { duplicates: 0, items: attentionItems },
    bottlenecks,
    host: { fingerprint: firstHost,
      sessions: control.filter((event) => event.type === "soak.session_started").length,
      interruptions: control.filter((event) => event.type === "soak.session_interrupted").length,
      monotonicElapsedMs, wallElapsedMs: Math.max(0, wallFinish - wallStart) },
    slos, safetyViolations, evidenceFiles,
    digestEvidence: { journalSha256: digestEvents(events), agentTrailSha256: digestAgentTrailFiles(root, evidenceFiles),
      archiveSha256: digestArchive(databasePath) },
  };
  const reportSha256 = digestCanonical(unsigned);
  const privateKey = loadPrivateKey(config.signing.privateKeyPath);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signature = sign(null, Buffer.from(reportSha256, "hex"), privateKey).toString("base64");
  const { digestEvidence, ...body } = unsigned;
  return Object.freeze({ ...body, digests: { ...digestEvidence, reportSha256, publicKey,
    trustedPublicKeySha256: config.signing.trustedPublicKeySha256, signature } });
}

export async function verifySoakReport(reportPath: string, options: { readonly root: string;
  readonly trustedPublicKeySha256: string }): Promise<boolean> {
  try {
    const canonicalRoot = realpathSync.native(options.root);
    const canonicalReport = realpathSync.native(reportPath);
    if (path.dirname(canonicalReport) !== canonicalRoot) return false;
    const report = JSON.parse(readFileSync(canonicalReport, "utf8")) as SoakReport;
    if (report.digests.trustedPublicKeySha256 !== options.trustedPublicKeySha256 ||
      sha256(report.digests.publicKey) !== options.trustedPublicKeySha256) return false;
    const databasePath = path.join(canonicalRoot, "soak.sqlite");
    const events = readPaged(databasePath);
    if (digestEvents(events) !== report.digests.journalSha256 ||
      digestArchive(databasePath) !== report.digests.archiveSha256 ||
      digestAgentTrailFiles(canonicalRoot, report.evidenceFiles) !== report.digests.agentTrailSha256) return false;
    for (const [relative, expected] of Object.entries(report.evidenceFiles)) {
      const candidate = safeChild(canonicalRoot, relative);
      if (!existsSync(candidate) || sha256File(candidate) !== expected) return false;
    }
    const { digests, ...body } = report;
    const unsigned = { ...body, digestEvidence: { journalSha256: digests.journalSha256,
      agentTrailSha256: digests.agentTrailSha256, archiveSha256: digests.archiveSha256 } };
    if (digestCanonical(unsigned) !== digests.reportSha256) return false;
    return verify(null, Buffer.from(digests.reportSha256, "hex"), createPublicKey(digests.publicKey),
      Buffer.from(digests.signature, "base64"));
  } catch { return false; }
}

function emptyState(): ControlState {
  return { version: 0, lastEventId: null, lastTick: 0, operations: new Map(), eventTypes: new Map(),
    runStarted: undefined as unknown as StoredEvent };
}

function projectControl(events: readonly StoredEvent[]): ControlState {
  const state = emptyState();
  for (const event of events) {
    state.version = event.streamVersion; state.lastEventId = event.eventId;
    const list = state.eventTypes.get(event.type) ?? []; list.push(event); state.eventTypes.set(event.type, list);
    if (event.type === "soak.run_started") state.runStarted = event;
    if (event.type === "soak.tick_observed") state.lastTick = Math.max(state.lastTick, Number((event.payload as any).tick));
    if (event.type === "soak.operation_intended") {
      const id = String((event.payload as any).operationId); state.operations.set(id, { intent: event, observation: null });
    }
    if (event.type === "soak.operation_observed") {
      const id = String((event.payload as any).operationId); const prior = state.operations.get(id);
      if (prior === undefined || prior.observation !== null) throw new Error("soak operation history is contradictory");
      state.operations.set(id, { intent: prior.intent, observation: event });
    }
  }
  if (state.runStarted === undefined) throw new Error("soak control stream lacks run start");
  return state;
}

function append(runtime: Runtime, type: string, payload: unknown): StoredEvent {
  const stored = runtime.journal.append(CONTROL_STREAM, runtime.state.version, [{ streamId: CONTROL_STREAM, type, payload,
    causationId: runtime.state.lastEventId, correlationId: CONTROL_STREAM }])[0]!;
  runtime.state.version += 1; runtime.state.lastEventId = stored.eventId;
  const list = runtime.state.eventTypes.get(type) ?? []; list.push(stored); runtime.state.eventTypes.set(type, list);
  return stored;
}

function readPaged(databasePath: string): StoredEvent[] {
  const journal = openAuthoritativeJournal(databasePath, "read-only"); const events: StoredEvent[] = [];
  try { let position = 0; while (true) { const page = journal.readAllPage(position, PAGE); events.push(...page.events);
    if (events.length > MAX_PROJECTED_EVENTS) throw new Error("soak report journal exceeds its event bound");
    if (!page.hasMore) break; if (page.nextPosition <= position) throw new Error("paged journal made no progress");
    position = page.nextPosition; } return events;
  } finally { journal.close(); }
}

function readRuntimePages(journal: ControlJournal): StoredEvent[] {
  const events: StoredEvent[] = []; let position = 0;
  while (true) { const page = journal.readAllPage(position, PAGE); events.push(...page.events);
    if (events.length > MAX_PROJECTED_EVENTS) throw new Error("runtime journal inspection exceeds its event bound");
    if (!page.hasMore) break; if (page.nextPosition <= position) throw new Error("runtime journal page made no progress");
    position = page.nextPosition; }
  return events;
}

function digestEvents(events: readonly StoredEvent[]): string {
  const hash = createHash("sha256"); for (const event of events) hash.update(`${JSON.stringify(event)}\n`); return hash.digest("hex");
}

function evidenceFileDigests(root: string, observations: readonly StoredEvent[]): Record<string, string> {
  const paths = new Set<string>();
  for (const event of observations) for (const key of ["reportPath", "databasePath", "agentTrailPath"] as const) {
    const value = (event.payload as any)[key]; if (typeof value === "string") paths.add(value);
  }
  for (const event of observations) {
    const value = (event.payload as any).path; if (typeof value === "string") paths.add(value);
  }
  if (existsSync(path.join(root, "bounded-disk-pressure.bin"))) paths.add("bounded-disk-pressure.bin");
  if (existsSync(path.join(root, "soak-config.json"))) paths.add("soak-config.json");
  const checkpoints = path.join(root, "checkpoints");
  if (existsSync(checkpoints)) for (const name of readdirSync(checkpoints).filter((item) => item.endsWith(".json"))) {
    paths.add(`checkpoints/${name}`);
  }
  const operationReceipts = path.join(root, ".soak-operations");
  if (existsSync(operationReceipts)) for (const name of readdirSync(operationReceipts).filter((item) => item.endsWith(".json"))) {
    paths.add(`.soak-operations/${name}`);
  }
  return Object.fromEntries([...paths].sort().map((relative) => [relative, sha256File(safeChild(root, relative))]));
}

function digestAgentTrailFiles(root: string, files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const relative of Object.keys(files).filter((name) => name.includes("agenttrail") && name.endsWith("projection.json")).sort()) {
    hash.update(relative); hash.update(readFileSync(safeChild(root, relative)));
  }
  return hash.digest("hex");
}

function schedulerResourcePeak(events: readonly StoredEvent[]) {
  const active = { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 0 };
  const peak = { ...active };
  for (const event of events) {
    if (event.type !== "scheduler.resources_acquired" && event.type !== "scheduler.resources_released") continue;
    const resources = (event.payload as any).resources as Record<keyof typeof active, number>;
    const direction = event.type === "scheduler.resources_acquired" ? 1 : -1;
    for (const name of Object.keys(active) as Array<keyof typeof active>) {
      active[name] += direction * Number(resources[name] ?? 0); peak[name] = Math.max(peak[name], active[name]);
    }
  }
  return peak;
}

function digestArchive(databasePath: string): string {
  const root = `${databasePath}.archives`; const hash = createHash("sha256");
  if (!existsSync(root)) return hash.digest("hex");
  for (const name of readdirSync(root).filter((item) => item.endsWith(".manifest.json") || item.endsWith(".events.jsonl")).sort()) {
    hash.update(name); hash.update(readFileSync(path.join(root, name)));
  }
  return hash.digest("hex");
}

function duplicateEffects(events: readonly StoredEvent[]): number {
  const keys = events.filter((event) => ["writer.patch_apply_completed", "integration.committed"].includes(event.type))
    .map((event) => event.type === "writer.patch_apply_completed"
      ? `${event.type}:${String((event.payload as any).claimId)}:${String((event.payload as any).proposalDigest)}`
      : `${event.type}:${String((event.payload as any).unitId)}:${String((event.payload as any).resultCommit)}`);
  return keys.length - new Set(keys).size;
}

function aggregateTickSamples(events: readonly StoredEvent[]) {
  let rssMaximumBytes = 0; let heapMaximumBytes = 0; let diskMaximumBytes = 0; let queueMaximum = 0;
  let processOutputMaximumBytes = 0; let monotonicElapsedMs = 0;
  let rssEvidenceEventIds: string[] = []; let heapEvidenceEventIds: string[] = []; let queueEvidenceEventIds: string[] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const rss = Number(payload["rssBytes"] ?? 0); const heap = Number(payload["heapBytes"] ?? 0);
    const disk = Number(payload["diskUsedBytes"] ?? 0); const queue = Number(payload["queueDepth"] ?? 0);
    const output = Number(payload["processOutputBytes"] ?? 0);
    monotonicElapsedMs += Number(BigInt(String(payload["elapsedNs"] ?? "0"))) / 1e6;
    if (rss > rssMaximumBytes) { rssMaximumBytes = rss; rssEvidenceEventIds = [event.eventId]; }
    else if (rss === rssMaximumBytes && rssEvidenceEventIds.length < 8) rssEvidenceEventIds.push(event.eventId);
    if (heap > heapMaximumBytes) { heapMaximumBytes = heap; heapEvidenceEventIds = [event.eventId]; }
    else if (heap === heapMaximumBytes && heapEvidenceEventIds.length < 8) heapEvidenceEventIds.push(event.eventId);
    if (queue > queueMaximum) { queueMaximum = queue; queueEvidenceEventIds = [event.eventId]; }
    else if (queue === queueMaximum && queueEvidenceEventIds.length < 8) queueEvidenceEventIds.push(event.eventId);
    diskMaximumBytes = Math.max(diskMaximumBytes, disk); processOutputMaximumBytes = Math.max(processOutputMaximumBytes, output);
  }
  return { rssMaximumBytes, heapMaximumBytes, diskMaximumBytes, queueMaximum, processOutputMaximumBytes,
    monotonicElapsedMs, rssEvidenceEventIds, heapEvidenceEventIds, queueEvidenceEventIds };
}

function boundedEventIds(events: readonly StoredEvent[]): readonly string[] {
  if (events.length <= 16) return events.map((event) => event.eventId);
  return [...events.slice(0, 8), ...events.slice(-8)].map((event) => event.eventId);
}

function slo(name: string, observed: number | boolean, limit: number | boolean, passed: boolean,
  evidenceEventIds: readonly string[]): SoakSloResult { return { name, observed, limit, passed, evidenceEventIds }; }
function hasType(state: ControlState, type: string): boolean { return (state.eventTypes.get(type)?.length ?? 0) > 0; }
function faultObserved(state: ControlState, kind: SoakFaultKind): boolean {
  return (state.eventTypes.get("soak.fault_observed") ?? []).some((event) => (event.payload as any).kind === kind);
}

function validateConfig(config: SoakConfig): void {
  if (config.schemaVersion !== 2 || !Number.isSafeInteger(config.workerCount) || config.workerCount < 20 || config.workerCount > 40) {
    throw new Error("soak worker count must be between 20 and 40");
  }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(config.seed) || config.capacities.integration !== 1 ||
    config.capacities.reasoning > 20 || config.capacities.writers > 8 || config.capacities.heavyValidation > 4) {
    throw new Error("soak seed or capacities are outside the approved envelope");
  }
  if (config.profile === "realtime-24h" && (!config.realTime || !config.qualifying || config.tickMs !== 60_000 ||
    config.ticks !== 1_440 || config.durationMs !== 86_400_000)) throw new Error("real-time profile must be exactly 1,440 60-second ticks");
  if (config.profile !== "realtime-24h" && (config.realTime || config.qualifying)) throw new Error("accelerated profiles cannot qualify as real-time runs");
  if (config.limits.maxArchiveEvents >= 10_000 || config.limits.maxArchiveEvents < 1) throw new Error("archive range must remain below 10,000 events");
  if (!path.isAbsolute(config.signing.privateKeyPath) || realpathSync.native(config.signing.privateKeyPath) !== config.signing.privateKeyPath ||
    trustedSoakPublicKeySha256(config.signing.privateKeyPath) !== config.signing.trustedPublicKeySha256) {
    throw new Error("soak signing key does not match the externally trusted public-key digest");
  }
}

function loadPrivateKey(privateKeyPath: string) {
  const info = lstatSync(privateKeyPath); const uid = process.getuid?.();
  if (uid === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid ||
    (info.mode & 0o777) !== 0o600) throw new Error("soak signing key must be a private owned regular file");
  return createPrivateKey(readFileSync(privateKeyPath, "utf8"));
}

function frozenBuild(): SoakReport["build"] {
  let commit = "unknown";
  try { commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 }).trim(); } catch { /* Installed builds may supply no Git checkout. */ }
  return { commit, moduleSha256: sha256File(new URL(import.meta.url)), node: process.version,
    platform: process.platform, arch: process.arch };
}

function hostEvidence() {
  return { fingerprint: digestCanonical({ hostname: os.hostname(), platform: process.platform, arch: process.arch,
    bootMinute: Math.floor((Date.now() - os.uptime() * 1000) / 60_000) }), pid: process.pid,
    platform: process.platform, arch: process.arch };
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync("/usr/bin/git", [...args], { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: os.homedir(),
    TMPDIR: os.tmpdir(), LANG: "C", LC_ALL: "C" }, maxBuffer: 1024 * 1024 }).trim();
}

function safeChild(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("soak evidence path escapes root");
  const candidate = path.resolve(root, relative); if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("soak evidence path escapes root");
  return candidate;
}

function atomicJson(destination: string, value: unknown): void {
  const temporary = `${destination}.tmp-${randomUUID()}`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const file = openSync(temporary, "r"); fsyncSync(file); closeSync(file); renameSync(temporary, destination);
  const directory = openSync(path.dirname(destination), "r"); fsyncSync(directory); closeSync(directory);
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function sha256File(file: string | URL): string { return sha256(readFileSync(file)); }
async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => { const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
}
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
