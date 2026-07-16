import { describe, expect, it } from "vitest";

import {
  DockerBrokerTransportUncertainError,
  DockerCommandCancelledError,
  DockerCommandTimeoutError,
  runBoundedProcess,
  runBrokeredDockerProcess,
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

describe("brokered Docker subprocess lifecycle", () => {
  it("reports uncertain transport within a fixed grace when an active broker ignores abort forever", async () => {
    const source = `process.stdout.write(JSON.stringify({type:"model_turn",requestId:"one",prompt:"plan"})+"\\n");process.stdin.resume();setInterval(()=>{},1000);`;
    const controller = new AbortController();
    let brokerStarted!: () => void;
    const startedBroker = new Promise<void>((resolve) => { brokerStarted = resolve; });
    const running = runBrokeredDockerProcess(
      process.execPath,
      ["--input-type=module", "--eval", source],
      environment,
      controller.signal,
      10_000,
      async () => {
        brokerStarted();
        return new Promise<never>(() => {});
      },
    );
    await startedBroker;
    const started = Date.now();
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(DockerBrokerTransportUncertainError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("aborts and awaits a hanging broker before reporting timeout", async () => {
    let active = false;
    let aborted = false;
    const source = `process.stdout.write(JSON.stringify({type:"model_turn",requestId:"one",prompt:"plan"})+"\\n");process.stdin.resume();setInterval(()=>{},1000);`;
    const running = runBrokeredDockerProcess(
      process.execPath,
      ["--input-type=module", "--eval", source],
      environment,
      new AbortController().signal,
      500,
      async (_request, signal) => {
        active = true;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          aborted = true;
          active = false;
          resolve();
        }, { once: true }));
        throw new Error("aborted broker");
      },
    );

    await expect(running).rejects.toBeInstanceOf(DockerCommandTimeoutError);
    expect(aborted).toBe(true);
    expect(active).toBe(false);
  });

  it("aborts and awaits an in-flight broker when the child exits early", async () => {
    let settled = false;
    const source = `process.stdout.write(JSON.stringify({type:"model_turn",requestId:"one",prompt:"plan"})+"\\n",()=>setTimeout(()=>process.exit(7),20));`;
    const result = await runBrokeredDockerProcess(
      process.execPath,
      ["--input-type=module", "--eval", source],
      environment,
      new AbortController().signal,
      5_000,
      async (_request, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        settled = true;
        throw new Error("child closed");
      },
    );

    expect(result.exitCode).toBe(7);
    expect(settled).toBe(true);
  });

  it("treats closed stdin during an exchange as a protocol failure and aborts the broker", async () => {
    let aborted = false;
    const source = `import { closeSync } from "node:fs";closeSync(0);process.stdout.write(JSON.stringify({type:"model_turn",requestId:"one",prompt:"plan"})+"\\n");setInterval(()=>{},1000);`;
    await expect(runBrokeredDockerProcess(
      process.execPath,
      ["--input-type=module", "--eval", source],
      environment,
      new AbortController().signal,
      5_000,
      async (_request, signal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { type: "model_receipt" };
      },
    )).rejects.toThrow("model broker protocol failed");
    expect(aborted).toBe(true);
  });
});
