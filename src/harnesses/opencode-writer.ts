import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import type { MilestoneBudget } from "../contracts/milestone.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";

export interface WriterTaskPacket {
  readonly brief: string;
  readonly ownedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly budget: MilestoneBudget;
  readonly securityBoundary: {
    readonly repositoryWrites: "assigned_worktree_only";
    readonly validationAuthority: "zentra_named_validations_only";
    readonly integrationAuthority: "none";
    readonly shellAuthority: "none";
    readonly network: "denied";
    readonly parentSecretInheritance: "denied";
  };
}

export interface OpenCodeWriterRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly model: ModelCapability;
  readonly workspace: WorkspaceLease;
  readonly packet: WriterTaskPacket;
  readonly timeoutMs: number;
}

export interface OpenCodeWriterReport {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly executable: string;
  readonly modelId: string;
  readonly model: string;
  readonly provider: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly packetSha256: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export class OpenCodeWriter {
  constructor(private readonly supervisor: WorkerAdapter) {}

  async execute(request: OpenCodeWriterRequest, signal: AbortSignal): Promise<OpenCodeWriterReport> {
    const startedAt = new Date().toISOString();
    const executable = canonicalExecutable(request.executable);
    const cwd = canonicalDirectory(request.workspace.path);
    if (cwd !== request.workspace.path) throw new Error("OpenCode writer workspace must be canonical");
    const packet = JSON.stringify(request.packet);
    const argv = [
      "--pure",
      "run",
      "--format",
      "json",
      "--model",
      request.model.model,
      "--agent",
      "zentra-writer",
      "--dir",
      cwd,
      packet,
    ] as const;
    const result = await this.supervisor.execute({
      taskId: request.taskId,
      executable,
      args: argv,
      cwd,
      timeoutMs: request.timeoutMs,
      environment: {
        OPENCODE_CONFIG_CONTENT: writerConfiguration(request.model, request.packet.ownedPaths),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      },
    }, signal, "opencode_writer");
    return report(request, executable, cwd, argv, packet, result, startedAt);
  }
}

function report(
  request: OpenCodeWriterRequest,
  executable: string,
  cwd: string,
  argv: readonly string[],
  packet: string,
  result: WorkerResult,
  startedAt: string,
): OpenCodeWriterReport {
  return Object.freeze({
    outcome: result.outcome,
    exitCode: result.exitCode,
    executable,
    modelId: request.model.id,
    model: request.model.model,
    provider: request.model.model.replace(/\/.*/, ""),
    argv: Object.freeze([...argv.slice(0, -1), "<writer-task-packet>"]),
    cwd,
    packetSha256: sha256(packet),
    stdoutSha256: sha256(result.rawStdout),
    stderrSha256: sha256(result.stderr),
    stdout: result.rawStdout,
    stderr: result.stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function writerConfiguration(model: ModelCapability, ownedPaths: readonly string[]): string {
  const edit = Object.fromEntries([
    ["*", "deny"],
    ...ownedPaths.map((scope) => [scope, "allow"] as const),
  ]);
  return JSON.stringify({
    share: "disabled",
    autoupdate: false,
    formatter: false,
    lsp: false,
    mcp: {},
    plugin: [],
    instructions: [],
    model: model.model,
    default_agent: "zentra-writer",
    agent: {
      "zentra-writer": {
        mode: "primary",
        model: model.model,
        permission: {
          "*": "deny",
          read: "allow",
          glob: "allow",
          grep: "allow",
          edit,
          bash: "deny",
          task: "deny",
          webfetch: "deny",
          external_directory: "deny",
        },
      },
    },
  });
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error("OpenCode writer cwd must be a directory");
  return canonical;
}

function canonicalExecutable(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  if (candidate !== canonical || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error("OpenCode writer executable must be a canonical executable file");
  }
  return canonical;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
