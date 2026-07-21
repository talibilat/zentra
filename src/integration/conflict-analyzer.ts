import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { assertNoGitObjectSubstitution, type GitClient } from "../workspaces/git-client.js";

const Commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const Request = z.strictObject({
  repositoryPath: z.string().min(1).max(4_096).refine(path.isAbsolute),
  baseCommit: Commit,
  integrationCommit: Commit,
  sourceCommit: Commit,
});
const GIT_TIMEOUT_MS = 30_000;

export interface ConflictAnalysis {
  readonly classification: "conflict_free" | "real_conflict";
  readonly baseCommit: string;
  readonly integrationCommit: string;
  readonly sourceCommit: string;
  readonly conflictPaths: readonly string[];
  readonly analysisSha256: string;
}

export class ReadOnlyGitConflictAnalyzer {
  constructor(private readonly git: GitClient) {}

  async analyze(input: z.input<typeof Request>): Promise<ConflictAnalysis> {
    const request = Request.parse(input);
    const repositoryPath = await realpath(request.repositoryPath);
    await assertNoGitObjectSubstitution(this.git, repositoryPath, GIT_TIMEOUT_MS);
    const externalPrograms = await this.git.run(repositoryPath, [
      "config", "--get-regexp",
      "^(merge\\..*\\.driver|diff\\.external|diff\\..*\\.(command|textconv)|filter\\..*\\.(clean|smudge|process))$",
    ], { timeoutMs: GIT_TIMEOUT_MS });
    if (externalPrograms.termination !== null || externalPrograms.truncated ||
      (externalPrograms.exitCode !== 1 && externalPrograms.exitCode !== 0)) {
      throw new Error("conflict analysis could not verify external Git configuration");
    }
    if (externalPrograms.exitCode === 0 && externalPrograms.stdout.trim() !== "") {
      throw new Error("configured external Git programs are not allowed during conflict analysis");
    }
    const result = await this.git.run(repositoryPath, [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "merge-tree", request.baseCommit, request.integrationCommit, request.sourceCommit,
    ], { timeoutMs: GIT_TIMEOUT_MS });
    if (result.termination !== null) throw new Error(`conflict analysis was ${result.termination}`);
    if (result.exitCode !== 0 || result.truncated) throw new Error("read-only conflict analysis failed");
    const mergeTreeEvidence = `${result.stdout}\n${result.stderr}`;
    const conflictPaths = parseConflictPaths(mergeTreeEvidence);
    const evidence = {
      baseCommit: request.baseCommit,
      integrationCommit: request.integrationCommit,
      sourceCommit: request.sourceCommit,
      conflictPaths,
      mergeTreeSha256: sha256(mergeTreeEvidence),
    };
    return Object.freeze({
      classification: conflictPaths.length === 0 ? "conflict_free" : "real_conflict",
      baseCommit: request.baseCommit,
      integrationCommit: request.integrationCommit,
      sourceCommit: request.sourceCommit,
      conflictPaths: Object.freeze(conflictPaths),
      analysisSha256: sha256(JSON.stringify(evidence)),
    });
  }
}

function parseConflictPaths(output: string): string[] {
  const paths = new Set<string>();
  let sectionPaths: string[] = [];
  let sectionConflicted = false;
  const flush = (): void => {
    if (sectionConflicted) for (const candidate of sectionPaths) paths.add(candidate);
    sectionPaths = [];
    sectionConflicted = false;
  };
  for (const line of output.split(/\r?\n/)) {
    const binary = /^warning: Cannot merge binary files: (.+?)(?: \(.+\))?$/.exec(line);
    if (binary !== null) paths.add(binary[1]!);
    if (/^(changed in both|added in both|removed in both)$/.test(line)) {
      flush();
      continue;
    }
    const metadata = /^\s+(?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/.exec(line);
    if (metadata !== null) sectionPaths.push(metadata[1]!);
    if (/^[+ ]<<<<<<< |^[+ ]=======|^[+ ]>>>>>>> /.test(line)) sectionConflicted = true;
  }
  flush();
  return [...paths].sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
