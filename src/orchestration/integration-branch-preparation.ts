import { realpathSync, statSync } from "node:fs";

import {
  IntegrationBranchPreparationIntentSchema,
  IntegrationBranchPreparationObservedSchema,
  createIntegrationBranchPreparationIntent,
  type IntegrationBranchPreparationIntent,
} from "../contracts/integration-branch-preparation.js";
import type { EventJournal } from "../journal/journal.js";
import type { MilestoneRecord, MilestoneRegistry } from "../milestones/milestone-registry.js";
import type { ProjectConfig } from "../projects/project-config.js";
import type { GitClient } from "../workspaces/git-client.js";

export interface IntegrationBranchPreparationHooks {
  readonly afterIntent?: () => void | Promise<void>;
  readonly beforeEffect?: () => void | Promise<void>;
  readonly afterEffect?: () => void | Promise<void>;
  readonly beforeObservedAppend?: () => void | Promise<void>;
}

export class IntegrationBranchPreparation {
  constructor(
    private readonly journal: EventJournal,
    private readonly milestones: MilestoneRegistry,
    private readonly git: GitClient,
  ) {}

  async prepare(input: {
    readonly milestoneId: string;
    readonly project: ProjectConfig;
    readonly signal: AbortSignal;
    readonly hooks?: IntegrationBranchPreparationHooks;
  }): Promise<{ readonly status: "observed"; readonly intent: IntegrationBranchPreparationIntent } |
    { readonly status: "paused"; readonly milestone: MilestoneRecord }> {
    const milestone = this.milestones.inspect(input.milestoneId);
    if (milestone === null || milestone.plan === null) throw new Error("integration branch preparation requires a durable milestone plan");
    const stream = this.journal.readStream(input.milestoneId);
    let intentEvent = stream.find((event) => event.type === "milestone.integration_branch_preparation_intent");
    let intent: IntegrationBranchPreparationIntent;
    if (intentEvent === undefined) {
      intent = await this.createIntent(milestone, input.project, input.signal);
      const current = this.journal.readStream(input.milestoneId);
      const stored = this.journal.append(input.milestoneId, current.at(-1)!.streamVersion, [{
        streamId: input.milestoneId,
        type: "milestone.integration_branch_preparation_intent",
        payload: intent,
        causationId: null,
        correlationId: milestone.traceId,
      }]);
      intentEvent = stored[0]!;
      await input.hooks?.afterIntent?.();
    } else {
      intent = IntegrationBranchPreparationIntentSchema.parse(intentEvent.payload);
    }
    const observed = this.journal.readStream(input.milestoneId).find((event) =>
      event.type === "milestone.integration_branch_preparation_observed");
    if (observed !== undefined) {
      const payload = IntegrationBranchPreparationObservedSchema.parse(observed.payload);
      if (payload.intentDigest !== intent.intentDigest || payload.fullRef !== intent.fullRef ||
        payload.observedCommit !== intent.intendedBaseCommit) throw new Error("integration branch observation contradicts its intent");
      const retainedIdentity = await this.verifyIdentity(intent, input.signal);
      if (retainedIdentity !== null) return this.pause(input.milestoneId, intent, retainedIdentity);
      return { status: "observed", intent };
    }
    const state = await this.inspectRef(intent, input.signal);
    if (state.kind === "contradictory") {
      return {
        status: "paused",
        milestone: this.milestones.pauseForIntegrationBranchUncertainty(input.milestoneId, {
          intentDigest: intent.intentDigest,
          repository: intent.repository,
          commonDirectory: intent.commonDirectory,
          fullRef: intent.fullRef,
          intendedBaseCommit: intent.intendedBaseCommit,
          observedState: state.observed,
        }),
      };
    }
    if (state.kind === "absent") {
      await input.hooks?.beforeEffect?.();
      const mutationIdentity = await this.verifyIdentity(intent, input.signal);
      if (mutationIdentity !== null) return this.pause(input.milestoneId, intent, mutationIdentity);
      const zeros = "0".repeat(intent.intendedBaseCommit.length);
      const created = await this.git.run(intent.repository, [
        "-c", "core.hooksPath=/dev/null", "update-ref", intent.fullRef, intent.intendedBaseCommit, zeros,
      ], { signal: input.signal, timeoutMs: 30_000 });
      if (created.termination !== null || created.exitCode !== 0 || created.truncated) {
        const reconciled = await this.inspectRef(intent, input.signal);
        if (reconciled.kind !== "exact") {
          return {
            status: "paused",
            milestone: this.milestones.pauseForIntegrationBranchUncertainty(input.milestoneId, {
              intentDigest: intent.intentDigest, repository: intent.repository, commonDirectory: intent.commonDirectory,
              fullRef: intent.fullRef, intendedBaseCommit: intent.intendedBaseCommit,
              observedState: reconciled.kind === "absent" ? "absent_after_attempt" : reconciled.observed,
            }),
          };
        }
      }
      await input.hooks?.afterEffect?.();
    }
    const verified = await this.inspectRef(intent, input.signal);
    if (verified.kind === "contradictory") return this.pause(input.milestoneId, intent, verified.observed);
    if (verified.kind !== "exact") throw new Error("integration branch preparation was not exactly verified");
    await input.hooks?.beforeObservedAppend?.();
    const observationIdentity = await this.verifyIdentity(intent, input.signal);
    if (observationIdentity !== null) return this.pause(input.milestoneId, intent, observationIdentity);
    const current = this.journal.readStream(input.milestoneId);
    this.journal.append(input.milestoneId, current.at(-1)!.streamVersion, [{
      streamId: input.milestoneId,
      type: "milestone.integration_branch_preparation_observed",
      payload: IntegrationBranchPreparationObservedSchema.parse({
        schemaVersion: 1, intentDigest: intent.intentDigest, fullRef: intent.fullRef,
        observedCommit: intent.intendedBaseCommit, outcome: "exact",
      }),
      causationId: intentEvent.eventId,
      correlationId: milestone.traceId,
    }]);
    return { status: "observed", intent };
  }

  private async createIntent(milestone: MilestoneRecord, project: ProjectConfig, signal: AbortSignal) {
    const repository = realpathSync.native(project.repositoryPath);
    const repositoryStat = statSync(repository);
    const common = await this.git.run(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal, timeoutMs: 30_000 });
    if (common.termination !== null || common.exitCode !== 0 || common.truncated) throw new Error("integration branch common directory is unavailable");
    const commonDirectory = realpathSync.native(common.stdout.trim());
    const commonDirectoryStat = statSync(commonDirectory);
    const fullRef = `refs/heads/${project.integrationBranch}`;
    const existing = await this.git.run(repository, ["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`],
      { signal, timeoutMs: 30_000 });
    const base = existing.exitCode === 0
      ? existing
      : await this.git.run(repository, ["rev-parse", "--verify", "HEAD^{commit}"], { signal, timeoutMs: 30_000 });
    const intendedBaseCommit = base.stdout.trim();
    if (base.termination !== null || base.exitCode !== 0 || base.truncated || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(intendedBaseCommit)) {
      throw new Error("integration branch intended base is unavailable");
    }
    return createIntegrationBranchPreparationIntent({
      schemaVersion: 1, milestoneId: milestone.milestoneId, projectId: milestone.projectId,
      correlationId: milestone.traceId, repository,
      repositoryDevice: repositoryStat.dev, repositoryInode: repositoryStat.ino,
      commonDirectory, commonDirectoryDevice: commonDirectoryStat.dev, commonDirectoryInode: commonDirectoryStat.ino,
      fullRef, intendedBaseCommit,
    });
  }

  private async inspectRef(intent: IntegrationBranchPreparationIntent, signal: AbortSignal): Promise<
    { readonly kind: "absent" } | { readonly kind: "exact" } | { readonly kind: "contradictory"; readonly observed: string }> {
    const identityMismatch = await this.verifyIdentity(intent, signal);
    if (identityMismatch !== null) return { kind: "contradictory", observed: identityMismatch };
    const symbolic = await this.git.run(intent.repository, ["symbolic-ref", "--quiet", intent.fullRef], { signal, timeoutMs: 30_000 });
    if (symbolic.termination !== null || symbolic.truncated || (symbolic.exitCode !== 0 && symbolic.exitCode !== 1)) {
      return { kind: "contradictory", observed: "ref_identity_unreadable" };
    }
    if (symbolic.exitCode === 0) return { kind: "contradictory", observed: "symbolic_ref" };
    const ref = await this.git.run(intent.repository, ["rev-parse", "--verify", "--quiet", `${intent.fullRef}^{commit}`],
      { signal, timeoutMs: 30_000 });
    if (ref.termination !== null || ref.truncated || (ref.exitCode !== 0 && ref.exitCode !== 1)) {
      return { kind: "contradictory", observed: "ref_state_unreadable" };
    }
    if (ref.exitCode === 1) return { kind: "absent" };
    return ref.stdout.trim() === intent.intendedBaseCommit
      ? { kind: "exact" }
      : { kind: "contradictory", observed: `wrong_commit:${ref.stdout.trim()}` };
  }

  private async verifyIdentity(intent: IntegrationBranchPreparationIntent, signal: AbortSignal): Promise<string | null> {
    let repository: string;
    let repositoryStat: ReturnType<typeof statSync>;
    try {
      repository = realpathSync.native(intent.repository);
      repositoryStat = statSync(repository);
    } catch {
      return "repository_identity_unavailable";
    }
    if (repository !== intent.repository || repositoryStat.dev !== intent.repositoryDevice || repositoryStat.ino !== intent.repositoryInode) {
      return "repository_identity_mismatch";
    }
    const common = await this.git.run(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal, timeoutMs: 30_000 });
    if (common.termination !== null || common.exitCode !== 0 || common.truncated) return "common_directory_unavailable";
    try {
      const commonDirectory = realpathSync.native(common.stdout.trim());
      const commonStat = statSync(commonDirectory);
      if (commonDirectory !== intent.commonDirectory || commonStat.dev !== intent.commonDirectoryDevice ||
        commonStat.ino !== intent.commonDirectoryInode) return "common_directory_identity_mismatch";
    } catch {
      return "common_directory_unavailable";
    }
    return null;
  }

  private pause(milestoneId: string, intent: IntegrationBranchPreparationIntent, observedState: string) {
    return {
      status: "paused" as const,
      milestone: this.milestones.pauseForIntegrationBranchUncertainty(milestoneId, {
        intentDigest: intent.intentDigest,
        repository: intent.repository,
        commonDirectory: intent.commonDirectory,
        fullRef: intent.fullRef,
        intendedBaseCommit: intent.intendedBaseCommit,
        observedState,
      }),
    };
  }
}
