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
    if (grant.action.operation === "create_pull_request" && grant.action.headRef !== githubBrokerHeadRef(grant.grantId)) {
      context.addIssue({ code: "custom", path: ["githubWrites", index, "action", "headRef"], message: "pull request head must be broker-owned" });
    }
    if (grant.action.operation === "create_pull_request") {
      const action = grant.action;
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
    if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || offset > MAX_POLICY_BYTES) {
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
    const octets = address.split(".").map(Number);
    const [a = -1, b = -1] = octets;
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) || (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return !(
      normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
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
