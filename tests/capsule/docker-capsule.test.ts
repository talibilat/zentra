import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DockerCapsuleConformance,
  MITMPROXY_ARM64_DIGEST,
  MITMPROXY_INDEX_DIGEST,
  NODE_BASE_ARM64_DIGEST,
} from "../../src/capsule/docker-capsule.js";
import type { DockerClient } from "../../src/capsule/docker-client.js";
import { DockerCommandCancelledError, DockerCommandTimeoutError } from "../../src/capsule/docker-client.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

describe("DockerCapsuleConformance durable admission", () => {
  it("rejects a duplicate capsule stream before policy, assets, or Docker effects", async () => {
    const journal = new SqliteEventJournal(":memory:");
    journal.append("duplicate", 0, [{
      streamId: "duplicate", type: "capsule.started", payload: {}, causationId: null, correlationId: "duplicate",
    }]);
    const run = vi.fn();
    const capsule = new DockerCapsuleConformance(journal, { run } as unknown as DockerClient);
    await expect(capsule.run({
      capsuleId: "duplicate", policyPath: "/does/not/exist", projectPath: "/does/not/exist",
      signal: new AbortController().signal,
    })).rejects.toThrow("capsule stream already exists");
    expect(run).not.toHaveBeenCalled();
    journal.close();
  });

  it("maps the total capsule deadline to timed_out and still records cleanup", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-capsule-deadline-")));
    const policyPath = path.join(root, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1, reads: { mode: "exact_domains", domains: ["example.com"], methods: ["GET"] }, githubWrites: [], brokers: { github: "disabled", model: "disabled" },
    }));
    const journal = new SqliteEventJournal(":memory:");
    let first = true;
    const run = vi.fn((args: readonly string[], signal: AbortSignal) => {
      if (!first && args[0] === "image" && args[1] === "ls") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (!first) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "No such object" });
      first = false;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DockerCommandCancelledError()), { once: true });
      });
    });
    const capsule = new DockerCapsuleConformance(
      journal,
      { run, executable: "/Applications/Docker.app/Contents/Resources/bin/docker" } as unknown as DockerClient,
      25,
    );
    const report = await capsule.run({
      capsuleId: "deadline", policyPath, projectPath: root, signal: new AbortController().signal,
    });
    expect(report.outcome).toBe("timed_out");
    expect(report.cleanup).toBe("completed");
    expect(journal.readStream("deadline").map((event) => event.type)).toEqual([
      "capsule.started", "capsule.failure_observed", "capsule.cleanup_observed", "capsule.timed_out",
    ]);
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers and removes a labeled image after an uncertain build result", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-capsule-build-reconcile-")));
    const policyPath = path.join(root, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1, reads: { mode: "exact_domains", domains: ["example.com"], methods: ["GET"] },
      githubWrites: [], brokers: { github: "disabled", model: "disabled" },
    }));
    const imageId = `sha256:${"b".repeat(64)}`;
    let imagePresent = false;
    const run = vi.fn(async (args: readonly string[]) => {
      const joined = args.join(" ");
      if (joined === "context show") return { exitCode: 0, stdout: "desktop-linux\n", stderr: "" };
      if (args[0] === "version") return { exitCode: 0, stdout: JSON.stringify({ Client: { Version: "29.5.3" }, Server: { Version: "29.5.3", Arch: "arm64", Platform: { Name: "Docker Desktop 4.78.0" } } }), stderr: "" };
      if (joined.includes("buildx imagetools")) return { exitCode: 0, stdout: JSON.stringify({ manifests: [
        { digest: MITMPROXY_ARM64_DIGEST, platform: { architecture: "arm64", os: "linux" } },
        { digest: NODE_BASE_ARM64_DIGEST, platform: { architecture: "arm64", os: "linux" } },
      ] }), stderr: "" };
      if (args[0] === "pull") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "image" && args[1] === "inspect" && String(args[2]).startsWith("mitmproxy/")) return { exitCode: 0, stdout: JSON.stringify([{ Id: MITMPROXY_INDEX_DIGEST, RepoDigests: [`mitmproxy/mitmproxy@${MITMPROXY_INDEX_DIGEST}`], Architecture: "arm64", Os: "linux" }]), stderr: "" };
      if (args[0] === "build") { imagePresent = true; throw new DockerCommandTimeoutError(); }
      if (args[0] === "image" && args[1] === "ls" && imagePresent) return { exitCode: 0, stdout: `${imageId}\n`, stderr: "" };
      if (args[0] === "image" && args[1] === "inspect" && args[2] === imageId && imagePresent) return { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, Config: { Labels: { "org.zentra.capsule-id": "uncertain-build" } } }]), stderr: "" };
      if (args[0] === "image" && args[1] === "rm" && args.at(-1) === imageId) { imagePresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      return { exitCode: 1, stdout: "", stderr: "No such object" };
    });
    const journal = new SqliteEventJournal(":memory:");
    const report = await new DockerCapsuleConformance(
      journal,
      { run, executable: "/Applications/Docker.app/Contents/Resources/bin/docker" } as unknown as DockerClient,
      30_000,
    ).run({ capsuleId: "uncertain-build", policyPath, projectPath: root, signal: new AbortController().signal });
    expect(report.outcome).toBe("timed_out");
    expect(report.cleanup).toBe("completed");
    expect(imagePresent).toBe(false);
    expect(run).toHaveBeenCalledWith(["image", "rm", "--force", imageId], expect.any(AbortSignal), 30_000);
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
});
