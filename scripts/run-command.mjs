import { spawnSync } from "node:child_process";
import path from "node:path";

export function runCommand(executable, args, {
  cwd,
  environment,
  maxBuffer,
  timeoutMs,
}) {
  if (!path.isAbsolute(executable)) {
    throw new Error(`subprocess executable path must be absolute: ${executable}`);
  }
  const command = formatCommand(executable, args);
  const result = spawnSync(executable, args, {
    cwd,
    shell: false,
    env: environment,
    encoding: "utf8",
    killSignal: "SIGTERM",
    maxBuffer,
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    if ("code" in result.error && result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} timed out after ${timeoutMs}ms`);
    }
    if ("code" in result.error && result.error.code === "ENOBUFS") {
      throw new Error(`${command} exceeded the ${maxBuffer}-byte output limit`);
    }
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const termination = result.signal !== null
      ? `signal ${result.signal}`
      : Number.isInteger(result.status)
        ? `exit ${result.status}`
        : "unknown termination";
    const output = result.stderr || result.stdout;
    throw new Error(`${command} failed with ${termination}${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function formatCommand(executable, args) {
  return [executable, ...args].map((argument) => JSON.stringify(argument)).join(" ");
}
