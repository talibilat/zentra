import { createPrivateKey } from "node:crypto";
import { linkSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SqliteEventJournal } from "../dist/src/journal/sqlite-journal.js";
import {
  OpenCodeSubagentCapabilityProbe,
  OpenCodeSubagentConformanceJournal,
} from "../dist/src/harnesses/opencode-subagent-capability.js";
import { ProcessSupervisor } from "../dist/src/workers/process-supervisor.js";

const names = new Set([
  "executable", "cwd", "home", "database", "project-id", "probe-id", "signing-private-key",
  "trusted-public-key-sha256", "report",
]);
const trustedOpenCode = Object.freeze({
  executable: "/Users/talibilat/.opencode/bin/opencode",
  executableSha256: "43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2",
  version: "1.18.3",
  sourceRevision: "127bdb30784d508cc556c71a0f32b508a3061517",
});
const values = new Map();
const start = process.argv[2] === "--" ? 3 : 2;
for (let index = start; index < process.argv.length; index += 2) {
  const option = process.argv[index];
  const value = process.argv[index + 1];
  if (!option?.startsWith("--") || value === undefined || !names.has(option.slice(2)) || values.has(option.slice(2))) {
    throw new Error("invalid native-subagent probe arguments");
  }
  values.set(option.slice(2), value);
}
for (const name of names) if (!values.has(name)) throw new Error(`missing --${name}`);

const database = path.resolve(values.get("database"));
const keyPath = values.get("signing-private-key");
if (keyPath !== realpathSync.native(keyPath)) throw new Error("signing key path must be canonical");
const keyStat = lstatSync(keyPath);
if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077) !== 0 || keyStat.size > 16_384) {
  throw new Error("signing key must be a private bounded regular file");
}
const signingPrivateKey = createPrivateKey(readFileSync(keyPath));
const journal = new SqliteEventJournal(database);
try {
  const probeId = values.get("probe-id");
  const projectId = values.get("project-id");
  const existing = journal.readStream(`subagent-probe:${probeId}`);
  const report = existing.length === 0
    ? await new OpenCodeSubagentCapabilityProbe(new ProcessSupervisor(), trustedOpenCode).run({
      probeId,
      projectId,
      executable: values.get("executable"),
      sourceRevision: trustedOpenCode.sourceRevision,
      cwd: values.get("cwd"),
      home: values.get("home"),
      timeoutMs: 10_000,
      signingPrivateKey,
    }, AbortSignal.timeout(15_000))
    : existing[0]?.payload?.report;
  new OpenCodeSubagentConformanceJournal(journal, {
    trustedPublicKeySha256: [values.get("trusted-public-key-sha256")],
  }).record(probeId, projectId, report, probeId);
  retainExactReport(values.get("report"), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.outcome === "enabled" ? 0 : 2;
} finally {
  journal.close();
}

function retainExactReport(candidate, report) {
  const reportPath = path.resolve(candidate);
  const parent = path.dirname(reportPath);
  if (parent !== realpathSync.native(parent)) throw new Error("report parent must be canonical");
  const content = `${JSON.stringify(report, null, 2)}\n`;
  try {
    const stat = lstatSync(reportPath);
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(reportPath, "utf8") !== content) {
      throw new Error("retained report does not match the exact signed report");
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.${path.basename(reportPath)}.${process.pid}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, reportPath);
  } finally {
    unlinkSync(temporary);
  }
}
