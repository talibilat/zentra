import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { ProcessSupervisor } from "../workers/process-supervisor.js";
import {
  assertApprovedValidationExecutable,
  assertApprovedValidationExecutableIdentity,
  MAX_VALIDATION_TIMEOUT_MS,
  MIN_VALIDATION_TIMEOUT_MS,
  ValidationTimeoutSchema,
  type ProjectConfig,
} from "../projects/project-config.js";
import { z } from "zod";

export interface ValidationReport {
  readonly name: string;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly command: readonly string[];
  readonly argvSha256: string;
  readonly outputSha256: string;
  readonly timeoutMs?: number;
  readonly provenance: DurableValidationProvenance;
}

export interface DurableValidationProvenance {
  readonly invocationId: string;
  readonly canonicalCwd: string;
  readonly subjectSha256: string | null;
  readonly timeoutMs?: number;
}

export interface ValidationRunContext {
  readonly invocationId: string;
  readonly subjectSha256: string;
}

export interface ExpectedValidationProvenance extends ValidationRunContext {
  readonly canonicalCwd: string;
}

const ValidationProvenanceSchema = z.strictObject({
  invocationId: z.string().min(1),
  canonicalCwd: z.string().min(1),
  subjectSha256: z.string().min(1).nullable(),
  timeoutMs: ValidationTimeoutSchema,
});

export const ValidationReportSchema = z.strictObject({
  name: z.string().min(1),
  outcome: z.enum(["completed", "cancelled", "timed_out", "failed"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  command: z.array(z.string()).min(1),
  argvSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  timeoutMs: ValidationTimeoutSchema,
  provenance: ValidationProvenanceSchema,
}).superRefine((report, context) => {
  if (report.timeoutMs !== report.provenance.timeoutMs) {
    context.addIssue({
      code: "custom",
      message: "validation timeout must match provenance",
    });
  }
  if (report.outcome === "completed" && report.exitCode !== 0) {
    context.addIssue({ code: "custom", message: "completed validation requires exitCode 0" });
  }
  if (report.outcome === "failed" && report.exitCode === 0) {
    context.addIssue({ code: "custom", message: "failed validation cannot have exitCode 0" });
  }
  if (
    (report.outcome === "cancelled" || report.outcome === "timed_out") &&
    report.exitCode !== null
  ) {
    context.addIssue({ code: "custom", message: `${report.outcome} validation requires null exitCode` });
  }
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) {
    context.addIssue({ code: "custom", message: "validation finishedAt precedes startedAt" });
  }
});

const verifiedValidationReports = new WeakMap<ValidationReport, DurableValidationProvenance>();
const usedInvocationIds = new Set<string>();

export function isVerifiedValidationReport(
  report: ValidationReport,
  expected?: ExpectedValidationProvenance,
): boolean {
  const provenance = verifiedValidationReports.get(report);
  if (provenance === undefined) return false;
  if (expected === undefined) return true;
  return (
    provenance.invocationId === expected.invocationId &&
    provenance.canonicalCwd === expected.canonicalCwd &&
    provenance.subjectSha256 === expected.subjectSha256
  );
}

export function isVerifiedValidationSubject(
  report: ValidationReport,
  subjectSha256: string,
): boolean {
  return verifiedValidationReports.get(report)?.subjectSha256 === subjectSha256;
}

export class ValidationRunner {
  constructor(private readonly supervisor: ProcessSupervisor) {}

  async run(
    project: ProjectConfig,
    name: "focused" | "full",
    cwd: string,
    signal: AbortSignal,
    context?: ValidationRunContext,
  ): Promise<ValidationReport> {
    const timeout = ValidationTimeoutSchema.safeParse(
      name === "focused"
        ? project.validations.focusedTimeoutMs
        : project.validations.fullTimeoutMs,
    );
    if (!timeout.success) {
      throw new Error(
        `${name} validation timeout must be an integer from ${MIN_VALIDATION_TIMEOUT_MS}ms through ${MAX_VALIDATION_TIMEOUT_MS}ms`,
      );
    }
    const timeoutMs = timeout.data;
    const configuredCommand = project.validations[name];
    const command: readonly [string, ...string[]] = [
      configuredCommand[0],
      ...configuredCommand.slice(1),
    ];
    assertApprovedValidationExecutable(command[0]);
    const invocationId = context?.invocationId ?? randomUUID();
    if (invocationId === "" || usedInvocationIds.has(invocationId)) {
      throw new Error("validation invocationId must be nonempty and single-use");
    }
    if (context !== undefined && context.subjectSha256 === "") {
      throw new Error("validation subjectSha256 must be nonempty");
    }
    usedInvocationIds.add(invocationId);
    const canonicalCwd = await realpath(cwd);
    const startedAt = new Date().toISOString();
    await assertApprovedValidationExecutableIdentity(command[0]);

    const result = await this.supervisor.execute(
      {
        taskId: "validation",
        executable: command[0],
        args: command.slice(1),
        cwd: canonicalCwd,
        timeoutMs,
      },
      signal,
      "validation",
    );

    const finishedAt = new Date().toISOString();

    const argvSha256 = createHash("sha256")
      .update(JSON.stringify(command), "utf8")
      .digest("hex");

    const stdout = result.rawStdout;
    const outputContent = JSON.stringify({ stdout, stderr: result.stderr });
    const outputSha256 = createHash("sha256")
      .update(outputContent, "utf8")
      .digest("hex");
    const provenance: DurableValidationProvenance = Object.freeze({
      invocationId,
      canonicalCwd,
      subjectSha256: context?.subjectSha256 ?? null,
      timeoutMs,
    });

    const parsed = ValidationReportSchema.parse({
      name,
      outcome: result.outcome,
      exitCode: result.exitCode,
      stdout,
      stderr: result.stderr,
      startedAt,
      finishedAt,
      command,
      argvSha256,
      outputSha256,
      timeoutMs,
      provenance,
    });
    const frozen: ValidationReport = Object.freeze({
      ...parsed,
      command: Object.freeze([...parsed.command]),
      provenance: Object.freeze({ ...parsed.provenance }),
    });
    verifiedValidationReports.set(frozen, frozen.provenance);
    return frozen;
  }
}
