import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const OPEN_EXECUTABLE = "/usr/bin/open";

export async function openSessionInBrowser(sessionUrl: string): Promise<void> {
  const parsed = new URL(sessionUrl);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new Error("Browser session URL is not an IPv4 loopback URL");
  }
  if (realpathSync.native(OPEN_EXECUTABLE) !== OPEN_EXECUTABLE) {
    throw new Error("Browser opener executable is not canonical");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(OPEN_EXECUTABLE, [parsed.href], {
      shell: false,
      env: minimalBrowserEnvironment(),
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("Browser opener failed")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Browser opener failed"));
    });
  });
}

function minimalBrowserEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C" };
  for (const key of ["HOME", "TMPDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
