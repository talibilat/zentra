import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentTrailEvidence } from "../../src/agenttrail/agenttrail-events.js";
import type { AgentTrailReady, AgentTrailStartRequest } from "../../src/agenttrail/agenttrail-supervisor.js";
import type { StoredEvent } from "../../src/contracts/event.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { RuntimeStateManager } from "../../src/runtime/repository-runtime.js";
import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";
import { RunService } from "../../src/runs/run-service.js";
import type { WorkflowRunDetail, WorkflowSurface } from "../../src/surfaces/workflow-surface.js";
import {
  startZentraService,
  type AgentTrailService,
  type GatewayService,
  type RuntimeStateService,
  type ServiceTraceSink,
} from "../../src/service/start-service.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("startZentraService", () => {
  it("installs the production workflow exactly once after durable service readiness", async () => {
    const root = repository();
    let configuredSurface: WorkflowSurface | null = null;
    let configuredAfterReady = false;
    let configuredAgentTrailAddress: { readonly host: "127.0.0.1"; readonly port: number } | null = null;
    let gatewayBecameReadyAfterAgentTrailConfiguration = false;
    let configurationCount = 0;
    const sidecar = new FakeAgentTrail();
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createGateway: (options) => workflowGateway(new LoopbackGateway(options), (surface) => {
        const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
        configuredAfterReady = journal.readAll().some(({ type }) => type === "service.ready");
        journal.close();
        configuredSurface = surface;
        configurationCount += 1;
      }, (address) => { configuredAgentTrailAddress = address; }, () => {
        gatewayBecameReadyAfterAgentTrailConfiguration = configuredAgentTrailAddress !== null;
      }, () => undefined),
    });
    try {
      expect(configuredAfterReady).toBe(true);
      expect(configurationCount).toBe(1);
      expect(configuredAgentTrailAddress).toEqual({ host: "127.0.0.1", port: 4243 });
      expect(gatewayBecameReadyAfterAgentTrailConfiguration).toBe(true);
      const detail = await configuredSurface!.submitRun(
        { kind: "inline_goal", commandId: "startup-composition-submit", goal: "Verify startup composition." },
        { actorId: "operator", channel: "cli" },
      ) as WorkflowRunDetail;
      expect(detail).toMatchObject({ run: { lifecycle: "analyzing", authority: { executionAuthority: "none" } } });
      await waitFor(() => configuredSurface!.getRun(detail.run.runId)?.run.lifecycle === "waiting");
      expect(configuredSurface!.getRun(detail.run.runId)?.run).toMatchObject({
        lifecycle: "waiting",
        suspendedFrom: "analyzing",
      });
      const bootstrapToken = new URL(service.sessionUrl).hash.slice("#token=".length);
      const handoff = await fetch(`${service.origin}/api/v1/session`, {
        method: "POST",
        headers: { origin: service.origin, "content-type": "application/json" },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      expect(handoff.status).toBe(201);
      const auth = await handoff.json() as { bearerToken: string };
      const response = await fetch(`${service.origin}/api/v1/zentra/runs`, {
        headers: { authorization: `Bearer ${auth.bearerToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([expect.objectContaining({ runId: detail.run.runId })]);
    } finally {
      await service.shutdown("test_requested");
    }
  });

  it("resumes durable nonterminal runs before publishing gateway readiness and shuts the coordinator down", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();
    let resumes = 0;
    let shutdowns = 0;
    let readyAfterResume = false;
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      runAdvancer: {
        advance: () => undefined,
        resumeNonterminalRuns: async () => { resumes += 1; },
        shutdown: async () => { shutdowns += 1; },
      },
      createGateway: (options) => workflowGateway(
        new LoopbackGateway(options),
        () => undefined,
        () => undefined,
        () => { readyAfterResume = resumes === 1; },
        () => undefined,
      ),
    });

    expect(resumes).toBe(1);
    expect(readyAfterResume).toBe(true);
    await service.shutdown("test_requested");
    expect(shutdowns).toBe(1);
  });

  it("fails startup when the gateway cannot accept a workflow surface", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();
    await expect(startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createGateway: (options) => gatewayWithoutWorkflow(new LoopbackGateway(options)),
    })).rejects.toThrow(/workflow surface/i);
    expect(existsSync(path.join(root, ".zentra", "runtime", "state.json"))).toBe(false);
    expect(existsSync(path.join(root, ".zentra", "runtime", "cli-control.token"))).toBe(false);
  });

  it("discovers cwd, gates readiness on AgentTrail, publishes private state, degrades, recovers, and shuts down", async () => {
    const root = repository();
    const nested = path.join(root, "nested");
    execFileSync("/bin/mkdir", [nested], { env: {}, stdio: "ignore" });
    const sidecar = new FakeAgentTrail();
    let replacementAddress: { readonly host: "127.0.0.1"; readonly port: number } | null = null;
    let replacementHadDurableRecovery = false;
    const service = await startZentraService({ cwd: nested, tokenTtlMs: 60_000 }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createGateway: (options) => replacementGateway(new LoopbackGateway(options), (address) => {
        const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
        replacementHadDurableRecovery = journal.readAll().some(({ type }) => type === "gateway.recovered");
        journal.close();
        replacementAddress = address;
      }),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });

    expect(service.layout.projectRoot).toBe(root);
    expect(sidecar.startRequest?.tracePath).toMatch(new RegExp(`^${escapeRegex(path.join(root, ".zentra", "traces"))}/[^/]+\\.jsonl$`));
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(200);
    const state = readFileSync(service.layout.runtimeStatePath, "utf8");
    expect(state).toContain('"startupStatus":"ready"');
    expect(statSync(service.layout.runtimeStatePath).mode & 0o777).toBe(0o600);
    const bootstrapToken = new URL(service.sessionUrl).hash.slice("#token=".length);
    const cliTokenPath = path.join(service.layout.runtimeDirectory, "cli-control.token");
    const cliToken = readFileSync(cliTokenPath, "utf8");
    expect(cliToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(cliTokenPath).mode & 0o777).toBe(0o600);
    expect(state).not.toContain(bootstrapToken);
    expect(state).not.toContain(cliToken);

    await sidecar.crash();
    expect((await fetch(`${service.origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(503);
    expect((await fetch(service.sessionUrl, { redirect: "manual" })).status).toBe(503);
    await sidecar.recover();
    expect((await fetch(`${service.origin}/readyz`)).status).toBe(200);
    expect(sidecar.replacementAddress).toEqual({ host: "127.0.0.1", port: 4245 });
    expect(replacementAddress).toEqual({ host: "127.0.0.1", port: 4245 });
    expect(replacementHadDurableRecovery).toBe(true);
    const bootstrap = await fetch(service.sessionUrl, { redirect: "manual" });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("set-cookie")).toBeNull();

    await service.shutdown("test_requested");
    await service.closed;
    expect(sidecar.shutdownCount).toBe(1);
    expect(existsSync(service.layout.runtimeStatePath)).toBe(false);
    expect(existsSync(cliTokenPath)).toBe(false);

    const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    const events = journal.readAll();
    expect(events.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "service.starting",
      "agenttrail.starting",
      "agenttrail.ready",
      "service.ready",
      "gateway.degraded",
      "service.critical_attention",
      "agenttrail.failed",
      "gateway.backfill_target",
      "agenttrail.restarted",
      "gateway.recovered",
      "service.stopping",
      "service.shutdown",
    ]));
    expect(JSON.stringify(events)).not.toContain(bootstrapToken);
    expect(JSON.stringify(events)).not.toContain(cliToken);
    const targetEvent = events.find(({ type }) => type === "gateway.backfill_target")!;
    const restartedEvent = events.find(({ type }) => type === "agenttrail.restarted")!;
    expect(targetEvent.globalPosition).toBeLessThan(restartedEvent.globalPosition);
    const traceLines = readFileSync(sidecar.startRequest!.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(traceLines.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
      "service.starting",
      "agenttrail.starting",
      "agenttrail.failed",
      "gateway.degraded",
      "service.critical_attention",
      "gateway.backfill_target",
      "gateway.recovered",
      "service.shutdown",
    ]));
    expect(traceLines.at(-1)?.kind).toBe("service.shutdown");
    const projectedEvents = events.filter(({ correlationId }) => correlationId === events[0]!.correlationId);
    expect(traceLines).toEqual(projectedEvents.map(storedEventToAgentTailEvent));
    const traceByKind = new Map(traceLines.map((event) => [event.kind, event]));
    expect(traceByKind.get("agenttrail.failed")).toMatchObject({
      actor: { id: "zentra-agenttrail-supervisor", role: "observability" },
      operation: { name: "agenttrail_lifecycle", status: "failed" },
    });
    expect(traceByKind.get("gateway.degraded")?.operation).toEqual({ name: "gateway_observability", status: "failed" });
    expect(traceByKind.get("service.critical_attention")?.operation).toEqual({ name: "service_attention", status: "failed" });
    expect(traceByKind.get("gateway.backfill_target")?.operation.status).toBe("running");
    expect(traceByKind.get("agenttrail.restarted")?.operation.status).toBe("running");
    expect(traceByKind.get("agenttrail.ready")?.operation.status).toBe("completed");
    expect(traceByKind.get("gateway.recovered")?.operation.status).toBe("completed");
    expect(traceByKind.get("service.stopping")?.operation.status).toBe("running");
    expect(traceByKind.get("service.shutdown")?.operation).toEqual({ name: "service_shutdown", status: "completed" });
    journal.close();
  });

  it("does not publish ready state and reconciles runtime state when AgentTrail startup fails", async () => {
    const root = repository();
    await expect(startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => new FailingAgentTrail(evidence),
    })).rejects.toThrow("controlled AgentTrail startup failure");

    const statePath = path.join(root, ".zentra", "runtime", "state.json");
    expect(existsSync(statePath)).toBe(false);
    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
    expect(journal.readAll().some(({ type }) => type === "service.ready")).toBe(false);
    expect(journal.readAll().find(({ type }) => type === "service.shutdown")?.payload)
      .toMatchObject({ outcome: "failed", reasonCode: "startup_failed" });
    journal.close();
  });

  it("publishes runtime ready before service.ready and leaves no service.ready when publication fails", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();

    await expect(startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createRuntime: (layout, now) => new FailingReadyRuntime(new RuntimeStateManager(layout, { now })),
    })).rejects.toThrow("controlled runtime ready publication failure");

    expect(sidecar.shutdownCount).toBe(1);
    expect(existsSync(path.join(root, ".zentra", "runtime", "state.json"))).toBe(false);
    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
    expect(journal.readAll().some(({ type }) => type === "service.ready")).toBe(false);
    expect(journal.readAll().some(({ type }) => type === "service.shutdown")).toBe(true);
    journal.close();
  });

  it("recovers through the durable starting high-water while the trace grows before ready", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
    });
    try {
      await sidecar.crash();
      await sidecar.recover();

      expect((await fetch(`${service.origin}/readyz`)).status).toBe(200);
      const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
      expect(journal.readAll().some(({ type }) => type === "gateway.backfill_target")).toBe(true);
      expect(journal.readAll().some(({ type }) => type === "gateway.recovered")).toBe(true);
      journal.close();
    } finally {
      await service.shutdown("test_requested");
    }
  });

  it("gates readiness during delayed sidecar startup and cleans sockets and state on signal", async () => {
    const root = repository();
    const controller = new AbortController();
    const sidecar = new DelayedAgentTrail();
    const pending = startZentraService({ cwd: root, signal: controller.signal }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
    });
    const statePath = path.join(root, ".zentra", "runtime", "state.json");
    await waitFor(() => existsSync(statePath) && sidecar.startRequest !== null);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { address: { port: number }; startupStatus: string };
    expect(state.startupStatus).toBe("starting");
    expect((await fetch(`http://127.0.0.1:${state.address.port}/readyz`)).status).toBe(503);

    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled|abort/i);

    expect(existsSync(statePath)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${state.address.port}/healthz`)).rejects.toThrow();
    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
    expect(journal.readAll().some(({ type }) => type === "service.ready")).toBe(false);
    journal.close();
  });

  it("does not leak the authoritative journal across repeated invalid starts", async () => {
    const root = repository();
    await expect(startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => new FailingAgentTrail(evidence),
    })).rejects.toThrow();
    for (let index = 0; index < 5; index += 1) {
      await expect(startZentraService({ cwd: root, tokenTtlMs: 0 })).rejects.toThrow(/TTL/);
    }

    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-write");
    expect(() => journal.readAll()).not.toThrow();
    journal.close();
  });

  it("fails startup and closes state, trace, and journal when synchronous projection delivery fails", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();
    await expect(startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createTraceSink: (directory, tracePath, serviceId) => failingSink(
        AgentTailJsonlFileSink.open(directory, tracePath, serviceId),
        (events) => events.some(({ type }) => type === "service.starting"),
      ),
    })).rejects.toThrow(/projection delivery failed/i);

    expect(sidecar.startRequest).toBeNull();
    expect(existsSync(path.join(root, ".zentra", "runtime", "state.json"))).toBe(false);
    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
    expect(journal.readAll().some(({ type }) => type === "service.ready")).toBe(false);
    journal.close();
  });

  it("fails before binding sockets when projection initialization cannot reconcile", async () => {
    const root = repository();
    await expect(startZentraService({ cwd: root }, {
      createTraceSink: (directory, tracePath, serviceId) => initializationFailingSink(
        AgentTailJsonlFileSink.open(directory, tracePath, serviceId),
      ),
    })).rejects.toThrow(/projection initialization failed/i);

    expect(existsSync(path.join(root, ".zentra", "runtime", "state.json"))).toBe(false);
    const journal = openAuthoritativeJournal(path.join(root, ".zentra", "events.sqlite"), "read-only");
    expect(journal.readAll()).toEqual([]);
    journal.close();
  });

  it("stays degraded and rejects restart evidence when atomic degradation projection fails", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail();
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createTraceSink: (directory, tracePath, serviceId) => failingSink(
        AgentTailJsonlFileSink.open(directory, tracePath, serviceId),
        (events) => events.some(({ type }) => type === "gateway.degraded"),
      ),
    });
    try {
      await expect(sidecar.crash()).rejects.toThrow(/projection delivery failed/i);
      expect((await fetch(`${service.origin}/readyz`)).status).toBe(503);
      const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
      expect(journal.readAll().some(({ type }) => type === "gateway.degraded")).toBe(true);
      expect(journal.readAll().some(({ type }) => type === "service.critical_attention")).toBe(true);
      expect(journal.readAll().some(({ type }) => type === "agenttrail.restarted")).toBe(false);
      journal.close();
    } finally {
      await service.shutdown("test_requested").catch(() => undefined);
      await service.closed.catch(() => undefined);
    }
  });

  it("mints the exposed bootstrap session after delayed AgentTrail readiness with a full TTL", async () => {
    const root = repository();
    let clock = new Date("2026-07-19T12:00:00.000Z");
    const sidecar = new FakeAgentTrail(() => {
      clock = new Date("2026-07-19T12:02:00.000Z");
    });
    const service = await startZentraService({ cwd: root, tokenTtlMs: 1_000 }, {
      now: () => clock,
      createAgentTrail: (evidence) => sidecar.attach(evidence),
    });
    try {
      expect(service.tokenExpiresAt).toBe("2026-07-19T12:02:01.000Z");
      expect((await fetch(service.sessionUrl, { redirect: "manual" })).status).toBe(200);
      const state = JSON.parse(readFileSync(service.layout.runtimeStatePath, "utf8")) as { tokenExpiresAt: string };
      expect(state.tokenExpiresAt).toBe(service.tokenExpiresAt);
      const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
      const ready = journal.readAll().find(({ type }) => type === "service.ready")!;
      expect((ready.payload as { tokenExpiresAt: string }).tokenExpiresAt).toBe(service.tokenExpiresAt);
      journal.close();
    } finally {
      await service.shutdown("test_requested");
    }
  });

  it("records failed internal shutdown only after gateway, sidecar, and runtime cleanup failures", async () => {
    const root = repository();
    const sidecar = new FakeAgentTrail(undefined, true);
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
      createGateway: (options) => failingCleanupGateway(new LoopbackGateway(options)),
      createRuntime: (layout, now) => new FailingCleanupRuntime(new RuntimeStateManager(layout, { now })),
    });

    await expect(service.shutdown("test_requested")).rejects.toThrow(/cleanup failure/);
    await expect(service.closed).rejects.toThrow(/cleanup failure/);
    expect(existsSync(service.layout.runtimeStatePath)).toBe(false);
    const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    const shutdowns = journal.readAll().filter(({ type }) => type === "service.shutdown");
    const stopping = journal.readAll().find(({ type }) => type === "service.stopping")!;
    expect(shutdowns).toHaveLength(1);
    expect(shutdowns[0]?.causationId).toBe(stopping.eventId);
    expect(shutdowns[0]?.payload).toMatchObject({ outcome: "failed", reasonCode: "internal_failure" });
    expect(shutdowns[0]?.payload).not.toMatchObject({ outcome: "completed" });
    journal.close();
  });

  it("revokes RunService authority with service.stopping while sidecar cleanup is pending", async () => {
    const root = repository();
    const sidecar = new BlockingShutdownAgentTrail();
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => sidecar.attach(evidence),
    });
    const pendingShutdown = service.shutdown("test_requested");
    const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    await waitFor(() => journal.readAll().some(({ type }) => type === "service.stopping"));
    const ready = journal.readAll().find(({ type }) => type === "service.ready")!;
    const readyPayload = ready.payload as { process: { pid: number; processIncarnation: string } };
    expect(() => new RunService(journal).accept({
      runId: "run-during-stopping",
      projectId: "fixture-project",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      source: { kind: "inline_goal", referenceSha256: "b".repeat(64), declaredBytes: 1 },
      actor: { actorId: "operator-1", kind: "operator" },
      process: readyPayload.process,
      budget: { maxDurationMs: 1_000, maxInputTokens: 1, maxOutputTokens: 1,
        maxCostUsdNano: 0, maxRetries: 0, maxSourceFiles: 1, maxSourceBytes: 1 },
      commandId: "accept-during-stopping",
      causationId: ready.eventId,
    })).toThrow(/latest|shutdown|active service/i);
    journal.close();

    sidecar.releaseShutdown();
    await pendingShutdown;
    const replay = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    const serviceEvents = replay.readAll().filter(({ type }) => type.startsWith("service."));
    expect(serviceEvents.at(-2)?.type).toBe("service.stopping");
    expect(serviceEvents.at(-1)).toMatchObject({
      type: "service.shutdown",
      causationId: serviceEvents.at(-2)?.eventId,
      payload: { outcome: "completed" },
    });
    replay.close();
  });
});

class FakeAgentTrail implements AgentTrailService {
  private evidence: ((event: AgentTrailEvidence) => void | Promise<void>) | null = null;
  private incarnation = "agenttrail-v1:11111111-1111-4111-8111-111111111111";
  startRequest: AgentTrailStartRequest | null = null;
  shutdownCount = 0;
  replacementAddress: { readonly host: "127.0.0.1"; readonly port: number } | null = null;

  constructor(
    private readonly beforeReady?: () => void,
    private readonly failShutdown = false,
  ) {}

  attach(evidence: (event: AgentTrailEvidence) => void | Promise<void>): this {
    this.evidence = evidence;
    return this;
  }

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    this.startRequest = request;
    await this.emit("agenttrail.starting", { pid: null, startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex") });
    this.beforeReady?.();
    await this.emit("agenttrail.ready", { pid: 4242, address: { host: "127.0.0.1", port: 4243 }, startupMs: 1 });
    return { pid: 4242, incarnation: this.incarnation, executableSha256: "a".repeat(64),
      address: { host: "127.0.0.1", port: 4243 } };
  }

  async crash(): Promise<void> {
    await this.emit("agenttrail.failed", { pid: 4242, phase: "runtime", uptimeMs: 2,
      failure: { code: "process_exit", message: "exited", exitCode: 1, signal: null } });
  }

  async recover(afterTarget?: () => void | Promise<void>): Promise<void> {
    const failed = this.incarnation;
    this.incarnation = "agenttrail-v1:22222222-2222-4222-8222-222222222222";
    await this.emit("agenttrail.starting", { pid: null, startupDeadlineMs: 60_000,
      tracePathSha256: createHash("sha256").update(this.startRequest!.tracePath).digest("hex") });
    await this.emit("agenttrail.restarted", { pid: 4244, previousIncarnation: failed, restartAttempt: 1, backoffMs: 1 });
    await afterTarget?.();
    await this.emit("agenttrail.ready", { pid: 4244, address: { host: "127.0.0.1", port: 4245 }, startupMs: 1 });
    this.replacementAddress = { host: "127.0.0.1", port: 4245 };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    if (this.failShutdown) throw new Error("controlled sidecar cleanup failure");
  }

  private async emit(type: AgentTrailEvidence["type"], detail: Record<string, unknown>): Promise<void> {
    await this.evidence!({ type, schemaVersion: 1, executableSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64), incarnation: this.incarnation,
      occurredAt: new Date().toISOString(), ...detail } as AgentTrailEvidence);
  }
}

class FailingAgentTrail implements AgentTrailService {
  constructor(private readonly evidence: (event: AgentTrailEvidence) => void | Promise<void>) {}

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    const base = { schemaVersion: 1 as const, executableSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
      incarnation: "agenttrail-v1:33333333-3333-4333-8333-333333333333", occurredAt: new Date().toISOString() };
    await this.evidence({ type: "agenttrail.starting", ...base, pid: null,
      startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex") });
    await this.evidence({ type: "agenttrail.failed", ...base, pid: null, phase: "startup", uptimeMs: 1,
      failure: { code: "spawn_error", message: "controlled failure", exitCode: null, signal: null } });
    throw new Error("controlled AgentTrail startup failure");
  }

  async shutdown(): Promise<void> {}
}

class BlockingShutdownAgentTrail extends FakeAgentTrail {
  private release!: () => void;
  private readonly blocked = new Promise<void>((resolve) => { this.release = resolve; });

  override async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    await this.blocked;
  }

  releaseShutdown(): void {
    this.release();
  }
}

class DelayedAgentTrail implements AgentTrailService {
  private evidence: ((event: AgentTrailEvidence) => void | Promise<void>) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  startRequest: AgentTrailStartRequest | null = null;

  attach(evidence: (event: AgentTrailEvidence) => void | Promise<void>): this {
    this.evidence = evidence;
    return this;
  }

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    this.startRequest = request;
    await this.evidence!({
      type: "agenttrail.starting",
      schemaVersion: 1,
      executableSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      incarnation: "agenttrail-v1:44444444-4444-4444-8444-444444444444",
      occurredAt: new Date().toISOString(),
      pid: null,
      startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex"),
    });
    return new Promise((_, reject) => { this.rejectStart = reject; });
  }

  async shutdown(): Promise<void> {
    this.rejectStart?.(new Error("delayed AgentTrail startup cancelled"));
  }
}

class FailingReadyRuntime implements RuntimeStateService {
  constructor(private readonly inner: RuntimeStateService) {}

  start: RuntimeStateService["start"] = (input) => this.inner.start(input);
  read: RuntimeStateService["read"] = () => this.inner.read();
  remove: RuntimeStateService["remove"] = (claim) => this.inner.remove(claim);
  publish: RuntimeStateService["publish"] = (claim, input) => {
    if (input.startupStatus === "ready") {
      return Promise.reject(new Error("controlled runtime ready publication failure"));
    }
    return this.inner.publish(claim, input);
  };
}

class FailingCleanupRuntime implements RuntimeStateService {
  constructor(private readonly inner: RuntimeStateService) {}

  start: RuntimeStateService["start"] = (input) => this.inner.start(input);
  read: RuntimeStateService["read"] = () => this.inner.read();
  publish: RuntimeStateService["publish"] = async (claim, input) => {
    const result = await this.inner.publish(claim, input);
    if (input.startupStatus === "stopping" || input.startupStatus === "failed") {
      throw new Error("controlled runtime publication cleanup failure");
    }
    return result;
  };
  remove: RuntimeStateService["remove"] = async (claim) => {
    await this.inner.remove(claim);
    throw new Error("controlled runtime removal cleanup failure");
  };
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-gateway-service-"));
  cleanup.push(root);
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "--allow-empty", "-m", "fixture"], {
    cwd: root, env: { HOME: root }, stdio: "ignore",
  });
  return realpathSync(root);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for service state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function failingSink(inner: AgentTailJsonlFileSink, reject: (events: readonly StoredEvent[]) => boolean): ServiceTraceSink {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "append") {
        return (events: readonly StoredEvent[]) => {
          if (reject(events)) throw new Error("controlled projection delivery failure");
          return target.append(events);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function initializationFailingSink(inner: AgentTailJsonlFileSink): ServiceTraceSink {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "reconcileHistory") {
        return () => { throw new Error("controlled projection initialization failure"); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failingCleanupGateway(inner: LoopbackGateway): GatewayService {
  return {
    start: () => inner.start(),
    rotateSession: () => inner.rotateSession(),
    setReadiness: (readiness) => inner.setReadiness(readiness),
    setAgentTrailAddress: (address) => inner.setAgentTrailAddress(address),
    replaceAgentTrailAddress: (address) => inner.replaceAgentTrailAddress(address),
    setWorkflowSurface: (workflow) => inner.setWorkflowSurface(workflow),
    close: async () => {
      await inner.close();
      throw new Error("controlled gateway cleanup failure");
    },
  };
}

function workflowGateway(
  inner: LoopbackGateway,
  configured: (surface: WorkflowSurface) => void,
  configuredAgentTrail: (address: { readonly host: "127.0.0.1"; readonly port: number }) => void,
  becameReady: () => void,
  replacedAgentTrail: (address: { readonly host: "127.0.0.1"; readonly port: number }) => void,
): GatewayService {
  return {
    start: () => inner.start(),
    rotateSession: () => inner.rotateSession(),
    setReadiness: (readiness) => { if (readiness === "ready") becameReady(); inner.setReadiness(readiness); },
    setAgentTrailAddress: (address) => { configuredAgentTrail(address); inner.setAgentTrailAddress(address); },
    replaceAgentTrailAddress: (address) => { replacedAgentTrail(address); inner.replaceAgentTrailAddress(address); },
    setWorkflowSurface: (surface) => {
      configured(surface);
      inner.setWorkflowSurface(surface);
    },
    close: () => inner.close(),
  };
}

function replacementGateway(
  inner: LoopbackGateway,
  replaced: (address: { readonly host: "127.0.0.1"; readonly port: number }) => void,
): GatewayService {
  return {
    start: () => inner.start(),
    rotateSession: () => inner.rotateSession(),
    setReadiness: (readiness) => inner.setReadiness(readiness),
    setAgentTrailAddress: (address) => inner.setAgentTrailAddress(address),
    replaceAgentTrailAddress: (address) => { replaced(address); inner.replaceAgentTrailAddress(address); },
    setWorkflowSurface: (surface) => inner.setWorkflowSurface(surface),
    close: () => inner.close(),
  };
}

function gatewayWithoutWorkflow(inner: LoopbackGateway): GatewayService {
  return {
    start: () => inner.start(),
    rotateSession: () => inner.rotateSession(),
    setReadiness: (readiness) => inner.setReadiness(readiness),
    setAgentTrailAddress: (address) => inner.setAgentTrailAddress(address),
    replaceAgentTrailAddress: (address) => inner.replaceAgentTrailAddress(address),
    close: () => inner.close(),
  };
}
