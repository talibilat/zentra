import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import {
  DeterministicReviewerAdapter,
  ReviewerExecutionError,
} from "../../src/reviews/reviewer-adapter.js";
import type { ValidationReport } from "../../src/capabilities/validation-runner.js";
import type { WorkerRequest, WorkerResult } from "../../src/workers/worker-adapter.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  cleanup.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join("/tmp", "reviewer-adapter-"));
  cleanup.push(dir);
  return dir;
}

function getFixturePath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(__dirname, "../../fixtures/deterministic-reviewer.mjs");
}

describe("DeterministicReviewerAdapter", () => {
  const validationReport: ValidationReport = {
    name: "focused",
    outcome: "completed",
    exitCode: 0,
    stdout: "test output",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    command: ["echo", "test"],
    argvSha256: createHash("sha256").update(JSON.stringify(["echo", "test"])).digest("hex"),
    outputSha256: createHash("sha256")
      .update(JSON.stringify({ stdout: "test output", stderr: "" }))
      .digest("hex"),
  };

  it("executes the reviewer fixture successfully", async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    const decision = await adapter.review(
      {
        workerId: "worker-1",
        reviewerId: "reviewer-1",
        diff,
        validation: validationReport,
      },
      AbortSignal.timeout(5000)
    );

    expect(decision).toBeDefined();
    expect(decision.reviewerId).toBe("reviewer-1");
    expect(typeof decision.approved).toBe("boolean");
    expect(decision.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decision.reason).toBeDefined();
  });

  it("approves when worker and reviewer are different with valid digests", async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    const decision = await adapter.review(
      {
        workerId: "worker-1",
        reviewerId: "reviewer-1",
        diff,
        validation: validationReport,
      },
      AbortSignal.timeout(5000)
    );

    expect(decision.approved).toBe(true);
  });

  it("rejects when worker and reviewer have the same identity", async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    await expect(
      adapter.review(
        {
          workerId: "same-id",
          reviewerId: "same-id",
          diff,
          validation: validationReport,
        },
        AbortSignal.timeout(5000)
      )
    ).rejects.toThrow(/worker.*reviewer|identity|same/i);
  });

  it("rejects when worker and reviewer match before spawning", async () => {
    class RecordingSupervisor extends ProcessSupervisor {
      calls = 0;

      override execute(_request: WorkerRequest, _signal: AbortSignal): Promise<WorkerResult> {
        this.calls += 1;
        throw new Error("should not spawn");
      }
    }
    const supervisor = new RecordingSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    await expect(
      adapter.review(
        {
          workerId: "id",
          reviewerId: "id",
          diff,
          validation: validationReport,
        },
        AbortSignal.timeout(5000)
      )
    ).rejects.toThrow();
    expect(supervisor.calls).toBe(0);
  });

  it("includes diffSha256 in decision", async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    const decision = await adapter.review(
      {
        workerId: "worker-1",
        reviewerId: "reviewer-1",
        diff,
        validation: validationReport,
      },
      AbortSignal.timeout(5000)
    );

    expect(decision.diffSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes validationSha256 in decision", async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new DeterministicReviewerAdapter(supervisor, getFixturePath());

    const diff = "diff content";
    const decision = await adapter.review(
      {
        workerId: "worker-1",
        reviewerId: "reviewer-1",
        diff,
        validation: validationReport,
      },
      AbortSignal.timeout(5000)
    );

    expect(decision.validationSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["extra keys", '{"reviewerId":"reviewer-1","approved":true,"diffSha256":"%D%","validationSha256":"%V%","decidedAt":"2026-01-01T00:00:00.000Z","reason":"ok","extra":true}'],
    ["invalid digest", '{"reviewerId":"reviewer-1","approved":true,"diffSha256":"ABC","validationSha256":"%V%","decidedAt":"2026-01-01T00:00:00.000Z","reason":"ok"}'],
    ["invalid timestamp", '{"reviewerId":"reviewer-1","approved":true,"diffSha256":"%D%","validationSha256":"%V%","decidedAt":"yesterday","reason":"ok"}'],
    ["wrong types", '{"reviewerId":"reviewer-1","approved":"yes","diffSha256":"%D%","validationSha256":"%V%","decidedAt":"2026-01-01T00:00:00.000Z","reason":"ok"}'],
  ])("rejects a reviewer event with %s", async (_case, eventTemplate) => {
    const fixture = path.join(makeTempDir(), "reviewer.mjs");
    writeFileSync(fixture, `process.stdout.write(${JSON.stringify(`${eventTemplate.replaceAll("%D%", "d".repeat(64)).replaceAll("%V%", "e".repeat(64))}\n`)});`);
    const adapter = new DeterministicReviewerAdapter(new ProcessSupervisor(), fixture);

    await expect(adapter.review(
      { workerId: "worker-1", reviewerId: "reviewer-1", diff: "diff", validation: validationReport },
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/invalid|protocol/i);
  });

  it("rejects multiple reviewer events", async () => {
    const fixture = path.join(makeTempDir(), "reviewer.mjs");
    const event = {
      reviewerId: "reviewer-1",
      approved: true,
      diffSha256: "d".repeat(64),
      validationSha256: "e".repeat(64),
      decidedAt: "2026-01-01T00:00:00.000Z",
      reason: "ok",
    };
    writeFileSync(fixture, `console.log(${JSON.stringify(JSON.stringify(event))}); console.log(${JSON.stringify(JSON.stringify(event))});`);
    const adapter = new DeterministicReviewerAdapter(new ProcessSupervisor(), fixture);

    await expect(adapter.review(
      { workerId: "worker-1", reviewerId: "reviewer-1", diff: "diff", validation: validationReport },
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/exactly one|protocol/i);
  });

  it.each(["cancelled", "timed_out", "failed"] as const)(
    "preserves a supervised %s reviewer outcome in a typed error",
    async (outcome) => {
      class OutcomeSupervisor extends ProcessSupervisor {
        override execute(): Promise<WorkerResult> {
          return Promise.resolve({
            outcome,
            exitCode: null,
            events: [],
            stdout: "",
            rawStdout: "",
            stderr: "reviewer stopped",
          });
        }
      }
      const adapter = new DeterministicReviewerAdapter(
        new OutcomeSupervisor(),
        getFixturePath(),
      );

      await expect(
        adapter.review(
          {
            workerId: "worker-1",
            reviewerId: "reviewer-1",
            diff: "diff",
            validation: validationReport,
          },
          new AbortController().signal,
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ReviewerExecutionError>>({
          name: "ReviewerExecutionError",
          outcome,
        }),
      );
    },
  );
});
