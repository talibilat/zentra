import { z } from "zod";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const HexDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const RequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const RepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const GitRefSchema = z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const BranchSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const OutcomeSchema = z.enum(["completed", "cancelled", "timed_out", "failed"]);
const CleanupSchema = z.enum(["completed", "uncertain"]);
const CheckNameSchema = z.enum([
  "workerContainment", "projectReadOnly", "projectSymlinkSafe", "scratchWritable", "scratchNoexec",
  "scratchNosuid", "scratchBounded", "directInternetDenied", "directHostDenied", "directGatewayDenied",
  "directPrivateDenied", "proxyReadAllowed", "proxyPlaintextDenied", "proxyWriteDenied", "proxyUpgradeDenied",
  "proxyConnectDenied", "proxyDisallowedConnectDenied", "proxyAllowedConnectOpaqueDenied", "proxyReadBodyDenied", "proxyPrivateResolutionDenied", "openCodeVersion", "openCodeExecutableDigest",
]);
const PolicySummarySchema = z.object({
  schemaVersion: z.literal(1),
  readMode: z.enum(["exact_domains", "all_public_domains"]),
  readDomains: z.number().int().nonnegative().nullable(),
  readMethods: z.array(z.enum(["GET", "HEAD"])).min(1).max(2),
  githubWriteGrants: z.number().int().nonnegative(),
  githubBroker: z.enum(["disabled", "host"]),
  modelBroker: z.literal("disabled"),
  tlsInspectionRequired: z.literal(true),
  globalWrites: z.literal("denied"),
}).strict();

const schemas = {
  "capsule.started": z.object({
    projectAccess: z.literal("read_only"), scratchBytes: z.number().int().positive(),
    policy: PolicySummarySchema, githubEffects: z.enum(["disabled", "host_broker_only"]),
    modelEffects: z.literal("disabled_without_broker"), resourceNamespace: z.string().regex(/^[a-f0-9]{32}$/),
  }).strict(),
  "capsule.runtime_attested": z.object({
    dockerExecutableApproved: z.string().min(1), dockerExecutableMeasured: z.string().min(1),
    dockerContextApproved: z.literal("desktop-linux"), dockerContextMeasured: z.literal("desktop-linux"),
    clientVersionMeasured: z.string().regex(/^\d+\.\d+\.\d+$/), serverVersionMeasured: z.string().regex(/^\d+\.\d+\.\d+$/),
    serverPlatformMeasured: z.string().regex(/^Docker Desktop(?: |$)/), serverArchitectureMeasured: z.literal("arm64"),
  }).strict(),
  "capsule.image_attested": z.union([
    z.object({ image: z.literal("policy_proxy"), approvedIndexDigest: DigestSchema, approvedPlatformDigest: DigestSchema, measuredLocalImageId: DigestSchema, platform: z.literal("linux/arm64") }).strict(),
    z.object({ image: z.literal("worker"), measuredImageId: DigestSchema, approvedBaseIndexDigest: DigestSchema, approvedBasePlatformDigest: DigestSchema, platform: z.literal("linux/arm64") }).strict(),
  ]),
  "capsule.resources_prepared": z.object({ proxyContainerId: z.string().regex(/^[a-f0-9]{64}$/), workerContainerId: z.string().regex(/^[a-f0-9]{64}$/), internalNetworkId: z.string().regex(/^[a-f0-9]{64}$/), egressNetworkId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  "capsule.worker_attested": z.object({
    readOnlyRoot: z.literal(true), user: z.literal("10001:10001"), projectMount: z.literal("read_only"),
    scratchBytes: z.number().int().positive(), capabilities: z.literal("dropped"), noNewPrivileges: z.literal(true),
    directEgress: z.literal("internal_network_only"), inheritedSecrets: z.literal(false), dockerSocket: z.literal(false),
  }).strict(),
  "capsule.check_observed": z.object({ name: CheckNameSchema, passed: z.boolean() }).strict(),
  "capsule.harness_attested": z.object({ harness: z.literal("opencode"), version: z.literal("1.18.1"), executableSha256: HexDigestSchema }).strict(),
  "capsule.proxy_interaction_observed": z.object({
    scheme: z.enum(["http", "https", "unknown"]), method: z.enum(["GET", "HEAD", "POST", "CONNECT", "UPGRADE", "OTHER"]),
    host: z.string().regex(/^[a-z0-9.:-]{1,253}$/), allowed: z.boolean(),
    reason: z.enum(["configured_read", "plaintext_http_denied", "connect_denied", "upgrade_denied", "read_body_denied", "domain_not_allowed", "method_denied", "resolution_failed", "private_target_denied", "raw_tcp_denied"]),
  }).strict(),
  "capsule.github_grant_consumed": z.object({
    grantId: RequestIdSchema, audience: z.literal("zentra.github-broker"), expiresAt: z.string().datetime({ offset: true }),
    requestId: RequestIdSchema, policyDigest: HexDigestSchema, actionDigest: HexDigestSchema,
  }).strict(),
  "capsule.github_broker_accepted": githubActionSchema(),
  "capsule.github_broker_denied": githubActionSchema(),
  "capsule.github_broker_observed": z.object({
    requestId: RequestIdSchema, grantId: RequestIdSchema, actionDigest: HexDigestSchema,
    operation: z.enum(["push", "create_pull_request"]), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    target: z.string().min(1).max(255), outcome: z.enum(["denied", "uncertain"]),
  }).strict(),
  "capsule.github_broker_reconciled": z.discriminatedUnion("operation", [
    z.object({ requestId: RequestIdSchema, grantId: RequestIdSchema, actionDigest: HexDigestSchema, operation: z.literal("push"), repository: RepositorySchema, targetRef: GitRefSchema, sourceCommit: ObjectIdSchema, expectedOldOid: ObjectIdSchema, force: z.literal(false), attempt: z.number().int().positive().max(5), outcome: z.enum(["completed", "failed", "uncertain"]), observedRemoteOid: ObjectIdSchema.nullable() }).strict(),
    z.object({ requestId: RequestIdSchema, grantId: RequestIdSchema, actionDigest: HexDigestSchema, operation: z.literal("create_pull_request"), repository: RepositorySchema, pushGrantId: RequestIdSchema, headRef: BranchSchema, headCommit: ObjectIdSchema, base: BranchSchema, titleSha256: HexDigestSchema, bodySha256: HexDigestSchema, draft: z.boolean(), attempt: z.number().int().positive().max(5), outcome: z.enum(["completed", "failed", "uncertain"]), observedNumber: z.number().int().positive().nullable() }).strict(),
  ]),
  "capsule.failure_observed": z.object({ outcome: OutcomeSchema.exclude(["completed"]), reason: z.enum(["cancelled", "total_deadline", "command_timeout", "output_limit", "attestation_failed", "conformance_failed", "docker_failed", "journal_conflict", "internal_failure"]) }).strict(),
  "capsule.cleanup_observed": z.object({ outcome: CleanupSchema, containersAbsent: z.boolean(), networksAbsent: z.boolean(), imagesAbsent: z.boolean(), observationsCollected: z.boolean() }).strict(),
  "capsule.completed": z.object({ outcome: z.literal("completed"), cleanup: CleanupSchema }).strict(),
  "capsule.cancelled": z.object({ outcome: z.literal("cancelled"), cleanup: CleanupSchema }).strict(),
  "capsule.timed_out": z.object({ outcome: z.literal("timed_out"), cleanup: CleanupSchema }).strict(),
  "capsule.failed": z.object({ outcome: z.literal("failed"), cleanup: CleanupSchema }).strict(),
} as const;

export type CapsuleEventType = keyof typeof schemas;

function githubActionSchema() {
  const common = { requestId: RequestIdSchema, grantId: RequestIdSchema, policyDigest: HexDigestSchema, actionDigest: HexDigestSchema, repository: RepositorySchema };
  return z.discriminatedUnion("operation", [
    z.object({ ...common, operation: z.literal("push"), targetRef: GitRefSchema, sourceCommit: ObjectIdSchema, expectedOldOid: ObjectIdSchema, force: z.literal(false) }).strict(),
    z.object({ ...common, operation: z.literal("create_pull_request"), pushGrantId: RequestIdSchema, headRef: BranchSchema, headCommit: ObjectIdSchema, base: BranchSchema, titleSha256: HexDigestSchema, bodySha256: HexDigestSchema, draft: z.boolean() }).strict(),
  ]);
}

export function parseCapsuleEventPayload(type: string, payload: unknown): unknown {
  const schema = schemas[type as CapsuleEventType];
  if (schema === undefined) throw new Error("unsupported capsule event type");
  return schema.parse(payload);
}
