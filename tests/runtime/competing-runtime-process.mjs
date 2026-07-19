import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [workerPath, repositoryPath, action] = process.argv.slice(2);
if (workerPath === undefined || repositoryPath === undefined || action === undefined) {
  throw new Error("expected worker path, repository path, and action");
}

const runtimeDirectory = path.join(repositoryPath, ".zentra", "runtime");
const runtimeIdentity = statSync(runtimeDirectory);
const durable = JSON.parse(readFileSync(path.join(runtimeDirectory, "state.json"), "utf8"));
const claim = {
  pid: durable.pid,
  processIncarnation: durable.processIncarnation,
};
const direct = action === "direct-publish";
const request = action === "publish" || direct
  ? {
    operation: "publish",
    payload: {
      callerPid: direct ? durable.pid : process.pid,
      claim,
      input: {
        pid: durable.pid,
      address: { host: "127.0.0.1", port: 43_220 },
      tokenExpiresAt: "2026-07-19T13:00:00.000Z",
      startupStatus: "ready",
      },
    },
  }
  : action === "remove"
    ? { operation: "remove", payload: { callerPid: process.pid, claim } }
    : (() => { throw new Error(`unsupported action: ${action}`); })();

const result = spawnSync(
  process.execPath,
  [
    workerPath,
    ...(direct ? ["--operate"] : []),
    String(runtimeIdentity.dev),
    String(runtimeIdentity.ino),
  ],
  {
    cwd: runtimeDirectory,
    shell: false,
    env: { HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", LANG: "C", LC_ALL: "C" },
    input: JSON.stringify(request),
    encoding: "utf8",
  },
);
if (result.error !== undefined) throw result.error;
if (result.status !== 0) throw new Error(result.stderr);
const response = JSON.parse(result.stdout);
process.stdout.write(JSON.stringify({
  accepted: response.ok === true,
  error: response.ok === false ? response.error : undefined,
}));
