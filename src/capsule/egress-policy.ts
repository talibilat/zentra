import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const MAX_POLICY_BYTES = 64 * 1024;
const DomainSchema = z.string().min(1).max(253).regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/,
);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200);
export const GitHubCredentialReferenceSchema = z.object({
  type: z.literal("environment"),
  name: z.literal("GITHUB_TOKEN"),
}).strict();
const ObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const ContentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GitRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(255)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"));
const BranchSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).max(255)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"));

const GitHubActionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("push"),
    repository: RepositorySchema,
    targetRef: GitRefSchema,
    sourceCommit: ObjectIdSchema,
    expectedOldOid: ObjectIdSchema,
    force: z.literal(false),
  }).strict(),
  z.object({
    operation: z.literal("create_pull_request"),
    repository: RepositorySchema,
    pushGrantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    headRef: BranchSchema,
    headCommit: ObjectIdSchema,
    base: BranchSchema,
    titleSha256: ContentDigestSchema,
    bodySha256: ContentDigestSchema,
    draft: z.boolean(),
  }).strict(),
]);
const GitHubGrantSchema = z.object({
  grantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  audience: z.literal("zentra.github-broker"),
  expiresAt: z.string().datetime({ offset: true }),
  action: GitHubActionSchema,
  credential: GitHubCredentialReferenceSchema,
}).strict();

export const CapsulePolicySchema = z.object({
  schemaVersion: z.literal(1),
  reads: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("exact_domains"),
      domains: z.array(DomainSchema).min(1).max(128),
      methods: z.array(z.enum(["GET", "HEAD"])).min(1).max(2),
    }).strict(),
    z.object({
      mode: z.literal("all_public_domains"),
      domains: z.never().optional(),
      methods: z.array(z.enum(["GET", "HEAD"])).min(1).max(2),
    }).strict(),
  ]),
  githubWrites: z.array(GitHubGrantSchema).max(128),
  brokers: z.object({
    github: z.enum(["disabled", "host"]),
    model: z.literal("disabled"),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (policy.brokers.github === "disabled" && policy.githubWrites.length > 0) {
    context.addIssue({ code: "custom", path: ["githubWrites"], message: "GitHub grants require the host broker" });
  }
  const ids = new Set<string>();
  policy.githubWrites.forEach((grant, index) => {
    if (ids.has(grant.grantId)) context.addIssue({ code: "custom", path: ["githubWrites", index, "grantId"], message: "duplicate GitHub grant identity" });
    ids.add(grant.grantId);
    if (grant.action.operation === "create_pull_request") {
      const action = grant.action;
      if (action.headRef !== githubBrokerHeadRef(grant.grantId)) {
        context.addIssue({ code: "custom", path: ["githubWrites", index, "action", "headRef"], message: "pull request head must be broker-owned" });
      }
      const push = policy.githubWrites.find((candidate) => candidate.grantId === action.pushGrantId);
      if (
        push?.action.operation !== "push" || push.action.repository !== action.repository ||
        push.action.targetRef !== `refs/heads/${action.headRef}` ||
        push.action.sourceCommit !== action.headCommit || push.action.expectedOldOid !== "0".repeat(40)
      ) {
        context.addIssue({ code: "custom", path: ["githubWrites", index, "action", "pushGrantId"], message: "pull request requires an exact branch-creation push grant" });
      }
    }
  });
});

export type CapsulePolicy = z.infer<typeof CapsulePolicySchema>;
export type GitHubWriteGrant = z.infer<typeof GitHubGrantSchema>;
export type GitHubEffectRequest =
  | { readonly operation: "push"; readonly repository: string; readonly targetRef: string; readonly sourceCommit: string; readonly expectedOldOid: string; readonly force: false }
  | { readonly operation: "create_pull_request"; readonly repository: string; readonly pushGrantId: string; readonly headRef: string; readonly headCommit: string; readonly base: string; readonly titleSha256: string; readonly bodySha256: string; readonly draft: boolean };

export function githubBrokerHeadRef(grantId: string): string {
  return `zentra/grant-${createHash("sha256").update(grantId, "utf8").digest("hex").slice(0, 24)}`;
}

export interface ProxyFlowRequest {
  readonly scheme: string;
  readonly method: string;
  readonly host: string;
  readonly hasBody: boolean;
  readonly upgrade: boolean;
  readonly resolvedAddresses: readonly string[];
}

export type EgressDecisionReason =
  | "configured_read"
  | "plaintext_http_denied"
  | "connect_denied"
  | "upgrade_denied"
  | "read_body_denied"
  | "domain_not_allowed"
  | "method_denied"
  | "resolution_failed"
  | "private_target_denied"
  | "raw_tcp_denied";

export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason: EgressDecisionReason;
}

export function loadCapsulePolicy(policyPath: string): CapsulePolicy {
  if (!path.isAbsolute(policyPath) || path.normalize(policyPath) !== policyPath) throw new Error("capsule policy path is invalid");
  const canonical = realpathSync.native(policyPath);
  if (canonical !== policyPath) throw new Error("capsule policy path must be canonical and non-symlinked");
  const descriptor = openSync(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) throw new Error("capsule policy is invalid");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
      throw new Error("capsule policy changed while reading");
    }
    return CapsulePolicySchema.parse(JSON.parse(buffer.subarray(0, offset).toString("utf8")) as unknown);
  } finally {
    closeSync(descriptor);
  }
}

export function decideProxyFlow(policy: CapsulePolicy, request: ProxyFlowRequest): EgressDecision {
  const method = request.method.toUpperCase();
  const host = request.host.toLowerCase();
  if (request.scheme.toLowerCase() !== "https") return { allowed: false, reason: "plaintext_http_denied" };
  if (method === "CONNECT") return { allowed: false, reason: "connect_denied" };
  if (request.upgrade) return { allowed: false, reason: "upgrade_denied" };
  if (method !== "GET" && method !== "HEAD") return { allowed: false, reason: "method_denied" };
  if (request.hasBody) return { allowed: false, reason: "read_body_denied" };
  if (!policy.reads.methods.includes(method)) return { allowed: false, reason: "domain_not_allowed" };
  if (policy.reads.mode === "exact_domains" && !policy.reads.domains.includes(host)) {
    return { allowed: false, reason: "domain_not_allowed" };
  }
  if (request.resolvedAddresses.length === 0) return { allowed: false, reason: "resolution_failed" };
  if (request.resolvedAddresses.some((address) => !isPublicAddress(address))) {
    return { allowed: false, reason: "private_target_denied" };
  }
  return { allowed: true, reason: "configured_read" };
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Value(address);
    return !IPV4_SPECIAL.some(([network, prefix]) => inSubnet(value, network, prefix, 32));
  }
  if (family === 6) {
    const value = ipv6Value(address);
    if (inSubnet(value, 0xffffn << 32n, 96, 128)) return isPublicAddress(ipv4FromValue(value & 0xffffffffn));
    if (!inSubnet(value, 0x2000n << 112n, 3, 128)) return false;
    return !IPV6_SPECIAL.some(([network, prefix]) => inSubnet(value, network, prefix, 128));
  }
  return false;
}

const IPV4_SPECIAL: readonly (readonly [bigint, number])[] = [
  [ipv4Value("0.0.0.0"), 8], [ipv4Value("10.0.0.0"), 8], [ipv4Value("100.64.0.0"), 10],
  [ipv4Value("127.0.0.0"), 8], [ipv4Value("169.254.0.0"), 16], [ipv4Value("172.16.0.0"), 12],
  [ipv4Value("192.0.0.0"), 24], [ipv4Value("192.0.2.0"), 24], [ipv4Value("192.31.196.0"), 24],
  [ipv4Value("192.52.193.0"), 24], [ipv4Value("192.88.99.0"), 24], [ipv4Value("192.168.0.0"), 16],
  [ipv4Value("192.175.48.0"), 24], [ipv4Value("198.18.0.0"), 15], [ipv4Value("198.51.100.0"), 24],
  [ipv4Value("203.0.113.0"), 24], [ipv4Value("224.0.0.0"), 4], [ipv4Value("240.0.0.0"), 4],
];
const IPV6_SPECIAL: readonly (readonly [bigint, number])[] = [
  [ipv6Value("64:ff9b::"), 96], [ipv6Value("64:ff9b:1::"), 48], [ipv6Value("100::"), 64],
  [ipv6Value("2001::"), 23], [ipv6Value("2001:2::"), 48], [ipv6Value("2001:db8::"), 32],
  [ipv6Value("2002::"), 16], [ipv6Value("3fff::"), 20], [ipv6Value("5f00::"), 16],
  [ipv6Value("fc00::"), 7], [ipv6Value("fec0::"), 10], [ipv6Value("fe80::"), 10], [ipv6Value("ff00::"), 8],
];

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}
function ipv4FromValue(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join(".");
}
function ipv6Value(address: string): bigint {
  const [left = "", right = ""] = address.toLowerCase().split("::", 2);
  const parse = (side: string): number[] => side === "" ? [] : side.split(":").flatMap((part) => {
    if (!part.includes(".")) return [Number.parseInt(part, 16)];
    const value = Number(ipv4Value(part));
    return [value >>> 16, value & 0xffff];
  });
  const before = parse(left);
  const after = parse(right);
  const groups = address.includes("::") ? [...before, ...Array(8 - before.length - after.length).fill(0), ...after] : before;
  if (groups.length !== 8) throw new Error("invalid IPv6 address");
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}
function inSubnet(value: bigint, network: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (network >> shift);
}

export function findExactGitHubGrant(
  policy: CapsulePolicy,
  request: GitHubEffectRequest,
): GitHubWriteGrant | null {
  return policy.githubWrites.find((grant) => {
    const action = grant.action;
    if (action.operation !== request.operation || action.repository !== request.repository) return false;
    return action.operation === "push"
      ? request.operation === "push" && action.targetRef === request.targetRef && action.sourceCommit === request.sourceCommit && action.expectedOldOid === request.expectedOldOid && action.force === request.force
      : request.operation === "create_pull_request" && action.pushGrantId === request.pushGrantId && action.headRef === request.headRef && action.headCommit === request.headCommit && action.base === request.base && action.titleSha256 === request.titleSha256 && action.bodySha256 === request.bodySha256 && action.draft === request.draft;
  }) ?? null;
}

export function publicCapsulePolicySummary(policy: CapsulePolicy): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    readMode: policy.reads.mode,
    readDomains: policy.reads.mode === "exact_domains" ? policy.reads.domains.length : null,
    readMethods: policy.reads.methods,
    githubWriteGrants: policy.githubWrites.length,
    githubBroker: policy.brokers.github,
    modelBroker: policy.brokers.model,
    tlsInspectionRequired: true,
    globalWrites: "denied",
  });
}
