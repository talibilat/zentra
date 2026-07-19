import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_RETAINED_ARTIFACT_BYTES } from "../contracts/artifact.js";
import { digestCanonical } from "../contracts/authority-attention.js";
import type { StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type EventJournal } from "../journal/journal.js";
import { assertApprovedValidationExecutableIdentity, type ProjectConfig } from "../projects/project-config.js";
import { assertNoGitObjectSubstitution, GitClient, type CommandResult } from "../workspaces/git-client.js";
import { ProcessSupervisor } from "../workers/process-supervisor.js";
import {
  parseReleaseEventPayload,
  RELEASE_BLOCKED_OPERATIONS,
  RELEASE_PREPARED_MESSAGE,
  RELEASE_TRUSTED_PROJECT_NOTICE,
  ReleaseArtifactPayloadSchema,
  ReleaseCreatedPayloadSchema,
  ReleasePacketSchema,
  ReleaseStepObservedPayloadSchema,
  type ReleasePacket,
} from "./release-events.js";

const GIT_TIMEOUT_MS = 30_000;
const EXTERNAL_PROGRAM_CONFIG =
  "^(merge\\..*\\.driver|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process))$";
const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
export const MAX_RELEASE_ARTIFACT_BYTES = 64 * MAX_RETAINED_ARTIFACT_BYTES;
export const MAX_RELEASE_ARTIFACT_TOTAL_BYTES = 256 * MAX_RETAINED_ARTIFACT_BYTES;
const READ_BUFFER_BYTES = 64 * 1024;

type StepName = "build" | "package" | "verify";
type ArtifactEvidence = { readonly path: string; readonly size: number; readonly sha256: string };
type StepReport = { readonly name: StepName; readonly outcome: "completed" | "cancelled" | "timed_out" | "failed"; readonly exitCode: number | null; readonly argvSha256: string; readonly outputSha256: string };
interface RepositorySnapshot { readonly sha256: string; readonly refsSha256: string }

export interface LocalReleaseResult {
  readonly releaseId: string;
  readonly status: "prepared_local_only" | "cancelled" | "timed_out" | "failed" | "uncertain";
  readonly worktreePath: string;
  readonly steps: readonly StepReport[];
  readonly artifacts: readonly ArtifactEvidence[];
  readonly blockedOperations: typeof RELEASE_BLOCKED_OPERATIONS;
  readonly message: string;
  readonly authorityModel: "trusted_project_config";
  readonly trustedProjectCodeNotice: string;
}

export function inspectLocalReleaseResult(journal: EventJournal, packet: ReleasePacket): LocalReleaseResult | null {
  const events = readStreamEvents(journal, `release:${packet.releaseId}`);
  if (events.length === 0) return null;
  assertReleaseHistory(events, digestCanonical(packet));
  if (hasUnobservedStep(events)) return releaseResult("uncertain", packet.worktreePath, events);
  const failed = events.findLast((event) => event.type === "release.failed");
  if (failed !== undefined) {
    return releaseResult((failed.payload as Readonly<Record<string, unknown>>)["reason"] === "uncertain_worktree" ? "uncertain" : "failed", packet.worktreePath, events);
  }
  if (events.some((event) => event.type === "release.prepared_local_only")) {
    return releaseResult("prepared_local_only", packet.worktreePath, events);
  }
  const observed = events.filter((event) => event.type === "release.step_observed").at(-1);
  if (observed !== undefined) {
    const outcome = ReleaseStepObservedPayloadSchema.parse(observed.payload).outcome;
    if (outcome !== "completed") return releaseResult(outcome, packet.worktreePath, events);
  }
  return null;
}

export async function createLocalReleasePacket(input: {
  readonly releaseId: string; readonly milestoneId: string; readonly taskId: string;
  readonly project: ProjectConfig; readonly resultCommit: string;
  readonly securityDigest: string; readonly authorityDigest: string;
  readonly verifierAdmissionDigest: string;
}): Promise<ReleasePacket> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.releaseId) || input.releaseId.includes("..")) {
    throw new Error("releaseId must be a contained worktree identity");
  }
  const config = input.project.releasePreparation;
  if (config === undefined) throw new Error("project has no releasePreparation configuration");
  const repositoryPath = await canonicalDirectory(input.project.repositoryPath, "release repository");
  const worktreeRoot = await canonicalDirectory(input.project.worktreeRoot, "release worktree root");
  return ReleasePacketSchema.parse({
    schemaVersion: 1,
    releaseId: input.releaseId,
    milestoneId: input.milestoneId,
    taskId: input.taskId,
    projectId: input.project.projectId,
    repositoryPath,
    worktreeRoot,
    worktreePath: path.join(worktreeRoot, `release-${input.releaseId}`),
    resultCommit: input.resultCommit,
    integrationRef: `refs/heads/${input.project.integrationBranch}`,
    securityDigest: input.securityDigest,
    authorityDigest: input.authorityDigest,
    verifierAdmissionDigest: input.verifierAdmissionDigest,
    commands: {
      build: { argv: config.build, timeoutMs: config.buildTimeoutMs },
      package: { argv: config.package, timeoutMs: config.packageTimeoutMs },
      verify: { argv: config.verify, timeoutMs: config.verifyTimeoutMs },
    },
    artifacts: config.artifacts,
  });
}

export class LocalReleaseRunner {
  constructor(
    private readonly journal: EventJournal,
    private readonly git = new GitClient(),
    private readonly supervisor = new ProcessSupervisor(),
  ) {}

  async run(input: {
    readonly packet: ReleasePacket; readonly project: ProjectConfig; readonly signal: AbortSignal;
  }): Promise<LocalReleaseResult> {
    const packet = ReleasePacketSchema.parse(input.packet);
    const packetDigest = digestCanonical(packet);
    const expected = await createLocalReleasePacket({
      releaseId: packet.releaseId, milestoneId: packet.milestoneId, taskId: packet.taskId,
      project: input.project, resultCommit: packet.resultCommit, securityDigest: packet.securityDigest,
      authorityDigest: packet.authorityDigest, verifierAdmissionDigest: packet.verifierAdmissionDigest,
    });
    if (digestCanonical(expected) !== packetDigest) throw new Error("release configuration does not match the immutable packet");
    const streamId = `release:${packet.releaseId}`;
    let events = readStreamEvents(this.journal, streamId);
    if (events.length > 0) {
      assertReleaseHistory(events, packetDigest);
      if (hasUnobservedStep(events)) return releaseResult("uncertain", packet.worktreePath, events);
      const failed = events.findLast((event) => event.type === "release.failed");
      if (failed !== undefined) {
        return releaseResult((failed.payload as Record<string, unknown>)["reason"] === "uncertain_worktree" ? "uncertain" : "failed", packet.worktreePath, events);
      }
      if (events.some((event) => event.type === "release.prepared_local_only")) {
        return releaseResult("prepared_local_only", packet.worktreePath, events);
      }
    } else {
      events = this.append(streamId, packet.milestoneId, "release.created", {
        schemaVersion: 1, packet, packetDigest,
      });
    }
    for (const command of Object.values(packet.commands)) {
      await assertApprovedValidationExecutableIdentity(command.argv[0]);
    }

    const baseline = await this.snapshotRepository(packet, true);
    const retainedSnapshot = repositorySnapshot(events);
    if (retainedSnapshot !== null && retainedSnapshot.sha256 !== baseline.sha256) {
      throw new Error("release repository state changed after packet binding");
    }
    if (retainedSnapshot === null) {
      events = this.append(streamId, packet.milestoneId, "release.refs_snapshot", { schemaVersion: 1, ...baseline });
    }

    if (!events.some((event) => event.type === "release.worktree_intent")) {
      events = this.append(streamId, packet.milestoneId, "release.worktree_intent", {
        schemaVersion: 1, path: packet.worktreePath, resultCommit: packet.resultCommit,
      });
      const add = await this.runGit(packet.repositoryPath, ["worktree", "add", "--detach", packet.worktreePath, packet.resultCommit], input.signal);
      if (!complete(add) || !(await this.workspaceIsExact(packet, baseline))) {
        events = this.append(streamId, packet.milestoneId, "release.failed", { schemaVersion: 1, stage: "worktree", reason: "uncertain_worktree" });
        return releaseResult("uncertain", packet.worktreePath, events);
      }
    } else if (!(await this.workspaceIsExact(packet, baseline))) {
      return releaseResult("uncertain", packet.worktreePath, events);
    }

    const environmentRoot = path.join(packet.worktreeRoot, `.release-${packet.releaseId}-environment`);
    const home = path.join(environmentRoot, "home");
    const temporary = path.join(environmentRoot, "tmp");
    if (!events.some((event) => event.type === "release.environment_intent")) {
      events = this.append(streamId, packet.milestoneId, "release.environment_intent", { schemaVersion: 1, home, temporary });
    }
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: true, mode: 0o700 });

    for (const name of ["build", "package", "verify"] as const) {
      const command = packet.commands[name];
      const argvSha256 = digestCanonical(command.argv);
      const observed = observedStep(events, name);
      if (observed !== null) {
        if (observed.argvSha256 !== argvSha256) throw new Error(`release ${name} command contradicts the immutable packet`);
        if (observed.outcome !== "completed") return releaseResult(observed.outcome, packet.worktreePath, events);
        await this.assertStageState(packet, baseline);
        continue;
      }
      events = this.append(streamId, packet.milestoneId, "release.step_started", { schemaVersion: 1, name, argvSha256 });
      const execution = await this.supervisor.execute({
        taskId: packet.taskId, executable: command.argv[0], args: command.argv.slice(1),
        cwd: packet.worktreePath, timeoutMs: command.timeoutMs,
        environment: { HOME: home, TMPDIR: temporary },
      }, input.signal, "validation");
      events = this.append(streamId, packet.milestoneId, "release.step_observed", {
        schemaVersion: 1, name, argvSha256, outcome: execution.outcome, exitCode: execution.exitCode,
        stdout: execution.stdout, stderr: execution.stderr,
        outputSha256: sha256(`${execution.rawStdout}\0${execution.stderr}`),
      });
      if (execution.outcome !== "completed") return releaseResult(execution.outcome, packet.worktreePath, events);
      try {
        await this.assertStageState(packet, baseline);
      } catch {
        events = this.append(streamId, packet.milestoneId, "release.failed", { schemaVersion: 1, stage: "refs", reason: "ref_mutation" });
        return releaseResult("failed", packet.worktreePath, events);
      }
    }

    let totalBytes = 0;
    for (const relativePath of packet.artifacts) {
      const retained = events.find((event) => event.type === "release.artifact_hashed" && payloadPath(event.payload) === relativePath);
      if (retained !== undefined) {
        totalBytes += ReleaseArtifactPayloadSchema.parse(retained.payload).size;
        if (totalBytes > MAX_RELEASE_ARTIFACT_TOTAL_BYTES) throw new Error("retained release artifacts exceed the total byte budget");
        continue;
      }
      try {
        const artifact = await hashArtifact(packet.worktreePath, relativePath, MAX_RELEASE_ARTIFACT_TOTAL_BYTES - totalBytes);
        totalBytes += artifact.size;
        events = this.append(streamId, packet.milestoneId, "release.artifact_hashed", { schemaVersion: 1, ...artifact });
      } catch {
        events = this.append(streamId, packet.milestoneId, "release.failed", { schemaVersion: 1, stage: "artifact", reason: "unsafe_artifact" });
        return releaseResult("failed", packet.worktreePath, events);
      }
    }
    for (const relativePath of packet.artifacts) {
      const retained = events.find((event) => event.type === "release.artifact_hashed" && payloadPath(event.payload) === relativePath);
      const expectedArtifact = retained === undefined ? null : ReleaseArtifactPayloadSchema.parse(retained.payload);
      try {
        const observed = await hashArtifact(packet.worktreePath, relativePath, MAX_RELEASE_ARTIFACT_TOTAL_BYTES);
        if (expectedArtifact === null || observed.size !== expectedArtifact.size || observed.sha256 !== expectedArtifact.sha256) {
          throw new Error("release artifact changed after evidence was retained");
        }
      } catch {
        events = this.append(streamId, packet.milestoneId, "release.failed", { schemaVersion: 1, stage: "artifact", reason: "unsafe_artifact" });
        return releaseResult("failed", packet.worktreePath, events);
      }
    }
    try {
      await this.assertStageState(packet, baseline);
    } catch {
      events = this.append(streamId, packet.milestoneId, "release.failed", { schemaVersion: 1, stage: "refs", reason: "ref_mutation" });
      return releaseResult("failed", packet.worktreePath, events);
    }
    events = this.append(streamId, packet.milestoneId, "release.refs_verified", { schemaVersion: 1, ...baseline });
    events = this.append(streamId, packet.milestoneId, "release.prepared_local_only", {
      schemaVersion: 1, status: "prepared_local_only", blockedOperations: RELEASE_BLOCKED_OPERATIONS,
      message: RELEASE_PREPARED_MESSAGE, authorityModel: "trusted_project_config",
      trustedProjectCodeNotice: RELEASE_TRUSTED_PROJECT_NOTICE,
    });
    return releaseResult("prepared_local_only", packet.worktreePath, events);
  }

  private append(streamId: string, correlationId: string, type: string, payload: unknown): readonly StoredEvent[] {
    parseReleaseEventPayload(type, payload);
    const current = readStreamEvents(this.journal, streamId);
    this.journal.append(streamId, current.length, [{ streamId, type, payload, causationId: current.at(-1)?.eventId ?? null, correlationId }]);
    return readStreamEvents(this.journal, streamId);
  }

  private async assertStageState(packet: ReleasePacket, baseline: RepositorySnapshot): Promise<void> {
    const current = await this.snapshotRepository(packet, false);
    if (current.sha256 !== baseline.sha256 || !(await this.workspaceIsExact(packet, baseline))) {
      throw new Error("release repository or worktree state changed");
    }
  }

  private async snapshotRepository(packet: ReleasePacket, requireIntegrationRef: boolean): Promise<RepositorySnapshot> {
    await this.assertSafeGitConfiguration(packet.repositoryPath);
    await assertNoGitObjectSubstitution(this.git, packet.repositoryPath, GIT_TIMEOUT_MS);
    const refs = await this.runGit(packet.repositoryPath, ["--no-optional-locks", "--no-replace-objects", "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "--", "refs/"]);
    if (!complete(refs)) throw new Error("release ref snapshot failed closed");
    if (requireIntegrationRef) assertExactRef(refs.stdout, packet.integrationRef, packet.resultCommit);
    const common = await this.runGit(packet.repositoryPath, ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!complete(common)) throw new Error("release Git common directory lookup failed closed");
    const lines = common.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) throw new Error("release Git common directory is malformed");
    const shallowSha256 = await optionalFileDigest(path.join(lines[0]!, "shallow"));
    const graftSha256 = await optionalFileDigest(path.join(lines[0]!, "info", "grafts"));
    if (graftSha256 !== null) throw new Error("nonempty Git graft evidence is not allowed");
    const refsSha256 = sha256(refs.stdout);
    return { refsSha256, sha256: digestCanonical({ refsSha256, shallowSha256, graftSha256 }) };
  }

  private async workspaceIsExact(packet: ReleasePacket, baseline: RepositorySnapshot): Promise<boolean> {
    try {
      const expected = path.join(await realpath(path.dirname(packet.worktreePath)), path.basename(packet.worktreePath));
      if ((await realpath(packet.worktreePath)) !== expected || !(await stat(packet.worktreePath)).isDirectory()) return false;
      const head = await this.runGit(packet.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const symbolic = await this.runGit(packet.worktreePath, ["symbolic-ref", "-q", "HEAD"]);
      const status = await this.runGit(packet.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      if (!complete(head) || head.stdout.trim() !== packet.resultCommit || symbolic.exitCode !== 1 || symbolic.stdout !== "" ||
        symbolic.termination !== null || symbolic.truncated || !complete(status)) return false;
      const allowed = new Set(packet.artifacts);
      for (const record of status.stdout.split("\0").filter(Boolean)) {
        if (!record.startsWith("?? ") || !allowed.has(record.slice(3))) return false;
      }
      const repository = await this.snapshotRepository(packet, false);
      return repository.sha256 === baseline.sha256;
    } catch { return false; }
  }

  private async assertSafeGitConfiguration(cwd: string): Promise<void> {
    const configured = await this.runGit(cwd, ["config", "--get-regexp", EXTERNAL_PROGRAM_CONFIG]);
    if (configured.termination !== null || configured.truncated || (configured.exitCode !== 0 && configured.exitCode !== 1) ||
      (configured.exitCode === 0 && configured.stdout.trim() !== "")) {
      throw new Error("configured external Git programs are not allowed for release checkout");
    }
  }

  private runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
    return this.git.run(cwd, [...SAFE_GIT_ARGS, ...args], { timeoutMs: GIT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) });
  }
}

function releaseResult(status: LocalReleaseResult["status"], worktreePath: string, events: readonly StoredEvent[]): LocalReleaseResult {
  const steps = events.filter((event) => event.type === "release.step_observed").map((event) => {
    const value = ReleaseStepObservedPayloadSchema.parse(event.payload);
    return { name: value.name, outcome: value.outcome, exitCode: value.exitCode, argvSha256: value.argvSha256, outputSha256: value.outputSha256 };
  });
  const artifacts = events.filter((event) => event.type === "release.artifact_hashed").map((event) => {
    const value = ReleaseArtifactPayloadSchema.parse(event.payload);
    return { path: value.path, size: value.size, sha256: value.sha256 };
  });
  return Object.freeze({
    status, worktreePath, steps: Object.freeze(steps), artifacts: Object.freeze(artifacts),
    releaseId: releaseIdFromEvents(events),
    blockedOperations: RELEASE_BLOCKED_OPERATIONS, message: RELEASE_PREPARED_MESSAGE,
    authorityModel: "trusted_project_config", trustedProjectCodeNotice: RELEASE_TRUSTED_PROJECT_NOTICE,
  });
}

function releaseIdFromEvents(events: readonly StoredEvent[]): string {
  const created = ReleaseCreatedPayloadSchema.parse(events[0]?.payload);
  return created.packet.releaseId;
}

function assertReleaseHistory(events: readonly StoredEvent[], packetDigest: string): void {
  const created = ReleaseCreatedPayloadSchema.parse(events[0]?.payload);
  if (events[0]?.type !== "release.created" || created.packetDigest !== packetDigest || digestCanonical(created.packet) !== packetDigest) {
    throw new Error("release replay packet does not match the durable binding");
  }
  const started = new Set<string>();
  const observed = new Set<string>();
  let terminal = false;
  for (const event of events) {
    if (terminal) throw new Error("release stream contains an event after its terminal result");
    parseReleaseEventPayload(event.type, event.payload);
    const name = payloadName(event.payload);
    if (event.type === "release.step_started") {
      if (started.has(name)) throw new Error(`release step ${name} started more than once`);
      started.add(name);
    }
    if (event.type === "release.step_observed") {
      if (!started.has(name) || observed.has(name)) throw new Error(`release step ${name} observation is not exact`);
      observed.add(name);
    }
    terminal = event.type === "release.prepared_local_only" || event.type === "release.failed";
  }
}

function hasUnobservedStep(events: readonly StoredEvent[]): boolean {
  return events.some((event) => event.type === "release.step_started" && !events.some((candidate) =>
    candidate.type === "release.step_observed" && payloadName(candidate.payload) === payloadName(event.payload)));
}

function observedStep(events: readonly StoredEvent[], name: StepName): ReturnType<typeof ReleaseStepObservedPayloadSchema.parse> | null {
  const event = events.find((candidate) => candidate.type === "release.step_observed" && payloadName(candidate.payload) === name);
  return event === undefined ? null : ReleaseStepObservedPayloadSchema.parse(event.payload);
}

function repositorySnapshot(events: readonly StoredEvent[]): RepositorySnapshot | null {
  const event = events.find((candidate) => candidate.type === "release.refs_snapshot");
  if (event === undefined) return null;
  const payload = event.payload as Readonly<Record<string, unknown>>;
  return { sha256: String(payload["sha256"]), refsSha256: String(payload["refsSha256"]) };
}

function payloadName(payload: unknown): string {
  return String(record(payload)["name"] ?? "");
}

function payloadPath(payload: unknown): string {
  return String(record(payload)["path"] ?? "");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function assertExactRef(output: string, expectedRef: string, expectedCommit: string): void {
  const matches = output.split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"))
    .filter((fields) => fields[0] === expectedRef);
  if (matches.length !== 1 || matches[0]!.length !== 3 || matches[0]![1] !== expectedCommit || matches[0]![2] !== "") {
    throw new Error("integration ref does not exactly equal the verified release commit");
  }
}

async function hashArtifact(root: string, relativePath: string, remainingTotal: number): Promise<ArtifactEvidence> {
  const canonicalRoot = await realpath(root);
  const absolute = path.join(canonicalRoot, relativePath);
  const parent = path.dirname(absolute);
  if ((await realpath(parent)) !== parent || !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("release artifact path escapes its worktree");
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_RELEASE_ARTIFACT_BYTES || before.size > remainingTotal) {
      throw new Error("release artifact exceeds its byte budget or is not regular");
    }
    const first = await digestHandle(handle, before.size);
    const second = await digestHandle(handle, before.size);
    const after = await handle.stat();
    const pathAfter = await stat(absolute);
    const linkAfter = await lstat(absolute);
    if (first !== second || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      linkAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size) {
      throw new Error("release artifact changed while hashing");
    }
    return { path: relativePath, size: before.size, sha256: first };
  } finally {
    await handle.close();
  }
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0) throw new Error("release artifact read was incomplete");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function optionalFileDigest(filePath: string): Promise<string | null> {
  try {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_RETAINED_ARTIFACT_BYTES) throw new Error("Git state file is unsafe or oversized");
      if (metadata.size === 0) return null;
      return digestHandle(handle, metadata.size);
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function complete(result: CommandResult): boolean {
  return result.termination === null && !result.truncated && result.exitCode === 0;
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(candidate);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
