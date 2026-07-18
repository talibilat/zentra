import { createHash } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";

import type { MilestoneBudget } from "../contracts/milestone.js";
import type { ModelCapability } from "../policy/model-sheet.js";
import type { WorkerAdapter, WorkerResult } from "../workers/worker-adapter.js";
import type { WorkspaceLease } from "../workspaces/worktree-manager.js";
import { OpenCodeWorkerEventAdapter } from "../agents/opencode-worker-event-adapter.js";

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
    readonly modelToolNetwork: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
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
  readonly expectedExecutableSha256?: string;
  readonly home?: string;
}

export interface OpenCodeWriterReport {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly executable: string;
  readonly modelId: string;
  readonly requestedModelSha256: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly packetSha256: string;
  readonly networkBoundary: {
    readonly modelTools: "denied";
    readonly harnessProviderTransport: "user_os_network_authority";
  };
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
    if (
      request.expectedExecutableSha256 !== undefined &&
      await sha256File(executable) !== request.expectedExecutableSha256
    ) {
      throw new Error("OpenCode writer executable changed after capability probe");
    }
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
        ...(request.home === undefined ? {} : { HOME: canonicalDirectory(request.home) }),
        OPENCODE_CONFIG_CONTENT: writerConfiguration(request.model, request.packet.ownedPaths),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      },
    }, signal, "opencode_writer");
    new OpenCodeWorkerEventAdapter().assertNoDelegation(result.events);
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
    requestedModelSha256: sha256(request.model.model),
    argv: Object.freeze(redactedArgv(argv)),
    cwd,
    packetSha256: sha256(packet),
    networkBoundary: Object.freeze({
      modelTools: request.packet.securityBoundary.modelToolNetwork,
      harnessProviderTransport: request.packet.securityBoundary.harnessProviderTransport,
    }),
    stdoutSha256: sha256(result.rawStdout),
    stderrSha256: sha256(result.stderr),
    stdout: result.rawStdout,
    stderr: result.stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function redactedArgv(argv: readonly string[]): readonly string[] {
  const retained = [...argv.slice(0, -1), "<writer-task-packet>"];
  const modelIndex = retained.indexOf("--model");
  if (modelIndex !== -1 && retained[modelIndex + 1] !== undefined) {
    retained[modelIndex + 1] = "<approved-model>";
  }
  return retained;
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

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
