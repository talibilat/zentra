import { createHash } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EventJournal } from "../journal/journal.js";
import type { IntegrationLease, IntegrationLeaseKey } from "../integration/integration-lease.js";
import { parseCapsuleEventPayload, type CapsuleEventType } from "./capsule-events.js";
import { runBoundedProcess } from "./docker-client.js";
import type { CapsulePolicy, GitHubCredentialReferenceSchema } from "./egress-policy.js";
import type { z } from "zod";

const GIT_EXECUTABLE = "/usr/bin/git";
const GIT_SHA256 = "97be7fb98d7272d97ca3034740883a93c12c5a438b313fd618a80aca102a3dda";
const GH_EXECUTABLE = "/opt/homebrew/Cellar/gh/2.76.2/bin/gh";
const GH_SHA256 = "2ee6cbdeee81adabbdd0d379610054d9e55d047067ff70401ad2fa5b5b3f9e0d";
const GH_VERSION = "2.76.2";
const GRANT_AUDIENCE = "zentra.github-broker";
const EFFECT_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const MAX_RECONCILIATIONS = 5;
const RECONCILIATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const REPOSITORY_LEASE_MS = 30_000;
const REPOSITORY_LEASE_RENEWAL_MS = 10_000;
const GITHUB_REPOSITORY_REF = "refs/zentra/github-effects";
const ZERO_OID = "0".repeat(40);

type CredentialReference = z.infer<typeof GitHubCredentialReferenceSchema>;
type PushAction = {
  readonly operation: "push";
  readonly repository: string;
  readonly targetRef: string;
  readonly sourceCommit: string;
  readonly expectedOldOid: string;
  readonly force: false;
};
type PullRequestAction = {
  readonly operation: "create_pull_request";
  readonly repository: string;
  readonly pushGrantId: string;
  readonly headRef: string;
  readonly headCommit: string;
  readonly base: string;
  readonly titleSha256: string;
  readonly bodySha256: string;
  readonly draft: boolean;
};
type DurableAction = PushAction | PullRequestAction;

export interface GitHubCredentialProvider {
  resolve(reference: CredentialReference): Promise<string>;
}

export interface GitHubRepositoryLeaseStore {
  acquire(key: IntegrationLeaseKey, durationMs: number): IntegrationLease | null;
  renew(lease: IntegrationLease, durationMs: number): IntegrationLease | null;
  release(lease: IntegrationLease): boolean;
}

export type GitHubProcessRunner = typeof runBoundedProcess;

export class EnvironmentGitHubCredentialProvider implements GitHubCredentialProvider {
  resolve(reference: CredentialReference): Promise<string> {
    if (reference.type !== "environment" || reference.name !== "GITHUB_TOKEN") {
      throw new Error("unsupported GitHub credential reference");
    }
    const credential = process.env.GITHUB_TOKEN;
    if (credential === undefined || credential.length === 0) throw new Error("GitHub credential is unavailable");
    return Promise.resolve(credential);
  }
}

export interface GitHubEffectReceipt {
  readonly requestId: string;
  readonly actionDigest: string;
  readonly operation: DurableAction["operation"];
  readonly repository: string;
  readonly outcome: "denied" | "failed" | "uncertain";
  readonly dispatchAcknowledged: boolean;
}

export interface GitHubReconciliationReceipt {
  readonly requestId: string;
  readonly actionDigest: string;
  readonly operation: DurableAction["operation"];
  readonly repository: string;
  readonly outcome: "completed" | "failed" | "uncertain";
  readonly attempt: number;
}

export class GitHubEffectBroker {
  private readonly gitExecutable: string;
  private readonly ghExecutable: string;
  private readonly policyDigest: string;

  constructor(
    private readonly policy: CapsulePolicy,
    private readonly journal: EventJournal,
    private readonly credentials: GitHubCredentialProvider,
    private readonly repositoryLeases: GitHubRepositoryLeaseStore,
    private readonly runProcess: GitHubProcessRunner = runBoundedProcess,
  ) {
    this.gitExecutable = approvedExecutable(GIT_EXECUTABLE, GIT_SHA256);
    this.ghExecutable = approvedExecutable(GH_EXECUTABLE, GH_SHA256);
    this.policyDigest = sha256(JSON.stringify(policy));
  }

  push(input: {
    readonly grantId: string;
    readonly repository: string;
    readonly targetRef: string;
    readonly sourceCommit: string;
    readonly expectedOldOid: string;
    readonly force: false;
    readonly sourceRepositoryPath: string;
    readonly signal: AbortSignal;
  }): Promise<GitHubEffectReceipt> {
    const action: PushAction = {
      operation: "push", repository: input.repository, targetRef: input.targetRef,
      sourceCommit: input.sourceCommit, expectedOldOid: input.expectedOldOid, force: input.force,
    };
    return withRepositoryLock(action.repository, () => this.withRepositoryLease(
      action,
      input.signal,
      (assertLease, leaseSignal) => this.dispatchPush(
        input.grantId,
        action,
        input.sourceRepositoryPath,
        AbortSignal.any([input.signal, leaseSignal]),
        assertLease,
      ),
      () => effectReceipt(input.grantId, sha256(JSON.stringify(action)), action, "denied", false),
    ));
  }

  createPullRequest(input: {
    readonly grantId: string;
    readonly pushGrantId: string;
    readonly repository: string;
    readonly headRef: string;
    readonly headCommit: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly signal: AbortSignal;
  }): Promise<GitHubEffectReceipt> {
    assertBoundedText(input.title, 1_024, "title");
    assertBoundedText(input.body, 65_536, "body");
    const finalBody = `${input.body}\n\n${requestMarker(input.grantId)}`;
    const action: PullRequestAction = {
      operation: "create_pull_request", repository: input.repository, pushGrantId: input.pushGrantId, headRef: input.headRef,
      headCommit: input.headCommit, base: input.base, titleSha256: sha256(input.title),
      bodySha256: sha256(finalBody), draft: input.draft,
    };
    return withRepositoryLock(action.repository, () => this.withRepositoryLease(
      action,
      input.signal,
      (assertLease, leaseSignal) => this.dispatchPullRequest(
        input.grantId,
        action,
        input.title,
        finalBody,
        AbortSignal.any([input.signal, leaseSignal]),
        assertLease,
      ),
      () => effectReceipt(input.grantId, sha256(JSON.stringify(action)), action, "denied", false),
    ));
  }

  async reconcilePush(input: { readonly grantId: string; readonly signal: AbortSignal }): Promise<GitHubReconciliationReceipt> {
    const grant = this.policy.githubWrites.find((candidate) => candidate.grantId === input.grantId);
    if (grant?.action.operation !== "push") throw new Error("GitHub reconciliation grant mismatch");
    return withRepositoryLock(grant.action.repository, () => this.withRepositoryLease(
      grant.action,
      input.signal,
      (_assertLease, leaseSignal) => this.reconcilePushUnlocked({
        ...input,
        signal: AbortSignal.any([input.signal, leaseSignal]),
      }),
      () => reconciliationUnavailable(input.grantId, grant.action, 0),
    ));
  }

  private async reconcilePushUnlocked(input: { readonly grantId: string; readonly signal: AbortSignal }): Promise<GitHubReconciliationReceipt> {
    const state = this.reconciliationState(input.grantId, "push");
    const action = state.action as PushAction;
    const grant = this.policy.githubWrites.find((candidate) => candidate.grantId === state.grantId) ?? null;
    if (grant === null || sha256(JSON.stringify(grant.action)) !== state.actionDigest) throw new Error("GitHub reconciliation grant mismatch");
    let observedRemoteOid: string | null = null;
    let outcome: GitHubReconciliationReceipt["outcome"] = "uncertain";
    try {
      await this.attestExecutables(input.signal);
      const token = await this.resolveCredential(grant.credential);
      const output = await this.runReadOnlyGit(["ls-remote", "--refs", remoteUrl(action.repository), action.targetRef], token, input.signal);
      if (output !== null) {
        observedRemoteOid = parseRemoteOid(output);
        outcome = classifyPushReconciliation(action.sourceCommit, observedRemoteOid);
      }
    } catch {
      outcome = "uncertain";
    }
    const payload = { requestId: input.grantId, grantId: state.grantId, actionDigest: state.actionDigest, ...action,
      attempt: state.attempt, outcome, observedRemoteOid };
    this.appendGrant(input.grantId, state.version, "capsule.github_broker_reconciled", payload);
    return { requestId: input.grantId, actionDigest: state.actionDigest, operation: action.operation,
      repository: action.repository, outcome, attempt: state.attempt };
  }

  async reconcilePullRequest(input: { readonly grantId: string; readonly signal: AbortSignal }): Promise<GitHubReconciliationReceipt> {
    const grant = this.policy.githubWrites.find((candidate) => candidate.grantId === input.grantId);
    if (grant?.action.operation !== "create_pull_request") throw new Error("GitHub reconciliation grant mismatch");
    return withRepositoryLock(grant.action.repository, () => this.withRepositoryLease(
      grant.action,
      input.signal,
      (_assertLease, leaseSignal) => this.reconcilePullRequestUnlocked({
        ...input,
        signal: AbortSignal.any([input.signal, leaseSignal]),
      }),
      () => reconciliationUnavailable(input.grantId, grant.action, 0),
    ));
  }

  private async reconcilePullRequestUnlocked(input: { readonly grantId: string; readonly signal: AbortSignal }): Promise<GitHubReconciliationReceipt> {
    const state = this.reconciliationState(input.grantId, "create_pull_request");
    const action = state.action as PullRequestAction;
    const grant = this.policy.githubWrites.find((candidate) => candidate.grantId === state.grantId) ?? null;
    if (grant === null || sha256(JSON.stringify(grant.action)) !== state.actionDigest) throw new Error("GitHub reconciliation grant mismatch");
    let outcome: GitHubReconciliationReceipt["outcome"] = "uncertain";
    let observedNumber: number | null = null;
    try {
      await this.attestExecutables(input.signal);
      const token = await this.resolveCredential(grant.credential);
      const marker = requestMarker(input.grantId);
      const query = `repo:${action.repository} is:pr in:body \"${marker}\"`;
      const searchOutput = await this.runReadOnlyGh([
        "api", "--method", "GET", "/search/issues", "-f", `q=${query}`, "-f", "per_page=2",
      ], token, input.signal);
      if (searchOutput !== null) {
        const search = JSON.parse(searchOutput) as { total_count?: number; items?: readonly { number?: number }[] };
        const number = selectUniquePullRequestNumber(search.total_count, search.items);
        if (number !== null) {
          const detailOutput = await this.runReadOnlyGh([
            "pr", "view", String(number), "--repo", action.repository,
            "--json", "number,headRefName,headRefOid,baseRefName,title,body,isDraft",
          ], token, input.signal);
          if (detailOutput !== null) {
            const row = JSON.parse(detailOutput) as {
              number?: number; headRefName?: string; headRefOid?: string; baseRefName?: string;
              title?: string; body?: string; isDraft?: boolean;
            };
            const exact = row.number === number && row.headRefName === action.headRef && row.headRefOid === action.headCommit &&
              row.baseRefName === action.base && typeof row.title === "string" && sha256(row.title) === action.titleSha256 &&
              typeof row.body === "string" && sha256(row.body) === action.bodySha256 && row.body.includes(marker) && row.isDraft === action.draft;
            if (exact) { outcome = "completed"; observedNumber = number; }
          }
        }
      }
    } catch {
      outcome = "uncertain";
    }
    const payload = { requestId: input.grantId, grantId: state.grantId, actionDigest: state.actionDigest, ...action,
      attempt: state.attempt, outcome, observedNumber };
    this.appendGrant(input.grantId, state.version, "capsule.github_broker_reconciled", payload);
    return { requestId: input.grantId, actionDigest: state.actionDigest, operation: action.operation,
      repository: action.repository, outcome, attempt: state.attempt };
  }

  private async dispatchPush(
    grantId: string,
    action: PushAction,
    sourceRepositoryPath: string,
    signal: AbortSignal,
    assertLease: () => void,
  ): Promise<GitHubEffectReceipt> {
    const requestId = grantId;
    const admitted = this.admit(grantId, action);
    if (!admitted.allowed) return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    try { await this.attestExecutables(signal); } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let token: string;
    try { token = await this.resolveCredential(admitted.credential!); } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let sourceObjects: string;
    let temporary: string;
    try {
      sourceObjects = canonicalGitObjectDirectory(sourceRepositoryPath);
      temporary = createBrokerDirectory();
    } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let dispatched = false;
    let acknowledged = false;
    try {
      const bare = path.join(temporary, "repository.git");
      await this.runGit(["init", "--bare", bare], temporary, gitEnvironment(temporary), signal, READ_TIMEOUT_MS);
      const info = path.join(bare, "objects", "info");
      mkdirSync(info, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(info, "alternates"), `${sourceObjects}\n`, { encoding: "utf8", mode: 0o600 });
      const verified = await this.runGit(["--git-dir", bare, "rev-parse", `${action.sourceCommit}^{commit}`], temporary, gitEnvironment(temporary), signal, READ_TIMEOUT_MS);
      if (verified.exitCode !== 0 || verified.stdout.trim() !== action.sourceCommit) throw new PreDispatchFailure();
      const remote = await this.runGit(["--git-dir", bare, "ls-remote", "--refs", remoteUrl(action.repository), action.targetRef], temporary, gitEnvironment(temporary, token), signal, READ_TIMEOUT_MS);
      if (remote.exitCode !== 0 || (parseRemoteOid(remote.stdout) ?? ZERO_OID) !== action.expectedOldOid) throw new PreDispatchFailure();
      if (action.expectedOldOid !== ZERO_OID) {
        const fetched = await this.runGit(["--git-dir", bare, "fetch", "--no-tags", "--depth=1", remoteUrl(action.repository), action.targetRef], temporary, gitEnvironment(temporary, token), signal, READ_TIMEOUT_MS);
        if (fetched.exitCode !== 0) throw new PreDispatchFailure();
        const fetchedOid = await this.runGit(["--git-dir", bare, "rev-parse", "FETCH_HEAD^{commit}"], temporary, gitEnvironment(temporary), signal, READ_TIMEOUT_MS);
        if (fetchedOid.exitCode !== 0 || fetchedOid.stdout.trim() !== action.expectedOldOid) throw new PreDispatchFailure();
        const ancestor = await this.runGit(["--git-dir", bare, "merge-base", "--is-ancestor", action.expectedOldOid, action.sourceCommit], temporary, gitEnvironment(temporary), signal, READ_TIMEOUT_MS);
        if (ancestor.exitCode !== 0) throw new PreDispatchFailure();
      }
      assertLease();
      dispatched = true;
      const pushed = await this.runGit([
        "--git-dir", bare, "push", "--porcelain", `--force-with-lease=${action.targetRef}:${action.expectedOldOid}`,
        remoteUrl(action.repository), `${action.sourceCommit}:${action.targetRef}`,
      ], temporary, gitEnvironment(temporary, token), signal, EFFECT_TIMEOUT_MS);
      acknowledged = pushed.exitCode === 0;
    } catch {
      if (!dispatched) {
        this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
        return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    this.observe(requestId, grantId, admitted.actionDigest, action, "uncertain");
    return effectReceipt(requestId, admitted.actionDigest, action, "uncertain", acknowledged);
  }

  private async dispatchPullRequest(
    grantId: string,
    action: PullRequestAction,
    title: string,
    body: string,
    signal: AbortSignal,
    assertLease: () => void,
  ): Promise<GitHubEffectReceipt> {
    const requestId = grantId;
    const admitted = this.admit(grantId, action);
    if (!admitted.allowed) return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    try { await this.attestExecutables(signal); } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let token: string;
    try { token = await this.resolveCredential(admitted.credential!); } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let temporary: string;
    try { temporary = createBrokerDirectory(); } catch {
      this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
      return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
    }
    let dispatched = false;
    let acknowledged = false;
    try {
      const head = await this.runGit(["ls-remote", "--refs", remoteUrl(action.repository), `refs/heads/${action.headRef}`], temporary, gitEnvironment(temporary, token), signal, READ_TIMEOUT_MS);
      if (head.exitCode !== 0 || parseRemoteOid(head.stdout) !== action.headCommit) throw new PreDispatchFailure();
      assertLease();
      dispatched = true;
      const args = ["pr", "create", "--repo", action.repository, "--head", action.headRef, "--base", action.base, "--title", title, "--body", body];
      if (action.draft) args.push("--draft");
      const result = await this.runProcess(this.ghExecutable, args, ghEnvironment(temporary, token), signal, EFFECT_TIMEOUT_MS, temporary);
      acknowledged = result.exitCode === 0;
    } catch {
      if (!dispatched) {
        this.observe(requestId, grantId, admitted.actionDigest, action, "denied");
        return effectReceipt(requestId, admitted.actionDigest, action, "denied", false);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    this.observe(requestId, grantId, admitted.actionDigest, action, "uncertain");
    return effectReceipt(requestId, admitted.actionDigest, action, "uncertain", acknowledged);
  }

  private admit(grantId: string, action: DurableAction): { allowed: boolean; actionDigest: string; credential: CredentialReference | null } {
    assertRequestId(grantId);
    const requestId = grantId;
    const streamId = grantStreamId(grantId);
    if (this.journal.readStream(streamId).length !== 0) {
      return { allowed: false, actionDigest: sha256(JSON.stringify(action)), credential: null };
    }
    const actionDigest = sha256(JSON.stringify(action));
    const grant = this.policy.githubWrites.find((candidate) => candidate.grantId === grantId) ?? null;
    const exactAction = grant === null ? false : sha256(JSON.stringify(grant.action)) === actionDigest;
    const payload = { requestId, grantId, policyDigest: this.policyDigest, actionDigest, ...action };
    if (
      this.policy.brokers.github !== "host" || grant === null || !exactAction ||
      (action.operation === "create_pull_request" && !this.hasCompletedPushPrerequisite(action)) ||
      grant.audience !== GRANT_AUDIENCE || Date.parse(grant.expiresAt) <= Date.now()
    ) {
      try { this.appendGrant(grantId, 0, "capsule.github_broker_denied", payload); } catch { /* concurrent burn */ }
      return { allowed: false, actionDigest, credential: null };
    }
    try {
      const grantPayload = parseCapsuleEventPayload("capsule.github_grant_consumed", {
        grantId, audience: grant.audience, expiresAt: grant.expiresAt, requestId,
        policyDigest: this.policyDigest, actionDigest,
      });
      const acceptedPayload = parseCapsuleEventPayload("capsule.github_broker_accepted", payload);
      this.journal.append(streamId, 0, [{
        streamId, type: "capsule.github_grant_consumed", payload: grantPayload,
        causationId: null, correlationId: requestId,
      }, {
        streamId, type: "capsule.github_broker_accepted", payload: acceptedPayload,
        causationId: null, correlationId: requestId,
      }]);
    } catch {
      return { allowed: false, actionDigest, credential: null };
    }
    return { allowed: true, actionDigest, credential: grant.credential };
  }

  private hasCompletedPushPrerequisite(action: PullRequestAction): boolean {
    const prerequisite = this.policy.githubWrites.find((candidate) => candidate.grantId === action.pushGrantId);
    if (
      prerequisite?.action.operation !== "push" ||
      prerequisite.action.repository !== action.repository ||
      prerequisite.action.targetRef !== `refs/heads/${action.headRef}` ||
      prerequisite.action.sourceCommit !== action.headCommit || prerequisite.action.expectedOldOid !== ZERO_OID
    ) return false;
    const events = this.journal.readStream(grantStreamId(action.pushGrantId));
    if (events.length < 4 || events[0]?.type !== "capsule.github_grant_consumed" || events[1]?.type !== "capsule.github_broker_accepted") return false;
    try {
      const consumption = parseCapsuleEventPayload(events[0].type, events[0].payload) as Record<string, unknown>;
      const accepted = parseCapsuleEventPayload(events[1].type, events[1].payload) as Record<string, unknown>;
      const final = events.at(-1)!;
      const reconciled = parseCapsuleEventPayload(final.type, final.payload) as Record<string, unknown>;
      const prerequisiteDigest = sha256(JSON.stringify(prerequisite.action));
      return events.slice(2).every((event) =>
        event.type === "capsule.github_broker_observed" || event.type === "capsule.github_broker_reconciled") &&
        final.type === "capsule.github_broker_reconciled" && reconciled.outcome === "completed" &&
        consumption.requestId === action.pushGrantId && consumption.grantId === action.pushGrantId &&
        consumption.policyDigest === this.policyDigest && consumption.actionDigest === prerequisiteDigest &&
        accepted.requestId === action.pushGrantId && accepted.grantId === action.pushGrantId &&
        accepted.policyDigest === this.policyDigest && accepted.actionDigest === prerequisiteDigest &&
        sha256(JSON.stringify(durableActionFromPayload(accepted))) === prerequisiteDigest &&
        reconciled.requestId === action.pushGrantId && reconciled.grantId === action.pushGrantId &&
        reconciled.actionDigest === prerequisiteDigest &&
        sha256(JSON.stringify(durableActionFromPayload(reconciled))) === prerequisiteDigest;
    } catch {
      return false;
    }
  }

  private observe(requestId: string, grantId: string, actionDigest: string, action: DurableAction, outcome: "denied" | "uncertain"): void {
    const target = action.operation === "push" ? action.targetRef : action.base;
    this.appendGrant(grantId, 2, "capsule.github_broker_observed", {
      requestId, grantId, actionDigest, operation: action.operation, repository: action.repository, target, outcome,
    });
  }

  private reconciliationState(requestId: string, expectedOperation: DurableAction["operation"]): {
    action: DurableAction; grantId: string; actionDigest: string; attempt: number; version: number;
  } {
    assertRequestId(requestId);
    const streamId = grantStreamId(requestId);
    const events = this.journal.readStream(streamId);
    if (events.length < 2 || events[0]?.type !== "capsule.github_grant_consumed" || events[1]?.type !== "capsule.github_broker_accepted") {
      throw new Error("GitHub effect is not awaiting reconciliation");
    }
    const consumption = parseCapsuleEventPayload(events[0].type, events[0].payload) as Record<string, unknown>;
    const accepted = parseCapsuleEventPayload(events[1].type, events[1].payload) as Record<string, unknown>;
    if (accepted.requestId !== requestId || accepted.operation !== expectedOperation || accepted.policyDigest !== this.policyDigest) {
      throw new Error("GitHub reconciliation identity mismatch");
    }
    const action = durableActionFromPayload(accepted);
    const actionDigest = sha256(JSON.stringify(action));
    const grantId = String(accepted.grantId);
    if (actionDigest !== accepted.actionDigest) throw new Error("GitHub action digest mismatch");
    const policyGrant = this.policy.githubWrites.find((candidate) => candidate.grantId === grantId);
    if (
      policyGrant === undefined || consumption.requestId !== requestId || consumption.grantId !== grantId ||
      consumption.actionDigest !== actionDigest || consumption.policyDigest !== this.policyDigest ||
      consumption.audience !== policyGrant.audience || consumption.expiresAt !== policyGrant.expiresAt ||
      sha256(JSON.stringify(policyGrant.action)) !== actionDigest
    ) {
      throw new Error("GitHub grant consumption evidence contradicts request");
    }
    let priorStart = 2;
    if (events[2]?.type === "capsule.github_broker_observed") {
      const observation = parseCapsuleEventPayload(events[2].type, events[2].payload) as Record<string, unknown>;
      const target = action.operation === "push" ? action.targetRef : action.base;
      if (
        observation.requestId !== requestId || observation.grantId !== grantId ||
        observation.actionDigest !== actionDigest || observation.operation !== action.operation ||
        observation.repository !== action.repository || observation.target !== target || observation.outcome !== "uncertain"
      ) throw new Error("GitHub observation contradicts accepted action");
      priorStart = 3;
    }
    const prior = events.slice(priorStart);
    if (prior.some((event) => event.type !== "capsule.github_broker_reconciled")) throw new Error("invalid reconciliation stream");
    for (let index = 0; index < prior.length; index += 1) {
      const payload = parseCapsuleEventPayload(prior[index]!.type, prior[index]!.payload) as Record<string, unknown>;
      if (
        payload.requestId !== requestId || payload.grantId !== grantId || payload.actionDigest !== actionDigest ||
        payload.operation !== action.operation || payload.repository !== action.repository || payload.attempt !== index + 1
      ) throw new Error("GitHub reconciliation stream contradicts accepted action");
      if (sha256(JSON.stringify(durableActionFromPayload(payload))) !== actionDigest) {
        throw new Error("GitHub reconciliation action contradicts accepted action");
      }
    }
    const lastOutcome = (prior.at(-1)?.payload as { outcome?: unknown } | undefined)?.outcome;
    if (lastOutcome === "completed" || lastOutcome === "failed") throw new Error("GitHub effect is already reconciled");
    const attempt = prior.length + 1;
    if (attempt > MAX_RECONCILIATIONS || Date.now() - Date.parse(events[1].recordedAt) > RECONCILIATION_WINDOW_MS) {
      throw new Error("GitHub reconciliation budget expired");
    }
    return { action, grantId, actionDigest, attempt, version: events.at(-1)!.streamVersion };
  }

  private runGit(args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number) {
    return this.runProcess(this.gitExecutable, args, environment, signal, timeoutMs, cwd);
  }
  private async attestExecutables(signal: AbortSignal): Promise<void> {
    if (approvedExecutable(this.gitExecutable, GIT_SHA256) !== this.gitExecutable || approvedExecutable(this.ghExecutable, GH_SHA256) !== this.ghExecutable) {
      throw new Error("GitHub broker executable attestation failed");
    }
    const temporary = createBrokerDirectory();
    try {
      const result = await this.runProcess(this.ghExecutable, ["--version"], {
        LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", HOME: path.join(temporary, "home"),
        XDG_CONFIG_HOME: path.join(temporary, "xdg"), GH_PROMPT_DISABLED: "1",
      }, signal, 5_000, temporary);
      if (result.exitCode !== 0 || result.stdout.split(/\r?\n/, 1)[0] !== `gh version ${GH_VERSION} (2025-07-30)`) {
        throw new Error("GitHub CLI version attestation failed");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  private async runReadOnlyGit(args: readonly string[], token: string, signal: AbortSignal): Promise<string | null> {
    const temporary = createBrokerDirectory();
    try {
      const result = await this.runGit(args, temporary, gitEnvironment(temporary, token), signal, READ_TIMEOUT_MS);
      return result.exitCode === 0 ? result.stdout : null;
    } catch { return null; } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  private async runReadOnlyGh(args: readonly string[], token: string, signal: AbortSignal): Promise<string | null> {
    const temporary = createBrokerDirectory();
    try {
      const result = await this.runProcess(this.ghExecutable, args, ghEnvironment(temporary, token), signal, READ_TIMEOUT_MS, temporary);
      return result.exitCode === 0 ? result.stdout : null;
    } catch { return null; } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  private resolveCredential(reference: CredentialReference): Promise<string> {
    return this.credentials.resolve(reference).then((value) => { if (value.length === 0) throw new Error("empty credential"); return value; });
  }
  private appendGrant(grantId: string, version: number, type: CapsuleEventType, payload: unknown): void {
    const streamId = grantStreamId(grantId);
    this.journal.append(streamId, version, [{ streamId, type, payload: parseCapsuleEventPayload(type, payload), causationId: null, correlationId: grantId }]);
  }

  private async withRepositoryLease<T>(
    action: DurableAction,
    signal: AbortSignal,
    operation: (assertLease: () => void, leaseSignal: AbortSignal) => Promise<T>,
    unavailable: () => T,
  ): Promise<T> {
    if (signal.aborted) return unavailable();
    let current = this.repositoryLeases.acquire(repositoryLeaseKey(action.repository), REPOSITORY_LEASE_MS);
    if (current === null) return unavailable();
    let lost = false;
    const leaseController = new AbortController();
    const assertLease = (): void => {
      if (lost) throw new RepositoryLeaseLostError();
      const renewed = this.repositoryLeases.renew(current!, REPOSITORY_LEASE_MS);
      if (renewed === null) {
        lost = true;
        leaseController.abort(new RepositoryLeaseLostError());
        throw new RepositoryLeaseLostError();
      }
      current = renewed;
    };
    const renewal = setInterval(() => {
      try {
        assertLease();
      } catch {
        lost = true;
        if (!leaseController.signal.aborted) {
          leaseController.abort(new RepositoryLeaseLostError());
        }
      }
    }, REPOSITORY_LEASE_RENEWAL_MS);
    renewal.unref();
    try {
      return await operation(assertLease, leaseController.signal);
    } finally {
      clearInterval(renewal);
      try {
        this.repositoryLeases.release(current);
      } catch {
        // Lease expiry preserves exclusion; release failure cannot replace an
        // authoritative effect observation with a synthetic local failure.
      }
    }
  }
}

class PreDispatchFailure extends Error {}
class RepositoryLeaseLostError extends Error {}

function approvedExecutable(candidate: string, expectedSha256: string): string {
  const canonical = realpathSync.native(candidate);
  const stat = statSync(canonical);
  const digest = createHash("sha256").update(readFileSync(canonical)).digest("hex");
  if (canonical !== candidate || !stat.isFile() || (stat.mode & 0o111) === 0 || digest !== expectedSha256) throw new Error("GitHub broker executable is not canonical and attested");
  return canonical;
}

function createBrokerDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-github-broker-")));
  chmodSync(directory, 0o700);
  mkdirSync(path.join(directory, "home"), { mode: 0o700 });
  mkdirSync(path.join(directory, "xdg"), { mode: 0o700 });
  return directory;
}

function gitEnvironment(root: string, token?: string): NodeJS.ProcessEnv {
  const fixed: Record<string, string> = {
    "core.hooksPath": "/dev/null",
    "credential.helper": "",
    "core.fsmonitor": "false",
    "diff.external": "",
    "core.pager": "cat",
    "protocol.file.allow": "never",
    "fetch.fsckObjects": "true",
    "transfer.fsckObjects": "true",
  };
  if (token !== undefined) fixed["http.https://github.com/.extraheader"] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  const environment: NodeJS.ProcessEnv = {
    LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_COUNT: String(Object.keys(fixed).length),
  };
  Object.entries(fixed).forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

function ghEnvironment(root: string, token: string): NodeJS.ProcessEnv {
  return { LANG: "C", LC_ALL: "C", PATH: "/usr/local/bin:/usr/bin:/bin", HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "xdg"), GH_TOKEN: token, GH_PROMPT_DISABLED: "1" };
}

function canonicalGitObjectDirectory(repositoryPath: string): string {
  const repository = realpathSync.native(repositoryPath);
  if (repository !== repositoryPath || !statSync(repository).isDirectory()) throw new Error("source repository path is not canonical");
  let gitDirectory: string;
  const dotGit = path.join(repository, ".git");
  const dotGitStat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (dotGitStat?.isDirectory()) gitDirectory = realpathSync.native(dotGit);
  else if (dotGitStat?.isFile() && !dotGitStat.isSymbolicLink()) {
    const content = readFileSync(dotGit, "utf8");
    if (Buffer.byteLength(content) > 4_096 || !content.startsWith("gitdir: ")) throw new Error("invalid Git worktree link");
    gitDirectory = realpathSync.native(path.resolve(repository, content.slice(8).trim()));
  } else if (statSync(path.join(repository, "objects"), { throwIfNoEntry: false })?.isDirectory()) gitDirectory = repository;
  else throw new Error("source repository metadata is unavailable");
  const commonFile = path.join(gitDirectory, "commondir");
  const commonStat = lstatSync(commonFile, { throwIfNoEntry: false });
  if (commonStat?.isFile() && !commonStat.isSymbolicLink()) {
    const common = readFileSync(commonFile, "utf8");
    if (Buffer.byteLength(common) > 4_096) throw new Error("invalid Git common directory");
    gitDirectory = realpathSync.native(path.resolve(gitDirectory, common.trim()));
  }
  const objects = realpathSync.native(path.join(gitDirectory, "objects"));
  if (!statSync(objects).isDirectory()) throw new Error("source object directory is unavailable");
  if (lstatSync(path.join(objects, "info", "alternates"), { throwIfNoEntry: false }) !== undefined) {
    throw new Error("source object alternates are not allowed");
  }
  return objects;
}

function durableActionFromPayload(payload: Record<string, unknown>): DurableAction {
  if (payload.operation === "push") return {
    operation: "push", repository: String(payload.repository), targetRef: String(payload.targetRef),
    sourceCommit: String(payload.sourceCommit), expectedOldOid: String(payload.expectedOldOid), force: false,
  };
  return {
    operation: "create_pull_request", repository: String(payload.repository), pushGrantId: String(payload.pushGrantId), headRef: String(payload.headRef),
    headCommit: String(payload.headCommit), base: String(payload.base), titleSha256: String(payload.titleSha256),
    bodySha256: String(payload.bodySha256), draft: payload.draft === true,
  };
}

function parseRemoteOid(output: string): string | null {
  const line = output.trim();
  if (line === "") return null;
  const [oid] = line.split(/\s+/, 1);
  return oid !== undefined && /^[a-f0-9]{40,64}$/.test(oid) ? oid : null;
}
export function classifyPushReconciliation(expectedCommit: string, observedRemoteOid: string | null): "completed" | "uncertain" {
  return observedRemoteOid === expectedCommit ? "completed" : "uncertain";
}
export function selectUniquePullRequestNumber(
  totalCount: number | undefined,
  items: readonly { readonly number?: number }[] | undefined,
): number | null {
  return totalCount === 1 && items?.length === 1 && Number.isInteger(items[0]?.number)
    ? items[0]!.number!
    : null;
}
function remoteUrl(repository: string): string { return `https://github.com/${repository}.git`; }
export function repositoryLeaseKey(repository: string): IntegrationLeaseKey {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("invalid GitHub repository identity");
  }
  return {
    commonDirectory: path.posix.join(
      "/zentra/github.com/repositories",
      sha256(repository.toLowerCase()),
    ),
    integrationRef: GITHUB_REPOSITORY_REF,
  };
}
function grantStreamId(grantId: string): string { return `github-grant:${grantId}`; }
function requestMarker(requestId: string): string { return `Zentra-Request-ID: ${requestId}`; }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function assertRequestId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("invalid GitHub request identity"); }
function assertBoundedText(value: string, max: number, field: string): void { if (value.length === 0 || Buffer.byteLength(value, "utf8") > max) throw new Error(`GitHub ${field} is invalid`); }
function effectReceipt(requestId: string, actionDigest: string, action: DurableAction, outcome: GitHubEffectReceipt["outcome"], dispatchAcknowledged: boolean): GitHubEffectReceipt {
  return { requestId, actionDigest, operation: action.operation, repository: action.repository, outcome, dispatchAcknowledged };
}
function reconciliationUnavailable(
  requestId: string,
  action: DurableAction,
  attempt: number,
): GitHubReconciliationReceipt {
  return {
    requestId,
    actionDigest: sha256(JSON.stringify(action)),
    operation: action.operation,
    repository: action.repository,
    outcome: "uncertain",
    attempt,
  };
}

const repositoryLocks = new Map<string, Promise<void>>();

async function withRepositoryLock<T>(repository: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = repositoryLocks.get(repository) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = predecessor.then(() => current);
  repositoryLocks.set(repository, queued);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryLocks.get(repository) === queued) repositoryLocks.delete(repository);
  }
}
