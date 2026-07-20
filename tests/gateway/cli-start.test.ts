import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { runCli, type CliRuntime } from "../../src/cli/main.js";
import type { RunningZentraService } from "../../src/service/start-service.js";

describe("zentra start CLI", () => {
  it("prints one session URL and opens it only for an interactive TTY", async () => {
    const output: string[] = [];
    const opened: string[] = [];
    const sessionUrl = `http://127.0.0.1:43210/?token=${"a".repeat(43)}`;
    const code = await runCli(["start"], runtime({
      interactive: true,
      stdout: (value) => output.push(value),
      openBrowser: async (url) => { opened.push(url); },
      startService: async (options) => {
        expect(options?.cwd).toBe(process.cwd());
        return stoppedService(sessionUrl);
      },
    }));

    expect(code).toBe(0);
    expect(opened).toEqual([sessionUrl]);
    expect(output.filter((value) => value.includes(sessionUrl))).toEqual([`${sessionUrl}\n`]);
    expect(output.join("")).not.toContain(`"sessionUrl"`);
  });

  it("never opens a browser in noninteractive mode and accepts bounded startup options", async () => {
    const opened: string[] = [];
    const sessionUrl = `http://127.0.0.1:43211/?token=${"b".repeat(43)}`;
    const code = await runCli([
      "start", "--project", "/tmp/project", "--token-ttl-seconds", "30", "--agenttrail-timeout-ms", "5000",
    ], runtime({
      interactive: false,
      openBrowser: async (url) => { opened.push(url); },
      startService: async (options) => {
        expect(options).toMatchObject({
          cwd: "/tmp/project",
          tokenTtlMs: 30_000,
          agentTrailStartupTimeoutMs: 5_000,
        });
        return stoppedService(sessionUrl);
      },
    }));

    expect(code).toBe(0);
    expect(opened).toEqual([]);
  });

  it("lists start options without starting a service", async () => {
    const output: string[] = [];
    const code = await runCli(["start", "--help"], runtime({ stdout: (value) => output.push(value) }));

    expect(code).toBe(0);
    expect(output.join("")).toContain("--token-ttl-seconds");
    expect(output.join("")).toContain("--agenttrail-timeout-ms");
  });
});

function runtime(overrides: CliRuntime): CliRuntime {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    signalSource: new EventEmitter(),
    ...overrides,
  };
}

function stoppedService(sessionUrl: string): RunningZentraService {
  return {
    layout: { projectRoot: "/tmp/project" } as RunningZentraService["layout"],
    origin: new URL(sessionUrl).origin,
    sessionUrl,
    tokenExpiresAt: "2026-07-19T12:15:00.000Z",
    closed: Promise.resolve(),
    shutdown: async () => undefined,
  };
}
