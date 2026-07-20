export interface WorkerRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly input?: string;
}

export interface WorkerResult {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly events: readonly unknown[];
  readonly stdout: string;
  readonly rawStdout: string;
  readonly stderr: string;
}

export type InvocationKind = "worker" | "validation" | "reviewer" | "opencode_writer";

export interface WorkerAdapter {
  execute(
    request: WorkerRequest,
    signal: AbortSignal,
    kind: InvocationKind,
  ): Promise<WorkerResult>;
}
