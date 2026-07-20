import { constants, existsSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import { digestCanonical } from "../contracts/authority-attention.js";
import { RuntimeStateManager, discoverProject, initializeProjectRuntime } from "../runtime/repository-runtime.js";
import {
  WorkflowSurfaceError,
  type RunSubmission,
  type WorkflowCallerContext,
  type WorkflowCommand,
  type WorkflowDecisionCommand,
  type WorkflowSurface,
  type WorkflowSurfaceErrorCode,
} from "./workflow-surface.js";

export const CLI_CONTROL_TOKEN_FILENAME = "cli-control.token";
export const CLI_CONTROL_AUTHORIZATION_SCHEME = "ZentraCLI";
export const CLI_PENDING_SUBMISSION_PREFIX = "pending-submission-v1-";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HttpWorkflowClient {
  private constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly submissions: CliSubmissionCommandStore,
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  static async connect(cwd: string): Promise<HttpWorkflowClient> {
    try {
      const discovery = await discoverProject(cwd);
      const runtimeDirectory = path.join(discovery.root, ".zentra", "runtime");
      if (!existsSync(path.join(runtimeDirectory, "state.json")) ||
        !existsSync(path.join(runtimeDirectory, CLI_CONTROL_TOKEN_FILENAME))) {
        throw new Error("service runtime is missing");
      }
      const layout = await initializeProjectRuntime(discovery);
      const state = await new RuntimeStateManager(layout).read();
      if (state === null || state.startupStatus !== "ready" || state.address.host !== "127.0.0.1") {
        throw new Error("service is not ready");
      }
      const token = await readPrivateToken(path.join(layout.runtimeDirectory, CLI_CONTROL_TOKEN_FILENAME));
      return new HttpWorkflowClient(
        state.address.port,
        token,
        new CliSubmissionCommandStore(layout.runtimeDirectory),
      );
    } catch (error) {
      throw new WorkflowSurfaceError("unavailable", "workflow service is unavailable", { cause: error });
    }
  }

  async submitRun(input: RunSubmission, caller: WorkflowCallerContext): Promise<unknown> {
    if (caller.channel !== "cli") throw new WorkflowSurfaceError("invalid_transition", "HTTP workflow client is CLI-only");
    const pending = await this.submissions.reserve(input, caller);
    try {
      const result = await this.mutate("/runs", { ...input, commandId: pending.commandId }, caller, 201);
      await this.submissions.acknowledge(pending);
      return result;
    } catch (error) {
      if (error instanceof WorkflowSurfaceError && isProvenPreEffectSubmissionErrorCode(error.code)) {
        await this.submissions.acknowledge(pending);
      }
      throw error;
    }
  }

  listRuns(): Promise<unknown> { return this.request("GET", "/runs"); }
  getRun(runId: string): Promise<unknown> { return this.request("GET", `/runs/${segment(runId)}`); }
  getSourceText(runId: string, sourceId: string): Promise<unknown> {
    return this.request("GET", `/runs/${segment(runId)}/sources/${segment(sourceId)}/text`);
  }
  getDecision(decisionId: string): Promise<unknown> { return this.request("GET", `/decisions/${segment(decisionId)}`); }
  listAttention(runId: string): Promise<unknown> { return this.request("GET", `/runs/${segment(runId)}/attention`); }

  cancelRun(input: WorkflowCommand & { readonly cancellationId: string; readonly reasonCode?: string }, caller: WorkflowCallerContext): Promise<unknown> {
    const { runId, ...body } = input;
    return this.mutate(`/runs/${segment(runId)}/cancel`, body, caller);
  }

  answerQuestion(input: WorkflowDecisionCommand & { readonly optionId: string }, caller: WorkflowCallerContext): Promise<unknown> {
    return this.decisionMutation("answer", input, caller);
  }

  rejectQuestion(input: WorkflowDecisionCommand & { readonly reason: string }, caller: WorkflowCallerContext): Promise<unknown> {
    return this.decisionMutation("reject-question", input, caller);
  }

  approvePlan(input: WorkflowDecisionCommand & { readonly planDigest: string; readonly envelopeDigest: string }, caller: WorkflowCallerContext): Promise<unknown> {
    return this.decisionMutation("approve-plan", input, caller);
  }

  rejectPlan(input: WorkflowDecisionCommand & { readonly reason: string }, caller: WorkflowCallerContext): Promise<unknown> {
    return this.decisionMutation("reject-plan", input, caller);
  }

  private decisionMutation(action: string, input: WorkflowDecisionCommand & object, caller: WorkflowCallerContext): Promise<unknown> {
    const { decisionId, ...body } = input as WorkflowDecisionCommand & Record<string, unknown>;
    return this.mutate(`/decisions/${segment(decisionId)}/${action}`, body, caller);
  }

  private mutate(pathname: string, body: object, caller: WorkflowCallerContext, expectedStatus = 200): Promise<unknown> {
    if (caller.channel !== "cli") throw new WorkflowSurfaceError("invalid_transition", "HTTP workflow client is CLI-only");
    return this.request("POST", pathname, { ...body, actorId: caller.actorId }, expectedStatus);
  }

  private request(method: "GET" | "POST", pathname: string, body?: object, expectedStatus = 200): Promise<unknown> {
    let encoded: Buffer | undefined;
    if (body !== undefined) {
      encoded = Buffer.from(JSON.stringify(body), "utf8");
      if (encoded.length > MAX_REQUEST_BYTES) {
        return Promise.reject(new WorkflowSurfaceError("invalid_transition", "workflow request is too large"));
      }
    }
    return new Promise((resolve, reject) => {
      let dispatched = false;
      const mutation = method === "POST";
      const request = httpRequest({
        host: "127.0.0.1",
        port: this.port,
        method,
        path: `/api/v1/zentra${pathname}`,
        agent: false,
        headers: {
          accept: "application/json",
          authorization: `${CLI_CONTROL_AUTHORIZATION_SCHEME} ${this.token}`,
          connection: "close",
          ...(encoded === undefined ? {} : {
            "content-type": "application/json",
            "content-length": String(encoded.length),
          }),
        },
      }, (response) => {
        const status = response.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new WorkflowSurfaceError("unavailable", "workflow redirect was rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) response.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        response.once("error", (error) => reject(new WorkflowSurfaceError(
          mutation ? "uncertain" : "internal",
          mutation ? "workflow mutation response was lost after dispatch" : "workflow response failed",
          { cause: error },
        )));
        response.once("end", () => {
          let value: unknown;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch (error) { reject(new WorkflowSurfaceError(mutation ? "uncertain" : "internal",
            mutation ? "workflow mutation response was malformed after dispatch" : "workflow response was malformed", { cause: error })); return; }
          if (status !== expectedStatus) { reject(httpFailure(status, value)); return; }
          resolve(value);
        });
      });
      request.once("finish", () => { dispatched = true; });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new Error("request timed out")));
      request.once("error", (error) => reject(new WorkflowSurfaceError(
        mutation && dispatched ? "uncertain" : "unavailable",
        mutation && dispatched ? "workflow mutation outcome is uncertain after dispatch" : "workflow service is unavailable",
        { cause: error },
      )));
      request.end(encoded);
    });
  }
}

export function isProvenPreEffectSubmissionErrorCode(code: WorkflowSurfaceErrorCode): boolean {
  return code === "invalid_transition" || code === "digest_mismatch";
}

export interface PendingSubmissionCommand {
  readonly keySha256: string;
  readonly commandId: string;
  readonly filePath: string;
}

export class CliSubmissionCommandStore {
  constructor(private readonly runtimeDirectory: string) {}

  async reserve(input: RunSubmission, caller: WorkflowCallerContext): Promise<PendingSubmissionCommand> {
    const { commandId, ...source } = input;
    const keySha256 = digestCanonical({ schemaVersion: 1, source, actor: caller });
    const filePath = path.join(this.runtimeDirectory, `${CLI_PENDING_SUBMISSION_PREFIX}${keySha256}.json`);
    const existing = await readPendingIfPresent(filePath);
    if (existing !== null) return { ...existing, filePath };
    const value = { schemaVersion: 1 as const, keySha256, commandId };
    const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (encoded.length > 1_024) throw new Error("pending submission command is too large");
    let descriptor;
    try {
      descriptor = await open(filePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600);
      await descriptor.writeFile(encoded);
      await descriptor.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await readPendingIfPresent(filePath);
      if (raced === null) throw new Error("pending submission command disappeared during reservation");
      return { ...raced, filePath };
    } finally {
      await descriptor?.close();
    }
    await syncDirectory(this.runtimeDirectory);
    return { keySha256, commandId, filePath };
  }

  async acknowledge(pending: PendingSubmissionCommand): Promise<void> {
    const current = await readPendingIfPresent(pending.filePath);
    if (current === null) return;
    if (current.keySha256 !== pending.keySha256 || current.commandId !== pending.commandId) {
      throw new Error("pending submission command changed before acknowledgement");
    }
    await unlink(pending.filePath);
    await syncDirectory(this.runtimeDirectory);
  }
}

export async function createHttpWorkflowClient(cwd: string): Promise<WorkflowSurface> {
  return await HttpWorkflowClient.connect(cwd) as unknown as WorkflowSurface;
}

async function readPrivateToken(tokenPath: string): Promise<string> {
  const before = await lstat(tokenPath);
  assertPrivateToken(before);
  const descriptor = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    assertPrivateToken(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("control token changed during inspection");
    const token = await descriptor.readFile("utf8");
    if (!TOKEN_PATTERN.test(token)) throw new Error("control token is malformed");
    return token;
  } finally {
    await descriptor.close();
  }
}

function assertPrivateToken(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (Number(metadata.mode) & 0o777) !== 0o600 || metadata.size !== 43) {
    throw new Error("control token file is not private");
  }
}

function segment(value: string): string { return encodeURIComponent(value); }

function httpFailure(status: number, value: unknown): WorkflowSurfaceError {
  const code = typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["error"] === "string"
    ? (value as Record<string, unknown>)["error"] as string
    : "";
  const allowed: readonly WorkflowSurfaceErrorCode[] = [
    "not_found", "stale", "consumed", "expired", "digest_mismatch", "invalid_transition", "uncertain", "unavailable", "internal",
  ];
  if (allowed.includes(code as WorkflowSurfaceErrorCode)) {
    return new WorkflowSurfaceError(code as WorkflowSurfaceErrorCode, "workflow request failed");
  }
  return new WorkflowSurfaceError(status === 401 || status === 503 ? "unavailable" : "internal", "workflow request failed");
}

async function readPendingIfPresent(filePath: string): Promise<{ readonly keySha256: string; readonly commandId: string } | null> {
  let before;
  try { before = await lstat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > 1_024) {
    throw new Error("pending submission command file is not private");
  }
  const descriptor = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600 ||
      opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1_024) {
      throw new Error("pending submission command changed during inspection");
    }
    const parsed = JSON.parse(await descriptor.readFile("utf8")) as Record<string, unknown>;
    if (parsed["schemaVersion"] !== 1 || typeof parsed["keySha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed["keySha256"]) || typeof parsed["commandId"] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(parsed["commandId"])) {
      throw new Error("pending submission command file is malformed");
    }
    return { keySha256: parsed["keySha256"], commandId: parsed["commandId"] };
  } finally {
    await descriptor.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}
