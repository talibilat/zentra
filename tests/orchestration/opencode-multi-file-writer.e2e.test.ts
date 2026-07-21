import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { PlannedTask } from "../../src/contracts/milestone.js";
import { OpenCodeWriter } from "../../src/harnesses/opencode-writer.js";
import { OpenCodeProbe } from "../../src/harnesses/opencode-probe.js";
import { SqliteEventJournal } from "../../src/journal/sqlite-journal.js";
import { OpenCodeMultiFileWriter } from "../../src/orchestration/opencode-multi-file-writer.js";
import { WriterWorktreeCapsule } from "../../src/orchestration/writer-worktree-capsule.js";
import type { ModelCapability } from "../../src/policy/model-sheet.js";
import type { SecuritySheet } from "../../src/policy/security-sheet.js";
import type { ProjectConfig } from "../../src/projects/project-config.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";
import { GitClient } from "../../src/workspaces/git-client.js";
import { PathClaimService, appendSupervisedWriterReceipt } from "../../src/workspaces/path-claims.js";
import { WorkspaceOwnershipGate } from "../../src/workspaces/workspace-ownership.js";
import { WorktreeManager } from "../../src/workspaces/worktree-manager.js";
import { TrustedPatchApplier } from "../../src/workspaces/trusted-patch-applier.js";
import { buildRoleCapabilityBinding, RoleCapabilityEnvelopeService } from "../../src/workers/role-capability-envelope.js";
import { digestCanonical } from "../../src/contracts/authority-attention.js";
import type { OpenCodeWriterReport } from "../../src/harnesses/opencode-writer.js";
import { buildWriterPatchProposal } from "../../src/contracts/writer-patch.js";

const directories: string[] = [];
const git = new GitClient();
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const viteNode = path.join(workspaceRoot, "node_modules/vite-node/dist/cli.mjs");
const patchRecoveryFixture = path.join(workspaceRoot, "fixtures/patch-recovery-process.ts");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OpenCodeMultiFileWriter real Git path", () => {
  it("claims before launch, edits multiple exact files, and retains checkpoint evidence", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      const packet = JSON.parse(args[10]);
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
      if (JSON.stringify(packet.ownedPaths) !== JSON.stringify(["src/a.ts", "src/b.ts", "src/new.ts"])) process.exit(81);
      if (packet.potentialWritePaths[0] !== "src/**" || !packet.pathClaim.claimId) process.exit(82);
      const edits = config.agent["zentra-writer"].permission.edit;
      if (edits !== "deny" || config.agent["zentra-writer"].permission["*"] !== "deny" ||
        config.agent["zentra-writer"].permission.bash !== "deny") process.exit(83);
      const reads = config.agent["zentra-writer"].permission.read;
      if (reads["**"] !== "allow" || reads[".git/**"] !== "deny" || reads[".env"] !== "deny") process.exit(84);
      ${proposalOutput(fixture.revision, [
        patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n"),
        patch("src/b.ts", "export const b = 1;\n", "export const b = 2;\n"),
        patch("src/new.ts", null, "export const fresh = true;\n"),
      ], { input: 120, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 5 })}
    `);
    const probe = await verifiedProbe(executable, fixture.repository);
    const capabilityBinding = acceptedBinding(journal, fixture.repository);
    const result = await writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe, signal: AbortSignal.timeout(10_000), claims: new PathClaimService(journal),
      capabilityBinding,
      observer: { onWriterCompleted: () => {
        const workspace = path.join(fixture.project.worktreeRoot, "multi-writer");
        expect(readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toContain("a = 1");
        expect(readFileSync(path.join(workspace, "src/b.ts"), "utf8")).toContain("b = 1");
        expect(existsSync(path.join(workspace, "src/new.ts"))).toBe(false);
      } },
      claimId: "claim-multi", correlationId: "run-multi",
      writer: {
        schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts", "src/b.ts", "src/new.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 },
      },
    });

    expect(result).toMatchObject({ outcome: "completed", pathClaim: { claimId: "claim-multi" },
      ownership: { changedPaths: ["src/a.ts", "src/b.ts", "src/new.ts"], violations: [] } });
    expect(Date.parse(result.pathClaim!.expiresAt) - Date.parse(result.pathClaim!.acquiredAt))
      .toBeGreaterThanOrEqual(40_000);
    expect(readFileSync(path.join(result.lease!.path, "src/a.ts"), "utf8")).toContain("2");
    expect(statSync(path.join(result.lease!.path, "src/new.ts")).mode & 0o777).toBe(0o644);
    expect(result.writer!.usage).toEqual({ inputTokens: 120, outputTokens: 40,
      reasoningTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, toolCalls: 0 });
    expect(journal.readStream("path-claims:fixture").find((event) => event.type === "writer.checkpointed")?.payload)
      .toMatchObject({ usage: result.writer!.usage });
    expect(journal.readStream("path-claims:fixture").find((event) => event.type === "writer.receipt_observed")?.payload)
      .toMatchObject({ patchProposalDigest: result.writer!.patchProposal!.digest });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toEqual([
      "path_claim.requested", "path_claim.acquired", "writer.dispatch_started",
      "writer.receipt_observed", "writer.patch_proposal_recorded", "writer.patch_application_intended",
      "writer.patch_application_started",
      "writer.patch_file_applied", "writer.patch_file_applied", "writer.patch_file_applied",
      "writer.patch_apply_completed", "writer.checkpointed", "path_claim.released",
    ]);
    expect(new PathClaimService(journal).inspect("fixture").active).toEqual([]);
    journal.close();
    const reopened = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    expect(new PathClaimService(reopened).inspect("fixture").active).toEqual([]);
    reopened.close();
  }, 15_000);

  it("grants no writer launch when an overlapping claim is active", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    claims.acquire({ projectId: "fixture", claimId: "existing", ownerId: "other-writer",
      revision: fixture.revision, paths: ["src/a.ts"], leaseMs: 60_000, correlationId: "other-run" });
    const marker = path.join(fixture.root, "writer-started");
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "started");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);
    const probe = await verifiedProbe(executable, fixture.repository);

    const capabilityBinding = acceptedBinding(journal, fixture.repository);
    await expect(writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe, signal: AbortSignal.timeout(10_000), claims, claimId: "competing",
      capabilityBinding,
      correlationId: "competing-run",
      writer: {
        schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts", "src/b.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 },
      },
    })).rejects.toThrow(/overlap/i);
    expect(existsSync(marker)).toBe(false);
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toContain("path_claim.denied");
    journal.close();
  }, 15_000);

  it("rejects missing capability binding and mismatched request read scope before acquisition", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const executable = fakeOpenCode(fixture.root, `process.exit(90);`);
    const probe = await verifiedProbe(executable, fixture.repository);
    const base = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe, signal: AbortSignal.timeout(10_000), claims: new PathClaimService(journal),
      claimId: "claim-bad-read", correlationId: "run-bad-read",
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["src/**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    };
    await expect(writer().run(base as Parameters<OpenCodeMultiFileWriter["run"]>[0]))
      .rejects.toThrow(/capability binding/i);
    await expect(writer().run({ ...base, capabilityBinding: acceptedBinding(journal, fixture.repository) }))
      .rejects.toThrow(/read paths/i);
    expect(journal.readStream("path-claims:fixture")).toEqual([]);
    journal.close();
  });

  it("recovers one durable unstarted patch intent after observer failure without redispatch", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 1;\n", "export const a = 4;\n")])}
    `);
    const probe = await verifiedProbe(executable, fixture.repository);
    const base = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe, signal: AbortSignal.timeout(10_000), claims, claimId: "claim-restart",
      correlationId: "run-multi", capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    };
    await expect(writer().run({ ...base, observer: {
      onWriterCompleted: () => { throw new Error("observation persistence failed"); },
    } })).rejects.toThrow(/observation persistence failed/);
    const claim = claims.inspect("fixture").active.find((candidate) => candidate.claimId === "claim-restart")!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    expect(claim.requiresReconciliation).toBe(true);
    await expect(writer().run({ ...base, retainedLease: lease })).rejects.toThrow(/reconcil/i);
    const prepared = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, lease, forbiddenPaths: [".git/**", ".env"],
      correlationId: "run-multi" }, { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(prepared.classification).toBe("patch_application_prepared");
    await expect(writer().run({ ...base, retainedLease: lease })).rejects.toThrow(/reconcil/i);
    new TrustedPatchApplier(claims).recover({ projectId: "fixture", correlationId: "run-multi",
      lease, claim: claims.inspect("fixture").active[0]!, binding: base.capabilityBinding });
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled.classification).toBe("effect_observed");
    const retainedEvents = journal.readStream("path-claims:fixture");
    const dispatchEvent = retainedEvents.find((event) => event.type === "writer.dispatch_started")!;
    const receiptEvent = retainedEvents.find((event) => event.type === "writer.receipt_observed")!;
    const intentEvent = retainedEvents.find((event) => event.type === "writer.patch_application_intended")!;
    expect(receiptEvent.streamVersion).toBeLessThan(
      retainedEvents.find((event) => event.type === "writer.effect_uncertain")!.streamVersion,
    );
    expect(receiptEvent.payload).toMatchObject({
      claimId: claim.claimId,
      dispatchId: (dispatchEvent.payload as { dispatchId: string }).dispatchId,
      dispatchBindingDigest: (dispatchEvent.payload as { binding: { digest: string } }).binding.digest,
    });
    expect(intentEvent.streamVersion).toBeLessThan(
      retainedEvents.find((event) => event.type === "writer.effect_uncertain")!.streamVersion,
    );
    expect(claims.inspect("fixture").active).toEqual([]);
    await expect(writer().run({ ...base, retainedLease: lease })).rejects.toThrow(/immutable|claim/i);
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toEqual(expect.arrayContaining([
      "writer.dispatch_started", "writer.effect_uncertain", "path_claim.diff_observed",
      "writer.checkpointed", "path_claim.released",
    ]));
    journal.close();
  }, 20_000);

  it("keeps an observed diff pending and rejects caller-fabricated worker receipts", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `process.exit(90);`);
    const request = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-missing-receipt", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
      observer: { onWriterStarted: ({ lease }: { lease: { path: string } }) => {
        writeFileSync(path.join(lease.path, "src/a.ts"), "export const a = 8;\n");
        throw new Error("crash before worker receipt");
      } },
    };
    await expect(writer().run(request)).rejects.toThrow(/crash before worker receipt/);
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    const pending = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(pending.classification).toBe("effect_observed_pending_evidence");
    expect(claims.inspect("fixture").active[0]).toMatchObject({
      requiresReconciliation: true, workerReceipt: null,
    });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type))
      .not.toContain("writer.checkpointed");
    expect((claims as unknown as { recordReceipt?: unknown }).recordReceipt).toBeUndefined();
    expect(() => appendSupervisedWriterReceipt(claims, {
      projectId: "fixture", claimId: claim.claimId, ownerId: claim.ownerId,
      revision: claim.revision, leaseToken: claim.leaseToken, dispatchId: claim.dispatchId!,
      correlationId: "run-multi",
    }, {} as OpenCodeWriterReport, claim.dispatchBinding!)).toThrow(/not issued by the supervised/i);
    const stillPending = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(stillPending.classification).toBe("effect_observed_pending_evidence");
    expect(claims.inspect("fixture").active[0]).toMatchObject({ requiresReconciliation: true });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type))
      .not.toContain("writer.checkpointed");
    journal.close();
  }, 20_000);

  it("allows one independent recovery process to consume intent CAS and leaves the loser mutation-free", async () => {
    const fixture = await createFixture();
    const database = path.join(fixture.root, "journal.sqlite");
    const journal = new SqliteEventJournal(database);
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, proposalOutput(fixture.revision, [
      patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n"),
      patch("src/b.ts", "export const b = 1;\n", "export const b = 2;\n"),
    ]));
    const binding = acceptedBinding(journal, fixture.repository);
    const request = { project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-process-race", correlationId: "run-multi", capabilityBinding: binding,
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts", "src/b.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
      observer: { onWriterCompleted: () => { throw new Error("pause after durable intent"); } } };
    await expect(writer().run(request)).rejects.toThrow(/pause after durable intent/);
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    expect((await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() })).classification)
      .toBe("patch_application_prepared");
    journal.close();
    const childInput = { projectId: "fixture", correlationId: "run-multi", lease, binding };
    const results = await Promise.all([
      recoverPatchInProcess(database, childInput), recoverPatchInProcess(database, childInput),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["applied", "lost"]);
    expect(readFileSync(path.join(lease.path, "src/a.ts"), "utf8")).toContain("a = 2");
    expect(readFileSync(path.join(lease.path, "src/b.ts"), "utf8")).toContain("b = 2");
    const reopened = new SqliteEventJournal(database);
    const types = reopened.readStream("path-claims:fixture").map((event) => event.type);
    expect(types.filter((type) => type === "writer.patch_application_started")).toHaveLength(1);
    expect(types.filter((type) => type === "writer.patch_file_applied")).toHaveLength(2);
    expect(types.filter((type) => type === "writer.patch_apply_completed")).toHaveLength(1);
    expect(() => new PathClaimService(reopened).inspect("fixture")).not.toThrow();
    reopened.close();
  }, 30_000);

  it("authorizes fresh dispatch only after reconciliation proves no effect", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 1;\n", "export const a = 6;\n")])}
    `);
    const base = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-no-effect", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    };
    await expect(writer().run({ ...base, observer: {
      onWriterStarted: () => { throw new Error("crash before writer transport"); },
    } })).rejects.toThrow(/crash before writer transport/);
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled.classification).toBe("no_effect");
    const resumed = await writer().run({ ...base, retainedLease: lease });
    expect(resumed.outcome).toBe("completed");
    expect(claims.inspect("fixture").active).toEqual([]);
    journal.close();
  }, 20_000);

  it("executes a bounded correction in the retained worktree under the original claim", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const initialExecutable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision, [
        patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n"),
        patch("src/b.ts", "export const b = 1;\n", "export const b = 2;\n"),
      ])}
    `);
    const binding = acceptedBinding(journal, fixture.repository);
    const request = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(initialExecutable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-correction", correlationId: "run-multi", capabilityBinding: binding,
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts", "src/b.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    };
    const multi = writer();
    const initial = await multi.run(request);
    const correctionExecutable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs"; import path from "node:path";
      const args = process.argv.slice(2);
      const packet = JSON.parse(args[10]);
      const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
      if (JSON.stringify(packet.ownedPaths) !== JSON.stringify(["src/a.ts"])) process.exit(81);
      if (config.agent["zentra-writer"].permission.edit !== "deny") process.exit(82);
      ${proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 2;\n", "export const a = 3;\n")])}
    `);
    const corrected = await multi.runCorrection({
      ...request, probe: await verifiedProbe(correctionExecutable, fixture.repository),
    }, {
      correctionId: "correction-1", paths: ["src/a.ts"], reason: "independent review rejected value 2",
      lease: initial.lease!, leaseToken: initial.pathClaim!.leaseToken,
    });
    expect(corrected.outcome).toBe("completed");
    expect(readFileSync(path.join(corrected.lease!.path, "src/a.ts"), "utf8")).toContain("a = 3");
    expect(readFileSync(path.join(corrected.lease!.path, "src/b.ts"), "utf8")).toContain("b = 2");
    expect(corrected.pathClaim!.paths).toEqual(["src/a.ts"]);
    expect(claims.inspect("fixture").active).toEqual([]);
    expect(journal.readStream("path-claims:fixture").map((event) => event.type))
      .toContain("writer.correction_proposed");
    journal.close();
  }, 20_000);

  it("records uncertainty when durable checkpointing fails after dispatch", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new FailingCheckpointClaims(journal);
    const executable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 1;\n", "export const a = 5;\n")])}
    `);
    await expect(writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-checkpoint-failure", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    })).rejects.toThrow(/checkpoint persistence failed/);
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toContain("writer.effect_uncertain");
    expect(claims.inspect("fixture").active[0]?.requiresReconciliation).toBe(true);
    journal.close();
  }, 20_000);

  it("keeps a genuine receipt without durable proposal intent evidence-missing", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new FailingIntentClaims(journal);
    const executable = fakeOpenCode(fixture.root,
      proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n")]));
    await expect(writer().run({ project: fixture.project, task: task(), model: model(),
      security: security(fixture.repository), probe: await verifiedProbe(executable, fixture.repository),
      signal: AbortSignal.timeout(10_000), claims, claimId: "claim-intent-crash", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    })).rejects.toThrow(/simulated crash before patch intent/);
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled).toMatchObject({ classification: "effect_observed_pending_evidence",
      missing: "patch_proposal_or_intent" });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toContain("writer.evidence_missing");
    expect(claims.inspect("fixture").active[0]).toMatchObject({ requiresReconciliation: true });
    journal.close();
  }, 20_000);

  it("rejects multiple OpenCode mutation-tool attempts without any host mutation", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      process.stdout.write(JSON.stringify({ type: "tool.denied", tool: "edit", status: "denied", path: "src/a.ts" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool.denied", tool: "write", status: "denied", path: "src/a.ts" }) + "\\n");
      ${proposalOutput(fixture.revision, [patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n")])}
    `);
    const result = await writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-tool-limit", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    });
    expect(result.outcome).toBe("denied");
    expect(readFileSync(path.join(result.lease!.path, "src/a.ts"), "utf8")).toContain("a = 1");
    expect(claims.inspect("fixture").active[0]).toMatchObject({ requiresReconciliation: true });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type))
      .not.toContain("writer.patch_application_intended");
    journal.close();
  }, 20_000);

  it("rejects a stale proposal preimage before trusted mutation", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const stale = patch("src/a.ts", "stale preimage\n", "export const a = 2;\n");
    const executable = fakeOpenCode(fixture.root, `${proposalOutput(fixture.revision, [stale])}`);
    await expect(writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims: new PathClaimService(journal), claimId: "claim-stale-preimage", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    })).rejects.toThrow(/preimage digest changed/i);
    const workspace = path.join(fixture.project.worktreeRoot, "multi-writer");
    expect(readFileSync(path.join(workspace, "src/a.ts"), "utf8")).toContain("a = 1");
    expect(journal.readStream("path-claims:fixture").map((event) => event.type))
      .not.toContain("writer.patch_application_intended");
    journal.close();
  }, 20_000);

  it("preserves executable replacement mode and applies the configured new-file mode", async () => {
    const fixture = await createFixture();
    const executablePath = path.join(fixture.repository, "src/run.sh");
    writeFileSync(executablePath, "#!/bin/sh\necho old\n");
    chmodSync(executablePath, 0o755);
    await ok(fixture.repository, ["add", "--", "src/run.sh"]);
    await ok(fixture.repository, ["commit", "-m", "add executable"]);
    const revision = (await output(fixture.repository, ["rev-parse", "HEAD"])).trim();
    const project = { ...fixture.project };
    const journal = new SqliteEventJournal(path.join(fixture.root, "mode.sqlite"));
    const executable = fakeOpenCode(fixture.root, proposalOutput(revision, [
      patch("src/run.sh", "#!/bin/sh\necho old\n", "#!/bin/sh\necho new\n"),
      patch("src/generated.txt", null, "generated\n"),
    ]));
    const planned = task();
    const result = await writer().run({ project, task: planned, model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims: new PathClaimService(journal), claimId: "claim-mode", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: planned.taskId, projectId: project.projectId,
        baseRevision: revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/generated.txt", "src/run.sh"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    });
    expect(result.outcome).toBe("completed");
    expect(statSync(path.join(result.lease!.path, "src/run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(result.lease!.path, "src/generated.txt")).mode & 0o777).toBe(0o644);
    journal.close();
  }, 20_000);

  it("accounts cache and reasoning components against input and output token budgets", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision,
        [patch("src/a.ts", "export const a = 1;\n", "export const a = 7;\n")],
        { input: 900, output: 990, reasoning: 11, cacheRead: 101, cacheWrite: 0 })}
    `);
    const result = await writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-token-budget", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    });
    expect(result.outcome).toBe("failed");
    expect(result.writer!.usage).toEqual({ inputTokens: 900, outputTokens: 990,
      reasoningTokens: 11, cacheReadTokens: 101, cacheWriteTokens: 0, toolCalls: 0 });
    const events = journal.readStream("path-claims:fixture");
    expect(events.find((event) => event.type === "writer.receipt_observed")?.payload)
      .toMatchObject({ usage: result.writer!.usage });
    expect(events.map((event) => event.type)).not.toContain("writer.checkpointed");
    expect(events.map((event) => event.type)).not.toContain("path_claim.released");
    expect(claims.inspect("fixture").active[0]).toMatchObject({ requiresReconciliation: true });
    journal.close();
  }, 20_000);

  it("journals partial trusted application and never retries the second file after a crash", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      ${proposalOutput(fixture.revision, [
        patch("src/a.ts", "export const a = 1;\n", "export const a = 2;\n"),
        patch("src/b.ts", "export const b = 1;\n", "export const b = 2;\n"),
      ])}
    `);
    const crashingWriter = writer((service) => new TrustedPatchApplier(service, (appliedPath) => {
      if (appliedPath === "src/a.ts") throw new Error("simulated crash after first atomic rename");
    }));
    await expect(crashingWriter.run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-partial", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts", "src/b.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
    })).rejects.toThrow(/simulated crash/);
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    expect(readFileSync(path.join(lease.path, "src/a.ts"), "utf8")).toContain("a = 2");
    expect(readFileSync(path.join(lease.path, "src/b.ts"), "utf8")).toContain("b = 1");
    const claim = claims.inspect("fixture").active[0]!;
    expect(claim.patchApplicationPending).not.toBeNull();
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled.classification).toBe("uncertain");
    expect(readFileSync(path.join(lease.path, "src/b.ts"), "utf8")).toContain("b = 1");
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).toEqual(expect.arrayContaining([
      "writer.patch_application_intended", "writer.patch_application_started",
      "writer.patch_file_applied", "writer.effect_uncertain",
    ]));
    journal.close();
  }, 20_000);

  it("keeps an unverified retained effect uncertain and blocked", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `
      import { writeFileSync } from "node:fs"; import path from "node:path";
      const args = process.argv.slice(2);
      writeFileSync(path.join(args[9], "README.md"), "outside claim\\n");
      process.stdout.write(JSON.stringify({ type: "step_finish" }) + "\\n");
    `);
    const request = {
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: AbortSignal.timeout(10_000),
      claims, claimId: "claim-uncertain", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1 as const, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
      observer: { onWriterCompleted: () => { throw new Error("crash after outside effect"); } },
    };
    const denied = await writer().run(request);
    expect(denied.outcome).toBe("denied");
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled.classification).toBe("uncertain");
    expect(claims.inspect("fixture").active[0]).toMatchObject({ requiresReconciliation: true });
    const { observer: _observer, ...restart } = request;
    await expect(writer().run({ ...restart, retainedLease: lease })).rejects.toThrow(/reconcil|baseline/i);
    journal.close();
  }, 20_000);

  it("keeps a cancelled receipt without patch intent evidence-missing", async () => {
    const fixture = await createFixture();
    const journal = new SqliteEventJournal(path.join(fixture.root, "journal.sqlite"));
    const claims = new PathClaimService(journal);
    const executable = fakeOpenCode(fixture.root, `setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const result = await writer().run({
      project: fixture.project, task: task(), model: model(), security: security(fixture.repository),
      probe: await verifiedProbe(executable, fixture.repository), signal: controller.signal,
      claims, claimId: "claim-cancelled", correlationId: "run-multi",
      capabilityBinding: acceptedBinding(journal, fixture.repository),
      writer: { schemaVersion: 1, taskId: "multi-writer", projectId: "fixture",
        baseRevision: fixture.revision, readPaths: ["**"], potentialWritePaths: ["src/**"],
        claimedWritePaths: ["src/a.ts"], forbiddenPaths: [".git/**", ".env"],
        checkpoint: { maxDurationMs: 10_000, maxToolCalls: 1 } },
      observer: { onWriterStarted: () => { setTimeout(() => controller.abort(), 100); } },
    });
    expect(result.outcome).toBe("cancelled");
    const claim = claims.inspect("fixture").active[0]!;
    const lease = { taskId: "multi-writer", branch: "ticket/multi-writer",
      path: path.join(fixture.project.worktreeRoot, "multi-writer") };
    const reconciled = await claims.reconcileWorkspace({ projectId: "fixture", claimId: claim.claimId,
      ownerId: claim.ownerId, revision: claim.revision, leaseToken: claim.leaseToken, lease,
      forbiddenPaths: [".git/**", ".env"], correlationId: "run-multi" },
    { ownership: new WorkspaceOwnershipGate(), worktrees: new WorktreeManager() });
    expect(reconciled).toMatchObject({ classification: "effect_observed_pending_evidence",
      missing: "patch_proposal_or_intent" });
    expect(journal.readStream("path-claims:fixture").map((event) => event.type)).not.toContain("path_claim.released");
    journal.close();
  }, 20_000);
});

function writer(factory?: (claims: PathClaimService) => TrustedPatchApplier): OpenCodeMultiFileWriter {
  const capsule = factory === undefined
    ? new WriterWorktreeCapsule(
      new WorktreeManager(), new OpenCodeWriter(new ProcessSupervisor()), new WorkspaceOwnershipGate(),
    )
    : new WriterWorktreeCapsule(
      new WorktreeManager(), new OpenCodeWriter(new ProcessSupervisor()), new WorkspaceOwnershipGate(),
      new GitClient(), factory,
    );
  const implementation = new OpenCodeMultiFileWriter(capsule);
  return {
    run: (request) => implementation.run({ ...request, dispatchAuthority: { mode: "unscheduled" } }),
    runCorrection: (request, correction) => implementation.runCorrection({ ...request,
      dispatchAuthority: { mode: "unscheduled" } }, correction),
  } as OpenCodeMultiFileWriter;
}

async function createFixture(): Promise<{ root: string; repository: string; revision: string; project: ProjectConfig }> {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-multi-file-")));
  directories.push(root);
  const repository = path.join(root, "repository");
  await ok(root, ["init", "-b", "main", repository]);
  await ok(repository, ["config", "user.name", "Zentra Fixture"]);
  await ok(repository, ["config", "user.email", "fixture@zentra.local"]);
  mkdirSync(path.join(repository, "src"));
  writeFileSync(path.join(repository, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repository, "src/b.ts"), "export const b = 1;\n");
  await ok(repository, ["add", "--", "src/a.ts", "src/b.ts"]);
  await ok(repository, ["commit", "-m", "initial"]);
  const revision = (await output(repository, ["rev-parse", "HEAD"])).trim();
  return { root, repository, revision, project: {
    projectId: "fixture", repositoryPath: repository, integrationBranch: "zentra/integration",
    worktreeRoot: path.join(root, "worktrees"), validations: {
      focused: [process.execPath, "--version"], full: [process.execPath, "--version"],
      focusedTimeoutMs: 5_000, fullTimeoutMs: 5_000,
    },
  } };
}

function task(): PlannedTask {
  return { taskId: "multi-writer", title: "Edit two files", description: "Edit both source files.",
    dependencies: [], ownedPaths: ["src/**"], forbiddenPaths: [".git/**", ".env"],
    acceptanceCriteria: ["Both files change."],
    roleAssignment: { role: "implementer", agentId: "writer-model", harness: "opencode" },
    risk: { level: "low", authority: "workspace_write", requiresReview: true, requiresApproval: false },
    budget: { maxSeconds: 10, maxRetries: 0, maxCostUsd: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 } };
}

function model(): ModelCapability {
  return { id: "writer-model", harness: "opencode", model: "provider/model", roles: ["implementer"],
    specialties: ["coding"], costTier: "low", contextTokens: 128_000, maxConcurrency: 1,
    toolPermissions: ["read_repository", "write_worktree"], network: "denied", fallbackOrder: [],
    qualityHistory: { successes: 1, attempts: 1 } };
}

function security(repository: string): SecuritySheet {
  return { allowedRepositories: [repository], allowedFileScopes: ["**"], forbiddenPaths: [".git/**", ".env"],
    network: { default: "denied", allowedDestinations: [] }, secretHandling: ["No inherited secrets."],
    approvalRequiredOperations: ["external_effect"], releaseBoundary: "local_preparation_only",
    stopAndAskConditions: ["forbidden_file_scope"] };
}

function acceptedBinding(journal: SqliteEventJournal, repository: string) {
  const capability = model();
  const sheet = security(repository);
  const binding = buildRoleCapabilityBinding({
    milestoneId: "multi-writer", taskId: "multi-writer", projectId: "fixture",
    correlationId: "run-multi", role: "implementer", actorId: capability.id,
    repository, planDigest: digestCanonical(task()), securityDigest: digestCanonical(sheet),
    model: { capabilityId: capability.id, transportModelId: capability.model,
      digest: digestCanonical(capability), harness: capability.harness, roles: capability.roles,
      toolPermissions: capability.toolPermissions, network: capability.network },
    budget: task().budget, admissionDigest: digestCanonical({ taskId: "multi-writer" }),
    configuredReadPaths: sheet.allowedFileScopes, ownedPaths: task().ownedPaths,
    forbiddenPaths: [...new Set([...task().forbiddenPaths, ...sheet.forbiddenPaths])],
  });
  return new RoleCapabilityEnvelopeService(journal).accept(binding);
}

function fakeOpenCode(root: string, source: string): string {
  const file = path.join(root, `fake-opencode-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, `#!/usr/bin/env node\nif (process.argv.length === 3 && process.argv[2] === "--version") { process.stdout.write("OpenCode fixture 1.0\\n"); process.exit(0); }\n${source}`, { mode: 0o755 });
  return realpathSync.native(file);
}

async function verifiedProbe(executable: string, repository: string) {
  const capability = model();
  const report = await new OpenCodeProbe(new ProcessSupervisor()).probe({
    executable, cwd: repository, timeoutMs: 5_000, modelId: capability.id,
    models: { models: [capability] }, security: security(repository),
  }, AbortSignal.timeout(10_000));
  if (report.outcome !== "completed") throw new Error("fixture probe failed");
  return report;
}

async function ok(cwd: string, args: readonly string[]): Promise<void> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const result = await git.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}

class FailingCheckpointClaims extends PathClaimService {
  override checkpoint(_input: Parameters<PathClaimService["checkpoint"]>[0]): void {
    throw new Error("checkpoint persistence failed");
  }
}

class FailingIntentClaims extends PathClaimService {
  override recordPatchProposalAndIntent(_input: Parameters<PathClaimService["recordPatchProposalAndIntent"]>[0]): never {
    throw new Error("simulated crash before patch intent");
  }
}

function patch(candidate: string, before: string | null, content: string) {
  return { path: candidate, expectedSha256: before === null ? null : sha256Text(before),
    content, contentSha256: sha256Text(content) };
}

function proposalOutput(
  baseRevision: string,
  operations: readonly ReturnType<typeof patch>[],
  tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
): string {
  const proposal = buildWriterPatchProposal({ schemaVersion: 1, kind: "zentra.patch_proposal",
    proposalId: `proposal-${Math.random().toString(16).slice(2)}`, baseRevision,
    operations: [...operations] });
  return `process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: ${JSON.stringify(JSON.stringify(proposal))} } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: ${tokens.input}, output: ${tokens.output}, reasoning: ${tokens.reasoning}, cache: { read: ${tokens.cacheRead}, write: ${tokens.cacheWrite} } } } }) + "\\n");`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recoverPatchInProcess(database: string, input: unknown): Promise<{ readonly outcome: "applied" | "lost" }> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
    const child = spawn(process.execPath, [viteNode, patchRecoveryFixture, database, encoded], {
      cwd: workspaceRoot, shell: false,
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
        .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`patch recovery child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout) as { outcome: "applied" | "lost" }); }
      catch (error) { reject(error); }
    });
  });
}
