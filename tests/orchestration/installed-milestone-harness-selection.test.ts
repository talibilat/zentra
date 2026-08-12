import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { OpenCodeReadOnlyCapsule } from "../../src/agents/opencode-read-only-agent.js";
import { DisabledModelBroker } from "../../src/capsule/model-broker.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { AgentTailJsonlFileSink } from "../../src/observability/agent-tail-file-sink.js";
import { ProjectConfigSchema } from "../../src/projects/project-config.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { HarnessWriterRegistry, UnregisteredHarnessWriterError } from "../../src/harnesses/harness-writer-registry.js";
import type { HarnessWriter } from "../../src/harnesses/harness-writer.js";
import {
  INSTALLED_MILESTONE_RESEARCH_URL,
  InstalledMilestoneRunner,
} from "../../src/orchestration/installed-milestone.js";

const roots: string[] = [];
const git = new GitClient();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeWriter(): HarnessWriter {
  return {
    prepare: async () => ({ binding: {} as never }),
    execute: async () => ({} as never),
  };
}

describe("InstalledMilestoneRunner harness resolution", () => {
  it("only opencode is registered by default, matching today's behavior", () => {
    const registry = new HarnessWriterRegistry({ opencode: fakeWriter() });
    expect(() => registry.get("opencode")).not.toThrow();
    expect(() => registry.get("claude_code")).toThrow(UnregisteredHarnessWriterError);
    expect(() => registry.get("codex")).toThrow(UnregisteredHarnessWriterError);
  });

  it("fails run() loudly with UnregisteredHarnessWriterError instead of swallowing it into a generic incomplete milestone", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-installed-milestone-harness-")));
    roots.push(root);
    const repository = path.join(root, "repository");
    await gitOk(root, ["init", "-b", "main", repository]);
    await gitOk(repository, ["config", "user.name", "Zentra Test"]);
    await gitOk(repository, ["config", "user.email", "test@zentra.local"]);
    mkdirSync(path.join(repository, "src"));
    writeFileSync(path.join(repository, "src/greeting.mjs"), "export const greeting = 'hello';\n");
    await gitOk(repository, ["add", "--", "."]);
    await gitOk(repository, ["commit", "-m", "initial"]);

    const fakeHarness = path.join(root, "codex");
    writeFileSync(fakeHarness, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") { process.stdout.write("fixture-codex 1\\n"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
    const executable = realpathSync.native(fakeHarness);
    const hostAttestation = {
      harnessExpectedSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      harnessExpectedVersion: "fixture-codex 1",
    };
    const harnessHome = path.join(root, "codex-home");
    mkdirSync(harnessHome);

    const database = path.join(root, "journal.sqlite");
    const trace = path.join(root, "trace.jsonl");
    const sqlite = new SqliteEventJournal(database);
    const sink = AgentTailJsonlFileSink.open(root, trace, "installed-codex-unregistered");

    const broker = new DisabledModelBroker();
    const capsule: OpenCodeReadOnlyCapsule = {
      execute: async () => {
        throw new Error("capsule.execute must not run before writer resolution");
      },
    };

    const models = { models: [
      model("planner", "planner", ["read_repository"]),
      model("researcher", "researcher", ["read_repository", "web_research"], "declared"),
      model("implementer", "implementer", ["read_repository", "write_worktree"]),
      model("reviewer", "reviewer", ["read_repository", "review_diff"]),
    ] };
    const security = {
      allowedRepositories: [repository], allowedFileScopes: ["src/**"], forbiddenPaths: [".env", ".git/**"],
      network: { default: "denied" as const, allowedDestinations: [new URL(INSTALLED_MILESTONE_RESEARCH_URL).origin] }, secretHandling: ["No parent secrets."],
      approvalRequiredOperations: ["external_effect"], releaseBoundary: "local_preparation_only",
      stopAndAskConditions: ["missing_authority"],
    };
    const project = ProjectConfigSchema.parse({
      projectId: "project", repositoryPath: repository, worktreeRoot: path.join(root, "worktrees"),
      validations: { focused: [process.execPath, "--version"], full: [process.execPath, "--version"] },
    });

    const runner = new InstalledMilestoneRunner({ journal: sqlite, sink, broker, readOnlyCapsule: capsule });
    try {
      const error = await runner.run({
        milestoneId: "installed-codex-unregistered", goal: "Update the exact greeting", file: "src/greeting.mjs",
        tracePath: trace, project, models, security, azureDeployment: "zentra-deployment",
        harness: "codex", harnessExecutable: executable, harnessHome, ...hostAttestation,
        signal: AbortSignal.timeout(20_000),
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(UnregisteredHarnessWriterError);
      expect((error as Error).message).toMatch(/no writer is registered for harness "codex"/);
    } finally {
      sink.close();
      sqlite.close();
    }
  }, 30_000);
});

function model(
  id: string,
  role: "planner" | "researcher" | "implementer" | "reviewer",
  tools: string[],
  network: "denied" | "declared" = "denied",
): ModelCapability {
  return {
    id, harness: "opencode", model: role === "implementer" ? `fixture/${id}` : "zentra-deployment", roles: [role], specialties: [], costTier: "low",
    contextTokens: 128_000, maxConcurrency: 1, toolPermissions: tools, network,
    fallbackOrder: [], qualityHistory: { successes: 1, attempts: 1 },
  };
}

async function gitOk(cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}
