import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const HEADLESS_SHELL = "/Users/talibilat/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const GOOGLE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = canonicalBrowser(HEADLESS_SHELL, "--headless") ?? canonicalBrowser(GOOGLE_CHROME, "--headless=new");
const roots: string[] = [];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("packaged AgentTrail fleet browser", () => {
  it.skipIf(browser === null)("renders real multi-pod, stale-incarnation, advisory fleet state at desktop and mobile widths", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-agenttrail-fleet-browser-")));
    roots.push(root);
    const trace = path.join(root, "fleet.jsonl");
    writeFileSync(trace, fixture().map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
    const sidecar = await startSidecar(trace, root);
    try {
      const desktop = await dump(`${sidecar.origin}/?view=fleet&snapshot=1`, root, 1280, 800);
      expect(desktop).toContain('data-fleet-ready="true"');
      expect(desktop).toContain('aria-label="Fleet"');
      expect(desktop).toContain("Pod and task DAG");
      expect(desktop).toContain("pod-alpha");
      expect(desktop).toContain("pod-beta");
      expect(desktop).toContain("1 claims");
      expect(desktop).toContain("worker-alpha-v2");
      expect(desktop).toContain("daemon-old");
      expect(desktop).toContain("stale");
      expect(desktop).toContain("active / 2 registered");
      expect(desktop).toContain("backpressured");
      expect(desktop).toContain("placeholder");
      expect(desktop).toContain("lease-worker-beta");
      expect(desktop).toContain("Lease and heartbeat health");
      expect(desktop).toContain("advisory · no authority");
      expect(desktop).toContain('aria-label="Fleet resource slot usage"');
      expect(desktop).toContain('aria-label="Writer slots: 0 used of 2 slots"');
      expect(desktop).toContain('aria-label="Integration slots: 0 used of 1 slots"');
      expect(desktop).toContain('aria-label="Fleet budget capacity reserved and used"');
      expect(desktop).toContain('aria-label="Time capacity: 1000 seconds"');
      expect(desktop).toContain('aria-label="Time reserved: 0 seconds"');
      expect(desktop).toContain('aria-label="Time used: 0 seconds"');
      expect(desktop).toContain('aria-label="Input tokens capacity: 10000 tokens"');
      expect(desktop).toContain('aria-label="Output tokens capacity: 5000 tokens"');
      expect(desktop).toContain('aria-label="Cost capacity: 0.001000 USD"');
      expect(desktop).toContain('aria-label="Retries capacity: not available"');
      expect(desktop).toContain('aria-label="External effects capacity: not available"');
      expect(desktop).not.toContain("SECRET_ACCEPTANCE");
      expect(desktop).not.toContain("/private/worktree");

      const mobile = await dump(`${sidecar.origin}/?view=fleet&snapshot=1`, root, 390, 844);
      expect(mobile).toContain('data-fleet-viewport-width="390"');
      expect(mobile).toContain('data-fleet-document-width="390"');
      expect(mobile).toContain('aria-label="Pod and fleet status"');
      expect(mobile).toContain('aria-label="Fleet budget capacity reserved and used"');
      expect(mobile).toContain('aria-label="Fleet resource slot usage"');
    } finally {
      await terminate(sidecar.child);
    }
  }, 60_000);

  it("reconstructs fleet state from the canonical file after sidecar byte eviction and restart", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-agenttrail-fleet-restart-")));
    roots.push(root);
    const trace = path.join(root, "fleet-large.jsonl");
    const initial = [...fixture()];
    const filler = Array.from({ length: 10_050 }, (_, index) => envelope(index + 15, "task.started",
      { workerId: "filler-worker" }));
    writeFileSync(trace, [...initial, ...filler].map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
    const first = await startSidecar(trace, root, 4_096);
    let firstFleet: any;
    try {
      const detail = await fetch(`${first.origin}/api/v1/runs/fleet-browser`).then((response) => response.json()) as any;
      firstFleet = detail.fleet;
      expect(detail.run.event_count).toBeLessThan(10_064);
      expect(firstFleet).toMatchObject({ workers: { registered: 2, active: 1 }, observability: {
        state: "healthy", projection_position: 10_064, projection_lag: 0,
        history_complete: true, retention_independent: true,
      } });
    } finally { await terminate(first.child); }

    const restarted = await startSidecar(trace, root, 4_096);
    try {
      const detail = await fetch(`${restarted.origin}/api/v1/runs/fleet-browser`).then((response) => response.json()) as any;
      expect(detail.fleet).toEqual(firstFleet);
    } finally { await terminate(restarted.child); }
  }, 60_000);
});

function fixture(): readonly unknown[] {
  const limits = { resources: { reasoning: 4, writers: 2, heavyValidation: 1, review: 1, integration: 1 },
    budget: { seconds: 1_000, inputTokens: 10_000, outputTokens: 5_000, costUsdNano: 1_000_000 } };
  return [
    envelope(1, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-old",
      pid: 101, platform: "darwin-arm64", capabilities: ["write_worktree", "integrate"], limits, startedAtMs: 1 }),
    envelope(2, "scheduler.daemon_started", { schemaVersion: 1, schedulerId: "installed", processIncarnation: "daemon-new",
      pid: 102, platform: "darwin-arm64", capabilities: ["write_worktree", "integrate"], limits, startedAtMs: 2 }),
    envelope(3, "scheduler.daemon_stale", { schemaVersion: 1, staleProcessIncarnation: "daemon-old",
      replacementProcessIncarnation: "daemon-new", detectedAtMs: 3 }),
    envelope(4, "pod.registered", { podId: "pod-alpha", projectId: "project-a", revision: 1,
      tasks: [{ taskId: "research-a", dependencies: [] }, { taskId: "implement-a", dependencies: [{ taskId: "research-a" }] }],
      budget: {}, ownership: { ownedPathDigests: ["a".repeat(64)], forbiddenPathDigests: [] } },
      { pod_id: "pod-alpha", project_id: "project-a" }),
    envelope(5, "pod.started", {}, { pod_id: "pod-alpha", project_id: "project-a" }),
    envelope(6, "pod.registered", { podId: "pod-beta", projectId: "project-b", revision: 1,
      tasks: [{ taskId: "integrate-b", dependencies: [] }], budget: {},
      ownership: { ownedPathDigests: ["b".repeat(64)], forbiddenPathDigests: [] } },
      { pod_id: "pod-beta", project_id: "project-b" }),
    envelope(7, "scheduler.task_submitted", schedulerTask("implement-a", "project-a", "worker-alpha", false)),
    envelope(8, "scheduler.task_ready", { taskId: "implement-a" }),
    envelope(9, "scheduler.backpressure", { taskId: "implement-a", kind: "resources", observedAtMs: 9 }),
    envelope(10, "scheduler.task_submitted", schedulerTask("integrate-b", "project-b", "worker-beta", true)),
    envelope(11, "scheduler.dispatch_started", { taskId: "integrate-b", dispatchId: "00000000-0000-4000-8000-000000000011",
      processIncarnation: "daemon-new", workerPid: 201, workerIncarnation: "worker-alpha-v2",
      workerProcessStartIdentity: "pid-201", startedAtMs: 11 }),
    envelope(12, "scheduler.worker_heartbeat", { taskId: "integrate-b", dispatchId: "00000000-0000-4000-8000-000000000011",
      processIncarnation: "daemon-new", workerIncarnation: "worker-alpha-v2", observedAtMs: 12 }),
    envelope(13, "lease.granted", { schemaVersion: 1, leaseId: "lease-worker-beta", taskId: "integrate-b",
      workerId: "worker-beta", schedulerId: "installed", processIncarnation: "daemon-new", scope: "worker",
      grantedAtMs: 1, expiresAtMs: 180_001 }),
    envelope(14, "lease.heartbeat", { schemaVersion: 1, leaseId: "lease-worker-beta",
      processIncarnation: "daemon-new", workerIncarnation: "worker-alpha-v2", observedAtMs: 60_001,
      expiresAtMs: 180_001 }),
  ];
}

function schedulerTask(taskId: string, projectId: string, workerId: string, integration: boolean) {
  return { taskId, projectId, workerId, effect: "potentially_effectful", platform: "darwin-arm64",
    requiredCapabilities: [integration ? "integrate" : "write_worktree"], workspaceAvailable: true,
    dependencies: [], admission: { decisionsApproved: true, pathsAvailable: true, capabilitySupported: true,
      platformSupported: true, policyPermits: true, budgetAvailable: true, workspaceValid: true,
      acceptanceDeclared: true, evidenceDeclared: true },
    resources: integration ? { reasoning: 0, writers: 0, heavyValidation: 0, review: 0, integration: 1 }
      : { reasoning: 1, writers: 1, heavyValidation: 0, review: 0, integration: 0 },
    budget: { seconds: 60, inputTokens: 100, outputTokens: 50, costUsdNano: 1_000 },
    grantId: `grant-${taskId}`, submittedAtMs: 1 };
}

function envelope(sequence: number, kind: string, payload: unknown, identities: Record<string, string> = {}) {
  return { schema_version: "1.0", event_id: `event-${sequence}`, trace_id: "fleet-browser",
    span_id: kind.startsWith("pod.") ? `pod:${identities.pod_id}` : `scheduler:installed:${sequence}`,
    parent_span_id: null, emitter_id: "zentra:event-journal", sequence,
    timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, sequence)).toISOString(), kind,
    actor: { id: kind.startsWith("pod.") ? "zentra-pod-coordinator" : "zentra-daemon-scheduler", role: "scheduler" },
    operation: { name: "scheduling", status: kind.includes("stale") ? "completed" : "running" },
    relationships: [], identities: { emitter_id: "zentra:event-journal", ...identities },
    attributes: { zentra: { global_position: sequence, native_type: kind } }, payload };
}

async function startSidecar(trace: string, root: string, maxBytes?: number): Promise<{ origin: string; child: ChildProcess }> {
  const executable = path.resolve("agenttrail/package/darwin-arm64/agenttrail");
  const child = spawn(executable, ["serve", trace, "--host", "127.0.0.1", "--port", "0",
    ...(maxBytes === undefined ? [] : ["--max-bytes", String(maxBytes)])], {
    detached: true, shell: false, env: { HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; let error = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /listening on (http:\/\/127\.0\.0\.1:[0-9]+\/)/.exec(output);
    if (match !== null) return { origin: match[1]!.replace(/\/$/, ""), child };
    if (child.exitCode !== null) throw new Error(`AgentTrail exited ${child.exitCode}: ${error}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`AgentTrail startup timed out: ${error}`);
}

function dump(url: string, root: string, width: number, height: number): Promise<string> {
  const profile = path.join(root, `profile-${width}`); mkdirSync(profile, { mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(browser!.executable, [browser!.flag, "--disable-background-networking", "--disable-extensions",
      "--disable-gpu", "--no-proxy-server", "--no-sandbox", "--no-first-run", `--window-size=${width},${height}`,
      "--virtual-time-budget=3000", `--user-data-dir=${profile}`, "--dump-dom", url], {
      detached: true, shell: false, env: { HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let error = "";
    let settled = false;
    const complete = async (failure: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminate(child);
      failure === null ? resolve(output) : reject(failure);
    };
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (output.includes('data-fleet-ready="true"') && output.includes("</html>")) void complete(null);
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
    child.once("error", (failure) => { void complete(failure); });
    child.once("close", (code) => { if (!settled) void complete(code === 0 ? null : new Error(`Chromium exited ${code}: ${error.slice(-512)}`)); });
    const timer = setTimeout(() => { void complete(new Error(`Chromium fleet render timed out: ${error.slice(-512)} DOM ${output.slice(-1_500)}`)); }, 30_000);
  });
}

function canonicalBrowser(candidate: string, flag: string) {
  if (!existsSync(candidate)) return null;
  const info = statSync(candidate);
  return info.isFile() && (info.mode & 0o111) !== 0 && realpathSync(candidate) === candidate ? { executable: candidate, flag } : null;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  if (child.exitCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
