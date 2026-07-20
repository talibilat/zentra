import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentTrailEvidence } from "../../src/agenttrail/agenttrail-events.js";
import type { AgentTrailReady, AgentTrailStartRequest } from "../../src/agenttrail/agenttrail-supervisor.js";
import { runCli } from "../../src/cli/main.js";
import { openAuthoritativeJournal } from "../../src/journal/retention.js";
import {
  startZentraService,
  type AgentTrailService,
  type RunningZentraService,
} from "../../src/service/start-service.js";

const directories: string[] = [];
const services: RunningZentraService[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.shutdown("test_requested")));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("live daemon CLI control channel", () => {
  it("routes submissions, reads, cancellation, and browser SSE through one durable gateway authority", async () => {
    const root = repository();
    const agentTrail = new FixtureAgentTrail();
    const service = await startZentraService({ cwd: root }, {
      createAgentTrail: (evidence) => agentTrail.attach(evidence),
    });
    services.push(service);
    const tokenPath = path.join(service.layout.runtimeDirectory, "cli-control.token");
    const controlToken = readFileSync(tokenPath, "utf8");
    const runtimeBefore = readFileSync(service.layout.runtimeStatePath, "utf8");
    const browser = await browserSession(service);

    const inline = await invoke(root, ["run", "Fix the live parser", "--actor", "operator-inline"]);
    const tickets = path.join(root, "tickets");
    mkdirSync(tickets);
    writeFileSync(path.join(tickets, "ticket.md"), "Implement the bounded ticket.\n", "utf8");
    const ticket = await invoke(root, ["run", "--tickets", tickets, "--actor", "operator-ticket"]);
    const inlineRunId = runId(inline);
    const ticketRunId = runId(ticket);

    const listed = await invoke(root, ["list"]);
    expect(listed.code).toBe(0);
    expect(JSON.stringify(listed.json)).toContain(inlineRunId);
    expect(JSON.stringify(listed.json)).toContain(ticketRunId);
    const status = await invoke(root, ["status", inlineRunId]);
    const version = ((status.json["run"] as { run: { streamVersion: number } }).run.streamVersion);
    const cancelled = await invoke(root, [
      "cancel", inlineRunId, "--expected-version", String(version),
      "--actor", "operator-cancel", "--command-id", "cancel-live-1",
    ]);
    expect(cancelled).toMatchObject({ code: 0, json: { command: "cancel" } });

    const changes = await fetch(`${service.origin}/api/v1/zentra/events?cursor=0`, {
      headers: { authorization: `Bearer ${browser.bearerToken}` },
    }).then((response) => response.text());
    expect(changes).toContain(inlineRunId);
    expect(changes).toContain(ticketRunId);
    expect(changes).toContain('"channel":"cli"');

    const output = [inline, ticket, listed, status, cancelled].map((item) => item.raw).join("\n");
    expect(output).not.toContain(controlToken);
    expect(runtimeBefore).not.toContain(controlToken);
    const journal = openAuthoritativeJournal(service.layout.databasePath, "read-only");
    expect(JSON.stringify(journal.readAll())).not.toContain(controlToken);
    journal.close();

    await service.shutdown("test_requested");
    services.splice(services.indexOf(service), 1);
    expect(() => readFileSync(tokenPath, "utf8")).toThrow();
    expect((await invoke(root, ["list"]))).toMatchObject({ code: 1, json: { error: { code: "unavailable" } } });

    const missing = repository();
    expect((await invoke(missing, ["list"]))).toMatchObject({ code: 1, json: { error: { code: "unavailable" } } });
  });
});

class FixtureAgentTrail implements AgentTrailService {
  private evidence: ((event: AgentTrailEvidence) => void | Promise<void>) | null = null;
  private readonly incarnation = "agenttrail-v1:99999999-9999-4999-8999-999999999999";

  attach(evidence: (event: AgentTrailEvidence) => void | Promise<void>): this {
    this.evidence = evidence;
    return this;
  }

  async start(request: AgentTrailStartRequest): Promise<AgentTrailReady> {
    const base = {
      schemaVersion: 1 as const,
      executableSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      incarnation: this.incarnation,
      occurredAt: new Date().toISOString(),
    };
    await this.evidence!({ type: "agenttrail.starting", ...base, pid: null,
      startupDeadlineMs: request.startupTimeoutMs,
      tracePathSha256: createHash("sha256").update(request.tracePath).digest("hex") });
    await this.evidence!({ type: "agenttrail.ready", ...base, pid: 4242,
      address: { host: "127.0.0.1", port: 4243 }, startupMs: 1 });
    return { pid: 4242, incarnation: this.incarnation, executableSha256: "a".repeat(64),
      address: { host: "127.0.0.1", port: 4243 } };
  }

  async shutdown(): Promise<void> {}
}

async function browserSession(service: RunningZentraService): Promise<{ bearerToken: string }> {
  const bootstrapToken = new URL(service.sessionUrl).hash.slice("#token=".length);
  const response = await fetch(`${service.origin}/api/v1/session`, {
    method: "POST",
    headers: { origin: service.origin, "content-type": "application/json" },
    body: JSON.stringify({ token: bootstrapToken }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { bearerToken: string };
}

async function invoke(cwd: string, argv: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  const raw = `${stdout}${stderr}`.trim();
  return { code, stdout, stderr, raw, json: JSON.parse(raw) as Record<string, unknown> };
}

function runId(result: Awaited<ReturnType<typeof invoke>>): string {
  return ((result.json["result"] as { run: { runId: string } }).run.runId);
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-live-daemon-cli-"));
  directories.push(root);
  execFileSync("/usr/bin/git", ["init", root], { env: { HOME: root }, stdio: "ignore" });
  execFileSync("/usr/bin/git", ["config", "user.name", "Zentra Test"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["config", "user.email", "zentra@example.invalid"], { cwd: root, env: { HOME: root } });
  execFileSync("/usr/bin/git", ["commit", "--allow-empty", "-m", "fixture"], {
    cwd: root, env: { HOME: root }, stdio: "ignore",
  });
  return realpathSync(root);
}
