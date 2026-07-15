import {
  lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { runCli } from "../../src/cli/main.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { githubBrokerHeadRef } from "../../src/capsule/egress-policy.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHub broker CLI composition", () => {
  it("uses the canonical journal for leases and never touches the former sidecar path", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-github-cli-")));
    roots.push(root);
    const policyPath = path.join(root, "policy.json");
    const databasePath = path.join(root, "journal.sqlite");
    const tracePath = path.join(root, "trace.jsonl");
    const sidecarPath = `${databasePath}.github-leases.sqlite`;
    const sidecarTarget = path.join(root, "sidecar-target");
    writeFileSync(sidecarTarget, "must remain untouched\n");
    symlinkSync(sidecarTarget, sidecarPath);
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1,
      reads: { mode: "exact_domains", domains: ["example.com"], methods: ["GET"] },
      githubWrites: [
        { grantId: "push-cli-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "push", repository: "talibilat/zentra", targetRef: `refs/heads/${githubBrokerHeadRef("pr-cli-grant")}`, sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false }, credential: { type: "environment", name: "GITHUB_TOKEN" } },
        { grantId: "pr-cli-grant", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "create_pull_request", repository: "talibilat/zentra", pushGrantId: "push-cli-grant", headRef: githubBrokerHeadRef("pr-cli-grant"), headCommit: "1".repeat(40), base: "main", titleSha256: digest("Title"), bodySha256: digest("Body\n\nZentra-Request-ID: pr-cli-grant"), draft: false }, credential: { type: "environment", name: "GITHUB_TOKEN" } },
      ],
      brokers: { github: "host", model: "disabled" },
    }));
    let stdout = "";
    let stderr = "";
    const code = await runCli([
      "github", "create-pr", "--policy", policyPath, "--database", databasePath,
      "--agent-tail-jsonl", tracePath, "--grant-id", "pr-cli-grant", "--push-grant-id", "push-cli-grant", "--repository", "talibilat/zentra",
      "--base", "main", "--head-ref", githubBrokerHeadRef("pr-cli-grant"), "--head-commit", "1".repeat(40),
      "--title", "Title", "--body", "Body",
    ], { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } });
    expect(code).toBe(1);
    expect(`${stdout}${stderr}`).not.toMatch(/env:GITHUB_TOKEN|"title":"Title"|"body":"Body"|authorization/i);
    const journal = SqliteEventJournal.openReadOnly(databasePath);
    expect(journal.readStream("github-grant:pr-cli-grant").map((event) => event.type)).toEqual([
      "capsule.github_broker_denied",
    ]);
    journal.close();
    const database = new Database(realpathSync.native(databasePath), { readonly: true });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration_leases'",
    ).get()).toEqual({ name: "integration_leases" });
    database.close();
    expect(lstatSync(sidecarPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(sidecarPath)).toBe(sidecarTarget);
    expect(readFileSync(sidecarTarget, "utf8")).toBe("must remain untouched\n");
    expect(readFileSync(tracePath, "utf8")).not.toMatch(/env:GITHUB_TOKEN|"title":"Title"|"body":"Body"|authorization/i);
  });
});
