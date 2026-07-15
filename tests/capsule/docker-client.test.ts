import { describe, expect, it } from "vitest";

import {
  DockerCommandCancelledError,
  DockerCommandTimeoutError,
  runBoundedProcess,
} from "../../src/capsule/docker-client.js";

const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };

describe("bounded Docker subprocess behavior", () => {
  it("returns a typed timeout after terminating the process group", async () => {
    const started = Date.now();
    await expect(runBoundedProcess(
      process.execPath,
      ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
      environment,
      new AbortController().signal,
      50,
    )).rejects.toBeInstanceOf(DockerCommandTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("escalates to SIGKILL when a process group ignores SIGTERM", async () => {
    const source = [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['--input-type=module', '--eval', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const started = Date.now();
    await expect(runBoundedProcess(
      process.execPath,
      ["--input-type=module", "--eval", source],
      environment,
      new AbortController().signal,
      1_000,
    )).rejects.toBeInstanceOf(DockerCommandTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_800);
    expect(Date.now() - started).toBeLessThan(3_500);
  });

  it("returns typed cancellation for an aborted invocation", async () => {
    const controller = new AbortController();
    const running = runBoundedProcess(
      process.execPath,
      ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
      environment,
      controller.signal,
      10_000,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(running).rejects.toBeInstanceOf(DockerCommandCancelledError);
  });
});
