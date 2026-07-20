import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLI_PENDING_SUBMISSION_PREFIX,
  CliSubmissionCommandStore,
  HttpWorkflowClient,
} from "../../src/surfaces/http-workflow-client.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("HttpWorkflowClient submission reconciliation", () => {
  it.each([
    { name: "internal response", status: 500, error: "internal" },
    { name: "unavailable response", status: 503, error: "unavailable" },
    { name: "lost response", status: 0, error: "uncertain" },
  ])("retains and reuses the exact command after a daemon $name", async ({ status, error }) => {
    const runtime = temporaryRuntime();
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
        if (runId === undefined) {
          runId = `run-${++created}`;
          runs.set(commandId, runId);
        }
        if (requests.length === 1 && status === 0) { response.destroy(); return; }
        response.statusCode = requests.length === 1 ? status : 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(requests.length === 1 ? { error } : { runId }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    const client = testClient(address.port, runtime, 1_000);
    const caller = { actorId: "operator-1", channel: "cli" as const };

    await expect(client.submitRun({ kind: "inline_goal", commandId: "first-candidate", goal: "One daemon run." }, caller))
      .rejects.toMatchObject({ code: error });
    expect(pendingFiles(runtime)).toHaveLength(1);
    await expect(client.submitRun({ kind: "inline_goal", commandId: "replacement-candidate", goal: "One daemon run." }, caller))
      .resolves.toEqual({ runId: "run-1" });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.["commandId"]).toBe(requests[0]?.["commandId"]);
    expect(created).toBe(1);
    expect(pendingFiles(runtime)).toEqual([]);
    await closeServer(server);
  });

  it.each(["invalid_transition", "digest_mismatch"] as const)(
    "clears a pending command after proven pre-effect %s rejection",
    async (error) => {
      const runtime = temporaryRuntime();
      const server = createServer((_request, response) => {
        response.statusCode = 409;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server address missing");
      const client = testClient(address.port, runtime, 1_000);

      await expect(client.submitRun(
        { kind: "inline_goal", commandId: "pre-effect-command", goal: "Rejected before effects." },
        { actorId: "operator-1", channel: "cli" },
      )).rejects.toMatchObject({ code: error });
      expect(pendingFiles(runtime)).toEqual([]);
      await closeServer(server);
    },
  );

  it("retains a private command after timeout and retries the exact command to one run", async () => {
    const runtime = temporaryRuntime();
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
        if (runId === undefined) {
          runId = `run-${++created}`;
          runs.set(commandId, runId);
        }
        const send = (): void => {
          if (response.destroyed) return;
          response.statusCode = 201;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ runId }));
        };
        if (requests.length === 1) setTimeout(send, 75);
        else send();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    const client = testClient(address.port, runtime, 10);
    const caller = { actorId: "operator-1", channel: "cli" as const };

    await expect(client.submitRun({ kind: "inline_goal", commandId: "first-candidate", goal: "One run." }, caller))
      .rejects.toMatchObject({ code: "uncertain" });
    const pending = readdirSync(runtime).filter((name) => name.startsWith(CLI_PENDING_SUBMISSION_PREFIX));
    expect(pending).toHaveLength(1);
    const pendingPath = path.join(runtime, pending[0]!);
    const pendingMetadata = statSync(pendingPath);
    expect(pendingMetadata.mode & 0o777).toBe(0o600);
    expect(pendingMetadata.size).toBeLessThan(1_024);
    expect(readFileSync(pendingPath, "utf8")).not.toContain("One run.");
    expect(readFileSync(pendingPath, "utf8")).not.toContain("operator-1");

    await expect(client.submitRun({ kind: "inline_goal", commandId: "different-candidate", goal: "One run." }, caller))
      .resolves.toEqual({ runId: "run-1" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.["commandId"]).toBe(requests[0]?.["commandId"]);
    expect(created).toBe(1);
    expect(pendingFiles(runtime)).toEqual([]);
    await closeServer(server);
  });

  it("reads one encoded source through the authenticated source-text route", async () => {
    const runtime = temporaryRuntime();
    const server = createServer((request, response) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/api/v1/zentra/runs/run%3Aencoded/sources/source%3Aone/text");
      expect(request.headers.authorization).toBe(`ZentraCLI ${"c".repeat(43)}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ runId: "run:encoded", sourceId: "source:one", text: "safe" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server address missing");
    const client = testClient(address.port, runtime, 1_000);

    await expect(client.getSourceText("run:encoded", "source:one"))
      .resolves.toEqual({ runId: "run:encoded", sourceId: "source:one", text: "safe" });
    await closeServer(server);
  });
});

function temporaryRuntime(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zentra-http-workflow-"));
  directories.push(root);
  const runtime = path.join(root, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  return runtime;
}

function testClient(port: number, runtime: string, timeout: number): HttpWorkflowClient {
  const Constructor = HttpWorkflowClient as unknown as new (
    port: number,
    token: string,
    submissions: CliSubmissionCommandStore,
    timeout: number,
  ) => HttpWorkflowClient;
  return new Constructor(port, "c".repeat(43), new CliSubmissionCommandStore(runtime), timeout);
}

function pendingFiles(runtime: string): readonly string[] {
  return readdirSync(runtime).filter((name) => name.startsWith(CLI_PENDING_SUBMISSION_PREFIX));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
