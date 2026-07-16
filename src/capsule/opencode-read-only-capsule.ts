import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";
import { controlledViewRoot } from "../agents/opencode-resource-identity.js";

import {
  OpenCodeReadOnlyCapsuleRequestSchema,
  OpenCodeReadOnlyCapsuleResultSchema,
  type OpenCodeReadOnlyCapsule,
  type OpenCodeCapsuleObservation,
  type OpenCodeReadOnlyCapsuleRequest,
  type OpenCodeReadOnlyCapsuleResult,
} from "../agents/opencode-read-only-agent.js";
import {
  ModelBrokerReceiptSchema,
  ModelBrokerRequestSchema,
  type ModelBroker,
  type ModelBrokerReceipt,
} from "./model-broker.js";
import {
  NODE_BASE_INDEX_DIGEST,
  OPENCODE_EXECUTABLE_SHA256,
  OPENCODE_VERSION,
  openCodeWorkerDockerfile,
} from "./docker-capsule.js";
import { DockerBrokerTransportUncertainError, DockerClient, DockerCommandCancelledError, DockerCommandTimeoutError } from "./docker-client.js";

const SCRATCH_BYTES = 16 * 1024 * 1024;
const MAX_TURNS = 32;
const TurnSchema = z.strictObject({
  type: z.literal("model_turn"),
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  prompt: z.string().min(1).max(256 * 1024),
});
const ResultSchema = z.strictObject({
  type: z.literal("opencode_result"),
  exitCode: z.number().int(),
  stdout: z.string().max(4 * 1024 * 1024),
  stderr: z.string().max(4 * 1024 * 1024),
});

export class DockerOpenCodeReadOnlyCapsule implements OpenCodeReadOnlyCapsule {
  constructor(private readonly docker = new DockerClient()) {}

  async execute(
    rawRequest: OpenCodeReadOnlyCapsuleRequest,
    broker: ModelBroker,
    signal: AbortSignal,
    observe: (observation: OpenCodeCapsuleObservation) => void = () => {},
  ): Promise<OpenCodeReadOnlyCapsuleResult> {
    const request = OpenCodeReadOnlyCapsuleRequestSchema.parse(rawRequest);
    const repository = canonicalDirectory(request.repositoryPath);
    const imageName = request.resources.imageName;
    const containerName = request.resources.containerName;
    const assets = createRunnerAssets(request);
    let imageId: string | null = null;
    let containerId: string | null = null;
    let measuredHarness: OpenCodeReadOnlyCapsuleResult["openCode"] = null;
    const brokerState: { receipt: ModelBrokerReceipt | null } = { receipt: null };
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let cleanup: "completed" | "uncertain" = "uncertain";
    let brokerTransport: "completed" | "uncertain" = "completed";
    let outcome: OpenCodeReadOnlyCapsuleResult["outcome"] = "failed";
    let evidence: OpenCodeReadOnlyCapsuleResult["evidence"] = [];
    try {
      await dockerOk(this.docker, ["build", "--platform", "linux/arm64", "--tag", imageName, assets], signal);
      const inspect = JSON.parse((await dockerOk(this.docker, ["image", "inspect", imageName], signal)).stdout) as readonly [{ readonly Id?: string; readonly Architecture?: string; readonly Os?: string; readonly Config?: { readonly Labels?: Readonly<Record<string, string>> } }];
      const image = inspect[0];
      if (inspect.length !== 1 || image?.Architecture !== "arm64" || image.Os !== "linux" ||
        image.Config?.Labels?.["org.zentra.node-base-digest"] !== NODE_BASE_INDEX_DIGEST ||
        image.Config?.Labels?.["org.zentra.capsule-id"] !== request.capsuleId ||
        !/^sha256:[a-f0-9]{64}$/.test(image.Id ?? "")) {
        throw new Error("OpenCode worker image attestation failed");
      }
      imageId = image.Id!;
      const created = await dockerOk(this.docker, [
        "create", "--name", containerName, "--label", request.resources.resourceLabel,
        "--network", "none", "--read-only", "--user", "10001:10001",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5",
        "--stop-timeout", "1", "--tmpfs", `/scratch:rw,noexec,nosuid,size=${SCRATCH_BYTES},mode=1777`,
        "--mount", `type=bind,src=${repository},dst=/project,readonly`,
        "--mount", `type=bind,src=${assets},dst=/runner,readonly`,
        "--env", "HOME=/scratch", "--env", "TMPDIR=/scratch", "--env", "OPENCODE_DISABLE_AUTOUPDATE=1",
        "--env", "OPENCODE_DISABLE_DEFAULT_PLUGINS=1", "--env", "OPENCODE_DISABLE_LSP_DOWNLOAD=1",
        imageName, "/bin/sleep", "600",
      ], signal);
      const createdId = created.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(createdId)) throw new Error("OpenCode container identity attestation failed");
      containerId = createdId;
      observe({ type: "resources_prepared", payload: {
        capsuleId: request.capsuleId,
        resourceLabel: request.resources.resourceLabel,
        containerName,
        containerId,
        imageName,
        imageId,
        repositoryViewPath: repository,
        repositoryRevision: request.securityBoundary.repositoryRevision,
      } });
      await dockerOk(this.docker, ["start", containerId], signal);
      const version = await dockerOk(this.docker, ["exec", containerId, "/usr/local/bin/opencode", "--version"], signal);
      const digest = await dockerOk(this.docker, ["exec", containerId, "/usr/bin/sha256sum", "/usr/local/bin/opencode"], signal);
      const executableSha256 = digest.stdout.trim().split(/\s+/, 1)[0] ?? "";
      if (version.stdout.trim() !== OPENCODE_VERSION || executableSha256 !== OPENCODE_EXECUTABLE_SHA256) {
        throw new Error("OpenCode harness attestation failed");
      }
      measuredHarness = { version: OPENCODE_VERSION, executableSha256 };
      const run = await this.docker.runBrokered([
        "exec", "--interactive", containerId, "/usr/local/bin/node", "/runner/runner.mjs",
      ], signal, request.timeoutMs, async (rawTurn, exchangeSignal) => {
        const turn = TurnSchema.parse(rawTurn);
        turns += 1;
        if (turns > MAX_TURNS) throw new Error("OpenCode model turn limit exceeded");
        const remainingInputTokens = request.budget.maxInputTokens - inputTokens;
        const remainingOutputTokens = request.budget.maxOutputTokens - outputTokens;
        const remainingCostUsd = request.budget.maxCostUsd - costUsd;
        if (remainingInputTokens <= 0 || remainingOutputTokens <= 0 || remainingCostUsd < 0) {
          throw new Error("OpenCode model budget exhausted");
        }
        const brokerRequest = ModelBrokerRequestSchema.parse({
          modelId: request.transportModelId,
          prompt: turn.prompt,
          maxInputTokens: remainingInputTokens,
          maxOutputTokens: remainingOutputTokens,
          maxCostUsd: remainingCostUsd,
        });
        const receipt = ModelBrokerReceiptSchema.parse(await broker.execute(brokerRequest, exchangeSignal));
        if (receipt.model !== null && receipt.model.id !== request.transportModelId) {
          throw new Error("model broker receipt identity mismatch");
        }
        if (receipt.usage !== null) {
          inputTokens += receipt.usage.inputTokens;
          outputTokens += receipt.usage.outputTokens;
          costUsd += receipt.usage.costUsd;
        }
        if (inputTokens > request.budget.maxInputTokens || outputTokens > request.budget.maxOutputTokens || costUsd > request.budget.maxCostUsd) {
          throw new Error("OpenCode model budget exceeded");
        }
        brokerState.receipt = receipt;
        if (receipt.outcome === "uncertain") {
          brokerTransport = "uncertain";
          throw new Error("model broker transport is uncertain");
        }
        if (receipt.outcome !== "completed") throw new Error(`model broker ${receipt.outcome}`);
        return {
          type: "model_receipt",
          requestId: turn.requestId,
          receipt,
        };
      });
      const result = parseResult(run.stdout);
      outcome = run.exitCode === 0 && result.exitCode === 0 && brokerState.receipt?.outcome === "completed" ? "completed" : "failed";
      if (outcome === "completed") {
        evidence = [{ kind: request.role === "planner" ? "plan" : "research", summary: parseOpenCodeFinalAssistantText(result.stdout) }];
      }
    } catch (error) {
      if (error instanceof DockerBrokerTransportUncertainError) brokerTransport = "uncertain";
      outcome = brokerTransport === "uncertain" ? "failed" :
        brokerState.receipt?.outcome === "cancelled" ? "cancelled" :
        brokerState.receipt?.outcome === "timed_out" ? "timed_out" :
        error instanceof DockerCommandTimeoutError ? "timed_out" :
        error instanceof DockerCommandCancelledError || signal.aborted ? "cancelled" : "failed";
    } finally {
      const containerRemoval = await removeOwnedResource(this.docker, "container", containerId, containerName, request.capsuleId);
      const imageRemoval = await removeOwnedResource(this.docker, "image", imageId, imageName, request.capsuleId);
      const containerRemoved = containerRemoval.absent;
      const imageRemoved = imageRemoval.absent;
      cleanup = containerRemoved && imageRemoved ? "completed" : "uncertain";
      observe({ type: "cleanup_observed", payload: {
        capsuleId: request.capsuleId,
        resourceLabel: request.resources.resourceLabel,
        containerName,
        containerId,
        imageName,
        imageId,
        repositoryViewPath: repository,
        repositoryRevision: request.securityBoundary.repositoryRevision,
        outcome: cleanup,
        containerAbsent: containerRemoved,
        imageAbsent: imageRemoved,
        repositoryViewAbsent: false,
      } });
      rmSync(assets, { recursive: true, force: true });
    }
    if (cleanup === "uncertain" && outcome === "completed") outcome = "failed";
    return OpenCodeReadOnlyCapsuleResultSchema.parse({
      outcome,
      openCode: measuredHarness,
      model: brokerState.receipt?.model ?? null,
      evidence,
      cleanup,
      brokerTransport,
    });
  }

  async reconcile(prepared: {
    readonly capsuleId: string;
    readonly resourceLabel: string;
    readonly containerName: string;
    readonly containerId: string | null;
    readonly imageName: string;
    readonly imageId: string | null;
    readonly repositoryViewPath: string;
    readonly repositoryRevision: string | null;
  }): Promise<{ readonly outcome: "completed" | "uncertain"; readonly containerId: string | null; readonly imageId: string | null; readonly containerAbsent: boolean; readonly imageAbsent: boolean; readonly repositoryViewAbsent: boolean }> {
    const containers = await labeledIds(this.docker, "container", prepared.resourceLabel);
    const images = await labeledIds(this.docker, "image", prepared.resourceLabel);
    if (containers === null || images === null || containers.length > 1 || images.length > 1 ||
      (prepared.containerId !== null && containers.some((id) => id !== prepared.containerId)) ||
      (prepared.imageId !== null && images.some((id) => id !== prepared.imageId))) {
      return { outcome: "uncertain", containerId: prepared.containerId, imageId: prepared.imageId, containerAbsent: false, imageAbsent: false, repositoryViewAbsent: false };
    }
    if (prepared.containerId === null && containers[0] !== undefined &&
      await inspectOwnedName(this.docker, "container", prepared.containerName, prepared.capsuleId) !== containers[0]) {
      return { outcome: "uncertain", containerId: null, imageId: prepared.imageId, containerAbsent: false, imageAbsent: false, repositoryViewAbsent: false };
    }
    if (prepared.imageId === null && images[0] !== undefined &&
      await inspectOwnedName(this.docker, "image", prepared.imageName, prepared.capsuleId) !== images[0]) {
      return { outcome: "uncertain", containerId: prepared.containerId, imageId: null, containerAbsent: false, imageAbsent: false, repositoryViewAbsent: false };
    }
    const containerId = prepared.containerId ?? containers[0] ?? null;
    const imageId = prepared.imageId ?? images[0] ?? null;
    const containerRemoval = await removeOwnedResource(this.docker, "container", containerId, prepared.containerName, prepared.capsuleId);
    const imageRemoval = await removeOwnedResource(this.docker, "image", imageId, prepared.imageName, prepared.capsuleId);
    const containerAbsent = containerRemoval.absent;
    const imageAbsent = imageRemoval.absent;
    const repositoryViewAbsent = removeRepositoryView(prepared.repositoryViewPath);
    return {
      outcome: containerAbsent && imageAbsent && repositoryViewAbsent ? "completed" : "uncertain",
      containerId: containerRemoval.id, imageId: imageRemoval.id, containerAbsent, imageAbsent, repositoryViewAbsent,
    };
  }
}

function createRunnerAssets(request: OpenCodeReadOnlyCapsuleRequest): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-opencode-readonly-"));
  chmodSync(directory, 0o755);
  writeFileSync(path.join(directory, "Dockerfile"), openCodeWorkerDockerfile(request.capsuleId), { mode: 0o600 });
  writeFileSync(path.join(directory, "request.json"), JSON.stringify({ role: request.role, rolePrompt: request.rolePrompt }), { mode: 0o444 });
  writeFileSync(path.join(directory, "runner.mjs"), runnerSource(), { mode: 0o444 });
  return directory;
}

function runnerSource(): string {
  return `import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const input=JSON.parse(readFileSync("/runner/request.json","utf8"));
const pending=new Map();
createInterface({input:process.stdin}).on("line",line=>{const message=JSON.parse(line);const resolve=pending.get(message.requestId);if(resolve){pending.delete(message.requestId);resolve(message.receipt)}});
function text(messages){return messages.map(message=>message.role+": "+(typeof message.content==="string"?message.content:JSON.stringify(message.content))).join("\\n")}
function chunks(base,assistant){if(assistant.type==="text")return[{...base,object:"chat.completion.chunk",choices:[{index:0,delta:{role:"assistant",content:""},finish_reason:null,logprobs:null}]},{...base,object:"chat.completion.chunk",choices:[{index:0,delta:{content:assistant.text},finish_reason:null,logprobs:null}]},{...base,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop",logprobs:null}]}];return[{...base,object:"chat.completion.chunk",choices:[{index:0,delta:{role:"assistant",tool_calls:assistant.calls.map((call,index)=>({index,id:call.id,type:"function",function:{name:call.name,arguments:call.arguments}}))},finish_reason:null,logprobs:null}]},{...base,object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"tool_calls",logprobs:null}]}]}
const server=createServer((request,response)=>{let body="";request.on("data",chunk=>{body+=chunk;if(Buffer.byteLength(body)>2097152)request.destroy()});request.on("end",async()=>{try{const parsed=JSON.parse(body);const requestId=randomUUID();const receiptPromise=new Promise(resolve=>pending.set(requestId,resolve));process.stdout.write(JSON.stringify({type:"model_turn",requestId,prompt:text(parsed.messages??[])})+"\\n");const receipt=await receiptPromise;if(receipt.outcome!=="completed"||receipt.response===null)throw new Error("model turn failed");const base={id:"chatcmpl-"+requestId,created:Math.floor(Date.now()/1000),model:"brokered"};response.setHeader("content-type","text/event-stream; charset=utf-8");response.setHeader("connection","close");for(const chunk of chunks(base,receipt.response))response.write("data: "+JSON.stringify(chunk)+"\\n\\n");response.end("data: [DONE]\\n\\n")}catch{response.statusCode=502;response.end('{"error":"model broker failed"}')}})});
server.listen(4317,"127.0.0.1",()=>{const config=JSON.stringify({share:"disabled",autoupdate:false,formatter:false,lsp:false,mcp:{},plugin:[],instructions:[],model:"zentra/brokered",default_agent:"zentra-read-only",provider:{zentra:{npm:"@ai-sdk/openai-compatible",name:"Zentra Model Broker",options:{baseURL:"http://127.0.0.1:4317/v1",apiKey:"one-use-local-session"},models:{brokered:{name:"Brokered"}}}},agent:{"zentra-read-only":{mode:"primary",model:"zentra/brokered",permission:{"*":"deny",read:"allow",glob:"allow",grep:"allow",edit:"deny",bash:"deny",task:"deny",webfetch:"deny",external_directory:"deny"}}}});const child=spawn("/usr/local/bin/opencode",["run","--format","json","--model","zentra/brokered","--agent","zentra-read-only","--dir","/project",input.rolePrompt],{shell:false,env:{HOME:"/scratch",TMPDIR:"/scratch",PATH:"/usr/local/bin:/usr/bin:/bin",OPENCODE_CONFIG_CONTENT:config,OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_DEFAULT_PLUGINS:"1",OPENCODE_DISABLE_LSP_DOWNLOAD:"1"},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";const collect=(current,chunk)=>Buffer.byteLength(current)+chunk.length<=4194304?current+chunk.toString("utf8"):current;child.stdout.on("data",chunk=>stdout=collect(stdout,chunk));child.stderr.on("data",chunk=>stderr=collect(stderr,chunk));child.on("close",code=>{server.close();server.closeAllConnections();process.stdout.write(JSON.stringify({type:"opencode_result",exitCode:code??1,stdout,stderr})+"\\n",()=>process.exit(code??1))})});`;
}

function parseResult(output: string): z.infer<typeof ResultSchema> {
  const line = output.split(/\r?\n/).findLast((candidate) => candidate.includes('"type":"opencode_result"'));
  if (line === undefined) throw new Error("OpenCode capsule emitted no result");
  return ResultSchema.parse(JSON.parse(line));
}

export function parseOpenCodeFinalAssistantText(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  let currentTexts: string[] = [];
  let finalTexts: string[] | null = null;
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error("OpenCode emitted non-JSON evidence"); }
    if (typeof event !== "object" || event === null || Array.isArray(event)) throw new Error("OpenCode emitted invalid evidence");
    const record = event as Record<string, unknown>;
    if (record["type"] === "step_start") currentTexts = [];
    if (record["type"] === "step_finish") {
      finalTexts = currentTexts;
      currentTexts = [];
    }
    if (record["type"] === "text") {
      const part = record["part"];
      if (typeof part !== "object" || part === null || Array.isArray(part) || (part as Record<string, unknown>)["type"] !== "text") {
        throw new Error("OpenCode emitted invalid assistant text evidence");
      }
      const text = (part as Record<string, unknown>)["text"];
      if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) throw new Error("OpenCode assistant text evidence is invalid");
      currentTexts.push(text);
    }
  }
  if (currentTexts.length !== 0 || finalTexts?.length !== 1) {
    throw new Error("OpenCode final assistant evidence is partial or ambiguous");
  }
  return finalTexts[0]!;
}

async function dockerOk(docker: DockerClient, args: readonly string[], signal: AbortSignal) {
  const result = await docker.run(args, signal);
  if (result.exitCode !== 0) throw new Error("Docker operation failed");
  return result;
}

async function removeOwnedResource(
  docker: DockerClient,
  kind: "container" | "image",
  knownId: string | null,
  deterministicName: string,
  capsuleId: string,
): Promise<{ readonly absent: boolean; readonly id: string | null }> {
  try {
    let id = knownId;
    if (id !== null) {
      const ownership = await inspectOwnedIdentifier(docker, kind, id, deterministicName, capsuleId);
      if (ownership === "collision") return { absent: false, id };
      if (ownership === "absent") {
        const nameOwnership = await inspectOwnedName(docker, kind, deterministicName, capsuleId);
        return { absent: nameOwnership === "absent", id };
      }
    } else {
      const ownership = await inspectOwnedName(docker, kind, deterministicName, capsuleId);
      if (ownership === "collision") return { absent: false, id: null };
      if (ownership === "absent") return { absent: true, id: null };
      id = ownership;
    }
    const removeArgs = kind === "container" ? ["rm", "--force", id] : ["image", "rm", "--force", id];
    const removed = await docker.run(removeArgs, new AbortController().signal, 30_000);
    if (removed.exitCode !== 0 && !/(?:No such|not found)/i.test(removed.stderr)) return { absent: false, id };
    const idAbsent = await inspectAbsent(docker, kind, id);
    const nameAbsent = await inspectAbsent(docker, kind, deterministicName);
    return { absent: idAbsent && nameAbsent, id };
  } catch {
    return { absent: false, id: knownId };
  }
}

async function inspectOwnedIdentifier(
  docker: DockerClient,
  kind: "container" | "image",
  identifier: string,
  deterministicName: string,
  capsuleId: string,
): Promise<"absent" | "collision" | string> {
  const args = kind === "container" ? ["inspect", identifier] : ["image", "inspect", identifier];
  const result = await docker.run(args, new AbortController().signal, 30_000);
  if (result.exitCode !== 0) return /(?:No such|not found)/i.test(result.stderr) ? "absent" : "collision";
  return parseOwnedInspect(result.stdout, kind, deterministicName, capsuleId, identifier);
}

async function inspectOwnedName(
  docker: DockerClient,
  kind: "container" | "image",
  name: string,
  capsuleId: string,
): Promise<"absent" | "collision" | string> {
  const args = kind === "container" ? ["inspect", name] : ["image", "inspect", name];
  const result = await docker.run(args, new AbortController().signal, 30_000);
  if (result.exitCode !== 0) return /(?:No such|not found)/i.test(result.stderr) ? "absent" : "collision";
  return parseOwnedInspect(result.stdout, kind, name, capsuleId, null);
}

function parseOwnedInspect(
  output: string,
  kind: "container" | "image",
  name: string,
  capsuleId: string,
  expectedId: string | null,
): "collision" | string {
  const parsed = JSON.parse(output) as readonly {
    readonly Id?: string;
    readonly Name?: string;
    readonly RepoTags?: readonly string[];
    readonly Config?: { readonly Labels?: Readonly<Record<string, string>> };
  }[];
  if (parsed.length !== 1) return "collision";
  const item = parsed[0]!;
  const validId = kind === "container" ? /^[a-f0-9]{64}$/ : /^sha256:[a-f0-9]{64}$/;
  const identityMatches = kind === "container" ? item.Name === `/${name}` : item.RepoTags?.includes(name) === true;
  if (!validId.test(item.Id ?? "") || (expectedId !== null && item.Id !== expectedId) ||
    !identityMatches || item.Config?.Labels?.["org.zentra.capsule-id"] !== capsuleId) return "collision";
  return item.Id!;
}

async function inspectAbsent(docker: DockerClient, kind: "container" | "image", identifier: string): Promise<boolean> {
  const args = kind === "container" ? ["inspect", identifier] : ["image", "inspect", identifier];
  const result = await docker.run(args, new AbortController().signal, 30_000);
  return result.exitCode !== 0 && /(?:No such|not found)/i.test(result.stderr);
}

async function labeledIds(
  docker: DockerClient,
  kind: "container" | "image",
  label: string,
): Promise<readonly string[] | null> {
  try {
    const args = kind === "container"
      ? ["container", "ls", "--all", "--filter", `label=${label}`, "--quiet", "--no-trunc"]
      : ["image", "ls", "--filter", `label=${label}`, "--quiet", "--no-trunc"];
    const result = await docker.run(args, new AbortController().signal, 30_000);
    if (result.exitCode !== 0) return null;
    const ids = [...new Set(result.stdout.split(/\s+/).filter(Boolean))];
    const valid = kind === "container" ? /^[a-f0-9]{64}$/ : /^sha256:[a-f0-9]{64}$/;
    return ids.every((id) => valid.test(id)) ? ids : null;
  } catch {
    return null;
  }
}

function removeRepositoryView(viewPath: string): boolean {
  const parent = controlledViewRoot();
  if (path.dirname(viewPath) !== parent || !/^[a-f0-9]{64}$/.test(path.basename(viewPath))) return false;
  try {
    rmSync(viewPath, { recursive: true, force: true });
    return !statExists(viewPath);
  } catch {
    return false;
  }
}

function statExists(candidate: string): boolean {
  try { statSync(candidate); return true; } catch { return false; }
}

function canonicalDirectory(candidate: string): string {
  const canonical = realpathSync.native(candidate);
  if (candidate !== canonical || !statSync(canonical).isDirectory()) throw new Error("OpenCode repository must be canonical");
  return canonical;
}
