import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decideProxyFlow,
  findExactGitHubGrant,
  githubBrokerHeadRef,
  loadCapsulePolicy,
  publicCapsulePolicySummary,
} from "../../src/capsule/egress-policy.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function policyFile(value: unknown): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-capsule-policy-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "policy.json");
  writeFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  return realpathSync.native(file);
}

function validPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reads: { mode: "exact_domains", domains: ["example.com", "private-alias.test"], methods: ["GET", "HEAD"] },
    githubWrites: [
      { grantId: "push-1", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "push", repository: "talibilat/zentra", targetRef: `refs/heads/${githubBrokerHeadRef("pr-1")}`, sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false }, credential: { type: "environment", name: "GITHUB_TOKEN" } },
      { grantId: "pr-1", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "create_pull_request", repository: "talibilat/zentra", pushGrantId: "push-1", headRef: githubBrokerHeadRef("pr-1"), headCommit: "1".repeat(40), base: "main", titleSha256: "a".repeat(64), bodySha256: "b".repeat(64), draft: false }, credential: { type: "environment", name: "GITHUB_TOKEN" } },
    ],
    brokers: { github: "host", model: "disabled" },
  };
}

const publicFlow = {
  scheme: "https",
  method: "GET",
  host: "example.com",
  hasBody: false,
  upgrade: false,
  resolvedAddresses: ["93.184.216.34"],
} as const;

describe("capsule egress policy", () => {
  it("loads a strict handle-only policy and publishes no handles", () => {
    const policy = loadCapsulePolicy(policyFile(validPolicy()));
    expect(publicCapsulePolicySummary(policy)).toEqual({
      schemaVersion: 1,
      readMode: "exact_domains",
      readDomains: 2,
      readMethods: ["GET", "HEAD"],
      githubWriteGrants: 2,
      githubBroker: "host",
      modelBroker: "disabled",
      tlsInspectionRequired: true,
      globalWrites: "denied",
    });
  });

  it("supports all public domains without weakening address or HTTPS checks", () => {
    const candidate = validPolicy();
    candidate.reads = { mode: "all_public_domains", methods: ["GET"] };
    const policy = loadCapsulePolicy(policyFile(candidate));
    expect(decideProxyFlow(policy, { ...publicFlow, host: "any-public.example" })).toEqual({ allowed: true, reason: "configured_read" });
    expect(decideProxyFlow(policy, { ...publicFlow, host: "any-public.example", resolvedAddresses: ["127.0.0.1"] }).reason).toBe("private_target_denied");
  });

  it("allows only bodyless HTTPS GET/HEAD without upgrades", () => {
    const policy = loadCapsulePolicy(policyFile(validPolicy()));
    expect(decideProxyFlow(policy, publicFlow)).toEqual({ allowed: true, reason: "configured_read" });
    expect(decideProxyFlow(policy, { ...publicFlow, scheme: "http" }).reason).toBe("plaintext_http_denied");
    expect(decideProxyFlow(policy, { ...publicFlow, method: "CONNECT" }).reason).toBe("connect_denied");
    expect(decideProxyFlow(policy, { ...publicFlow, method: "POST" }).reason).toBe("method_denied");
    expect(decideProxyFlow(policy, { ...publicFlow, hasBody: true }).reason).toBe("read_body_denied");
    expect(decideProxyFlow(policy, { ...publicFlow, upgrade: true }).reason).toBe("upgrade_denied");
  });

  it("reproduces and denies an allowed-domain alias resolving to private targets", () => {
    const policy = loadCapsulePolicy(policyFile(validPolicy()));
    for (const address of [
      "127.0.0.1", "10.0.0.2", "169.254.169.254", "172.16.0.1", "192.168.65.1",
      "224.0.0.1", "240.0.0.1", "::1", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    ]) {
      expect(decideProxyFlow(policy, {
        ...publicFlow,
        host: "private-alias.test",
        resolvedAddresses: [address],
      })).toEqual({ allowed: false, reason: "private_target_denied" });
    }
    expect(decideProxyFlow(policy, { ...publicFlow, resolvedAddresses: [] }).reason).toBe("resolution_failed");
  });

  it("matches exact GitHub grants without exposing credential values", () => {
    const policy = loadCapsulePolicy(policyFile(validPolicy()));
    expect(findExactGitHubGrant(policy, {
      operation: "push", repository: "talibilat/zentra", targetRef: `refs/heads/${githubBrokerHeadRef("pr-1")}`, sourceCommit: "1".repeat(40), expectedOldOid: "0".repeat(40), force: false,
    })?.credential).toEqual({ type: "environment", name: "GITHUB_TOKEN" });
    expect(findExactGitHubGrant(policy, {
      operation: "push", repository: "talibilat/zentra", targetRef: "refs/heads/other", sourceCommit: "1".repeat(40), expectedOldOid: "2".repeat(40), force: false,
    })).toBeNull();
  });

  it("rejects raw secrets, wildcard domains, grants without a broker, and unknown fields", () => {
    for (const invalid of [
      { ...validPolicy(), token: "secret" },
      { ...validPolicy(), reads: { mode: "exact_domains", domains: ["*.example.com"], methods: ["GET"] } },
      { ...validPolicy(), brokers: { github: "disabled", model: "disabled" } },
      { ...validPolicy(), githubWrites: [{ grantId: "bad", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "push", repository: "talibilat/zentra", targetRef: "refs/heads/x", sourceCommit: "1".repeat(40), expectedOldOid: "2".repeat(40), force: false }, credential: { type: "environment", name: "TOKEN=secret" } }] },
      { ...validPolicy(), githubWrites: [{ grantId: "bad", audience: "zentra.github-broker", expiresAt: "2099-01-01T00:00:00.000Z", action: { operation: "push", repository: "talibilat/zentra", targetRef: "refs/heads/x", sourceCommit: "1".repeat(40), expectedOldOid: "2".repeat(40), force: false }, credential: { type: "keychain", name: "GITHUB_TOKEN" } }] },
      { ...validPolicy(), githubWrites: [{ ...(validPolicy().githubWrites as Record<string, unknown>[])[0], audience: "other-service" }] },
    ]) expect(() => loadCapsulePolicy(policyFile(invalid))).toThrow();
  });

  it("rejects symlinked policy paths", () => {
    const canonical = policyFile(validPolicy());
    const linked = path.join(path.dirname(canonical), "linked.json");
    symlinkSync(canonical, linked);
    expect(() => loadCapsulePolicy(linked)).toThrow("canonical");
  });
});
