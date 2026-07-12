import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import {
  canonicalValidationDigest,
  ProcessReviewerAdapter,
  ReviewerExecutionError,
} from "../../src/reviews/reviewer-adapter.js";
import { DeterministicReviewerAdapter } from "../support/deterministic-reviewer-adapter.js";
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
  return path.join(__dirname, "../fixtures/deterministic-reviewer.mjs");
}

function getContentAwareFixturePath(): string {
  return path.resolve(import.meta.dirname, "../fixtures/content-aware-reviewer.mjs");
}

function processReviewer(
  fixture: string,
  options: { readonly timeoutMs?: number; readonly maxInputBytes?: number; readonly maxOutputBytes?: number } = {},
): ProcessReviewerAdapter {
  return new ProcessReviewerAdapter({
    executable: process.execPath,
    args: [fixture],
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
}

function reviewerScript(source: string): string {
  const fixture = path.join(makeTempDir(), "reviewer.mjs");
  writeFileSync(fixture, source, "utf8");
  return fixture;
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
    provenance: {
      invocationId: "reviewer-test-validation",
      canonicalCwd: "/tmp",
      subjectSha256: "reviewer-test-subject",
    },
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

  it("denies a dangerous diff even when focused validation passes", async () => {
    const adapter = processReviewer(getContentAwareFixturePath());
    const dangerousDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-export const requireAuthentication = true;",
      "+export const requireAuthentication = false;",
      "",
    ].join("\n");

    const decision = await adapter.review(
      {
        workerId: "worker-1",
        reviewerId: "reviewer-1",
        diff: dangerousDiff,
        validation: validationReport,
      },
      AbortSignal.timeout(5_000),
    );

    expect(validationReport.outcome).toBe("completed");
    expect(validationReport.exitCode).toBe(0);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/authentication|dangerous|security/i);
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

describe("ProcessReviewerAdapter", () => {
  const validationReport: ValidationReport = {
    name: "focused",
    outcome: "completed",
    exitCode: 0,
    stdout: "focused validation passed",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    command: ["node", "--test"],
    argvSha256: createHash("sha256").update(JSON.stringify(["node", "--test"])).digest("hex"),
    outputSha256: createHash("sha256")
      .update(JSON.stringify({ stdout: "focused validation passed", stderr: "" }))
      .digest("hex"),
    provenance: {
      invocationId: "content-review-validation",
      canonicalCwd: "/tmp",
      subjectSha256: "content-review-subject",
    },
  };
  const input = {
    workerId: "worker-1",
    reviewerId: "reviewer-1",
    diff: "diff --git a/file b/file\n-old\n+new\n",
    validation: validationReport,
  } as const;

  it("sends the exact diff and validation evidence through stdin rather than argv", async () => {
    const decision = await processReviewer(getContentAwareFixturePath()).review(
      input,
      AbortSignal.timeout(5_000),
    );

    expect(decision.approved).toBe(true);
    expect(decision.reason).toContain(validationReport.stdout);
  });

  it("rejects reviewer input that exceeds its byte bound before spawning", async () => {
    const fixture = reviewerScript('process.stdout.write("should not run\\n");');
    const adapter = processReviewer(fixture, { maxInputBytes: 128 });

    await expect(adapter.review(
      { ...input, diff: "x".repeat(129) },
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/input.*limit|evidence.*large|bounded/i);
  });

  it("fails closed when the reviewer returns an evidence digest mismatch", async () => {
    const fixture = reviewerScript(`
      import { createHash } from "node:crypto";
      let body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      console.log(JSON.stringify({
        reviewerId: request.reviewerId,
        decision: "approve",
        requestSha256: createHash("sha256").update(body).digest("hex"),
        diffSha256: "0".repeat(64),
        validationSha256: request.validationSha256,
        decidedAt: new Date().toISOString(),
        reason: "reviewed"
      }));
    `);

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/diff.*digest.*mismatch|evidence.*mismatch/i);
  });

  it("fails closed when the reviewer returns the right diff digest but wrong validation digest", async () => {
    const fixture = reviewerScript(`
      import { createHash } from "node:crypto";
      let body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      console.log(JSON.stringify({
        reviewerId: request.reviewerId,
        decision: "approve",
        requestSha256: createHash("sha256").update(body).digest("hex"),
        diffSha256: request.diffSha256,
        validationSha256: "0".repeat(64),
        decidedAt: new Date().toISOString(),
        reason: "reviewed"
      }));
    `);

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/validation.*digest.*mismatch|evidence.*mismatch/i);
  });

  it("fails closed when the reviewer closes stdin early", async () => {
    const fixture = reviewerScript("process.stdin.destroy(); process.exit(0);");

    await expect(processReviewer(fixture).review(
      { ...input, diff: "x".repeat(1_800_000) },
      AbortSignal.timeout(5_000),
    )).rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  it("does not accept a zero exit from a reviewer that does not consume the full request", async () => {
    const diff = "x".repeat(1_800_000);
    const fixture = reviewerScript(`
      process.stdin.destroy();
      console.log(${JSON.stringify(JSON.stringify({
        reviewerId: input.reviewerId,
        decision: "approve",
        diffSha256: createHash("sha256").update(diff).digest("hex"),
        validationSha256: canonicalValidationDigest(validationReport),
        decidedAt: "2026-01-01T00:00:02.000Z",
        reason: "did not read request",
      }))});
    `);

    await expect(processReviewer(fixture).review(
      { ...input, diff },
      AbortSignal.timeout(5_000),
    )).rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  it("does not approve a valid-looking decision from a reviewer that never reads stdin", async () => {
    const fixture = reviewerScript(`
      console.log(${JSON.stringify(JSON.stringify({
        reviewerId: input.reviewerId,
        decision: "approve",
        requestSha256: "0".repeat(64),
        diffSha256: createHash("sha256").update(input.diff).digest("hex"),
        validationSha256: canonicalValidationDigest(validationReport),
        decidedAt: "2026-01-01T00:00:02.000Z",
        reason: "did not read request",
      }))});
    `);

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/request receipt.*mismatch/i);
  });

  it("does not approve a valid decision prefix before reviewer output reaches EOF", async () => {
    const fixture = reviewerScript(`
      import { createHash } from "node:crypto";
      import { spawn } from "node:child_process";
      let body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      const decision = JSON.stringify({ reviewerId: request.reviewerId, decision: "approve", requestSha256: createHash("sha256").update(body).digest("hex"), diffSha256: request.diffSha256, validationSha256: request.validationSha256, decidedAt: new Date().toISOString(), reason: "incomplete output" });
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write('trailing output'), 250)"], {
        detached: true,
        stdio: ["ignore", "inherit", "ignore"]
      });
      descendant.unref();
      console.log(decision);
    `);

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
  });

  it("fails closed after bounded settlement when a detached descendant retains stdio", async () => {
    const fixture = reviewerScript(`
      import { createHash } from "node:crypto";
      import { spawn } from "node:child_process";
      let body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"]
      });
      descendant.unref();
      console.log(JSON.stringify({ reviewerId: request.reviewerId, decision: "approve", requestSha256: createHash("sha256").update(body).digest("hex"), diffSha256: request.diffSha256, validationSha256: request.validationSha256, decidedAt: new Date().toISOString(), reason: "reviewed" }));
    `);
    const startedAt = performance.now();

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toEqual(expect.objectContaining({ outcome: "failed" }));
    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("fails closed when the reviewer times out", async () => {
    const fixture = reviewerScript(`
      import { spawn } from "node:child_process";
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1_000)"], {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"]
      });
      descendant.unref();
      setInterval(() => {}, 1_000);
    `);
    const startedAt = performance.now();

    await expect(processReviewer(fixture, { timeoutMs: 20 }).review(
      input,
      AbortSignal.timeout(5_000),
    )).rejects.toEqual(expect.objectContaining({ outcome: "timed_out" }));
    expect(performance.now() - startedAt).toBeLessThan(750);
  });

  it("fails closed on malformed reviewer output", async () => {
    const fixture = reviewerScript('process.stdin.resume(); process.stdin.on("end", () => console.log("not json"));');

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/invalid|protocol|json/i);
  });

  it("fails closed when reviewer output exceeds its byte bound", async () => {
    const fixture = reviewerScript('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("x".repeat(1_024)));');

    await expect(processReviewer(fixture, { maxOutputBytes: 128 }).review(
      input,
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/output.*limit|truncat/i);
  });

  it("requires exactly one reviewer decision", async () => {
    const fixture = reviewerScript(`
      import { createHash } from "node:crypto";
      let body = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      const decision = JSON.stringify({ reviewerId: request.reviewerId, decision: "deny", requestSha256: createHash("sha256").update(body).digest("hex"), diffSha256: request.diffSha256, validationSha256: request.validationSha256, decidedAt: new Date().toISOString(), reason: "denied" });
      console.log(decision);
      console.log(decision);
    `);

    await expect(processReviewer(fixture).review(input, AbortSignal.timeout(5_000)))
      .rejects.toThrow(/exactly one|single.*decision|protocol/i);
  });

  it("rejects matching worker and reviewer identities before spawning", async () => {
    const fixture = reviewerScript('process.stdout.write("should not run\\n");');

    await expect(processReviewer(fixture).review(
      { ...input, reviewerId: input.workerId },
      AbortSignal.timeout(5_000),
    )).rejects.toThrow(/identity|differ|same/i);
  });
});
