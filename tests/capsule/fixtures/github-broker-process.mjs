import { appendFileSync, realpathSync } from "node:fs";

import { CapsulePolicySchema } from "../../../dist/src/capsule/egress-policy.js";
import { GitHubEffectBroker } from "../../../dist/src/capsule/github-broker.js";
import { IntegrationLeaseStore } from "../../../dist/src/integration/integration-lease.js";
import { SqliteEventJournal } from "../../../dist/src/journal/sqlite-journal.js";

const [journalPath, repository, resultsPath, startAtRaw, holdMsRaw] = process.argv.slice(2);
if ([journalPath, repository, resultsPath, startAtRaw, holdMsRaw].some((value) => value === undefined)) {
  process.exit(2);
}

const startAt = Number(startAtRaw);
const holdMs = Number(holdMsRaw);
const grantId = `process-grant-${process.pid}`;
const action = {
  operation: "push",
  repository,
  targetRef: "refs/heads/zentra/github-process-test",
  sourceCommit: "1".repeat(40),
  expectedOldOid: "0".repeat(40),
  force: false,
};
const policy = CapsulePolicySchema.parse({
  schemaVersion: 1,
  reads: { mode: "exact_domains", domains: ["example.com"], methods: ["GET"] },
  githubWrites: [{
    grantId,
    audience: "zentra.github-broker",
    expiresAt: "2099-01-01T00:00:00.000Z",
    action,
    credential: { type: "environment", name: "GITHUB_TOKEN" },
  }],
  brokers: { github: "host", model: "disabled" },
});

while (Date.now() < startAt) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const journal = new SqliteEventJournal(journalPath);
const leases = new IntegrationLeaseStore(realpathSync.native(journalPath));
try {
  const broker = new GitHubEffectBroker(policy, journal, {
    async resolve() {
      appendFileSync(resultsPath, `${JSON.stringify({ pid: process.pid, repository, event: "begin", at: Date.now() })}\n`);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      appendFileSync(resultsPath, `${JSON.stringify({ pid: process.pid, repository, event: "end", at: Date.now() })}\n`);
      throw new Error("intentional pre-dispatch stop");
    },
  }, leases);
  const receipt = await broker.push({
    grantId,
    ...action,
    sourceRepositoryPath: process.cwd(),
    signal: new AbortController().signal,
  });
  appendFileSync(resultsPath, `${JSON.stringify({ pid: process.pid, repository, event: "receipt", outcome: receipt.outcome, at: Date.now() })}\n`);
} finally {
  leases.close();
  journal.close();
}
