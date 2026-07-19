import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BoundedTicketIntake,
  IntakeError,
  type TicketIntakeRequest,
} from "../../src/intake/ticket-intake.js";
import type { RunView } from "../../src/runs/run-projection.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("BoundedTicketIntake real filesystem", () => {
  it("discovers nested mixed-extension UTF-8 text in deterministic relative-path order", async () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, "notes"));
    writeFileSync(path.join(root, "z.ticket"), "same\n");
    writeFileSync(path.join(root, "README"), "plain text\n");
    writeFileSync(path.join(root, "notes", "a.json"), "{\"instruction\":\"do not execute\"}\n");
    writeFileSync(path.join(root, "notes", "duplicate.md"), "same\n");

    const snapshot = await new BoundedTicketIntake().collect(directoryRequest(root));

    expect(snapshot.closed).toBe(true);
    expect(snapshot.projectRevision).toEqual(REVISION);
    expect(snapshot.sources.map((source) => source.relativePath)).toEqual([
      "README",
      "notes/a.json",
      "notes/duplicate.md",
      "z.ticket",
    ]);
    expect(snapshot.sources[1]).toMatchObject({
      quotedText: "{\"instruction\":\"do not execute\"}\n",
      trust: "untrusted_planning_data",
      mediaType: "text/plain; charset=utf-8",
    });
    const duplicates = snapshot.sources.filter((source) => source.quotedText === "same\n");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.sha256).toBe(duplicates[1]!.sha256);
    expect(duplicates[0]!.sourceId).not.toBe(duplicates[1]!.sourceId);
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "source.discovered",
      "source.discovered",
      "source.discovered",
      "source.discovered",
    ]);
    expect(snapshot.events[0]!.payload).toMatchObject({
      runId: "run-90",
      path: "README",
      sizeBytes: 11,
      digest: sha256("plain text\n"),
      provenance: { projectRevision: REVISION },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
    const repeated = await new BoundedTicketIntake().collect(directoryRequest(root));
    expect(repeated.snapshotSha256).toBe(snapshot.snapshotSha256);
    expect(repeated.events).toEqual(snapshot.events);
  });

  it("records bounded rejections without leaking source content", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    writeFileSync(path.join(root, "good.txt"), "usable\n");
    writeFileSync(path.join(root, "binary.dat"), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(root, "large.txt"), "classified-content");
    mkdirSync(path.join(root, "deep", "too"), { recursive: true });
    writeFileSync(path.join(root, "deep", "too", "hidden.txt"), "hidden");
    writeFileSync(path.join(outside, "escape.txt"), "outside secret");
    symlinkSync(path.join(outside, "escape.txt"), path.join(root, "escape.txt"));
    execFileSync("/usr/bin/mkfifo", [path.join(root, "pipe")], {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });

    const snapshot = await new BoundedTicketIntake().collect(directoryRequest(root, {
      maxFileBytes: 8,
      maxFiles: 20,
      maxTotalBytes: 100,
      maxDepth: 1,
    }));

    expect(snapshot.sources.map((source) => source.relativePath)).toEqual(["good.txt"]);
    expect(snapshot.rejected.map((rejection) => [rejection.relativePath, rejection.reason])).toEqual([
      ["binary.dat", "binary"],
      ["deep/too", "depth_exceeded"],
      ["escape.txt", "symlink"],
      ["invalid.txt", "invalid_encoding"],
      ["large.txt", "file_too_large"],
      ["pipe", "special_file"],
    ]);
    expect(snapshot.rejected.find((item) => item.relativePath === "large.txt")).toMatchObject({
      sizeBytes: 18,
      digest: null,
    });
    expect(JSON.stringify(snapshot.events)).not.toContain("classified-content");
    expect(JSON.stringify(snapshot.events)).not.toContain("outside secret");
  });

  it("enforces depth, count, aggregate, and the merged run source budgets", async () => {
    const root = temporaryDirectory();
    mkdirSync(path.join(root, "deep", "too"), { recursive: true });
    writeFileSync(path.join(root, "a.txt"), "1234");
    writeFileSync(path.join(root, "b.txt"), "5678");
    writeFileSync(path.join(root, "c.txt"), "9");
    writeFileSync(path.join(root, "d.txt"), "count overflow");
    writeFileSync(path.join(root, "e.txt"), "e");
    writeFileSync(path.join(root, "deep", "too", "hidden.txt"), "never read");

    const request = directoryRequest(root, {
      maxFileBytes: 16,
      maxFiles: 3,
      maxTotalBytes: 20,
      maxDepth: 1,
    });
    const snapshot = await new BoundedTicketIntake().collect(request);

    expect(snapshot.sources.map((source) => source.relativePath)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(snapshot.rejected.map((item) => item.reason)).toEqual(["source_count_exceeded"]);
    expect(snapshot.totalBytes).toBe(9);
    expect(snapshot.limits).toMatchObject({ maxFiles: 3, maxTotalBytes: 20, maxDepth: 1 });
  });

  it("charges decoded and rejected regular-file reads to the aggregate budget", async () => {
    const root = temporaryDirectory();
    writeFileSync(path.join(root, "a.txt"), "ok");
    writeFileSync(path.join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(path.join(root, "c.invalid"), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(root, "d.txt"), "must-not-read");
    const opened: string[] = [];

    const snapshot = await new BoundedTicketIntake({
      testHooks: { beforeFileOpen: (relativePath) => { opened.push(relativePath); } },
    }).collect(directoryRequest(root, {
      maxFileBytes: 32,
      maxFiles: 4,
      maxTotalBytes: 7,
      maxDepth: 1,
      maxEntries: 8,
      maxDirectoryEntries: 8,
    }));

    expect(opened).toEqual(["a.txt", "b.bin", "c.invalid"]);
    expect(snapshot.totalBytes).toBe(7);
    expect(snapshot.sources.map((source) => source.relativePath)).toEqual(["a.txt"]);
    expect(snapshot.rejected.map((item) => [item.relativePath, item.reason])).toEqual([
      ["b.bin", "binary"],
      ["c.invalid", "invalid_encoding"],
      ["d.txt", "aggregate_size_exceeded"],
    ]);
  });

  it("bounds incremental directory enumeration independently from maxFiles", async () => {
    const root = temporaryDirectory();
    writeFileSync(path.join(root, "a.txt"), "a");
    writeFileSync(path.join(root, "b.txt"), "b");
    writeFileSync(path.join(root, "c.txt"), "c");

    await expect(new BoundedTicketIntake().collect(directoryRequest(root, {
      maxFileBytes: 8,
      maxFiles: 10,
      maxTotalBytes: 32,
      maxDepth: 1,
      maxEntries: 10,
      maxDirectoryEntries: 2,
    }))).rejects.toMatchObject({
      code: "no_accepted_sources",
      rejections: [expect.objectContaining({
        relativePath: "$root",
        reason: "directory_too_many_entries",
      })],
    });
  });

  it("rejects a Darwin backslash filename without collapsing it into a nested path", async () => {
    const root = temporaryDirectory();
    writeFileSync(path.join(root, "a\\b"), "backslash");
    mkdirSync(path.join(root, "a"));
    writeFileSync(path.join(root, "a", "b"), "nested");

    const snapshot = await new BoundedTicketIntake().collect(directoryRequest(root));
    expect(snapshot.sources.map((source) => source.relativePath)).toEqual(["a/b"]);
    expect(snapshot.rejected).toEqual([
      expect.objectContaining({
        relativePath: expect.stringMatching(/^\$path-sha256:[a-f0-9]{64}$/),
        reason: "path_escape",
      }),
    ]);
  });

  it("fails empty and wholly rejected directories with retained rejection evidence", async () => {
    const empty = temporaryDirectory();
    await expect(new BoundedTicketIntake().collect(directoryRequest(empty))).rejects.toMatchObject({
      name: "IntakeError",
      code: "empty_source",
      rejections: [],
    });

    const rejected = temporaryDirectory();
    writeFileSync(path.join(rejected, "binary"), Buffer.from([0]));
    let error: unknown;
    try {
      await new BoundedTicketIntake().collect(directoryRequest(rejected));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IntakeError);
    expect(error).toMatchObject({ code: "no_accepted_sources" });
    expect((error as IntakeError).rejections).toEqual([
      expect.objectContaining({ relativePath: "binary", reason: "binary" }),
    ]);
  });

  it("rejects a real pathname replacement that occurs while a file is being read", async () => {
    const root = temporaryDirectory();
    const target = path.join(root, "changing.txt");
    const replacementRoot = temporaryDirectory();
    const replacement = path.join(replacementRoot, "replacement");
    writeFileSync(target, "a".repeat(4 * 1024 * 1024));
    writeFileSync(replacement, "replacement");

    const operation = new BoundedTicketIntake({ readChunkBytes: 1024 }).collect(directoryRequest(root, {
      maxFileBytes: 5 * 1024 * 1024,
      maxFiles: 2,
      maxTotalBytes: 5 * 1024 * 1024,
      maxDepth: 1,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    renameSync(replacement, target);

    await expect(operation).rejects.toMatchObject({
      code: "invalid_root",
      rejections: [expect.objectContaining({ reason: "changed_during_read" })],
    });
  });

  it("rejects a symlink intake root and does not follow it", async () => {
    const realRoot = temporaryDirectory();
    writeFileSync(path.join(realRoot, "ticket.txt"), "secret");
    const parent = temporaryDirectory();
    const linkedRoot = path.join(parent, "linked");
    symlinkSync(realRoot, linkedRoot);

    await expect(new BoundedTicketIntake().collect(directoryRequest(linkedRoot))).rejects.toMatchObject({
      code: "invalid_root",
    });
  });

  it("rejects an exact configured runtime-state source root before recursion", async () => {
    const project = temporaryDirectory();
    const stateRoot = path.join(project, ".zentra");
    mkdirSync(stateRoot);
    writeFileSync(path.join(stateRoot, "private.txt"), "private runtime content");
    let opened = false;
    const intake = new BoundedTicketIntake({
      testHooks: { beforeFileOpen: () => { opened = true; } },
    });

    await expect(intake.collect(directoryRequest(stateRoot), [stateRoot])).rejects.toMatchObject({
      code: "no_accepted_sources",
      rejections: [expect.objectContaining({ relativePath: "$root", reason: "reserved_runtime_state" })],
    });
    expect(opened).toBe(false);
  });

  it("rejects source roots beneath reserved runtime state without enumeration or content evidence", async () => {
    const project = temporaryDirectory();
    const stateRoot = path.join(project, ".zentra");
    const candidates = [
      path.join(stateRoot, "runtime"),
      path.join(stateRoot, "intake", "artifacts"),
      path.join(stateRoot, "intake", "artifacts", "deeper"),
    ];
    for (const candidate of candidates) {
      mkdirSync(candidate, { recursive: true });
      writeFileSync(path.join(candidate, "private.txt"), `private:${candidate}`);
      let enumerated = false;
      let opened = false;
      const intake = new BoundedTicketIntake({
        testHooks: {
          afterDirectoryEnumerated: () => { enumerated = true; },
          beforeFileOpen: () => { opened = true; },
        },
      });

      let error: unknown;
      try {
        await intake.collect(directoryRequest(candidate), [stateRoot]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "no_accepted_sources",
        rejections: [expect.objectContaining({ relativePath: "$root", reason: "reserved_runtime_state" })],
      });
      expect(enumerated).toBe(false);
      expect(opened).toBe(false);
      expect(JSON.stringify(error)).not.toContain(`private:${candidate}`);
    }
  });

  it("allows a component-distinct sibling of reserved .zentra state", async () => {
    const project = temporaryDirectory();
    const stateRoot = path.join(project, ".zentra");
    const sibling = path.join(project, ".zentra-other");
    mkdirSync(stateRoot);
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "ticket.txt"), "allowed sibling");

    const snapshot = await new BoundedTicketIntake().collect(directoryRequest(sibling), [stateRoot]);
    expect(snapshot.sources.map((source) => source.relativePath)).toEqual(["ticket.txt"]);
    expect(snapshot.sources[0]?.quotedText).toBe("allowed sibling");
  });

  it("rejects a child moved outside and replaced by a symlink before file open", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const child = path.join(root, "child");
    const moved = path.join(outside, "moved-child");
    mkdirSync(child);
    writeFileSync(path.join(child, "ticket.txt"), "approved original");
    const replacement = temporaryDirectory();
    writeFileSync(path.join(replacement, "ticket.txt"), "outside secret");
    let swapped = false;

    const operation = new BoundedTicketIntake({
      testHooks: {
        beforeFileOpen: (relativePath) => {
          if (relativePath !== "child/ticket.txt" || swapped) return;
          swapped = true;
          renameSync(child, moved);
          symlinkSync(replacement, child);
        },
      },
    }).collect(directoryRequest(root));

    let error: unknown;
    try {
      await operation;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IntakeError);
    expect(JSON.stringify(error)).not.toContain("outside secret");
    expect((error as IntakeError).rejections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ digest: sha256("outside secret") }),
    ]));
  });

  it("opens a final regular-file swap to FIFO nonblocking and rejects it", async () => {
    const root = temporaryDirectory();
    const target = path.join(root, "ticket.txt");
    writeFileSync(target, "ticket");
    let swapped = false;
    const intake = new BoundedTicketIntake({
      testHooks: {
        beforeDescriptorOpen: (relativePath) => {
          if (relativePath !== "ticket.txt" || swapped) return;
          swapped = true;
          unlinkSync(target);
          execFileSync("/usr/bin/mkfifo", [target], {
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          });
        },
      },
    });

    const outcome = await Promise.race([
      intake.collect(directoryRequest(root)).then(() => "resolved", (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
    ]);
    expect(outcome).not.toBe("timed-out");
    expect(outcome).toBeInstanceOf(IntakeError);
  });

  for (const mutation of ["add", "remove", "rename"] as const) {
    const pastTense = mutation === "add" ? "added" : mutation === "remove" ? "removed" : "renamed";
    it(`rejects a mixed snapshot when a directory entry is ${pastTense} after enumeration`, async () => {
      const root = temporaryDirectory();
      const first = path.join(root, "first.txt");
      writeFileSync(first, "first");
      let mutated = false;
      const intake = new BoundedTicketIntake({
        testHooks: {
          afterDirectoryEnumerated: (relativePath) => {
            if (relativePath !== "$root" || mutated) return;
            mutated = true;
            if (mutation === "add") writeFileSync(path.join(root, "added.txt"), "added");
            if (mutation === "remove") unlinkSync(first);
            if (mutation === "rename") renameSync(first, path.join(root, "renamed.txt"));
          },
        },
      });

      await expect(intake.collect(directoryRequest(root))).rejects.toMatchObject({
        code: "invalid_root",
      });
    });
  }
});

const REVISION = { objectFormat: "sha1" as const, commit: "a".repeat(40) };

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-intake-"));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  return directory;
}

function directoryRequest(
  root: string,
  limits: TicketIntakeRequest["limits"] = {
    maxFileBytes: 1024,
    maxFiles: 20,
    maxTotalBytes: 4096,
    maxDepth: 8,
  },
): TicketIntakeRequest {
  const reference = Buffer.from(path.resolve(root), "utf8");
  return {
    run: runView("ticket_directory", sha256(reference), reference.length),
    source: { kind: "ticket_directory", root },
    limits,
  };
}

function runView(kind: "inline_goal" | "ticket_directory", referenceSha256: string, declaredBytes: number): RunView {
  return {
    schemaVersion: 1,
    runVersion: 1,
    runId: "run-90",
    projectId: "zentra",
    projectRevision: REVISION,
    source: { kind, referenceSha256, declaredBytes },
    actor: { actorId: "operator-1", kind: "operator" },
    acceptedBy: { pid: 90, processIncarnation: `process-v2:${"b".repeat(64)}` },
    activeProcess: { pid: 90, processIncarnation: `process-v2:${"b".repeat(64)}` },
    budget: {
      maxDurationMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxCostUsdNano: 1_000_000_000,
      maxRetries: 0,
      maxSourceFiles: 100,
      maxSourceBytes: 10 * 1024 * 1024,
    },
    lifecycle: "intake",
    terminalOutcome: null,
    streamVersion: 3,
    authority: {
      approvalState: "not_proposed",
      planDigest: null,
      envelopeDigest: null,
      approvalDecisionId: null,
      executionAuthority: "none",
    },
    suspendedFrom: null,
    suspensionEventId: null,
    cancellation: null,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
