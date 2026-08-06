import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { listGitHubBrokerActivity } from "../../src/capsule/github-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";

const pushAction = {
  operation: "push" as const, repository: "talibilat/zentra", targetRef: "refs/heads/zentra/pr-grant",
  sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false as const,
};
const prAction = {
  operation: "create_pull_request" as const, repository: "talibilat/zentra", pushGrantId: "push-grant", headRef: "zentra/pr-grant",
  headCommit: "1".repeat(40), base: "main",
  titleSha256: createHash("sha256").update("Title").digest("hex"),
  bodySha256: createHash("sha256").update("Body").digest("hex"), draft: false,
};

function appendDenied(journal: SqliteEventJournal, grantId: string): void {
  const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 0, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_denied",
    payload: { requestId: grantId, grantId, policyDigest: "a".repeat(64), actionDigest, ...pushAction },
    causationId: null, correlationId: grantId,
  }]);
}

function appendAccepted(journal: SqliteEventJournal, grantId: string, action: typeof pushAction | typeof prAction): void {
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  const common = { requestId: grantId, grantId, actionDigest };
  journal.append(`github-grant:${grantId}`, 0, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_grant_consumed",
    payload: { ...common, audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", policyDigest: "a".repeat(64) },
    causationId: null, correlationId: grantId,
  }, {
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_accepted",
    payload: { ...common, policyDigest: "a".repeat(64), ...action }, causationId: null, correlationId: grantId,
  }]);
}

function appendObservedUncertain(journal: SqliteEventJournal, grantId: string, action: typeof pushAction): void {
  appendAccepted(journal, grantId, action);
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 2, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_observed",
    payload: { requestId: grantId, grantId, actionDigest, operation: "push", repository: action.repository, target: action.targetRef, outcome: "uncertain" },
    causationId: null, correlationId: grantId,
  }]);
}

function appendReconciledCompleted(journal: SqliteEventJournal, grantId: string, action: typeof pushAction): void {
  appendObservedUncertain(journal, grantId, action);
  const actionDigest = createHash("sha256").update(JSON.stringify(action), "utf8").digest("hex");
  journal.append(`github-grant:${grantId}`, 3, [{
    streamId: `github-grant:${grantId}`, type: "capsule.github_broker_reconciled",
    payload: { requestId: grantId, grantId, actionDigest, ...action, attempt: 1, outcome: "completed", observedRemoteOid: action.sourceCommit },
    causationId: null, correlationId: grantId,
  }]);
}

describe("listGitHubBrokerActivity", () => {
  it("returns an empty list when no broker activity exists", () => {
    const journal = new SqliteEventJournal(":memory:");
    expect(listGitHubBrokerActivity(journal)).toEqual([]);
  });

  it("lists a denied grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendDenied(journal, "denied-grant");
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([{
      grantId: "denied-grant", requestId: "denied-grant", operation: "push", repository: "talibilat/zentra",
      status: "denied", detail: expect.objectContaining({ targetRef: pushAction.targetRef }),
    }]);
  });

  it("lists an accepted-but-not-yet-observed grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "accepted-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "accepted-grant", status: "accepted" })]);
  });

  it("lists an observed-uncertain grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendObservedUncertain(journal, "observed-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "observed-grant", status: "observed_uncertain" })]);
  });

  it("lists a fully reconciled completed push", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendReconciledCompleted(journal, "push-grant", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({
      grantId: "push-grant", operation: "push", repository: "talibilat/zentra", status: "completed",
      detail: expect.objectContaining({ observedRemoteOid: pushAction.sourceCommit }),
    })]);
  });

  it("lists a fully reconciled completed pull request", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "pr-grant", prAction);
    const actionDigest = createHash("sha256").update(JSON.stringify(prAction), "utf8").digest("hex");
    journal.append("github-grant:pr-grant", 2, [{
      streamId: "github-grant:pr-grant", type: "capsule.github_broker_reconciled",
      payload: { requestId: "pr-grant", grantId: "pr-grant", actionDigest, ...prAction, attempt: 1, outcome: "completed", observedNumber: 42 },
      causationId: null, correlationId: "pr-grant",
    }]);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({
      grantId: "pr-grant", operation: "create_pull_request", repository: "talibilat/zentra", status: "completed",
      detail: expect.objectContaining({ observedNumber: 42 }),
    })]);
  });

  it("lists a reconciled-failed grant", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendAccepted(journal, "failed-grant", pushAction);
    const actionDigest = createHash("sha256").update(JSON.stringify(pushAction), "utf8").digest("hex");
    journal.append("github-grant:failed-grant", 2, [{
      streamId: "github-grant:failed-grant", type: "capsule.github_broker_reconciled",
      payload: { requestId: "failed-grant", grantId: "failed-grant", actionDigest, ...pushAction, attempt: 1, outcome: "failed", observedRemoteOid: null },
      causationId: null, correlationId: "failed-grant",
    }]);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity).toEqual([expect.objectContaining({ grantId: "failed-grant", status: "failed" })]);
  });

  it("lists multiple independent grant streams together", () => {
    const journal = new SqliteEventJournal(":memory:");
    appendDenied(journal, "grant-a");
    appendAccepted(journal, "grant-b", pushAction);
    const activity = listGitHubBrokerActivity(journal);
    expect(activity.map((entry) => entry.grantId)).toEqual(["grant-a", "grant-b"]);
  });
});
