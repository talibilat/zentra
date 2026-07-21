import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const roots: string[] = [];
const repository = realpathSync.native(path.resolve(import.meta.dirname, "../../.."));
const node = realpathSync.native(process.execPath);
const npm = realpathSync.native(path.join(path.dirname(node), "npm"));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installed integrated three-pod package", () => {
  it("runs the real installed fixture and matches its authoritative journal through packaged AgentTrail", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-installed-three-pod-"))); roots.push(root);
    const artifacts = path.join(root, "artifacts"); const consumer = path.join(root, "consumer");
    const runRoot = path.join(root, "run"); mkdirSync(artifacts); mkdirSync(consumer); mkdirSync(runRoot);
    writeFileSync(path.join(consumer, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
    const environment = env(root);
    const packed = await run(node, [npm, "pack", "--silent", "--json", "--pack-destination", artifacts], repository, environment, 180_000);
    const packageResult = JSON.parse(packed.stdout) as readonly { filename: string }[];
    await run(node, [npm, "install", "--no-audit", "--no-fund", path.join(artifacts, packageResult[0]!.filename)],
      consumer, environment, 180_000);
    const trace = path.join(root, "actual-journal.jsonl"); const expected = path.join(root, "expected.json");
    const fixture = path.join(consumer, "run.mjs");
    writeFileSync(fixture, `import { writeFileSync } from "node:fs";
import { AgentTailJsonlFileSink, SqliteEventJournal, compareAgentTrailJournal, isAgentTailProjectableEventType, projectAgentTrailFleet, runInstalledThreePodConformance, storedEventToAgentTailEvent, agentTailEventToJsonLine } from "zentra";
const result = await runInstalledThreePodConformance(${JSON.stringify(runRoot)});
const journal = new SqliteEventJournal(result.databasePath);
const all = journal.readAll();
const outside = all.filter(event => isAgentTailProjectableEventType(event.type) && event.correlationId !== "run-three-pod-installed");
if (outside.length !== 0) throw new Error("projectable journal events escaped the integrated trace: " + outside.map(event => event.type).join(","));
const events = all.filter(event => isAgentTailProjectableEventType(event.type) && event.correlationId === "run-three-pod-installed");
const envelopes = events.map(storedEventToAgentTailEvent);
writeFileSync(${JSON.stringify(trace)}, envelopes.map(agentTailEventToJsonLine).join(""), { mode: 0o600 });
const projected = envelopes.map(event => ({ eventId: event.event_id, position: event.sequence, digest: event.attributes.zentra.journal_digest }));
const comparison = compareAgentTrailJournal(events, projected);
const fleet = projectAgentTrailFleet(events, { nowMs: Date.parse(events.at(-1).recordedAt) });
const fleetExpected = {
  pods: fleet.pods.map(pod => ({ pod_id: pod.podId, project_id: pod.projectId, state: pod.state,
    tasks: pod.tasks.map(task => ({ task_id: task.taskId, dependencies: task.dependencies })), ownership_claim_digests: pod.ownershipClaimDigests })),
  workers: { registered: fleet.workers.registered, active: fleet.workers.active,
    items: fleet.workers.items.map(worker => ({ worker_id: worker.workerId, task_ids: worker.taskIds,
      project_id: worker.projectId, registered: worker.registered, active: worker.active,
      process_incarnation: worker.processIncarnation, daemon_incarnation: worker.daemonIncarnation,
      daemon_state: worker.daemonState, health: worker.health, last_heartbeat_at_ms: worker.lastHeartbeatAtMs })) },
  process_incarnations: fleet.processIncarnations,
  leases: fleet.leases.map(lease => ({ lease_id: lease.leaseId, task_id: lease.taskId, worker_id: lease.workerId,
    state: lease.state, expires_at_ms: lease.expiresAtMs, last_heartbeat_at_ms: lease.lastHeartbeatAtMs, authority: false })),
  queue: { queued: fleet.queue.queued, active: fleet.queue.active, backpressured: fleet.queue.backpressured,
    projects: fleet.queue.projects.map(project => ({ project_id: project.projectId, queued: project.queued,
      active: project.active, backpressured: project.backpressured, dispatches: project.dispatches })) },
  resources: fleet.resources, budgets: fleet.budgets,
  integration_units: fleet.integrationUnits.map(unit => ({ ...(unit.taskId === undefined ? {} : { task_id: unit.taskId }),
    ...(unit.unitId === undefined ? {} : { unit_id: unit.unitId }), project_id: unit.projectId,
    ...(unit.taskIds === undefined ? {} : { task_ids: unit.taskIds }), ...(unit.podIds === undefined ? {} : { pod_ids: unit.podIds }),
    state: unit.state, placeholder: unit.placeholder })),
  observability: { state: fleet.observability.state, projection_position: fleet.observability.projectionPosition,
    journal_high_water_position: fleet.observability.journalHighWaterPosition, projection_lag: fleet.observability.projectionLag,
    history_complete: fleet.observability.historyComplete, retention_independent: fleet.observability.retentionIndependent,
    dropped_projection_entries: fleet.observability.droppedProjectionEntries, ingestion_gap_count: fleet.observability.ingestionGapCount }
};
writeFileSync(${JSON.stringify(expected)}, JSON.stringify({ projected, fleetExpected, report: result.report, mutationCount: result.writerMutationCount }));
journal.close();
process.stdout.write(JSON.stringify({ comparison, report: result.report, mutationCount: result.writerMutationCount }));
`);
    const generated = await run(node, [fixture], consumer, { ...environment,
      ZENTRA_THREE_POD_SECRET_CANARY: "package-secret-canary" }, 120_000);
    const actual = JSON.parse(generated.stdout) as any;
    expect(actual).toMatchObject({ comparison: { complete: true }, mutationCount: 10,
      report: { pods: { durable: 3, completed: 2, cancelled: 1 }, conflicts: { observed: 1 },
        evidence: { complete: true }, capacities: { respected: true } } });
    expect(`${generated.stdout}${generated.stderr}${readFileSync(trace, "utf8")}`).not.toContain("package-secret-canary");

    const agenttrail = realpathSync.native(path.join(consumer, "node_modules/zentra/agenttrail/package/darwin-arm64/agenttrail"));
    const sidecar = await serve(agenttrail, trace, root);
    try {
      const detail = await fetch(`${sidecar.origin}/api/v1/runs/run-three-pod-installed`).then((response) => response.json()) as any;
      const truth = JSON.parse(readFileSync(expected, "utf8")) as any;
      expect(detail.events.map((event: any) => ({ eventId: event.event_id, position: event.sequence,
        digest: event.attributes.zentra.journal_digest }))).toEqual(truth.projected);
      const normalized = normalizeFleet(detail.fleet);
      expect(normalized).toEqual(truth.fleetExpected);
      expect(detail.fleet.attention.every((warning: any) => warning.authority === "none")).toBe(true);
    } finally { await stop(sidecar.child); }
    const markdown = path.join(root, "actual-report.md");
    await run(agenttrail, [trace, "--export", markdown], root, environment, 30_000);
    expect(readFileSync(markdown, "utf8")).toContain("conflict.observed");
  }, 300_000);
});

function env(home: string): NodeJS.ProcessEnv { return { PATH: [path.dirname(node), "/usr/bin", "/bin"].join(path.delimiter),
  HOME: home, TMPDIR: tmpdir(), LANG: "C", LC_ALL: "C", npm_config_audit: "false", npm_config_fund: "false",
  npm_config_update_notifier: "false" }; }
async function run(executable: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeout: number) {
  return execute(executable, [...args], { cwd, env: environment, timeout, maxBuffer: 32 * 1024 * 1024 }); }
async function serve(executable: string, trace: string, root: string): Promise<{ origin: string; child: ChildProcess }> {
  const child = spawn(executable, ["serve", trace, "--host", "127.0.0.1", "--port", "0"], {
    detached: true, shell: false, env: env(root), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const match = /listening on (http:\/\/127\.0\.0\.1:[0-9]+\/)/.exec(stdout);
    if (match !== null) return { origin: match[1]!.replace(/\/$/, ""), child };
    if (child.exitCode !== null) throw new Error(stderr); await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error(`AgentTrail startup timed out: ${stderr}`); }
async function stop(child: ChildProcess): Promise<void> { if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve())); }

function normalizeFleet(fleet: any) {
  return { pods: fleet.pods, workers: { registered: fleet.workers.registered, active: fleet.workers.active,
    items: fleet.workers.items.map(({ lease_health: _lease, ...worker }: any) => worker) },
  process_incarnations: fleet.process_incarnations,
  leases: fleet.leases.map(({ scope: _scope, process_incarnation: _process, worker_incarnation: _worker, ...lease }: any) => lease),
  queue: fleet.queue, resources: fleet.resources, budgets: fleet.budgets, integration_units: fleet.integration_units,
  observability: { state: fleet.observability.state, projection_position: fleet.observability.projection_position,
    journal_high_water_position: fleet.observability.journal_high_water_position,
    projection_lag: fleet.observability.projection_lag, history_complete: fleet.observability.history_complete,
    retention_independent: fleet.observability.retention_independent,
    dropped_projection_entries: fleet.observability.dropped_projection_entries,
    ingestion_gap_count: fleet.observability.ingestion_gap_count } };
}
