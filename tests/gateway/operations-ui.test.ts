import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  BrowserPendingSubmissionCommands,
  OPERATIONS_SCRIPT,
  isProvenPreEffectBrowserSubmissionError,
} from "../../src/gateway/operations-ui.js";

describe("operations UI submission dispatch", () => {
  it("creates one command identity per form submission and suppresses duplicate dispatch while pending", () => {
    expect(OPERATIONS_SCRIPT).toContain('if(form.dataset.submitting==="true")return');
    expect(OPERATIONS_SCRIPT).toContain('form.dataset.submitting="true"');
    expect(OPERATIONS_SCRIPT).toContain('control.disabled=true');
    expect(OPERATIONS_SCRIPT).toContain("pendingSubmissions.reserve(submission,UI_ACTOR)");
    expect(OPERATIONS_SCRIPT).toContain("commandId:command.commandId");
    expect(OPERATIONS_SCRIPT).toContain('delete form.dataset.submitting');
  });

  it("keys pending identities by canonical submission and actor while bounding unresolved entries", () => {
    let next = 0;
    const pending = new BrowserPendingSubmissionCommands(() => `command-${++next}`);
    const actor = { actorId: "zentra-local-operator", channel: "ui" };
    const original = pending.reserve({ kind: "inline_goal", goal: "Original" }, actor);

    expect(pending.reserve({ goal: "Original", kind: "inline_goal" }, actor)).toEqual(original);
    expect(pending.reserve({ kind: "inline_goal", goal: "Edited" }, actor).commandId).not.toBe(original.commandId);
    expect(pending.reserve({ kind: "inline_goal", goal: "Original" }, { ...actor, actorId: "other" }).commandId)
      .not.toBe(original.commandId);
    expect(pending.size).toBe(3);
    for (let index = 0; index < 29; index++) pending.reserve({ kind: "inline_goal", goal: `Bounded ${index}` }, actor);
    expect(() => pending.reserve({ kind: "inline_goal", goal: "One too many" }, actor)).toThrow("pending_submission_limit");
    expect(() => new BrowserPendingSubmissionCommands(() => "unused").reserve(
      { kind: "inline_goal", goal: "x".repeat(25 * 1024) }, actor,
    )).toThrow("pending_submission_key_too_large");
  });

  it("classifies only typed pre-effect validation and digest failures as safe to clear", () => {
    expect(isProvenPreEffectBrowserSubmissionError("invalid_transition")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("digest_mismatch")).toBe(true);
    expect(isProvenPreEffectBrowserSubmissionError("internal")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("unavailable")).toBe(false);
    expect(isProvenPreEffectBrowserSubmissionError("uncertain")).toBe(false);
  });

  it.each([
    { name: "internal response", status: 500, error: "internal" },
    { name: "unavailable response", status: 503, error: "unavailable" },
    { name: "lost response", status: 0, error: "uncertain" },
  ])("reuses the browser command after a daemon $name and creates one run", async ({ status, error }) => {
    const requests: Array<Record<string, unknown>> = [];
    const runs = new Map<string, string>();
    let created = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const commandId = String(body["commandId"]);
        let runId = runs.get(commandId);
        if (runId === undefined) { runId = `run-${++created}`; runs.set(commandId, runId); }
        if (requests.length === 1 && status === 0) { response.destroy(); return; }
        response.statusCode = requests.length === 1 ? status : 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(requests.length === 1 ? { error } : { runId }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    const pending = new BrowserPendingSubmissionCommands(() => crypto.randomUUID());
    const submission = { kind: "inline_goal", goal: "One browser run." };
    const actor = { actorId: "zentra-local-operator", channel: "ui" };
    const submit = async (): Promise<unknown> => {
      const command = pending.reserve(submission, actor);
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/runs`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...submission, commandId: command.commandId }),
        });
        const body = await response.json() as Record<string, unknown>;
        if (!response.ok) {
          if (isProvenPreEffectBrowserSubmissionError(body["error"])) pending.acknowledge(command);
          throw Object.assign(new Error(String(body["error"])), { code: body["error"] });
        }
        pending.acknowledge(command);
        return body;
      } catch (failure) {
        throw failure;
      }
    };

    await expect(submit()).rejects.toThrow();
    expect(pending.size).toBe(1);
    await expect(submit()).resolves.toEqual({ runId: "run-1" });
    expect(requests[1]?.["commandId"]).toBe(requests[0]?.["commandId"]);
    expect(created).toBe(1);
    expect(pending.size).toBe(0);
    await new Promise<void>((resolve, reject) => server.close((closeError) => closeError === undefined ? resolve() : reject(closeError)));
  });

  it("loads source text only from an explicit accessible action and bounds DOM insertion", () => {
    expect(OPERATIONS_SCRIPT).toContain('button.addEventListener("click",()=>loadSourceText');
    expect(OPERATIONS_SCRIPT).toContain('setText(button,"Expand source text")');
    expect(OPERATIONS_SCRIPT).toContain("MAX_SOURCE_DISPLAY_CHARS=65536");
    expect(OPERATIONS_SCRIPT).toContain("Text display truncated");
    expect(OPERATIONS_SCRIPT).not.toMatch(/innerHTML|outerHTML/);
  });

  it("batches durable catch-up before refresh and preserves interactive state", () => {
    expect(() => new Function(OPERATIONS_SCRIPT)).not.toThrow();
    expect(OPERATIONS_SCRIPT).toContain("do{page=await readChangePage();changed=changed||page.changed}while(page.hasMore)");
    expect(OPERATIONS_SCRIPT).toContain("if(changed)await refresh()");
    expect(OPERATIONS_SCRIPT).toContain("await refresh();await synchronize();status");
    expect(OPERATIONS_SCRIPT.indexOf('await synchronize();status("Secure local session established."'))
      .toBeLessThan(OPERATIONS_SCRIPT.indexOf('document.documentElement.dataset.ready="true"'));
    expect(OPERATIONS_SCRIPT).toContain("captureInteraction");
    expect(OPERATIONS_SCRIPT).toContain("restoreInteraction(interaction)");
    expect(OPERATIONS_SCRIPT).toContain("state.sourceTexts[key]={loading:true}");
    expect(OPERATIONS_SCRIPT).toContain("state.sourceTexts[key]=cached");
  });
});
