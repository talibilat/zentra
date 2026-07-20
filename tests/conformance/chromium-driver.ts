import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CANDIDATES = [
  "/Users/talibilat/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

export const chromiumExecutable = CANDIDATES.find((candidate) => {
  try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
}) ?? null;

export class ChromiumDriver {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(
    private readonly child: ChildProcess,
    private readonly socket: WebSocket,
    readonly stderr: () => string,
  ) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async launch(url: string, profile: string, home: string, temporary: string): Promise<ChromiumDriver> {
    if (chromiumExecutable === null) throw new Error("canonical Chromium executable is unavailable");
    let stderr = "";
    const child = spawn(chromiumExecutable, [
      "--headless", "--disable-background-networking", "--disable-breakpad",
      "--disable-component-update", "--disable-default-apps", "--disable-extensions",
      "--disable-gpu", "--disable-sync", "--metrics-recording-only", "--no-proxy-server",
      "--no-default-browser-check", "--no-first-run", "--no-sandbox", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank",
    ], {
      detached: true,
      shell: false,
      env: { HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
    const portFile = path.join(profile, "DevToolsActivePort");
    await waitFor(() => existsSync(portFile), 15_000, () => `Chromium debugging port unavailable: ${stderr}`);
    const port = Number(readFileSync(portFile, "utf8").split("\n", 1)[0]);
    let target: { webSocketDebuggerUrl?: string; type?: string; url?: string } | undefined;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
      if (response === null || !response.ok) return false;
      const targets = await response.json() as { webSocketDebuggerUrl?: string; type?: string; url?: string }[];
      target = targets.find((candidate) => candidate.type === "page");
      return target?.webSocketDebuggerUrl !== undefined;
    }, 15_000, () => `Chromium page target unavailable: ${stderr}`);
    const socket = new WebSocket(target!.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium debugger connection timed out")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chromium debugger connection failed")); }, { once: true });
    });
    const driver = new ChromiumDriver(child, socket, () => stderr);
    await driver.command("Page.navigate", { url });
    return driver;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as { result?: { value?: T; description?: string }; exceptionDetails?: unknown };
    if (result.exceptionDetails !== undefined) throw new Error(result.result?.description ?? "browser evaluation failed");
    return result.result?.value as T;
  }

  async wait(expression: string, timeoutMs = 20_000): Promise<void> {
    await waitFor(async () => {
      try { return await this.evaluate<boolean>(expression); }
      catch { return false; }
    }, timeoutMs, () => `Browser condition timed out: ${expression}`);
  }

  async close(): Promise<void> {
    this.socket.close();
    if (this.child.pid === undefined) return;
    try { process.kill(-this.child.pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await waitFor(() => this.child.exitCode !== null, 2_000, () => "Chromium did not exit").catch(() => {
      try { process.kill(-this.child.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }

  private command(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium debugger command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message());
}
