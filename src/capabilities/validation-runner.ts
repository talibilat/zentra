import { createHash } from "node:crypto";
import { ProcessSupervisor } from "../workers/process-supervisor.js";
import type { ProjectConfig } from "../projects/project-config.js";

const DEFAULT_TIMEOUT_MS = 120_000;

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
}

export interface ValidationRunnerOptions {
  readonly timeoutMs?: number;
}

export class ValidationRunner {
  private readonly timeoutMs: number;

  constructor(
    private readonly supervisor: ProcessSupervisor,
    options: ValidationRunnerOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(
    project: ProjectConfig,
    name: "focused" | "full",
    cwd: string,
    signal: AbortSignal
  ): Promise<ValidationReport> {
    const configuredCommand = project.validations[name];
    const command: readonly [string, ...string[]] = [
      configuredCommand[0],
      ...configuredCommand.slice(1),
    ];
    const startedAt = new Date().toISOString();

    const result = await this.supervisor.execute(
      {
        taskId: "validation",
        executable: command[0],
        args: command.slice(1),
        cwd,
        timeoutMs: this.timeoutMs,
      },
      signal
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

    return {
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
    };
  }
}
