import { randomUUID } from "node:crypto";
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { EventJournal } from "../journal/journal.js";
import { parseCapsuleEventPayload, type CapsuleEventType } from "./capsule-events.js";
import {
  DockerClient,
  DockerCommandCancelledError,
  DockerCommandTimeoutError,
  DockerOutputLimitError,
  type DockerCommandResult,
} from "./docker-client.js";
import { loadCapsulePolicy, publicCapsulePolicySummary, type CapsulePolicy } from "./egress-policy.js";

export const NODE_BASE_INDEX_DIGEST = "sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89";
export const NODE_BASE_ARM64_DIGEST = "sha256:af442a7998c3f3a985309cfa7b709ea8d3f1911ea19a598f1f1a2e158273c73e";
export const MITMPROXY_INDEX_DIGEST = "sha256:743b6cdc817211d64bc269f5defacca8d14e76e647fc474e5c7244dbcb645141";
export const MITMPROXY_ARM64_DIGEST = "sha256:96956193a230561f100083fd55bfeca839912830325c4504cefc7dc8d8b3bc9f";
export const OPENCODE_VERSION = "1.18.1";
export const OPENCODE_EXECUTABLE_SHA256 = "b83305b14e233483aba7027a9dd6a18716b8786b3fe13261e0afce96f4418b17";

const NODE_BASE = `node:24.2.0-bookworm-slim@${NODE_BASE_INDEX_DIGEST}`;
const PROXY_IMAGE = `mitmproxy/mitmproxy:12.2.1@${MITMPROXY_INDEX_DIGEST}`;
const SCRATCH_BYTES = 16 * 1024 * 1024;
const TOTAL_CAPSULE_TIMEOUT_MS = 8 * 60_000;
const MAX_PROXY_OBSERVATIONS = 256;

export interface CapsuleConformanceRequest {
  readonly capsuleId: string;
  readonly policyPath: string;
  readonly projectPath: string;
  readonly signal: AbortSignal;
}

export interface CapsuleConformanceReport {
  readonly capsuleId: string;
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed";
  readonly workerImageDigest: string | null;
  readonly proxyImageDigest: string | null;
  readonly openCodeVersion: string | null;
  readonly openCodeExecutableSha256: string | null;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly cleanup: "completed" | "uncertain";
  readonly policy: Record<string, unknown>;
}

interface ResourceIds {
  proxyContainer: string | null;
  workerContainer: string | null;
  internalNetwork: string | null;
  egressNetwork: string | null;
}

export class DockerCapsuleConformance {
  constructor(
    private readonly journal: EventJournal,
    private readonly docker = new DockerClient(),
    private readonly totalTimeoutMs = TOTAL_CAPSULE_TIMEOUT_MS,
  ) {}

  async run(request: CapsuleConformanceRequest): Promise<CapsuleConformanceReport> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.capsuleId)) throw new Error("invalid capsule identity");
    if (this.journal.readStream(request.capsuleId).length !== 0) throw new Error("capsule stream already exists");
    const policy = loadCapsulePolicy(request.policyPath);
    const projectPath = canonicalDirectory(request.projectPath);
    const hostIdentity = dockerHostIdentity();
    const suffix = randomUUID().replaceAll("-", "");
    const names = {
      workerImage: `zentra-worker:${suffix}`,
      worker: `zentra-worker-${suffix}`,
      proxy: `zentra-proxy-${suffix}`,
      internalNetwork: `zentra-internal-${suffix}`,
      egressNetwork: `zentra-egress-${suffix}`,
    };
    const assets = createAssets(policy, request.capsuleId);
    const ids: ResourceIds = { proxyContainer: null, workerContainer: null, internalNetwork: null, egressNetwork: null };
    const checks: Record<string, boolean> = {};
    let version = 0;
    let workerImageDigest: string | null = null;
    let proxyImageDigest: string | null = null;
    let openCodeVersion: string | null = null;
    let openCodeExecutableSha256: string | null = null;
    let cleanup: "completed" | "uncertain" = "completed";
    let outcome: CapsuleConformanceReport["outcome"] = "failed";
    let observationsCollected = false;
    let proxyObservationsAppended = false;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), this.totalTimeoutMs);
    const signal = AbortSignal.any([request.signal, deadline.signal]);

    const append = (type: CapsuleEventType, payload: unknown): void => {
      const safePayload = parseCapsuleEventPayload(type, payload);
      const stored = this.journal.append(request.capsuleId, version, [{
        streamId: request.capsuleId, type, payload: safePayload, causationId: null, correlationId: request.capsuleId,
      }]);
      version = stored.at(-1)?.streamVersion ?? version;
    };
    const observeCheck = (name: string, passed: boolean): void => {
      checks[name] = passed;
      append("capsule.check_observed", { name, passed });
    };
    const collectProxy = async (): Promise<boolean> => {
      if (proxyObservationsAppended || ids.proxyContainer === null) return ids.proxyContainer === null;
      try {
        const logs = await this.docker.run(["logs", ids.proxyContainer], new AbortController().signal, 15_000);
        for (const interaction of parseProxyInteractions(`${logs.stdout}\n${logs.stderr}`)) {
          append("capsule.proxy_interaction_observed", interaction);
        }
        proxyObservationsAppended = true;
        return true;
      } catch {
        return false;
      }
    };

    append("capsule.started", {
      projectAccess: "read_only", scratchBytes: SCRATCH_BYTES, policy: publicCapsulePolicySummary(policy),
      githubEffects: policy.brokers.github === "host" ? "host_broker_only" : "disabled",
      modelEffects: "disabled_without_broker", resourceNamespace: suffix,
    });
    try {
      const runtime = await attestDockerRuntime(this.docker, signal);
      append("capsule.runtime_attested", runtime);
      await assertArm64Manifest(this.docker, PROXY_IMAGE, MITMPROXY_ARM64_DIGEST, signal);
      await assertArm64Manifest(this.docker, NODE_BASE, NODE_BASE_ARM64_DIGEST, signal);
      await ok(this.docker, ["pull", "--platform", "linux/arm64", PROXY_IMAGE], signal);
      const proxyInspect = firstInspect<DockerImageInspect>(await ok(this.docker, ["image", "inspect", PROXY_IMAGE], signal));
      assertImagePlatform(proxyInspect, MITMPROXY_INDEX_DIGEST);
      proxyImageDigest = MITMPROXY_ARM64_DIGEST;
      append("capsule.image_attested", {
        image: "policy_proxy", approvedIndexDigest: MITMPROXY_INDEX_DIGEST,
        approvedPlatformDigest: MITMPROXY_ARM64_DIGEST, measuredLocalImageId: proxyInspect.Id,
        platform: "linux/arm64",
      });

      await ok(this.docker, ["build", "--platform", "linux/arm64", "--pull", "--tag", names.workerImage, assets.directory], signal);
      const workerInspect = firstInspect<DockerImageInspect>(await ok(this.docker, ["image", "inspect", names.workerImage], signal));
      workerImageDigest = workerInspect.Id;
      if (
        workerInspect.Os !== "linux" || workerInspect.Architecture !== "arm64" ||
        workerInspect.Config?.Labels?.["org.zentra.node-base-digest"] !== NODE_BASE_INDEX_DIGEST
      ) throw new Error("worker image attestation failed");
      append("capsule.image_attested", {
        image: "worker", measuredImageId: workerImageDigest, approvedBaseIndexDigest: NODE_BASE_INDEX_DIGEST,
        approvedBasePlatformDigest: NODE_BASE_ARM64_DIGEST, platform: "linux/arm64",
      });

      ids.internalNetwork = exactDockerId((await ok(this.docker, ["network", "create", "--label", `org.zentra.capsule-id=${request.capsuleId}`, "--internal", names.internalNetwork], signal)).stdout);
      ids.egressNetwork = exactDockerId((await ok(this.docker, ["network", "create", "--label", `org.zentra.capsule-id=${request.capsuleId}`, names.egressNetwork], signal)).stdout);
      ids.proxyContainer = exactDockerId((await ok(this.docker, [
        "run", "--detach", "--name", names.proxy, "--network", ids.egressNetwork,
        "--label", `org.zentra.capsule-id=${request.capsuleId}`,
        "--add-host", "private-alias.test:127.0.0.1", "--user", hostIdentity,
        "--entrypoint", "/usr/local/bin/mitmdump", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216", "--mount", `type=bind,src=${assets.certPath},dst=/certs`,
        "--mount", `type=bind,src=${assets.addonPath},dst=/policy/addon.py,readonly`,
        "--mount", `type=bind,src=${assets.policyPath},dst=/policy/policy.json,readonly`,
        PROXY_IMAGE, "--listen-host", "0.0.0.0", "--listen-port", "8080", "--set", "confdir=/certs",
        "--set", "connection_strategy=lazy", "--set", "rawtcp=false", "--set", "termlog_verbosity=error", "--set", "flow_detail=0", "-s", "/policy/addon.py",
      ], signal)).stdout);
      await ok(this.docker, ["network", "connect", "--alias", "policy-proxy", ids.internalNetwork, ids.proxyContainer], signal);
      await waitForCertificate(assets.certPath, signal);
      ids.workerContainer = exactDockerId((await ok(this.docker, workerCreateArgs(names, projectPath, assets.certPath, ids.internalNetwork, request.capsuleId), signal)).stdout);
      await ok(this.docker, ["start", ids.workerContainer], signal);
      const containerInspect = firstInspect<DockerContainerInspect>(await ok(this.docker, ["inspect", ids.workerContainer], signal));
      assertWorkerContainment(containerInspect, ids.workerContainer, ids.internalNetwork, projectPath);
      observeCheck("workerContainment", true);
      append("capsule.resources_prepared", {
        proxyContainerId: ids.proxyContainer, workerContainerId: ids.workerContainer,
        internalNetworkId: ids.internalNetwork, egressNetworkId: ids.egressNetwork,
      });
      append("capsule.worker_attested", {
        readOnlyRoot: true, user: "10001:10001", projectMount: "read_only", scratchBytes: SCRATCH_BYTES,
        capabilities: "dropped", noNewPrivileges: true, directEgress: "internal_network_only",
        inheritedSecrets: false, dockerSocket: false,
      });

      const worker = ids.workerContainer;
      observeCheck("projectReadOnly", !(await succeeds(this.docker, worker, ["/usr/bin/touch", "/project/should-not-exist"], signal)));
      observeCheck("projectSymlinkSafe", !(await succeeds(this.docker, worker, ["/usr/bin/touch", "/project/.zentra-symlink-probe"], signal)));
      observeCheck("scratchWritable", await succeeds(this.docker, worker, ["/bin/dd", "if=/dev/zero", "of=/scratch/probe", "bs=1024", "count=1"], signal));
      await exec(this.docker, worker, ["/bin/cp", "/bin/true", "/scratch/noexec"], signal);
      observeCheck("scratchNoexec", !(await succeeds(this.docker, worker, ["/scratch/noexec"], signal)));
      observeCheck("scratchNosuid", containerInspect.HostConfig?.Tmpfs?.["/scratch"]?.includes("nosuid") === true);
      observeCheck("scratchBounded", !(await succeeds(this.docker, worker, ["/bin/dd", "if=/dev/zero", "of=/scratch/full", "bs=1048576", "count=17"], signal)));
      observeCheck("directInternetDenied", !(await curl(this.docker, worker, ["--noproxy", "*", "--connect-timeout", "3", "https://example.com/"], signal)));
      observeCheck("directHostDenied", !(await curl(this.docker, worker, ["--noproxy", "*", "--connect-timeout", "3", "http://host.docker.internal/"], signal)));
      observeCheck("directGatewayDenied", !(await curl(this.docker, worker, ["--noproxy", "*", "--connect-timeout", "3", "http://172.17.0.1/"], signal)));
      observeCheck("directPrivateDenied", !(await curl(this.docker, worker, ["--noproxy", "*", "--connect-timeout", "3", "http://10.0.0.1/"], signal)));
      const ca = ["--cacert", "/certs/mitmproxy-ca-cert.pem"];
      observeCheck("proxyReadAllowed", await curl(this.docker, worker, [...ca, "https://example.com/"], signal));
      observeCheck("proxyPlaintextDenied", !(await curl(this.docker, worker, ["http://example.com/"], signal)));
      observeCheck("proxyWriteDenied", !(await curl(this.docker, worker, [...ca, "--request", "POST", "https://example.com/"], signal)));
      observeCheck("proxyUpgradeDenied", !(await curl(this.docker, worker, [...ca, "--http1.1", "--header", "Connection: Upgrade", "--header", "Upgrade: websocket", "https://example.com/"], signal)));
      observeCheck("proxyConnectDenied", await explicitConnectDenied(this.docker, worker, "127.0.0.1", 22, signal));
      observeCheck("proxyDisallowedConnectDenied", await explicitConnectDenied(this.docker, worker, "iana.org", 443, signal));
      observeCheck("proxyAllowedConnectOpaqueDenied", await opaqueConnectDenied(this.docker, worker, "example.com", signal));
      observeCheck("proxyReadBodyDenied", !(await curl(this.docker, worker, [...ca, "--request", "GET", "--data", "x", "https://example.com/"], signal)));
      observeCheck("proxyPrivateResolutionDenied", !(await curl(this.docker, worker, [...ca, "https://private-alias.test/"], signal)));
      const openCode = await exec(this.docker, worker, ["/usr/local/bin/opencode", "--version"], signal);
      openCodeVersion = openCode.stdout.trim();
      observeCheck("openCodeVersion", openCode.exitCode === 0 && openCodeVersion === OPENCODE_VERSION);
      const digest = await exec(this.docker, worker, ["/usr/bin/sha256sum", "/usr/local/bin/opencode"], signal);
      openCodeExecutableSha256 = digest.stdout.trim().split(/\s+/, 1)[0] ?? null;
      observeCheck("openCodeExecutableDigest", digest.exitCode === 0 && openCodeExecutableSha256 === OPENCODE_EXECUTABLE_SHA256);
      if (checks.openCodeVersion && checks.openCodeExecutableDigest) append("capsule.harness_attested", {
        harness: "opencode", version: openCodeVersion, executableSha256: openCodeExecutableSha256,
      });
      observationsCollected = await collectProxy();
      if (!observationsCollected || Object.values(checks).some((passed) => !passed)) throw new Error("capsule conformance failed");
      outcome = "completed";
    } catch (error) {
      outcome = canonicalOutcome(error, request.signal, deadline.signal);
      append("capsule.failure_observed", { outcome, reason: failureReason(error, outcome, deadline.signal) });
    } finally {
      clearTimeout(deadlineTimer);
      if (!observationsCollected) observationsCollected = await collectProxy();
      const reconciliation = await reconcileResources(this.docker, names, request.capsuleId, ids, workerImageDigest);
      ids.workerContainer = reconciliation.workerContainer;
      ids.proxyContainer = reconciliation.proxyContainer;
      ids.internalNetwork = reconciliation.internalNetwork;
      ids.egressNetwork = reconciliation.egressNetwork;
      workerImageDigest = reconciliation.workerImage;
      const containerRemoval = await Promise.all([
        removeById(this.docker, "container", ids.workerContainer), removeById(this.docker, "container", ids.proxyContainer),
      ]);
      const networkRemoval = await Promise.all([
        removeById(this.docker, "network", ids.internalNetwork), removeById(this.docker, "network", ids.egressNetwork),
      ]);
      const imageRemoval = await removeById(this.docker, "image", workerImageDigest);
      const containersAbsent = await allKnownAbsent(this.docker, "container", [names.worker!, names.proxy!]);
      const networksAbsent = await allKnownAbsent(this.docker, "network", [names.internalNetwork!, names.egressNetwork!]);
      const imagesAbsent = await allKnownAbsent(this.docker, "image", [names.workerImage!]);
      cleanup = reconciliation.certain && containerRemoval.every(Boolean) && networkRemoval.every(Boolean) && imageRemoval && containersAbsent && networksAbsent && imagesAbsent && observationsCollected
        ? "completed"
        : "uncertain";
      append("capsule.cleanup_observed", { outcome: cleanup, containersAbsent, networksAbsent, imagesAbsent, observationsCollected });
      if (cleanup === "uncertain" && outcome === "completed") outcome = "failed";
      append(`capsule.${outcome}`, { outcome, cleanup });
      rmSync(assets.directory, { recursive: true, force: true });
    }

    return Object.freeze({ capsuleId: request.capsuleId, outcome, workerImageDigest, proxyImageDigest,
      openCodeVersion, openCodeExecutableSha256, checks: Object.freeze({ ...checks }), cleanup,
      policy: publicCapsulePolicySummary(policy) });
  }
}

interface DockerImageInspect { readonly Id: string; readonly RepoDigests?: readonly string[]; readonly Architecture?: string; readonly Os?: string; readonly Config?: { readonly Labels?: Readonly<Record<string, string>> } }
interface DockerContainerInspect { readonly Id?: string; readonly Config?: { readonly User?: string; readonly Env?: readonly string[]; readonly Labels?: Readonly<Record<string, string>> }; readonly HostConfig?: { readonly ReadonlyRootfs?: boolean; readonly CapDrop?: readonly string[]; readonly SecurityOpt?: readonly string[]; readonly PidsLimit?: number; readonly Memory?: number; readonly NanoCpus?: number; readonly Tmpfs?: Readonly<Record<string, string>>; readonly NetworkMode?: string }; readonly Mounts?: readonly { readonly Source?: string; readonly Destination?: string; readonly RW?: boolean }[] }
interface DockerNetworkInspect { readonly Id?: string; readonly Labels?: Readonly<Record<string, string>> }
interface CapsuleAssets { readonly directory: string; readonly addonPath: string; readonly policyPath: string; readonly certPath: string }

function createAssets(policy: CapsulePolicy, capsuleId: string): CapsuleAssets {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-capsule-assets-"));
  try {
    const addonPath = path.join(directory, "addon.py");
    const policyPath = path.join(directory, "policy.json");
    const certPath = path.join(directory, "certs");
    mkdirSync(certPath, { mode: 0o755 });
    chmodSync(certPath, 0o755);
    writeFileSync(path.join(directory, "Dockerfile"), openCodeWorkerDockerfile(capsuleId), { encoding: "utf8", mode: 0o600 });
    writeFileSync(addonPath, proxyAddon(), { encoding: "utf8", mode: 0o600 });
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, { encoding: "utf8", mode: 0o600 });
    return { directory, addonPath, policyPath, certPath };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function openCodeWorkerDockerfile(capsuleId: string): string {
  return `FROM ${NODE_BASE}\nLABEL org.zentra.node-base-digest="${NODE_BASE_INDEX_DIGEST}" org.zentra.capsule-id="${capsuleId}"\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl coreutils && rm -rf /var/lib/apt/lists/*\nRUN npm install --global opencode-ai@${OPENCODE_VERSION} && test "$(opencode --version)" = "${OPENCODE_VERSION}" && printf '%s  %s\\n' "${OPENCODE_EXECUTABLE_SHA256}" /usr/local/bin/opencode | sha256sum --check --strict -\nRUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin zentra\nUSER 10001:10001\nWORKDIR /scratch\n`;
}

export function proxyAddon(): string {
  return `import ipaddress\nimport json\nimport socket\nfrom urllib.parse import urlsplit\nfrom mitmproxy import http, tcp\nwith open('/policy/policy.json', encoding='utf-8') as source:\n    POLICY = json.load(source)\nREAD_MODE = POLICY['reads']['mode']\nREAD_DOMAINS = set(POLICY['reads'].get('domains', []))\nREAD_METHODS = set(POLICY['reads']['methods'])\ndef emit(scheme, method, host, allowed, reason):\n    safe_method = method if method in ('GET','HEAD','POST','CONNECT','UPGRADE') else 'OTHER'\n    safe_host = (host or 'unknown').lower().rstrip('.')\n    print(json.dumps({'zentra_proxy_event':1,'scheme':scheme if scheme in ('http','https') else 'unknown','method':safe_method,'host':safe_host,'allowed':allowed,'reason':reason}), flush=True)\ndef deny(flow, reason, scheme, method, host):\n    flow.response = http.Response.make(403, b'{"error":"denied"}', {'Content-Type':'application/json','Connection':'close'})\n    emit(scheme, method, host, False, reason)\ndef domain_allowed(host):\n    return READ_MODE == 'all_public_domains' or host in READ_DOMAINS\ndef resolve_public(host, port):\n    try:\n        addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)})\n    except (OSError, socket.gaierror):\n        return None, 'resolution_failed'\n    if not addresses:\n        return None, 'resolution_failed'\n    for address in addresses:\n        ip = ipaddress.ip_address(address)\n        if not ip.is_global or ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:\n            return None, 'private_target_denied'\n    return addresses[0], None\ndef http_connect(flow: http.HTTPFlow) -> None:\n    host = flow.request.pretty_host.lower().rstrip('.')\n    if flow.request.port != 443: return deny(flow, 'connect_denied', 'https', 'CONNECT', host)\n    if not domain_allowed(host): return deny(flow, 'domain_not_allowed', 'https', 'CONNECT', host)\n    _, reason = resolve_public(host, flow.request.port)\n    if reason: return deny(flow, reason, 'https', 'CONNECT', host)\ndef request(flow: http.HTTPFlow) -> None:\n    host = flow.request.pretty_host.lower().rstrip('.')\n    method = flow.request.method.upper()\n    scheme = flow.request.scheme.lower()\n    if method == 'CONNECT': return deny(flow, 'connect_denied', scheme, method, host)\n    if scheme != 'https': return deny(flow, 'plaintext_http_denied', scheme, method, host)\n    if flow.request.headers.get('upgrade') or 'upgrade' in flow.request.headers.get('connection','').lower(): return deny(flow, 'upgrade_denied', scheme, 'UPGRADE', host)\n    if method not in READ_METHODS: return deny(flow, 'method_denied', scheme, method, host)\n    if flow.request.raw_content: return deny(flow, 'read_body_denied', scheme, method, host)\n    if not domain_allowed(host): return deny(flow, 'domain_not_allowed', scheme, method, host)\n    address, reason = resolve_public(host, flow.request.port)\n    if reason: return deny(flow, reason, scheme, method, host)\n    flow.server_conn.address = (address, flow.request.port)\n    emit(scheme, method, host, True, 'configured_read')\ndef response(flow: http.HTTPFlow) -> None:\n    if flow.response is None or flow.response.status_code not in (301,302,303,307,308): return\n    location = flow.response.headers.get('location')\n    if not location: return\n    target = urlsplit(location)\n    if not target.scheme and not target.hostname: return\n    host = (target.hostname or '').lower().rstrip('.')\n    if target.scheme.lower() != 'https': return deny(flow, 'plaintext_http_denied', 'http', flow.request.method.upper(), host or flow.request.pretty_host.lower())\n    if not domain_allowed(host): return deny(flow, 'domain_not_allowed', 'https', flow.request.method.upper(), host)\n    _, reason = resolve_public(host, target.port or 443)\n    if reason: return deny(flow, reason, 'https', flow.request.method.upper(), host)\ndef kill_tcp(flow: tcp.TCPFlow):\n    address = flow.server_conn.address\n    host = str(address[0]) if address else 'unknown'\n    emit('unknown', 'OTHER', host, False, 'raw_tcp_denied')\n    flow.kill()\ndef tcp_start(flow: tcp.TCPFlow):\n    kill_tcp(flow)\ndef tcp_message(flow: tcp.TCPFlow):\n    kill_tcp(flow)\n`;
}

function workerCreateArgs(names: Record<string, string>, projectPath: string, certPath: string, networkId: string, capsuleId: string): readonly string[] {
  return ["create", "--name", names.worker!, "--network", networkId, "--label", `org.zentra.capsule-id=${capsuleId}`, "--read-only", "--user", "10001:10001",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5",
    "--stop-timeout", "1", "--tmpfs", `/scratch:rw,noexec,nosuid,size=${SCRATCH_BYTES},mode=1777`,
    "--mount", `type=bind,src=${projectPath},dst=/project,readonly`, "--mount", `type=bind,src=${certPath},dst=/certs,readonly`,
    "--env", "HOME=/scratch", "--env", "TMPDIR=/scratch", "--env", "HTTP_PROXY=http://policy-proxy:8080",
    "--env", "HTTPS_PROXY=http://policy-proxy:8080", "--env", "http_proxy=http://policy-proxy:8080",
    "--env", "https_proxy=http://policy-proxy:8080", names.workerImage!, "/bin/sleep", "600"];
}

async function attestDockerRuntime(docker: DockerClient, signal: AbortSignal): Promise<Record<string, unknown>> {
  const context = (await ok(docker, ["context", "show"], signal)).stdout.trim();
  const measured = JSON.parse((await ok(docker, ["version", "--format", "{{json .}}"], signal)).stdout) as { Client?: { Version?: string }; Server?: { Version?: string; Arch?: string; Platform?: { Name?: string } } };
  if (context !== "desktop-linux" || measured.Server?.Arch !== "arm64" || !measured.Server.Platform?.Name?.startsWith("Docker Desktop") || !measured.Client?.Version || !measured.Server.Version) throw new Error("Docker runtime attestation failed");
  return { dockerExecutableApproved: "/Applications/Docker.app/Contents/Resources/bin/docker", dockerExecutableMeasured: docker.executable,
    dockerContextApproved: "desktop-linux", dockerContextMeasured: context, clientVersionMeasured: measured.Client.Version,
    serverVersionMeasured: measured.Server.Version, serverPlatformMeasured: measured.Server.Platform.Name, serverArchitectureMeasured: measured.Server.Arch };
}

function assertWorkerContainment(inspect: DockerContainerInspect, id: string, networkId: string, projectPath: string): void {
  const host = inspect.HostConfig;
  const mounts = inspect.Mounts ?? [];
  const env = inspect.Config?.Env ?? [];
  const project = mounts.find((mount) => mount.Destination === "/project");
  const certs = mounts.find((mount) => mount.Destination === "/certs");
  const allowedEnv = ["HOME=/scratch","TMPDIR=/scratch","HTTP_PROXY=http://policy-proxy:8080","HTTPS_PROXY=http://policy-proxy:8080","http_proxy=http://policy-proxy:8080","https_proxy=http://policy-proxy:8080","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","NODE_VERSION=24.2.0","YARN_VERSION=1.22.22"];
  if (inspect.Id !== id || inspect.Config?.User !== "10001:10001" || host?.ReadonlyRootfs !== true || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges") || host.PidsLimit !== 64 || host.Memory !== 256 * 1024 * 1024 || host.NanoCpus !== 500_000_000 || host.NetworkMode !== networkId || !host.Tmpfs?.["/scratch"]?.includes(`size=${SCRATCH_BYTES}`) || !host.Tmpfs?.["/scratch"]?.includes("noexec") || !host.Tmpfs?.["/scratch"]?.includes("nosuid") || project?.Source !== projectPath || project.RW !== false || certs?.RW !== false || mounts.some((mount) => mount.Destination === "/var/run/docker.sock") || env.some((entry) => !allowedEnv.includes(entry))) throw new Error("worker containment attestation failed");
}

async function waitForCertificate(certPath: string, signal: AbortSignal): Promise<void> {
  const candidate = path.join(certPath, "mitmproxy-ca-cert.pem");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (signal.aborted) throw new DockerCommandCancelledError();
    try { if (lstatSync(candidate).isFile() && realpathSync.native(candidate) === path.join(realpathSync.native(certPath), path.basename(candidate))) return; } catch { /* asynchronous creation */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("proxy certificate attestation failed");
}

async function exec(docker: DockerClient, id: string, args: readonly string[], signal: AbortSignal): Promise<DockerCommandResult> { return docker.run(["exec", id, ...args], signal, 30_000); }
async function succeeds(docker: DockerClient, id: string, args: readonly string[], signal: AbortSignal): Promise<boolean> { return (await exec(docker, id, args, signal)).exitCode === 0; }
async function curl(docker: DockerClient, id: string, args: readonly string[], signal: AbortSignal): Promise<boolean> { return succeeds(docker, id, ["/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "8", ...args], signal); }
async function explicitConnectDenied(docker: DockerClient, id: string, host: string, port: number, signal: AbortSignal): Promise<boolean> {
  const authority = `${host}:${port}`;
  const source = `import net from 'node:net';const s=net.createConnection(8080,'policy-proxy');let d='';s.setTimeout(5000);s.on('connect',()=>s.write('CONNECT ${authority} HTTP/1.1\\r\\nHost: ${authority}\\r\\n\\r\\nARBITRARY-BYTES'));s.on('data',c=>d+=c);s.on('end',()=>process.exit(/^HTTP\\/1\\.[01] 200/.test(d)?9:0));s.on('timeout',()=>process.exit(8));s.on('error',()=>process.exit(7));`;
  return succeeds(docker, id, ["/usr/local/bin/node", "--input-type=module", "--eval", source], signal);
}
async function opaqueConnectDenied(docker: DockerClient, id: string, host: string, signal: AbortSignal): Promise<boolean> {
  const source = `import net from 'node:net';const s=net.createConnection(8080,'policy-proxy');let d='';let sent=false;let opaqueSent=false;let finished=false;const done=c=>{if(finished)return;finished=true;s.destroy();process.exit(c)};s.setTimeout(5000);s.on('connect',()=>{sent=true;s.write('CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n')});s.on('data',c=>{d+=c;if(!opaqueSent&&/^HTTP\\/1\\.[01] 200/.test(d)&&d.includes('\\r\\n\\r\\n')){opaqueSent=true;d='';s.write('ARBITRARY-OPAQUE-BYTES')}else if(opaqueSent&&d.includes('ARBITRARY-OPAQUE-BYTES'))done(9)});s.on('end',()=>done(sent?0:7));s.on('close',()=>done(sent?0:7));s.on('timeout',()=>done(opaqueSent?0:8));s.on('error',()=>done(sent?0:7));`;
  return succeeds(docker, id, ["/usr/local/bin/node", "--input-type=module", "--eval", source], signal);
}
async function ok(docker: DockerClient, args: readonly string[], signal: AbortSignal): Promise<DockerCommandResult> { const result = await docker.run(args, signal); if (result.exitCode !== 0) throw new Error("Docker operation failed"); return result; }

async function removeById(docker: DockerClient, kind: "container" | "network" | "image", id: string | null): Promise<boolean> {
  if (id === null) return true;
  const args = kind === "container" ? ["rm", "--force", id] : kind === "network" ? ["network", "rm", id] : ["image", "rm", "--force", id];
  try { return (await docker.run(args, new AbortController().signal, 30_000)).exitCode === 0; } catch { return false; }
}
async function allKnownAbsent(docker: DockerClient, kind: "container" | "network" | "image", names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    try {
      const result = await docker.run([kind, "inspect", name], new AbortController().signal, 15_000);
      if (result.exitCode === 0 || !isNotFound(result)) return false;
    } catch { return false; }
  }
  return true;
}

interface ReconciledResources extends ResourceIds { readonly workerImage: string | null; readonly certain: boolean }
async function reconcileResources(
  docker: DockerClient,
  names: Record<string, string>,
  capsuleId: string,
  recorded: ResourceIds,
  recordedImage: string | null,
): Promise<ReconciledResources> {
  const worker = await discover(docker, "container", recorded.workerContainer ?? names.worker!, capsuleId);
  const proxy = await discover(docker, "container", recorded.proxyContainer ?? names.proxy!, capsuleId);
  const internal = await discover(docker, "network", recorded.internalNetwork ?? names.internalNetwork!, capsuleId);
  const egress = await discover(docker, "network", recorded.egressNetwork ?? names.egressNetwork!, capsuleId);
  const image = await discover(docker, "image", recordedImage ?? names.workerImage!, capsuleId);
  return {
    workerContainer: worker.id,
    proxyContainer: proxy.id,
    internalNetwork: internal.id,
    egressNetwork: egress.id,
    workerImage: image.id,
    certain: worker.certain && proxy.certain && internal.certain && egress.certain && image.certain,
  };
}

async function discover(
  docker: DockerClient,
  kind: "container" | "network" | "image",
  identifier: string,
  capsuleId: string,
  allowLabelFallback = true,
): Promise<{ readonly id: string | null; readonly certain: boolean }> {
  try {
    const result = await docker.run([kind, "inspect", identifier], new AbortController().signal, 15_000);
    if (result.exitCode !== 0) {
      if (!isNotFound(result)) return { id: null, certain: false };
      if (kind === "image" && allowLabelFallback) {
        const listed = await docker.run([
          "image", "ls", "--filter", `label=org.zentra.capsule-id=${capsuleId}`,
          "--quiet", "--no-trunc",
        ], new AbortController().signal, 15_000);
        if (listed.exitCode !== 0) return { id: null, certain: false };
        const ids = [...new Set(listed.stdout.split(/\s+/).filter(Boolean))];
        if (ids.length === 0) return { id: null, certain: true };
        if (ids.length !== 1) return { id: null, certain: false };
        return discover(docker, kind, ids[0]!, capsuleId, false);
      }
      return { id: null, certain: true };
    }
    const inspected = firstInspect<DockerContainerInspect & DockerNetworkInspect & DockerImageInspect>(result);
    const labels = kind === "network" ? inspected.Labels : inspected.Config?.Labels;
    const id = inspected.Id ?? "";
    const validId = kind === "image"
      ? /^sha256:[a-f0-9]{64}$/.test(id)
      : /^[a-f0-9]{64}$/.test(id);
    if (!validId || labels?.["org.zentra.capsule-id"] !== capsuleId) {
      return { id: null, certain: false };
    }
    return { id, certain: true };
  } catch {
    return { id: null, certain: false };
  }
}

function isNotFound(result: DockerCommandResult): boolean {
  return /(?:No such|not found)/i.test(result.stderr);
}

function firstInspect<T>(result: DockerCommandResult): T { const parsed = JSON.parse(result.stdout) as T[]; if (parsed.length !== 1 || parsed[0] === undefined) throw new Error("Docker attestation failed"); return parsed[0]; }
function exactDockerId(output: string): string { const id = output.trim(); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Docker immutable identity attestation failed"); return id; }
function assertImagePlatform(inspect: DockerImageInspect, indexDigest: string): void { if (inspect.Os !== "linux" || inspect.Architecture !== "arm64" || !inspect.RepoDigests?.some((value) => value.endsWith(`@${indexDigest}`)) || !/^sha256:[a-f0-9]{64}$/.test(inspect.Id)) throw new Error("proxy image attestation failed"); }
async function assertArm64Manifest(docker: DockerClient, image: string, digest: string, signal: AbortSignal): Promise<void> { const result = await ok(docker, ["buildx", "imagetools", "inspect", image, "--raw"], signal); const index = JSON.parse(result.stdout) as { manifests?: readonly { digest?: string; platform?: { architecture?: string; os?: string } }[] }; if (!index.manifests?.some((item) => item.digest === digest && item.platform?.architecture === "arm64" && item.platform.os === "linux")) throw new Error("image manifest attestation failed"); }

function parseProxyInteractions(output: string): readonly Record<string, unknown>[] {
  const interactions: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('"zentra_proxy_event"')) continue;
    if (interactions.length >= MAX_PROXY_OBSERVATIONS) throw new Error("proxy observation limit exceeded");
    const parsed = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    interactions.push(parseCapsuleEventPayload("capsule.proxy_interaction_observed", { scheme: parsed.scheme, method: parsed.method, host: parsed.host, allowed: parsed.allowed, reason: parsed.reason }) as Record<string, unknown>);
  }
  return interactions;
}

function canonicalDirectory(candidate: string): string { if (!path.isAbsolute(candidate)) throw new Error("project path must be absolute"); const canonical = realpathSync.native(candidate); if (canonical !== candidate || !statSync(canonical).isDirectory()) throw new Error("project path must be canonical"); return canonical; }
function dockerHostIdentity(): string { if (process.platform !== "darwin" || process.arch !== "arm64" || !process.getuid || !process.getgid) throw new Error("Docker capsules require Darwin arm64"); return `${process.getuid()}:${process.getgid()}`; }
function canonicalOutcome(error: unknown, caller: AbortSignal, deadline: AbortSignal): CapsuleConformanceReport["outcome"] { if (deadline.aborted || error instanceof DockerCommandTimeoutError) return "timed_out"; if (caller.aborted || error instanceof DockerCommandCancelledError) return "cancelled"; return "failed"; }
function failureReason(error: unknown, outcome: CapsuleConformanceReport["outcome"], deadline: AbortSignal): string { if (outcome === "cancelled") return "cancelled"; if (deadline.aborted) return "total_deadline"; if (error instanceof DockerCommandTimeoutError) return "command_timeout"; if (error instanceof DockerOutputLimitError) return "output_limit"; if (error instanceof Error && error.message.includes("attestation")) return "attestation_failed"; if (error instanceof Error && error.message.includes("conformance")) return "conformance_failed"; if (error instanceof Error && error.message.includes("Docker")) return "docker_failed"; return "internal_failure"; }
