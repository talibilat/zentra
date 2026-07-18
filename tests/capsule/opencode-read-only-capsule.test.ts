import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DockerOpenCodeReadOnlyCapsule, parseOpenCodeFinalAssistantText } from "../../src/capsule/opencode-read-only-capsule.js";
import { DockerBrokerTransportUncertainError, type DockerClient } from "../../src/capsule/docker-client.js";
import type { ModelBroker } from "../../src/capsule/model-broker.js";
import type { ModelBrokerReceipt } from "../../src/capsule/model-broker.js";
import type { OpenCodeReadOnlyCapsuleRequest } from "../../src/agents/opencode-read-only-agent.js";
import { openCodeResourceIdentity } from "../../src/agents/opencode-resource-identity.js";

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
      if (args[0] === "exec" && args.at(-1) === "--version") return { exitCode: 0, stdout: "1.18.1\n", stderr: "" };
      if (args[0] === "exec" && args.includes("/usr/bin/sha256sum")) return { exitCode: 0, stdout: "b83305b14e233483aba7027a9dd6a18716b8786b3fe13261e0afce96f4418b17  /usr/local/bin/opencode\n", stderr: "" };
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

describe.runIf(process.env.ZENTRA_OPENCODE_DOCKER_E2E === "1")("DockerOpenCodeReadOnlyCapsule real Docker path", () => {
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
});

function request(repositoryPath: string): OpenCodeReadOnlyCapsuleRequest {
  return {
    capsuleId: "milestone.task",
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
