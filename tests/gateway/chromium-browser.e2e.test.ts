import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";

const HEADLESS_SHELL = "/Users/talibilat/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const GOOGLE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = canonicalBrowser(HEADLESS_SHELL, "--headless") ?? canonicalBrowser(GOOGLE_CHROME, "--headless=new");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Chromium browser navigation semantics", () => {
  it.skipIf(browser === null)("executes CSP-authorized cleanup and exposes only the clean current URL", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-chromium-e2e-")));
    temporaryDirectories.push(root);
    const profile = path.join(root, "profile");
    const home = path.join(root, "home");
    const temporary = path.join(root, "tmp");
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    const gateway = new LoopbackGateway();
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const page = await runChromium(session.url, profile, home, temporary);
      expect(page.href).toBe(`${session.origin}/`);
      expect(page.dom).toContain(`data-location="${session.origin}/"`);
      expect(page.dom).not.toContain(new URL(session.url).searchParams.get("token")!);
      expect((await fetch(session.url)).status).toBe(401);
      expect((await fetch(session.origin)).status).toBe(401);
    } finally {
      await gateway.close();
    }
  }, 60_000);
});

async function runChromium(
  url: string,
  profile: string,
  home: string,
  temporary: string,
): Promise<{ readonly href: string; readonly dom: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(browser!.executable, [
      browser!.headlessFlag, "--disable-background-networking", "--disable-breakpad",
      "--disable-component-update", "--disable-default-apps", "--disable-extensions",
      "--disable-gpu", "--disable-sync", "--metrics-recording-only", "--no-proxy-server",
      "--no-default-browser-check", "--no-first-run", "--no-sandbox", `--user-data-dir=${profile}`,
      "--dump-dom", url,
    ], {
      detached: true,
      shell: false,
      env: { HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const complete = async (error: Error | null): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateGroup(child.pid);
      if (error !== null) {
        reject(error);
        return;
      }
      const href = /data-location="([^"]+)"/.exec(stdout)?.[1];
      if (href === undefined) {
        reject(new Error("Chromium dump DOM omitted the clean location marker"));
        return;
      }
      resolve({ href, dom: stdout });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
        void complete(new Error("Chromium browser E2E output exceeded its limit"));
      } else if (stdout.includes("data-location=") && stdout.includes("</html>")) {
        void complete(null);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.once("error", () => { void complete(new Error("Chromium browser E2E failed to start")); });
    child.once("exit", (code) => {
      if (!settled && code !== 0) void complete(new Error(`Chromium browser E2E exited ${code}: ${stderr.slice(0, 512)}`));
    });
    const timer = setTimeout(() => {
      void complete(new Error(`Chromium browser E2E exceeded its deadline: ${stderr.slice(0, 512)}`));
    }, 30_000);
  });
}

function canonicalBrowser(candidate: string, headlessFlag: "--headless" | "--headless=new") {
  if (!existsSync(candidate)) return null;
  try {
    const metadata = statSync(candidate);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || realpathSync(candidate) !== candidate) return null;
    return { executable: candidate, headlessFlag } as const;
  } catch {
    return null;
  }
}

async function terminateGroup(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
