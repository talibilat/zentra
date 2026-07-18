import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DockerOpenCodeReadOnlyCapsule, assertResearchCitations, parseOpenCodeFinalAssistantText } from "../../src/capsule/opencode-read-only-capsule.js";
import { DockerBrokerTransportUncertainError, type DockerClient } from "../../src/capsule/docker-client.js";
import type { ModelBroker } from "../../src/capsule/model-broker.js";
import type { ModelBrokerReceipt } from "../../src/capsule/model-broker.js";
import type { OpenCodeReadOnlyCapsuleRequest } from "../../src/agents/opencode-read-only-agent.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";
import { GovernedWebResearch, WebResearchPolicySchema, webResearchTerminalResult } from "../../src/research/web-research.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { storedEventToAgentTailEvent } from "../../src/observability/agent-tail.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DockerOpenCodeReadOnlyCapsule", () => {
  it("physically mounts the repository read-only and routes bounded turns through ModelBroker", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-project-")));
    roots.push(repository);
    const imageId = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    let imagePresent = true;
    let containerPresent = true;
    let transportUncertain = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") {
        if (!imagePresent) return { exitCode: 1, stdout: "", stderr: "No such image" };
        return { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: ["zentra-opencode-readonly:test"], Architecture: "arm64", Os: "linux", Config: { Labels: { "org.zentra.node-base-digest": "sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89", "org.zentra.capsule-id": "milestone.task" } } }]), stderr: "" };
      }
      if (args[0] === "create") return { exitCode: 0, stdout: `${containerId}\n`, stderr: "" };
      if (args[0] === "start") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "exec" && args.at(-1) === "--version") return { exitCode: 0, stdout: "1.18.3\n", stderr: "" };
      if (args[0] === "exec" && args.includes("/usr/bin/sha256sum")) return { exitCode: 0, stdout: "915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb  /usr/local/bin/opencode\n", stderr: "" };
      if (args[0] === "image" && args[1] === "rm") { imagePresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "rm" && args[1] === "--force") { containerPresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "inspect") return containerPresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: "/zentra-opencode-readonly-test", Config: { Labels: { "org.zentra.capsule-id": "milestone.task" } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such container" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const runBrokered = vi.fn(async (
      args: readonly string[],
      _signal: AbortSignal,
      _timeoutMs: number,
      exchange: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    ) => {
      if (transportUncertain) throw new DockerBrokerTransportUncertainError();
      expect(args).toEqual(["exec", "--interactive", containerId, "/usr/local/bin/node", "/runner/runner.mjs"]);
      expect(args.join(" ")).not.toContain(process.env.HOME ?? "host-home-never-present");
      const response = await exchange({
        type: "model_turn",
        requestId: "turn-1",
        prompt: "system: Plan safely.\nuser: Inspect contracts.",
      }, new AbortController().signal) as { receipt: { response: { type: "text"; text: string } } };
      const openCodeOutput = [
        JSON.stringify({ type: "text", part: { type: "text", text: response.receipt.response.text } }),
        JSON.stringify({ type: "step_finish" }),
      ].join("\n");
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ type: "opencode_result", exitCode: 0, stdout: openCodeOutput, stderr: "" })}\n`,
        stderr: "",
      };
    });
    const docker = {
      executable: "/Applications/Docker.app/Contents/Resources/bin/docker",
      run,
      runBrokered,
    } as unknown as DockerClient;
    const broker: ModelBroker = {
      execute: vi.fn(async (request): Promise<ModelBrokerReceipt> => ({
        outcome: "completed",
        response: { type: "text", text: `Plan from ${request.modelId}` },
        model: { id: request.modelId, provider: "fixture", name: "planner" },
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      })),
    };

    const observations: unknown[] = [];
    const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository), broker, new AbortController().signal, (observation) => observations.push(observation),
    );

    expect(result).toMatchObject({
      outcome: "completed",
      model: { id: "fixture/planner", provider: "fixture", name: "planner" },
      evidence: [{ kind: "plan", summary: "Plan from fixture/planner" }],
      cleanup: "completed",
    });
    expect(broker.execute).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "fixture/planner",
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxCostUsd: 1,
    }), expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "create", "--label", "org.zentra.capsule-id=milestone.task", "--network", "none", "--read-only",
      "--mount", `type=bind,src=${repository},dst=/project,readonly`,
    ]), expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith(["inspect", containerId], expect.any(AbortSignal), 30_000);
    expect(run).toHaveBeenCalledWith(["image", "inspect", imageId], expect.any(AbortSignal), 30_000);
    expect(observations).toEqual([
      expect.objectContaining({ type: "resources_prepared", payload: expect.objectContaining({ containerId, imageId, repositoryViewPath: repository }) }),
      { type: "model_started", modelId: "fixture/planner" },
      {
        type: "model_completed", modelId: "fixture/planner", outcome: "completed",
        usage: { seconds: 0, inputTokens: 10, outputTokens: 5, costUsd: 0.01, toolCalls: 0, modelTurns: 1 },
      },
      expect.objectContaining({ type: "cleanup_observed", payload: expect.objectContaining({ outcome: "completed", containerAbsent: true, imageAbsent: true }) }),
    ]);

    for (const brokerOutcome of ["cancelled", "timed_out", "uncertain"] as const) {
      imagePresent = true;
      containerPresent = true;
      const mapped = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
        request(repository),
        { execute: async () => ({ outcome: brokerOutcome, response: null, model: null, usage: null }) },
        new AbortController().signal,
      );
      expect(mapped).toMatchObject({
        outcome: brokerOutcome === "uncertain" ? "failed" : brokerOutcome,
        brokerTransport: brokerOutcome === "uncertain" ? "uncertain" : "completed",
        cleanup: "completed",
      });
    }
    imagePresent = true;
    containerPresent = true;
    transportUncertain = true;
    expect(await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository), broker, new AbortController().signal,
    )).toMatchObject({ outcome: "failed", brokerTransport: "uncertain" });

    transportUncertain = false;
    imagePresent = true;
    containerPresent = true;
    const researchPolicy = WebResearchPolicySchema.parse({
      schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 1_000, budget: { maxRequests: 1, maxBytes: 1_024, maxTimeMs: 1_000 },
    });
    const researchJournal = new SqliteEventJournal(":memory:");
    const research = new GovernedWebResearch(researchJournal, { dispatch: async () => ({
      status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("governed source fact"),
      compressedBytes: 20, decompressedBytes: 20, resolvedAddress: "93.184.216.34", tls: true, dispatched: true,
    }) });
    runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
      const researchReceipt = await exchange({ type: "research_request", requestId: "source-1", method: "GET", url: "https://docs.example.com/fact?secret=redacted" }, new AbortController().signal) as any;
      await exchange({ type: "model_turn", requestId: "turn-research", prompt: "source result" }, new AbortController().signal);
      const citation = `[source:${researchReceipt.result.evidence.evidenceId}]`;
      const output = [JSON.stringify({ type: "text", part: { type: "text", text: `Finding ${citation}` } }), JSON.stringify({ type: "step_finish" })].join("\n");
      return { exitCode: 0, stdout: `${JSON.stringify({ type: "opencode_result", exitCode: 0, stdout: output, stderr: "" })}\n`, stderr: "" };
    });
    const governed = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
      ...request(repository), role: "researcher", webResearch: researchPolicy,
      webResearchEnvelopeDigest: "a".repeat(64), securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
    }, broker, new AbortController().signal, undefined, research);
    expect(governed).toMatchObject({
      outcome: "completed",
      evidence: [{ kind: "research", summary: expect.stringContaining("[source:"), sourceEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/)] }],
    });
    expect(JSON.stringify(researchJournal.readAll())).not.toContain("governed source fact");
    expect(JSON.stringify(researchJournal.readAll())).not.toContain("secret=redacted");
    researchJournal.close();

    for (const mode of ["attention", "thrown"] as const) {
      imagePresent = true;
      containerPresent = true;
      const observed: any[] = [];
      runBrokered.mockImplementationOnce(async (_args, _signal, _timeout, exchange) => {
        await exchange({ type: "research_request", requestId: `${mode}-1`, method: "GET", url: "https://outside.example/" }, new AbortController().signal);
        throw new Error("broker process stopped after research completion");
      });
      const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute({
        ...request(repository), role: "researcher", webResearch: researchPolicy,
        webResearchEnvelopeDigest: "a".repeat(64), securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
      }, broker, new AbortController().signal, (observation) => observed.push(observation), {
        execute: async (raw) => {
          if (mode === "thrown") throw new Error("research execution threw");
          return webResearchTerminalResult(raw, "denied", "capability_attention");
        },
      });
      expect(result).toMatchObject({ outcome: "failed", cleanup: "completed" });
      expect(observed.filter((item) => item.type.startsWith("research_"))).toEqual([
        { type: "research_started", requestId: `${mode}-1` },
        expect.objectContaining({ type: "research_completed", requestId: `${mode}-1`, result: expect.objectContaining({
          outcome: mode === "attention" ? "denied" : "failed", reason: mode === "attention" ? "capability_attention" : "execution_threw",
        }) }),
      ]);
      expect(observed.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed" } });
    }
  });

  it("does not fabricate harness metadata when image build fails before attestation", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-pre-attest-")));
    roots.push(repository);
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 1, stdout: "", stderr: "build failed" };
      if (args[0] === "rm" || (args[0] === "image" && args[1] === "rm")) return { exitCode: 1, stdout: "", stderr: "No such object" };
      if (args[0] === "inspect" || (args[0] === "image" && args[1] === "inspect")) return { exitCode: 1, stdout: "", stderr: "No such object" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const docker = { run, runBrokered: vi.fn() } as unknown as DockerClient;

    const result = await new DockerOpenCodeReadOnlyCapsule(docker).execute(
      request(repository),
      { execute: vi.fn() },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: "failed", openCode: null, model: null, cleanup: "completed" });
  });

  it("preserves deterministic-name container and image collisions without the capsule label", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-collision-")));
    roots.push(repository);
    const requested = request(repository);
    const foreignContainerId = "e".repeat(64);
    const foreignImageId = `sha256:${"f".repeat(64)}`;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "build") return { exitCode: 1, stdout: "", stderr: "build failed" };
      if (args[0] === "inspect" && args[1] === requested.resources.containerName) {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: foreignContainerId, Name: `/${requested.resources.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args[2] === requested.resources.imageName) {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: foreignImageId, RepoTags: [requested.resources.imageName], Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      }
      throw new Error(`unsafe removal attempted: ${args.join(" ")}`);
    });

    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).execute(
      requested, { execute: vi.fn() }, new AbortController().signal,
    );

    expect(result).toMatchObject({ outcome: "failed", cleanup: "uncertain" });
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });

  it("idempotently reconciles prepared resources by label and exact identities", async () => {
    const identity = openCodeResourceIdentity("reconcile", "task", 1);
    mkdirSync(identity.repositoryViewPath);
    const view = realpathSync.native(identity.repositoryViewPath);
    roots.push(view);
    const containerId = "c".repeat(64);
    const imageId = `sha256:${"d".repeat(64)}`;
    let containerPresent = true;
    let imagePresent = true;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "container" && args[1] === "ls") return { exitCode: 0, stdout: containerPresent ? `${containerId}\n` : "", stderr: "" };
      if (args[0] === "image" && args[1] === "ls") return { exitCode: 0, stdout: imagePresent ? `${imageId}\n` : "", stderr: "" };
      if (args[0] === "rm") { containerPresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "image" && args[1] === "rm") { imagePresent = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (args[0] === "inspect") return containerPresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": identity.capsuleId } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such container" };
      if (args[0] === "image" && args[1] === "inspect") return imagePresent
        ? { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": identity.capsuleId } } }]), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "No such image" };
      throw new Error(`unexpected Docker operation: ${args.join(" ")}`);
    });
    const capsule = new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient);
    const prepared = { ...identity, containerId, imageId, repositoryViewPath: view, repositoryRevision: "a".repeat(64) };

    expect(await capsule.reconcile(prepared)).toEqual({
      outcome: "completed", containerId, imageId, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
    });
    expect(await capsule.reconcile(prepared)).toEqual({
      outcome: "completed", containerId, imageId, containerAbsent: true, imageAbsent: true, repositoryViewAbsent: true,
    });
  });

  it("fails reconciliation closed on deterministic-name resources with a foreign label", async () => {
    const identity = openCodeResourceIdentity("collision", "task", 1);
    mkdirSync(identity.repositoryViewPath);
    roots.push(identity.repositoryViewPath);
    const run = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "container" || args[0] === "image") && args[1] === "ls") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: "a".repeat(64), Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: `sha256:${"b".repeat(64)}`, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": "foreign" } } }]), stderr: "" };
      throw new Error(`unsafe removal attempted: ${args.join(" ")}`);
    });
    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).reconcile({
      ...identity, containerId: null, imageId: null, repositoryRevision: null,
    });

    expect(result).toMatchObject({ outcome: "uncertain", containerAbsent: false, imageAbsent: false });
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });

  it.each(["container", "image"] as const)("preserves a stale prepared %s ID whose current identity is corrupted", async (kind) => {
    const identity = openCodeResourceIdentity(`stale-${kind}`, "task", 1);
    mkdirSync(identity.repositoryViewPath);
    roots.push(identity.repositoryViewPath);
    const containerId = "6".repeat(64);
    const imageId = `sha256:${"7".repeat(64)}`;
    const run = vi.fn(async (args: readonly string[]) => {
      if ((args[0] === "container" || args[0] === "image") && args[1] === "ls") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[1] === containerId && kind === "container") {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: containerId, Name: `/${identity.containerName}`, Config: { Labels: { "org.zentra.capsule-id": "corrupted" } } }]), stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args[2] === imageId && kind === "image") {
        return { exitCode: 0, stdout: JSON.stringify([{ Id: imageId, RepoTags: [identity.imageName], Config: { Labels: { "org.zentra.capsule-id": "corrupted" } } }]), stderr: "" };
      }
      if (args[0] === "inspect" || (args[0] === "image" && args[1] === "inspect")) {
        return { exitCode: 1, stdout: "", stderr: "No such object" };
      }
      throw new Error(`stale resource removal attempted: ${args.join(" ")}`);
    });
    const result = await new DockerOpenCodeReadOnlyCapsule({ run } as unknown as DockerClient).reconcile({
      ...identity,
      containerId: kind === "container" ? containerId : null,
      imageId: kind === "image" ? imageId : null,
      repositoryRevision: "a".repeat(64),
    });

    expect(result.outcome).toBe("uncertain");
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "rm")).toBe(false);
    expect(run.mock.calls.some(([args]) => (args as readonly string[])[0] === "image" && (args as readonly string[])[1] === "rm")).toBe(false);
  });
});

describe("OpenCode final evidence parsing", () => {
  it("accepts only one text in the final naturally completed step", () => {
    const output = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "step_finish" }),
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { type: "text", text: "final evidence" } }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");
    expect(parseOpenCodeFinalAssistantText(output)).toBe("final evidence");
  });

  it.each([
    JSON.stringify({ type: "text", part: { type: "text", text: "partial" } }),
    [
      JSON.stringify({ type: "text", part: { type: "text", text: "one" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "two" } }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n"),
    "not-json",
  ])("rejects partial or ambiguous output", (output) => {
    expect(() => parseOpenCodeFinalAssistantText(output)).toThrow();
  });
});

describe("OpenCode research citation verification", () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  it("requires every retained source exactly once", () => {
    expect(() => assertResearchCitations(`One [source:${first}] two [source:${second}]`, [first, second], "all_exactly_once")).not.toThrow();
  });
  it.each([
    [`Only [source:${first}]`, [first, second]],
    [`Duplicate [source:${first}] [source:${first}]`, [first]],
    [`Unknown [source:${second}]`, [first]],
    ["No citation", [first]],
  ] as const)("rejects incomplete, duplicate, unknown, or absent citations", (summary, retained) => {
    expect(() => assertResearchCitations(summary, retained, "all_exactly_once")).toThrow(/retained source evidence/i);
  });
});

describe("DockerOpenCodeReadOnlyCapsule real Docker path", () => {
  it("runs the attested OpenCode executable with no network and a typed host broker", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-real-")));
    roots.push(repository);
    writeFileSync(path.join(repository, "evidence.txt"), "violet repository fact 731\n");
    let turns = 0;
    const promptEvidence: string[] = [];
    const broker: ModelBroker = {
      execute: async (brokerRequest): Promise<ModelBrokerReceipt> => {
        turns += 1;
        promptEvidence.push(brokerRequest.prompt.includes("violet repository fact 731") ? "file" : brokerRequest.prompt.slice(0, 40));
        const title = brokerRequest.prompt.startsWith("system: You are a title generator");
        const observedFile = brokerRequest.prompt.includes("violet repository fact 731");
        return {
          outcome: "completed",
          response: title
            ? { type: "text", text: "Repository evidence" }
            : observedFile
              ? { type: "text", text: "Observed violet repository fact 731" }
              : { type: "tool_calls", calls: [{ id: "read-evidence", name: "read", arguments: JSON.stringify({ filePath: "/project/evidence.txt" }) }] },
          model: { id: brokerRequest.modelId, provider: "fixture", name: "planner" },
          usage: { inputTokens: 10, outputTokens: 2, costUsd: 0 },
        };
      },
    };

    const result = await new DockerOpenCodeReadOnlyCapsule().execute({
      ...request(repository),
      role: "researcher",
      securityBoundary: {
        ...request(repository).securityBoundary,
        readableScopes: ["evidence.txt"],
      },
      timeoutMs: 30_000,
      budget: { maxSeconds: 30, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal);

    expect(result).toMatchObject({
      outcome: "completed",
      model: { id: "fixture/planner", provider: "fixture", name: "planner" },
      cleanup: "completed",
    });
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(promptEvidence).toContain("file");
    expect(result.evidence).toEqual([{ kind: "research", summary: "Observed violet repository fact 731" }]);
  }, 120_000);

  it("runs governed research through the supported local MCP protocol and requires citations", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-research-")));
    roots.push(repository);
    const policy = WebResearchPolicySchema.parse({
      schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 10_000, budget: { maxRequests: 2, maxBytes: 2_048, maxTimeMs: 20_000 },
    });
    const journal = new SqliteEventJournal(":memory:");
    const controlled = await controlledHttpsSource(repository, "governed MCP fact 913");
    const research = new GovernedWebResearch(journal, controlled.transport);
    const prompts: string[] = [];
    const broker: ModelBroker = { execute: async (brokerRequest) => {
      prompts.push(brokerRequest.prompt);
      const citation = /\[source:[a-f0-9]{64}\]/.exec(brokerRequest.prompt)?.[0];
      const title = brokerRequest.prompt.startsWith("system: You are a title generator");
      return {
        outcome: "completed" as const,
        response: title ? { type: "text" as const, text: "Governed research" } : citation === undefined
          ? { type: "tool_calls" as const, calls: [{ id: "research-1", name: "zentra_research_web_research", arguments: JSON.stringify({ url: "https://docs.example.com/fact", method: "GET" }) }] }
          : { type: "text" as const, text: `Observed governed MCP fact 913 ${citation}` },
        model: { id: brokerRequest.modelId, provider: "fixture", name: "researcher" },
        usage: { inputTokens: 10, outputTokens: 3, costUsd: 0 },
      };
    } };
    const result = await new DockerOpenCodeReadOnlyCapsule().execute({
      ...request(repository), role: "researcher", rolePrompt: "Use the governed research tool, then report the fact with its source citation.",
      webResearch: policy, webResearchEnvelopeDigest: "a".repeat(64),
      securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" },
      timeoutMs: 60_000, budget: { maxSeconds: 60, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal, undefined, research);

    expect(result).toMatchObject({
      outcome: "completed",
      openCode: { version: "1.18.3", executableSha256: "915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb" },
      evidence: [{ kind: "research", summary: expect.stringContaining("governed MCP fact 913"), sourceEvidenceIds: [expect.stringMatching(/^[a-f0-9]{64}$/)] }],
      cleanup: "completed",
    });
    expect(controlled.requests).toBe(1);
    const sourceEvent = journal.readStream("web-research:task-1")[0]!;
    expect(sourceEvent.payload).toMatchObject({
      outcome: "completed", identity: { taskId: "task-1", workerId: "milestone.task", role: "researcher",
        envelopeDigest: "a".repeat(64), policyDigest: policy.digest },
      evidence: { parent: { workerId: "milestone.task", modelId: "fixture/planner", tool: "zentra_web_research" },
        provenance: { transport: "zentra_https_broker", redirectHops: 0 } },
    });
    expect(storedEventToAgentTailEvent(sourceEvent)).toMatchObject({
      actor: { id: "milestone.task", role: "researcher" }, parent_span_id: "worker:milestone.task",
      operation: { name: "web_research", status: "completed" },
    });
    await controlled.close();
    journal.close();
  }, 120_000);

  it("emits a typed completion and cleans up when real MCP research requires capability attention", async () => {
    const repository = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-opencode-attention-")));
    roots.push(repository);
    const policy = WebResearchPolicySchema.parse({ schemaVersion: 1, destinations: [{ origin: "https://docs.example.com", pathPrefix: "/" }],
      contentTypes: ["text/plain"], maxRedirects: 1, maxCompressedBytes: 1_024, maxDecompressedBytes: 1_024,
      timeoutMs: 10_000, budget: { maxRequests: 1, maxBytes: 1_024, maxTimeMs: 10_000 } });
    let turns = 0;
    const broker: ModelBroker = { execute: async (brokerRequest) => {
      turns += 1;
      const title = brokerRequest.prompt.startsWith("system: You are a title generator");
      return { outcome: "completed", response: title ? { type: "text", text: "Research attention" }
        : { type: "tool_calls", calls: [{ id: "attention-1", name: "zentra_research_web_research", arguments: JSON.stringify({ url: "https://outside.example/", method: "GET" }) }] },
        model: { id: brokerRequest.modelId, provider: "fixture", name: "researcher" }, usage: { inputTokens: 5, outputTokens: 2, costUsd: 0 } };
    } };
    const observations: any[] = [];
    const result = await new DockerOpenCodeReadOnlyCapsule().execute({ ...request(repository), role: "researcher",
      rolePrompt: "Use the governed research tool.", webResearch: policy, webResearchEnvelopeDigest: "a".repeat(64),
      securityBoundary: { ...request(repository).securityBoundary, network: "brokered_web_research" }, timeoutMs: 60_000,
      budget: { maxSeconds: 60, maxCostUsd: 1, maxInputTokens: 10_000, maxOutputTokens: 1_000 },
    }, broker, new AbortController().signal, (observation) => observations.push(observation), {
      execute: async (raw) => webResearchTerminalResult(raw, "denied", "capability_attention"),
    });
    expect(result).toMatchObject({ outcome: "failed", cleanup: "completed" });
    expect(observations.filter((item) => item.type.startsWith("research_"))).toEqual([
      { type: "research_started", requestId: expect.any(String) },
      { type: "research_completed", requestId: expect.any(String), result: expect.objectContaining({ outcome: "denied", reason: "capability_attention" }) },
    ]);
    expect(observations.at(-1)).toMatchObject({ type: "cleanup_observed", payload: { outcome: "completed", containerAbsent: true, imageAbsent: true } });
    expect(turns).toBe(2);
  }, 120_000);
});

function request(repositoryPath: string): OpenCodeReadOnlyCapsuleRequest {
  return {
    capsuleId: "milestone.task",
    taskId: "task-1",
    repositoryPath,
    role: "planner",
    actorId: "opencode-planner",
    rolePrompt: "Plan safely.",
    capabilityId: "opencode-planner",
    transportModelId: "fixture/planner",
    resources: {
      resourceLabel: "org.zentra.capsule-id=milestone.task",
      containerName: "zentra-opencode-readonly-test",
      imageName: "zentra-opencode-readonly:test",
    },
    budget: { maxSeconds: 10, maxCostUsd: 1, maxInputTokens: 100, maxOutputTokens: 50 },
    timeoutMs: 5_000,
    webResearch: null,
    webResearchEnvelopeDigest: null,
    securityBoundary: {
      repository: "sanitized_read_only_bind_mount",
      scratch: "bounded_ephemeral",
      network: "model_broker_only",
      home: "ephemeral",
      credentials: "none",
      shell: "none",
      readableScopes: ["README.md"],
      forbiddenPaths: [".env"],
      repositoryRevision: "a".repeat(64),
    },
  };
}

async function controlledHttpsSource(root: string, content: string) {
  const key = path.join(root, "controlled.key");
  const cert = path.join(root, "controlled.crt");
  const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=docs.example.com", "-days", "1"], {
    shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8",
  });
  if (generated.status !== 0) throw new Error("controlled HTTPS certificate generation failed");
  let requests = 0;
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    requests += 1;
    response.setHeader("content-type", "text/plain");
    response.end(content);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("controlled HTTPS source did not bind");
  return {
    get requests() { return requests; },
    transport: { dispatch: (input: any) => new Promise<any>((resolve, reject) => {
      const request = https.request({ hostname: "127.0.0.1", port: address.port, path: input.url.pathname, method: input.method, rejectUnauthorized: false }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({ status: response.statusCode, headers: { "content-type": String(response.headers["content-type"]) }, body,
            compressedBytes: body.length, decompressedBytes: body.length, resolvedAddress: "93.184.216.34", tls: true, dispatched: true });
        });
      });
      request.on("error", reject);
      input.signal.addEventListener("abort", () => request.destroy(new Error("cancelled")), { once: true });
      request.end();
    }) },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
