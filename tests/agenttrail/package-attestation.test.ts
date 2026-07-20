import { cp, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packagedAgentTrailRoot,
  resolvePackagedAgentTrail,
  verifyAgentTrailPackageRoot,
} from "../../src/agenttrail/package-attestation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
  ));
});

describe("resolvePackagedAgentTrail", () => {
  it("resolves the canonical attested Darwin arm64 executable and web asset", async () => {
    const resolved = await resolvePackagedAgentTrail();

    expect(resolved.executablePath).toBe(path.join(await packagedAgentTrailRoot(), "agenttrail"));
    expect(resolved.webAssetPath).toBe(path.join(await packagedAgentTrailRoot(), "web", "index.html"));
    expect(resolved.webAssetByteLength).toBe(resolved.webAssetBytes.byteLength);
    expect(resolved.webAssetSha256).toBe("0016d4baa63c11617c3ee69b78410c847591e6cbf021d91259d71f1e756a8020");
    expect(resolved.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.architecture).toBe("arm64");
  });

  it.each([
    ["modified executable", async (root: string) => writeFile(path.join(root, "agenttrail"), "modified")],
    ["modified web asset", async (root: string) => writeFile(path.join(root, "web", "index.html"), "modified")],
    ["unsigned manifest", async (root: string) => writeFile(path.join(root, "attestation.json"), "{}\n")],
  ])("rejects a %s", async (_label, mutate) => {
    const root = await copyPackage();
    await mutate(root);
    await expect(verifyAgentTrailPackageRoot(root)).rejects.toThrow();
  });

  it("rejects a symlinked canonical executable", async () => {
    const root = await copyPackage();
    const executable = path.join(root, "agenttrail");
    const alternate = path.join(root, "agenttrail-alternate");
    await import("node:fs/promises").then(({ rename }) => rename(executable, alternate));
    await symlink(alternate, executable);

    await expect(verifyAgentTrailPackageRoot(root)).rejects.toThrow(/symlink/);
  });

  it("rejects relative and alternate executable identities", async () => {
    const root = await copyPackage();
    await expect(verifyAgentTrailPackageRoot("agenttrail/package/darwin-arm64"))
      .rejects.toThrow(/absolute/);
    await expect(verifyAgentTrailPackageRoot(root, path.join(root, "agenttrail-alternate")))
      .rejects.toThrow(/alternate executable/);
  });

  it("rejects wrong-architecture and wrapped executable content before launch", async () => {
    const root = await copyPackage();
    const executable = path.join(root, "agenttrail");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await rewriteDigestFiles(root);

    await expect(verifyAgentTrailPackageRoot(root)).rejects.toThrow(/package identity|Mach-O|arm64/);
  });

  it("rejects coherent executable, manifest, and attestation rewriting", async () => {
    const root = await copyPackage();
    await writeFile(path.join(root, "agenttrail"), Buffer.alloc(64, 0), { mode: 0o755 });
    await rewriteDigestFiles(root);

    await expect(verifyAgentTrailPackageRoot(root)).rejects.toThrow(/reviewed manifest/);
  });
});

async function copyPackage(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "zentra-agenttrail-package-")));
  temporaryDirectories.push(parent);
  const root = path.join(parent, "darwin-arm64");
  await cp(await packagedAgentTrailRoot(), root, { recursive: true });
  return root;
}

async function rewriteDigestFiles(root: string): Promise<void> {
  const { createHash } = await import("node:crypto");
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Record<string, { sha256: string; bytes: number }>;
  };
  const executable = await readFile(path.join(root, "agenttrail"));
  manifest.files["agenttrail"] = {
    ...manifest.files["agenttrail"],
    bytes: executable.byteLength,
    sha256: createHash("sha256").update(executable).digest("hex"),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const attestationPath = path.join(root, "attestation.json");
  const attestation = JSON.parse(await readFile(attestationPath, "utf8")) as Record<string, unknown>;
  attestation["manifestSha256"] = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
}
