import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DockerCapsuleConformance } from "../../src/capsule/docker-capsule.js";
import { DockerClient } from "../../src/capsule/docker-client.js";
import { ProjectingEventJournal } from "../../src/journal/projecting-journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("secure Docker capsule acceptance", () => {
  it("passes the complete real Docker Desktop boundary and retained audit trail", async () => {
    expect(process.platform).toBe("darwin");
    expect(process.arch).toBe("arm64");
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-capsule-e2e-")));
    temporaryDirectories.push(root);
    const project = path.join(root, "project");
    mkdirSync(project);
    writeFileSync(path.join(project, "source.txt"), "read only\n");
    writeFileSync(path.join(root, "outside-marker"), "unchanged\n");
    symlinkSync("../outside-marker", path.join(project, ".zentra-symlink-probe"));
    const databasePath = path.join(root, "journal.sqlite");
    const tracePath = path.join(root, "agent-tail.jsonl");
    const sqlite = new SqliteEventJournal(databasePath);
    const sink = AgentTailJsonlFileSink.open(root, tracePath);
    const journal = new ProjectingEventJournal(sqlite, sink);
    let report;
    try {
      report = await new DockerCapsuleConformance(journal).run({
        capsuleId: "docker-acceptance",
        policyPath: path.resolve(import.meta.dirname, "../fixtures/capsule-policy.json"),
        projectPath: realpathSync.native(project),
        signal: AbortSignal.timeout(7 * 60_000),
      });
    } finally {
      sink.close();
      sqlite.close();
    }

    expect(report.outcome, JSON.stringify(report)).toBe("completed");
    expect(report.cleanup).toBe("completed");
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(readFileSync(path.join(root, "outside-marker"), "utf8")).toBe("unchanged\n");
    const replay = SqliteEventJournal.openReadOnly(databasePath);
    const events = replay.readStream("docker-acceptance");
    replay.close();
    expect(events.at(-1)?.type).toBe("capsule.completed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "capsule.proxy_interaction_observed",
      payload: expect.objectContaining({ host: "private-alias.test", allowed: false, reason: "private_target_denied" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "capsule.proxy_interaction_observed",
      payload: expect.objectContaining({ method: "CONNECT", host: "127.0.0.1", allowed: false }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "capsule.proxy_interaction_observed",
      payload: expect.objectContaining({ method: "CONNECT", host: "iana.org", allowed: false, reason: "domain_not_allowed" }),
    }));
    expect(report.checks.proxyAllowedConnectOpaqueDenied).toBe(true);
    const proxyReasons = events
      .filter((event) => event.type === "capsule.proxy_interaction_observed")
      .map((event) => (event.payload as { reason: string }).reason);
    expect(proxyReasons).toEqual(expect.arrayContaining([
      "configured_read", "plaintext_http_denied", "method_denied", "upgrade_denied",
      "read_body_denied", "private_target_denied",
    ]));
    const jsonl = readFileSync(tracePath, "utf8");
    expect(jsonl).toContain('"schema_version":"1.0"');
    expect(jsonl).toContain('"kind":"capsule.completed"');
    expect(jsonl).not.toMatch(/authorization|raw-token|password|GH_TOKEN/i);
    const docker = new DockerClient();
    for (const filter of ["container", "network"] as const) {
      const result = await docker.run(
        filter === "container"
          ? ["ps", "--all", "--filter", "name=zentra-", "--quiet"]
          : ["network", "ls", "--filter", "name=zentra-", "--quiet"],
        new AbortController().signal,
        30_000,
      );
      expect(result.stdout.trim()).toBe("");
    }
  }, 8 * 60_000);
});
