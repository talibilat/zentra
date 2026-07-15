import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { CapsulePolicySchema, githubBrokerHeadRef } from "../../src/capsule/egress-policy.js";
import {
  classifyPushReconciliation,
  GitHubEffectBroker,
  repositoryLeaseKey,
  selectUniquePullRequestNumber,
  type GitHubRepositoryLeaseStore,
} from "../../src/capsule/github-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const pushAction = {
  operation: "push" as const, repository: "talibilat/zentra", targetRef: `refs/heads/${githubBrokerHeadRef("pr-grant")}`,
  sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false as const,
};
const prAction = {
  operation: "create_pull_request" as const, repository: "talibilat/zentra", pushGrantId: "push-grant", headRef: githubBrokerHeadRef("pr-grant"),
  headCommit: "1".repeat(40), base: "main",
  titleSha256: createHash("sha256").update("Title").digest("hex"),
  bodySha256: createHash("sha256").update("Body\n\nZentra-Request-ID: pr-grant").digest("hex"), draft: false,
};
const credential = { type: "environment" as const, name: "GITHUB_TOKEN" as const };
const policy = CapsulePolicySchema.parse({
  schemaVersion: 1,
  reads: { mode: "exact_domains", domains: ["example.com"], methods: ["GET"] },
  githubWrites: [
    { grantId: "push-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: pushAction, credential },
    { grantId: "pr-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: prAction, credential },
  ],
  brokers: { github: "host", model: "disabled" },
});

function repositoryLeases(overrides: Partial<GitHubRepositoryLeaseStore> = {}): GitHubRepositoryLeaseStore {
  const lease = {
    ...repositoryLeaseKey(pushAction.repository),
    ownerToken: "lease-owner",
    acquiredAt: 1,
    expiresAt: Date.now() + 60_000,
    pid: process.pid,
    hostname: "test",
  };
  return {
    acquire: () => lease,
    renew: () => ({ ...lease, expiresAt: Date.now() + 60_000 }),
    release: () => true,
    ...overrides,
  };
}

function appendCompletedPush(journal: SqliteEventJournal): void {
  const policyDigest = createHash("sha256").update(JSON.stringify(policy), "utf8").digest("hex");
  const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
  const common = { requestId: "push-grant", grantId: "push-grant", actionDigest };
  journal.append("github-grant:push-grant", 0, [{
    streamId: "github-grant:push-grant", type: "capsule.github_grant_consumed",
    payload: { ...common, audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", policyDigest }, causationId: null, correlationId: "push-grant",
  }, {
    streamId: "github-grant:push-grant", type: "capsule.github_broker_accepted",
    payload: { ...common, policyDigest, ...pushAction }, causationId: null, correlationId: "push-grant",
  }, {
    streamId: "github-grant:push-grant", type: "capsule.github_broker_observed",
    payload: { ...common, operation: "push", repository: pushAction.repository, target: pushAction.targetRef, outcome: "uncertain" }, causationId: null, correlationId: "push-grant",
  }, {
    streamId: "github-grant:push-grant", type: "capsule.github_broker_reconciled",
    payload: { ...common, ...pushAction, attempt: 1, outcome: "completed", observedRemoteOid: pushAction.sourceCommit }, causationId: null, correlationId: "push-grant",
  }]);
}

describe("GitHubEffectBroker", () => {
  it("keys case-insensitive repository identity in an absolute synthetic namespace", () => {
    const lower = repositoryLeaseKey("talibilat/zentra");
    expect(repositoryLeaseKey("TALIBILAT/ZENTRA")).toEqual(lower);
    expect(lower.commonDirectory).toMatch(/^\/zentra\/github\.com\/repositories\/[a-f0-9]{64}$/);
    expect(lower.integrationRef).toBe("refs/zentra/github-effects");
  });

  it("denies any incomplete action mismatch before credential access", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const resolve = vi.fn();
    const broker = new GitHubEffectBroker(policy, journal, { resolve }, repositoryLeases());
    await expect(broker.push({
      ...pushAction, sourceCommit: "3".repeat(40), grantId: "push-grant",
      sourceRepositoryPath: process.cwd(), signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", dispatchAcknowledged: false });
    expect(resolve).not.toHaveBeenCalled();
    const payload = journal.readStream("github-grant:push-grant")[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ ...pushAction, sourceCommit: "3".repeat(40) });
    expect(payload.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toMatch(/credential|GITHUB_TOKEN/);
    journal.close();
  });

  it("persists complete PR identity and action digest but not title, body, or credential reference", async () => {
    const journal = new SqliteEventJournal(":memory:");
    appendCompletedPush(journal);
    const broker = new GitHubEffectBroker(policy, journal, { resolve: vi.fn().mockRejectedValue(new Error("missing")) }, repositoryLeases());
    await expect(broker.createPullRequest({
      grantId: "pr-grant", pushGrantId: prAction.pushGrantId, repository: prAction.repository, headRef: prAction.headRef,
      headCommit: prAction.headCommit, base: prAction.base, title: "Title", body: "Body", draft: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", dispatchAcknowledged: false });
    const accepted = journal.readStream("github-grant:pr-grant")[1]?.payload as Record<string, unknown>;
    expect(accepted).toMatchObject(prAction);
    expect(JSON.stringify(journal.readStream("github-grant:pr-grant"))).not.toMatch(/"title":"Title"|"body":"Body"|GITHUB_TOKEN/);
    journal.close();
  });

  it("denies PR admission unless its exact separate push grant ended completed", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const resolve = vi.fn();
    const broker = new GitHubEffectBroker(policy, journal, { resolve }, repositoryLeases());
    await expect(broker.createPullRequest({
      grantId: "pr-grant", pushGrantId: "push-grant", repository: prAction.repository,
      headRef: prAction.headRef, headCommit: prAction.headCommit, base: prAction.base,
      title: "Title", body: "Body", draft: false, signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", requestId: "pr-grant" });
    expect(resolve).not.toHaveBeenCalled();
    expect(journal.readStream("github-grant:pr-grant").map((event) => event.type)).toEqual([
      "capsule.github_broker_denied",
    ]);
    journal.close();
  });

  it("allows bounded repeated read-only reconciliation using only durable action identity", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const policyDigest = createHash("sha256").update(JSON.stringify(policy), "utf8").digest("hex");
    const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
    journal.append("github-grant:push-grant", 0, [{
      streamId: "github-grant:push-grant", type: "capsule.github_grant_consumed",
      payload: { grantId: "push-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", requestId: "push-grant", policyDigest, actionDigest },
      causationId: null, correlationId: "push-grant",
    }, {
      streamId: "github-grant:push-grant", type: "capsule.github_broker_accepted",
      payload: { requestId: "push-grant", grantId: "push-grant", policyDigest, actionDigest, ...pushAction }, causationId: null, correlationId: "push-grant",
    }]);
    const broker = new GitHubEffectBroker(policy, journal, { resolve: vi.fn().mockRejectedValue(new Error("offline")) }, repositoryLeases());
    await expect(broker.reconcilePush({ grantId: "push-grant", signal: new AbortController().signal })).resolves.toMatchObject({ outcome: "uncertain", attempt: 1 });
    await expect(broker.reconcilePush({ grantId: "push-grant", signal: new AbortController().signal })).resolves.toMatchObject({ outcome: "uncertain", attempt: 2 });
    expect(journal.readStream("github-grant:push-grant").filter((event) => event.type === "capsule.github_broker_reconciled").map((event) => (event.payload as { attempt: number }).attempt)).toEqual([1, 2]);
    await expect(broker.push({
      grantId: "push-grant", ...pushAction,
      sourceRepositoryPath: process.cwd(), signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", requestId: "push-grant" });
    journal.close();
  });

  it("burns one grant atomically and rejects reuse under a new request identity", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const resolve = vi.fn().mockRejectedValue(new Error("missing"));
    const broker = new GitHubEffectBroker(policy, journal, { resolve }, repositoryLeases());
    const base = {
      grantId: "push-grant", ...pushAction, sourceRepositoryPath: process.cwd(), signal: new AbortController().signal,
    };
    await expect(Promise.all([broker.push(base), broker.push(base)])).resolves.toEqual([
      expect.objectContaining({ outcome: "denied", requestId: "push-grant" }),
      expect.objectContaining({ outcome: "denied", requestId: "push-grant" }),
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(journal.readStream("github-grant:push-grant").map((event) => event.type)).toEqual([
      "capsule.github_grant_consumed", "capsule.github_broker_accepted", "capsule.github_broker_observed",
    ]);
    journal.close();
  });

  it("denies expired grants before consumption or credential resolution", async () => {
    const expired = CapsulePolicySchema.parse({
      ...policy,
      githubWrites: [{ ...policy.githubWrites[0]!, grantId: "expired", expiresAt: "2020-01-01T00:00:00.000Z" }],
    });
    const journal = new SqliteEventJournal(":memory:");
    const resolve = vi.fn();
    const broker = new GitHubEffectBroker(expired, journal, { resolve }, repositoryLeases());
    await expect(broker.push({
      grantId: "expired", ...pushAction,
      sourceRepositoryPath: process.cwd(), signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied" });
    expect(resolve).not.toHaveBeenCalled();
    expect(journal.readStream("github-grant:expired").map((event) => event.type)).toEqual([
      "capsule.github_broker_denied",
    ]);
    journal.close();
  });

  it("does not consume a grant when repository serialization is unavailable", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const resolve = vi.fn();
    const broker = new GitHubEffectBroker(policy, journal, { resolve }, repositoryLeases({
      acquire: () => null,
    }));

    await expect(broker.push({
      grantId: "push-grant", ...pushAction,
      sourceRepositoryPath: process.cwd(), signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", dispatchAcknowledged: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(journal.readStream("github-grant:push-grant")).toEqual([]);
    journal.close();
  });

  it("prevents PR creation when lease ownership is lost immediately before dispatch", async () => {
    const journal = new SqliteEventJournal(":memory:");
    appendCompletedPush(journal);
    const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "gh version 2.76.2 (2025-07-30)\n", stderr: "" };
      }
      if (args[0] === "ls-remote") {
        return { exitCode: 0, stdout: `${prAction.headCommit}\trefs/heads/${prAction.headRef}\n`, stderr: "" };
      }
      throw new Error(`unexpected effect dispatch: ${args.join(" ")}`);
    });
    const broker = new GitHubEffectBroker(
      policy,
      journal,
      { resolve: vi.fn().mockResolvedValue("token") },
      repositoryLeases({ renew: () => null }),
      runner,
    );

    await expect(broker.createPullRequest({
      grantId: "pr-grant", pushGrantId: prAction.pushGrantId,
      repository: prAction.repository, headRef: prAction.headRef,
      headCommit: prAction.headCommit, base: prAction.base,
      title: "Title", body: "Body", draft: false,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "denied", dispatchAcknowledged: false });
    expect(runner.mock.calls.some((call) => call[1]?.[0] === "pr" && call[1]?.[1] === "create")).toBe(false);
    expect(journal.readStream("github-grant:pr-grant").map((event) => event.type)).toEqual([
      "capsule.github_grant_consumed", "capsule.github_broker_accepted", "capsule.github_broker_observed",
    ]);
    journal.close();
  });

  it("aborts an in-flight effect when renewal throws and preserves its uncertain result", async () => {
    vi.useFakeTimers();
    try {
      const competingAction = { ...pushAction, repository: "TALIBILAT/ZENTRA" };
      const renewalPolicy = CapsulePolicySchema.parse({
        ...policy,
        githubWrites: [
          ...policy.githubWrites,
          {
            grantId: "competing-grant",
            audience: "zentra.github-broker",
            expiresAt: "2099-01-01T00:00:00.000Z",
            action: competingAction,
            credential,
          },
        ],
      });
      const journal = new SqliteEventJournal(":memory:");
      let activeLease: ReturnType<GitHubRepositoryLeaseStore["acquire"]> = null;
      let renewals = 0;
      const leases: GitHubRepositoryLeaseStore = {
        acquire(key, durationMs) {
          if (activeLease !== null && activeLease.expiresAt > Date.now()) return null;
          activeLease = {
            ...key,
            ownerToken: "throwing-renewal-owner",
            acquiredAt: Date.now(),
            expiresAt: Date.now() + durationMs,
            pid: process.pid,
            hostname: "test",
          };
          return activeLease;
        },
        renew(lease, durationMs) {
          renewals += 1;
          if (renewals > 1) throw new Error("renewal database unavailable");
          activeLease = { ...lease, expiresAt: Date.now() + durationMs };
          return activeLease;
        },
        release() {
          throw new Error("release database unavailable");
        },
      };
      let dispatches = 0;
      let dispatchAborted = false;
      let dispatchStarted!: () => void;
      const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
      const runner = vi.fn(async (
        _executable: string,
        args: readonly string[],
        _environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => {
        if (args[0] === "--version") {
          return { exitCode: 0, stdout: "gh version 2.76.2 (2025-07-30)\n", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { exitCode: 0, stdout: `${pushAction.sourceCommit}\n`, stderr: "" };
        }
        if (args.includes("ls-remote")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("push")) {
          dispatches += 1;
          dispatchStarted();
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              dispatchAborted = true;
              reject(signal.reason);
            }, { once: true });
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      const first = new GitHubEffectBroker(
        renewalPolicy,
        journal,
        { resolve: vi.fn().mockResolvedValue("token") },
        leases,
        runner,
      ).push({
        grantId: "push-grant",
        ...pushAction,
        sourceRepositoryPath: process.cwd(),
        signal: new AbortController().signal,
      });

      await started;
      await vi.advanceTimersByTimeAsync(10_000);
      const competing = await new GitHubEffectBroker(
        renewalPolicy,
        journal,
        { resolve: vi.fn().mockResolvedValue("token") },
        leases,
        runner,
      ).push({
        grantId: "competing-grant",
        ...competingAction,
        sourceRepositoryPath: process.cwd(),
        signal: new AbortController().signal,
      });

      await expect(first).resolves.toMatchObject({ outcome: "uncertain", dispatchAcknowledged: false });
      expect(competing).toMatchObject({ outcome: "denied", dispatchAcknowledged: false });
      expect(dispatchAborted).toBe(true);
      expect(dispatches).toBe(1);
      expect(journal.readStream("github-grant:competing-grant")).toEqual([]);
      expect(journal.readStream("github-grant:push-grant").at(-1)).toMatchObject({
        type: "capsule.github_broker_observed",
        payload: expect.objectContaining({ outcome: "uncertain" }),
      });
      journal.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects contradictory observed streams before any reconciliation read", async () => {
    const journal = new SqliteEventJournal(":memory:");
    const policyDigest = createHash("sha256").update(JSON.stringify(policy), "utf8").digest("hex");
    const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
    journal.append("github-grant:push-grant", 0, [
      { streamId: "github-grant:push-grant", type: "capsule.github_grant_consumed", payload: { grantId: "push-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", requestId: "push-grant", policyDigest, actionDigest }, causationId: null, correlationId: "push-grant" },
      { streamId: "github-grant:push-grant", type: "capsule.github_broker_accepted", payload: { requestId: "push-grant", grantId: "push-grant", policyDigest, actionDigest, ...pushAction }, causationId: null, correlationId: "push-grant" },
      { streamId: "github-grant:push-grant", type: "capsule.github_broker_observed", payload: { requestId: "push-grant", grantId: "push-grant", actionDigest: "f".repeat(64), operation: "push", repository: pushAction.repository, target: pushAction.targetRef, outcome: "uncertain" }, causationId: null, correlationId: "push-grant" },
    ]);
    const resolve = vi.fn();
    const broker = new GitHubEffectBroker(policy, journal, { resolve }, repositoryLeases());
    await expect(broker.reconcilePush({ grantId: "push-grant", signal: new AbortController().signal })).rejects.toThrow("contradicts");
    expect(resolve).not.toHaveBeenCalled();
    journal.close();
  });

  it("keeps later ref movement, absent PRs, and searches beyond two candidates inconclusive", () => {
    expect(classifyPushReconciliation(pushAction.sourceCommit, "3".repeat(40))).toBe("uncertain");
    expect(classifyPushReconciliation(pushAction.sourceCommit, null)).toBe("uncertain");
    expect(selectUniquePullRequestNumber(0, [])).toBeNull();
    expect(selectUniquePullRequestNumber(3, [{ number: 1 }, { number: 2 }])).toBeNull();
    expect(selectUniquePullRequestNumber(1, [{ number: 7 }])).toBe(7);
  });

  it("keeps the production push path isolated from caller Git config and hooks", () => {
    const source = readFileSync(new URL("../../src/capsule/github-broker.ts", import.meta.url), "utf8");
    for (const required of [
      "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "core.hooksPath", "credential.helper",
      "core.fsmonitor", "diff.external", "GIT_NO_REPLACE_OBJECTS", "init", "--bare",
      "--force-with-lease", "merge-base", "--is-ancestor",
    ]) expect(source).toContain(required);
    expect(source).not.toContain('"-C", sourceRepositoryPath');
  });

  it("pins canonical production executable identities, versions, and digests", () => {
    const gitDigest = createHash("sha256").update(readFileSync("/usr/bin/git")).digest("hex");
    const ghDigest = createHash("sha256").update(readFileSync("/opt/homebrew/Cellar/gh/2.76.2/bin/gh")).digest("hex");
    expect(gitDigest).toBe("97be7fb98d7272d97ca3034740883a93c12c5a438b313fd618a80aca102a3dda");
    expect(ghDigest).toBe("2ee6cbdeee81adabbdd0d379610054d9e55d047067ff70401ad2fa5b5b3f9e0d");
    const source = readFileSync(new URL("../../src/capsule/github-broker.ts", import.meta.url), "utf8");
    expect(source).toContain('/opt/homebrew/Cellar/gh/2.76.2/bin/gh');
    expect(source).toContain('GH_VERSION = "2.76.2"');
    expect(source).not.toContain("GH_ENTRYPOINT");
  });
});
