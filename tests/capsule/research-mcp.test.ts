import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { researchMcpProtocolSource } from "../../src/capsule/opencode-read-only-capsule.js";

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenCode 1.18.3 local research MCP protocol", () => {
  it("supports initialize, notifications, list, malformed input, unknown methods, and shutdown", async () => {
    const child = startMcp();
    write(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(await line(child)).toMatchObject({ id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } } } });
    write(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    write(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(await line(child)).toMatchObject({ id: 2, result: { tools: [{ name: "web_research" }] } });
    child.stdin.write("not-json\n");
    expect(await line(child)).toMatchObject({ id: null, error: { code: -32700 } });
    write(child, { jsonrpc: "2.0", id: 3, method: "unknown" });
    expect(await line(child)).toMatchObject({ id: 3, error: { code: -32601 } });
    write(child, { jsonrpc: "2.0", id: 4, method: "shutdown" });
    expect(await line(child)).toEqual({ jsonrpc: "2.0", id: 4, result: null });
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  });

  it("calls only the narrow research endpoint and bounds output", async () => {
    const evidenceId = "a".repeat(64);
    servers.push(createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/research");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ outcome: "completed", content: "controlled fact", evidence: { evidenceId } }));
    }).listen(4318, "127.0.0.1"));
    await listening(servers[0]!);
    const child = startMcp();
    write(child, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_research", arguments: { url: "https://docs.example.com/", method: "GET" } } });
    expect(await line(child)).toMatchObject({ id: 1, result: { content: [{ text: `controlled fact\n\nSource evidence: [source:${evidenceId}]` }], isError: false } });
    write(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "other", arguments: {} } });
    expect(await line(child)).toMatchObject({ id: 2, error: { code: -32602 } });
  });

  it("cancels an active tool call and returns a bounded failure", async () => {
    servers.push(createServer(() => {}).listen(4318, "127.0.0.1"));
    await listening(servers[0]!);
    const child = startMcp();
    write(child, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "web_research", arguments: { url: "https://docs.example.com/" } } });
    write(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    expect(await line(child)).toMatchObject({ id: 7, result: { isError: true } });
  });

  it("rejects oversized input without executing it", async () => {
    const child = startMcp();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", padding: "x".repeat(70_000) })}\n`);
    expect(await line(child)).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("fails closed with bounded output when broker content is oversized", async () => {
    servers.push(createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ outcome: "completed", content: "x".repeat(5 * 1024 * 1024), evidence: { evidenceId: "a".repeat(64) } }));
    }).listen(4318, "127.0.0.1"));
    await listening(servers[0]!);
    const child = startMcp();
    write(child, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "web_research", arguments: { url: "https://docs.example.com/" } } });
    expect(await line(child)).toMatchObject({ id: 9, result: { isError: true, content: [{ text: "Research broker failed closed." }] } });
  });
});

function startMcp(): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", researchMcpProtocolSource()], {
    shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}
function write(child: ChildProcessWithoutNullStreams, value: unknown): void { child.stdin.write(`${JSON.stringify(value)}\n`); }
async function line(child: ChildProcessWithoutNullStreams): Promise<any> {
  let output = "";
  let errors = "";
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    const timer = setTimeout(() => reject(new Error(`MCP response timeout: ${output} ${errors}`)), 2_000);
    const data = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const index = output.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer); child.stdout.off("data", data); resolve(JSON.parse(output.slice(0, index)));
    };
    child.stdout.on("data", data);
  });
}
async function listening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
}
