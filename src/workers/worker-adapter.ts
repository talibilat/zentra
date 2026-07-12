export interface WorkerRequest {
  readonly taskId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface WorkerResult {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly exitCode: number | null;
  readonly events: readonly unknown[];
  readonly stdout: string;
  readonly rawStdout: string;
  readonly stderr: string;
}

export interface WorkerAdapter {
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult>;
}
