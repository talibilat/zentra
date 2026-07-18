import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EventJournal } from "../../src/journal/journal.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { MilestoneRegistry } from "../../src/milestones/milestone-registry.js";
import { projectMilestone } from "../../src/milestones/milestone-projection.js";
import { IntegrationBranchPreparation } from "../../src/orchestration/integration-branch-preparation.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { GitClient } from "../../src/workspaces/git-client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("IntegrationBranchPreparation", () => {
  it("performs no Git effect when the intent append fails", async () => {
    const fixture = await setup();
    const failing: EventJournal = {
      append: (streamId, version, events) => {
        if (events.some((event) => event.type === "milestone.integration_branch_preparation_intent")) {
          throw new Error("intent append failed");
        }
        return fixture.journal.append(streamId, version, events);
      },
      readStream: (streamId, after) => fixture.journal.readStream(streamId, after),
      readAll: (after) => fixture.journal.readAll(after),
    };
    await expect(new IntegrationBranchPreparation(failing, new MilestoneRegistry(failing), fixture.git).prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
    })).rejects.toThrow("intent append failed");
    expect((await fixture.git.run(fixture.repository, ["show-ref", "--verify", "--quiet", "refs/heads/zentra/integration"])).exitCode).toBe(1);
    expect(fixture.journal.readStream("milestone").map((event) => event.type)).not.toContain("milestone.integration_branch_preparation_intent");
    fixture.journal.close();
  });

  it("retries only after intent when absence proves the prior effect never ran", async () => {
    const fixture = await setup();
    const preparation = new IntegrationBranchPreparation(fixture.journal, fixture.registry, fixture.git);
    await expect(preparation.prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
      hooks: { afterIntent: () => { throw new Error("crash after intent"); } },
    })).rejects.toThrow("crash after intent");
    expect(fixture.journal.readStream("milestone").filter((event) => event.type.endsWith("preparation_intent"))).toHaveLength(1);
    expect((await fixture.git.run(fixture.repository, ["show-ref", "--verify", "--quiet", "refs/heads/zentra/integration"])).exitCode).toBe(1);
    await expect(preparation.prepare({ milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000) }))
      .resolves.toMatchObject({ status: "observed" });
    expect(fixture.journal.readStream("milestone").filter((event) => event.type.endsWith("preparation_intent"))).toHaveLength(1);
    expect(fixture.journal.readStream("milestone").filter((event) => event.type.endsWith("preparation_observed"))).toHaveLength(1);
    expect(projectMilestone(fixture.journal.readStream("milestone"))?.integrationBranchPreparation?.observed).not.toBeNull();
    fixture.journal.close();
  });

  it("records an exact prior effect after restart without dispatching creation again", async () => {
    const fixture = await setup();
    const counting = new CountingGitClient();
    const preparation = new IntegrationBranchPreparation(fixture.journal, fixture.registry, counting);
    await expect(preparation.prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
      hooks: { beforeObservedAppend: () => { throw new Error("crash after effect"); } },
    })).rejects.toThrow("crash after effect");
    expect(counting.updateRefCalls).toBe(1);
    await preparation.prepare({ milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000) });
    expect(counting.updateRefCalls).toBe(1);
    expect(fixture.journal.readStream("milestone").filter((event) => event.type.endsWith("preparation_observed"))).toHaveLength(1);
    fixture.journal.close();
  });

  it("pauses once and never retries a competing wrong ref", async () => {
    const fixture = await setup();
    const counting = new CountingGitClient();
    const preparation = new IntegrationBranchPreparation(fixture.journal, fixture.registry, counting);
    const paused = await preparation.prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
      hooks: { afterIntent: async () => {
        const intent = fixture.journal.readStream("milestone").find((event) => event.type.endsWith("preparation_intent"))!.payload as { intendedBaseCommit: string };
        const tree = (await fixture.git.run(fixture.repository, ["rev-parse", `${intent.intendedBaseCommit}^{tree}`])).stdout.trim();
        const wrong = (await fixture.git.run(fixture.repository, ["commit-tree", tree, "-p", intent.intendedBaseCommit, "-m", "competing"])).stdout.trim();
        await fixture.git.run(fixture.repository, ["update-ref", "refs/heads/zentra/integration", wrong]);
      } },
    });
    expect(paused).toMatchObject({ status: "paused", milestone: { lifecycle: "paused", replanningAttention: { reason: "uncertain_effect" } } });
    expect(counting.updateRefCalls).toBe(0);
    const version = fixture.registry.inspect("milestone")!.streamVersion;
    const repeated = await preparation.prepare({ milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000) });
    expect(repeated).toEqual(paused);
    expect(counting.updateRefCalls).toBe(0);
    expect(fixture.registry.inspect("milestone")!.streamVersion).toBe(version);
    fixture.journal.close();
  });

  it("pauses idempotently when the repository is replaced at the same path and never creates the ref", async () => {
    const fixture = await setup();
    const preparation = new IntegrationBranchPreparation(fixture.journal, fixture.registry, fixture.git);
    await expect(preparation.prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
      hooks: { afterIntent: () => { throw new Error("crash after retained identity"); } },
    })).rejects.toThrow("crash after retained identity");
    const original = `${fixture.repository}-original`;
    renameSync(fixture.repository, original);
    await ok(fixture.git, fixture.root, ["clone", "--no-local", original, fixture.repository]);
    const counting = new CountingGitClient();
    const restarted = new IntegrationBranchPreparation(fixture.journal, fixture.registry, counting);
    const paused = await restarted.prepare({
      milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000),
    });
    expect(paused).toMatchObject({ status: "paused", milestone: { lifecycle: "paused", replanningAttention: { reason: "uncertain_effect" } } });
    expect(counting.updateRefCalls).toBe(0);
    expect((await fixture.git.run(fixture.repository, ["show-ref", "--verify", "--quiet", "refs/heads/zentra/integration"])).exitCode).toBe(1);
    const version = fixture.registry.inspect("milestone")!.streamVersion;
    expect(await restarted.prepare({ milestoneId: "milestone", project: fixture.project, signal: AbortSignal.timeout(10_000) })).toEqual(paused);
    expect(fixture.registry.inspect("milestone")!.streamVersion).toBe(version);
    expect(counting.updateRefCalls).toBe(0);
    fixture.journal.close();
  });
});

class CountingGitClient extends GitClient {
  updateRefCalls = 0;
  override run(cwd: string, args: readonly string[], options?: Parameters<GitClient["run"]>[2]) {
    if (args.includes("update-ref")) this.updateRefCalls += 1;
    return super.run(cwd, args, options);
  }
}

async function setup() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-branch-preparation-")));
  roots.push(root);
  const repository = path.join(root, "repository");
  const git = new GitClient();
  await ok(git, root, ["init", "-b", "main", repository]);
  await ok(git, repository, ["config", "user.name", "Zentra Test"]);
  await ok(git, repository, ["config", "user.email", "test@zentra.local"]);
  writeFileSync(path.join(repository, "file.txt"), "base\n");
  await ok(git, repository, ["add", "--", "."]);
  await ok(git, repository, ["commit", "-m", "base"]);
  const project: ProjectConfig = {
    projectId: "project", repositoryPath: repository, integrationBranch: "zentra/integration",
    worktreeRoot: path.join(root, "worktrees"),
    validations: { focused: [process.execPath, "--test"], full: [process.execPath, "--test"], focusedTimeoutMs: 5_000, fullTimeoutMs: 5_000 },
  };
  const journal = new SqliteEventJournal(path.join(root, "journal.sqlite"));
  const registry = new MilestoneRegistry(journal);
  const modelSheet = { models: [{ id: "planner", harness: "opencode", model: "azure-deployment", roles: ["planner"], specialties: [],
    costTier: "low", contextTokens: 10_000, maxConcurrency: 1, toolPermissions: ["read_repository"], network: "denied",
    fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 } }] };
  registry.register({
    milestoneId: "milestone", projectId: "project", title: "Prepare", correlationId: "trace",
    plan: { milestoneId: "milestone", projectId: "project", goal: "Prepare", tasks: [{ taskId: "plan", title: "Plan", description: "Plan.",
      dependencies: [], ownedPaths: ["file.txt"], forbiddenPaths: [], acceptanceCriteria: ["Prepared."],
      roleAssignment: { role: "planner", agentId: "planner", harness: "opencode" },
      risk: { level: "low", authority: "read_only", requiresReview: false, requiresApproval: false },
      budget: { maxSeconds: 30, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 100 } }] },
    authority: { security: { allowedRepositories: [repository], allowedFileScopes: ["file.txt"], forbiddenPaths: [],
      network: { default: "denied", allowedDestinations: [] }, secretHandling: [], approvalRequiredOperations: [],
      releaseBoundary: "local_preparation_only", stopAndAskConditions: [] }, modelSheet },
  });
  return { root, repository, git, project, journal, registry };
}

async function ok(git: GitClient, cwd: string, args: readonly string[]) {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
