import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { attestHostOpenCode } from "../../src/harnesses/opencode-attestation.js";
import { ProcessSupervisor } from "../../src/workers/process-supervisor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("host OpenCode operator attestation", () => {
  it("requires the exact canonical executable digest and exact bounded version with a minimal home", async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-host-attestation-")));
    roots.push(root);
    const home = path.join(root, "home");
    mkdirSync(home);
    const executable = path.join(root, "opencode");
    writeFileSync(executable, `#!/usr/bin/env node
if (process.env.HOME !== ${JSON.stringify(home)} || process.argv[2] !== "--version") process.exit(9);
process.stdout.write("fixture-opencode 1.18.3\\n");
`, { mode: 0o755 });
    const canonical = realpathSync.native(executable);
    const expectedSha256 = createHash("sha256").update(readFileSync(canonical)).digest("hex");
    await expect(attestHostOpenCode(new ProcessSupervisor(), {
      executable: canonical, home: realpathSync.native(home), cwd: root, expectedSha256,
      expectedVersion: "fixture-opencode 1.18.3", timeoutMs: 5_000,
    }, AbortSignal.timeout(10_000))).resolves.toEqual({
      executable: canonical, executableSha256: expectedSha256, version: "fixture-opencode 1.18.3",
    });
  });

  it.each([
    ["digest", { expectedSha256: "0".repeat(64) }],
    ["version", { expectedVersion: "another version" }],
    ["version boundary", { expectedVersion: "x".repeat(513) }],
  ])("returns one stable error for %s mismatch", async (_name, changed) => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "zentra-host-attestation-fail-")));
    roots.push(root);
    const home = path.join(root, "home");
    mkdirSync(home);
    const executable = path.join(root, "opencode");
    writeFileSync(executable, "#!/usr/bin/env node\nprocess.stdout.write('v1\\n');\n", { mode: 0o755 });
    const request = {
      executable: realpathSync.native(executable), home: realpathSync.native(home), cwd: root,
      expectedSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      expectedVersion: "v1", timeoutMs: 5_000, ...changed,
    };
    await expect(attestHostOpenCode(new ProcessSupervisor(), request, AbortSignal.timeout(10_000)))
      .rejects.toThrow(/^host OpenCode operator attestation failed$/);
  });
});
