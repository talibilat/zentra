import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const HEADLESS_SHELL = "/Users/talibilat/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const GOOGLE_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface ChromiumAcceptanceResult {
  readonly accessibleNames: readonly string[];
  readonly focusOrder: readonly string[];
  readonly viewport: { readonly width: number; readonly documentWidth: number; readonly offenders: readonly string[] };
  readonly sourceText: string;
  readonly hostileExecuted: boolean;
}

export interface PreservedInteractionResult {
  readonly draft: string;
  readonly focusedId: string;
  readonly sourceText: string;
  readonly decisionVisible: boolean;
}

export const acceptanceBrowser = canonicalBrowser(HEADLESS_SHELL, "--headless") ??
  canonicalBrowser(GOOGLE_CHROME, "--headless=new");

export class ChromiumWorkflowDriver {
  private constructor(
    private readonly child: ChildProcess,
    private readonly cdp: Cdp,
  ) {}

  static async open(sessionUrl: string, workingRoot: string): Promise<ChromiumWorkflowDriver> {
    if (acceptanceBrowser === null) throw new Error("no canonical Chromium executable is available");
    const suffix = randomUUID();
    const profile = path.join(workingRoot, `chromium-profile-${suffix}`);
    const home = path.join(workingRoot, `chromium-home-${suffix}`);
    const temporary = path.join(workingRoot, `chromium-tmp-${suffix}`);
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(temporary, { mode: 0o700 });
    const child = spawn(acceptanceBrowser.executable, [
      acceptanceBrowser.headlessFlag,
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-proxy-server",
      "--no-sandbox",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], {
      detached: true,
      shell: false,
      env: { HOME: home, TMPDIR: temporary, LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-128 * 1024); });
    try {
      const port = await debuggingPort(child, () => stderr);
      const target = await pageTarget(port);
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Accessibility.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.send("Page.navigate", { url: sessionUrl });
      await waitFor(cdp, `document.documentElement.dataset.ready === "true"`);
      return new ChromiumWorkflowDriver(child, cdp);
    } catch (error) {
      await terminateGroup(child);
      throw error;
    }
  }

  async submitGoal(goal: string): Promise<string> {
    await this.setValue("#goal", goal);
    await this.click("#goal-form button[type=submit]");
    await this.waitForStatus("Goal submitted.");
    await waitFor(this.cdp, `document.querySelector("#run-detail .fact dd")?.textContent?.startsWith("run-") === true`);
    return await evaluate<string>(this.cdp, `document.querySelector("#run-detail .fact dd")?.textContent || ""`);
  }

  async selectRun(runId: string): Promise<void> {
    await evaluate(this.cdp, `(()=>{const id=${JSON.stringify(runId)};const button=[...document.querySelectorAll(".run-card")].find(item=>item.querySelector("span")?.textContent===id);if(!button)throw new Error("run control not found");button.click();return true})()`);
    await waitFor(this.cdp, `document.querySelector("#run-detail .fact dd")?.textContent === ${JSON.stringify(runId)}`);
  }

  async answerPendingQuestion(runId: string): Promise<void> {
    await this.selectRun(runId);
    await waitFor(this.cdp, `document.querySelector(".attention-card") !== null`);
    try {
      await waitFor(this.cdp, `(()=>{if(document.querySelector('form[data-action="answer"] select option:nth-child(2)'))return true;document.querySelector(".attention-card")?.click();return false})()`);
    } catch (error) {
      const rendered = await evaluate<string>(this.cdp, `document.querySelector("#decision")?.innerHTML || "missing decision"`);
      throw new Error(`${error instanceof Error ? error.message : "question form unavailable"}: ${rendered.slice(0, 1_000)}`);
    }
    await evaluate(this.cdp, `(()=>{const select=document.querySelector('form[data-action="answer"] select');select.value=select.options[1].value;return select.value})()`);
    await this.click(`form[data-action="answer"] button[type=submit]`);
    await this.waitForStatus("Decision recorded. Duplicate submission is disabled.");
  }

  async rejectPendingPlan(runId: string, reason: string): Promise<void> {
    await this.openPendingDecision(runId, "reject-plan");
    await this.setValue("#plan-reason", reason);
    await this.click(`form[data-action="reject-plan"] button[type=submit]`);
    await this.waitForStatus("Decision recorded. Duplicate submission is disabled.");
  }

  async approvePendingPlan(runId: string): Promise<void> {
    await this.openPendingDecision(runId, "approve-plan");
    const digests = await evaluate<{ plan: string; envelope: string }>(this.cdp, `({plan:document.querySelector("[data-plan-digest]")?.textContent||"",envelope:document.querySelector("[data-envelope-digest]")?.textContent||""})`);
    await this.setValue("#plan-digest", digests.plan);
    await this.setValue("#envelope-digest", digests.envelope);
    await this.click(`form[data-action="approve-plan"] button[type=submit]`);
    await this.waitForStatus("Decision recorded. Duplicate submission is disabled.");
  }

  async cancelRun(runId: string): Promise<void> {
    await this.selectRun(runId);
    await waitFor(this.cdp, `document.querySelector("#cancel-run")?.disabled === false`);
    await this.click("#cancel-run");
    await this.waitForStatus("Cancellation requested.");
    await waitFor(this.cdp, `document.querySelector("#cancel-run")?.disabled === true`);
  }

  async prepareInteractiveRefresh(runId: string, draft: string): Promise<void> {
    await this.selectRun(runId);
    await waitFor(this.cdp, `document.querySelector(".attention-card") !== null`);
    await evaluate(this.cdp, `(()=>{const loaded=[...document.querySelectorAll("button")].some(item=>item.textContent==="Source text loaded");if(!loaded)[...document.querySelectorAll("button")].find(item=>item.textContent==="Expand source text")?.click();return true})()`);
    await waitFor(this.cdp, `[...document.querySelectorAll("button")].some(item=>item.textContent === "Source text loaded")`);
    await evaluate(this.cdp, `document.querySelector(".attention-card")?.click()`);
    await waitFor(this.cdp, `document.querySelector("#decision form") !== null`);
    await this.setValue("#goal", draft);
    await evaluate(this.cdp, `(()=>{const field=document.querySelector("#goal");field.focus();field.setSelectionRange(3,7);return document.activeElement===field})()`);
  }

  async interactionAfterCursor(cursor: number): Promise<PreservedInteractionResult> {
    await waitFor(this.cdp, `Number(document.documentElement.dataset.eventCursor||0)>=${cursor}`);
    return evaluate<PreservedInteractionResult>(this.cdp, `({draft:document.querySelector("#goal")?.value||"",focusedId:document.activeElement?.id||"",sourceText:document.querySelector(".ticket-text")?.textContent||"",decisionVisible:document.querySelector("#decision form")!==null})`);
  }

  async inspectHostileSource(runId: string): Promise<ChromiumAcceptanceResult> {
    await this.selectRun(runId);
    const tree = await this.cdp.send("Accessibility.getFullAXTree") as {
      nodes: Array<{ ignored?: boolean; name?: { value?: string }; role?: { value?: string } }>;
    };
    const accessibleNames = tree.nodes
      .filter((node) => !node.ignored && typeof node.name?.value === "string" && node.name.value !== "")
      .map((node) => `${node.role?.value ?? "unknown"}:${node.name!.value}`);
    await evaluate(this.cdp, `document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
    const focusOrder: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      focusOrder.push(await evaluate<string>(this.cdp, `(()=>{const element=document.activeElement;if(!(element instanceof HTMLElement))return "";const labelled=element.getAttribute("aria-label");const label=element.id?document.querySelector('label[for="'+CSS.escape(element.id)+'"]')?.textContent:null;return [element.tagName.toLowerCase(),element.id||"",labelled||label||element.textContent||""].map(value=>String(value).trim()).join(":")})()`));
    }
    const viewport = await evaluate<ChromiumAcceptanceResult["viewport"]>(this.cdp, `(()=>{const width=innerWidth;const offenders=[];for(const element of document.body.querySelectorAll("*")){if(!(element instanceof HTMLElement)||element.offsetParent===null||element.classList.contains("skip"))continue;const rect=element.getBoundingClientRect();if(rect.right>width+1||rect.left<-1)offenders.push((element.id?"#"+element.id:element.tagName.toLowerCase()+"."+[...element.classList].join("."))+":"+Math.round(rect.left)+".."+Math.round(rect.right))}return {width,documentWidth:document.documentElement.scrollWidth,offenders:offenders.slice(0,20)}})()`);
    await this.clickByText("button", "Expand source text");
    await waitFor(this.cdp, `[...document.querySelectorAll("button")].some(item=>item.textContent === "Source text loaded")`);
    const sourceText = await evaluate<string>(this.cdp, `document.querySelector(".ticket-text")?.textContent || ""`);
    const hostileExecuted = await evaluate<boolean>(this.cdp, `document.documentElement.dataset.ticketAttack === "executed"`);
    return { accessibleNames, focusOrder, viewport, sourceText, hostileExecuted };
  }

  async close(): Promise<void> {
    this.cdp.close();
    await terminateGroup(this.child);
  }

  async click(selector: string): Promise<void> {
    await this.clickInternal(selector);
  }

  async waitFor(expression: string): Promise<void> {
    await waitFor(this.cdp, expression);
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await evaluate<T>(this.cdp, expression);
  }

  private async openPendingDecision(runId: string, action: string): Promise<void> {
    await this.selectRun(runId);
    await waitFor(this.cdp, `document.querySelector(".attention-card") !== null`);
    await waitFor(this.cdp, `(()=>{if(document.querySelector('form[data-action="${action}"]'))return true;document.querySelector(".attention-card")?.click();return false})()`);
  }

  private async clickInternal(selector: string): Promise<void> {
    await evaluate(this.cdp, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!(element instanceof HTMLElement))throw new Error("control not found");element.click();return true})()`);
  }

  private async clickByText(selector: string, text: string): Promise<void> {
    await evaluate(this.cdp, `(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(item=>item.textContent===${JSON.stringify(text)});if(!(element instanceof HTMLElement))throw new Error("text control not found");element.click();return true})()`);
  }

  private async setValue(selector: string, value: string): Promise<void> {
    await evaluate(this.cdp, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement))throw new Error("field not found");element.value=${JSON.stringify(value)};element.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  }

  private async waitForStatus(message: string): Promise<void> {
    await waitFor(this.cdp, `document.querySelector("#status")?.textContent === ${JSON.stringify(message)}`);
  }
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "CDP command failed"));
      else pending.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Chromium DevTools socket failed")), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.socket.close(); }
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as {
    result: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (response.exceptionDetails !== undefined) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "browser evaluation failed");
  }
  return response.result.value as T;
}

async function waitFor(cdp: Cdp, expression: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluate<boolean>(cdp, expression)) return; } catch { /* Navigation replaces execution contexts. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium condition timed out: ${expression}`);
}

async function debuggingPort(child: ChildProcess, stderr: () => string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:([0-9]+)\//.exec(stderr());
    if (match !== null) return Number(match[1]);
    if (child.exitCode !== null) throw new Error(`Chromium exited before DevTools became ready: ${stderr().slice(-512)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chromium DevTools startup timed out: ${stderr().slice(-512)}`);
}

async function pageTarget(port: number): Promise<{ readonly webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as
      Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const page = targets.find((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
    if (page?.webSocketDebuggerUrl !== undefined) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Chromium page target was unavailable");
}

function canonicalBrowser(candidate: string, headlessFlag: "--headless" | "--headless=new") {
  if (!existsSync(candidate)) return null;
  try {
    const metadata = statSync(candidate);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || realpathSync(candidate) !== candidate) return null;
    return { executable: candidate, headlessFlag } as const;
  } catch { return null; }
}

async function terminateGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch (error) {
      if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
