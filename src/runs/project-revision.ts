import { spawn } from "node:child_process";

import { ProjectRevisionSchema, type ProjectRevision } from "./run-contracts.js";

const GIT_EXECUTABLE = "/usr/bin/git";
const MAX_OUTPUT_BYTES = 4_096;
const TIMEOUT_MS = 10_000;

export async function resolveProjectRevision(projectRoot: string): Promise<ProjectRevision> {
  const [objectFormat, commit] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "--show-object-format"]),
    runGit(projectRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
  ]);
  return ProjectRevisionSchema.parse({ objectFormat: objectFormat.trim(), commit: commit.trim() });
}

export async function projectRevisionMatches(projectRoot: string, expected: ProjectRevision): Promise<boolean> {
  return JSON.stringify(await resolveProjectRevision(projectRoot)) === JSON.stringify(ProjectRevisionSchema.parse(expected));
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(GIT_EXECUTABLE, args, {
      cwd,
      shell: false,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    timer.unref();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("project revision command timed out"));
      if (bytes > MAX_OUTPUT_BYTES) return reject(new Error("project revision command output exceeded its limit"));
      if (code !== 0) return reject(new Error(`project revision command failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
