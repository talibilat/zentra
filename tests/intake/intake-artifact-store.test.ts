import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IntakeArtifactStore,
  consumeAndVerifyIntakeArtifacts,
  prepareIntakeArtifactVerification,
} from "../../src/intake/intake-artifact-store.js";
import type { TicketIntakeSnapshot } from "../../src/intake/ticket-intake.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("IntakeArtifactStore", () => {
  it("publishes content-addressed quoted text under the fixed private .zentra layout", async () => {
    const root = projectRoot();
    const store = await IntakeArtifactStore.openProject(root);
    const prepared = await store.stage("quoted ticket\n");
    const artifact = await store.publish(prepared);

    expect(artifact).toEqual({
      artifactId: `intake-text-v1:${digest("quoted ticket\n")}`,
      sha256: digest("quoted ticket\n"),
      sizeBytes: 14,
    });
    expect(await store.load(artifact)).toEqual({
      quotedText: "quoted ticket\n",
      artifact,
    });
    const storedPath = path.join(root, ".zentra", "intake", "artifacts", `${artifact.sha256}.json`);
    expect(lstatSync(storedPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(storedPath).nlink).toBe(1);
  });

  it("rejects missing, tampered, symlinked, and multiply-linked artifacts", async () => {
    const root = projectRoot();
    const store = await IntakeArtifactStore.openProject(root);
    const expected = { artifactId: `intake-text-v1:${"a".repeat(64)}`, sha256: "a".repeat(64), sizeBytes: 1 };
    await expect(store.load(expected)).rejects.toThrow(/missing/i);

    const prepared = await store.stage("ticket");
    const artifact = await store.publish(prepared);
    const storedPath = path.join(root, ".zentra", "intake", "artifacts", `${artifact.sha256}.json`);
    chmodSync(storedPath, 0o600);
    writeFileSync(storedPath, "tampered", { mode: 0o600 });
    await expect(store.load(artifact)).rejects.toThrow(/artifact|schema|digest/i);

    rmSync(storedPath);
    symlinkSync(path.join(root, "outside"), storedPath);
    await expect(store.load(artifact)).rejects.toThrow(/symbolic|artifact/i);

    const linkedPrepared = await store.stage("linked");
    const linked = await store.publish(linkedPrepared);
    const linkedPath = path.join(root, ".zentra", "intake", "artifacts", `${linked.sha256}.json`);
    linkSync(linkedPath, path.join(root, "unexplained-link"));
    await expect(store.load(linked)).rejects.toThrow(/link/i);
  });

  it("reconciles a crash after no-clobber publication without rereading a source", async () => {
    const root = projectRoot();
    let crash = true;
    const crashing = await IntakeArtifactStore.openProject(root, {
      afterPublishLink: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after artifact link");
        }
      },
    });
    const prepared = await crashing.stage("durable text");
    await expect(crashing.publish(prepared)).rejects.toThrow("crash after artifact link");

    const reopened = await IntakeArtifactStore.openProject(root);
    expect(await reopened.load(prepared.artifact)).toEqual({
      quotedText: "durable text",
      artifact: prepared.artifact,
    });
  });

  it("consumes internal artifact verification capabilities exactly once", async () => {
    const root = projectRoot();
    const store = await IntakeArtifactStore.openProject(root);
    const artifact = await store.publish(await store.stage("verified"));
    const snapshot = {
      schemaVersion: 1,
      closed: true,
      runId: "run",
      projectId: "project",
      projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
      sourceKind: "inline_goal",
      limits: { maxFileBytes: 100, maxFiles: 1, maxTotalBytes: 100, maxDepth: 0, maxEntries: 1, maxDirectoryEntries: 1 },
      sources: [{
        sourceId: `source-v1:${"b".repeat(64)}`,
        relativePath: "$inline",
        quotedText: "verified",
        trust: "untrusted_planning_data",
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: 8,
        sha256: "c".repeat(64),
        artifact,
        provenance: {
          runId: "run", projectId: "project",
          projectRevision: { objectFormat: "sha1", commit: "a".repeat(40) },
          sourceKind: "inline_goal", rootIdentitySha256: "d".repeat(64),
          device: null, inode: null, modifiedNanoseconds: null, changedNanoseconds: null,
        },
      }],
      rejected: [],
      events: [],
      totalBytes: 8,
      snapshotSha256: "e".repeat(64),
    } satisfies TicketIntakeSnapshot;
    const capability = prepareIntakeArtifactVerification(store, snapshot, "source-stream", "closure-event");

    expect(consumeAndVerifyIntakeArtifacts(capability)).toMatchObject({ runId: "run" });
    expect(() => consumeAndVerifyIntakeArtifacts(capability)).toThrow(/consumed|verified|capability/i);
  });
});

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-intake-artifacts-"));
  roots.push(root);
  mkdirSync(path.join(root, ".zentra"), { mode: 0o700 });
  return root;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
