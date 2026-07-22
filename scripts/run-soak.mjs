import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync,
  statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSoakProfile, runSoakHarness, verifySoakReport } from "../dist/src/soak/soak-harness.js";

const options = parse(process.argv.slice(2));
const root = realpathSync.native(options.output);
if (!statSync(root).isDirectory()) throw new Error("soak output must be an existing canonical directory");
const profile = options.profile;
const config = createSoakProfile(profile, { seed: options.seed, workerCount: options.workers,
  signing: { privateKeyPath: options.signingKey, trustedPublicKeySha256: options.trustedPublicKeySha256 } });
const configPath = path.join(root, "soak-config.json");
const configJson = `${JSON.stringify(config, null, 2)}\n`;
if (existsSync(configPath)) {
  if (readFileSync(configPath, "utf8") !== configJson) throw new Error("frozen soak config differs from requested run");
} else {
  const temporary = `${configPath}.tmp-${randomUUID()}`;
  writeFileSync(temporary, configJson, { mode: 0o600, flag: "wx" });
  const file = openSync(temporary, "r"); fsyncSync(file); closeSync(file);
  renameSync(temporary, configPath);
  const directory = openSync(root, "r"); fsyncSync(directory); closeSync(directory);
}
const controller = new AbortController();
const abort = () => controller.abort(new DOMException("soak interrupted", "AbortError"));
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
  const result = await runSoakHarness({ root, config, resume: options.resume, signal: controller.signal });
  if (!await verifySoakReport(result.reportPath, { root,
    trustedPublicKeySha256: options.trustedPublicKeySha256 })) throw new Error("soak report signature verification failed");
  process.stdout.write(`${JSON.stringify({ status: result.report.status, profile, reportPath: result.reportPath,
    databasePath: result.databasePath, configPath, reportSha256: result.report.digests.reportSha256 })}\n`);
  process.exitCode = result.report.status === "qualified" ? 0 : result.report.status === "running" ? 2 : 1;
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}

function parse(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const values = { profile: "ci", output: "", seed: undefined, workers: undefined, resume: false,
    signingKey: "", trustedPublicKeySha256: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--resume") { values.resume = true; continue; }
    if (!["--profile", "--output", "--seed", "--workers", "--signing-key",
      "--trusted-public-key-sha256"].includes(option)) throw new Error(`unknown soak option ${option}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${option}`);
    index += 1;
    if (option === "--profile") values.profile = value;
    else if (option === "--output") values.output = value;
    else if (option === "--seed") values.seed = value;
    else if (option === "--workers") values.workers = Number(value);
    else if (option === "--signing-key") values.signingKey = value;
    else values.trustedPublicKeySha256 = value;
  }
  if (!["ci", "process", "realtime-24h"].includes(values.profile)) throw new Error("unsupported soak profile");
  if (values.output.length === 0 || !path.isAbsolute(values.output) || !existsSync(values.output) ||
    realpathSync.native(values.output) !== path.normalize(values.output)) throw new Error("soak output must be canonical and absolute");
  if (values.seed !== undefined && (!/^[A-Za-z0-9._-]{1,256}$/.test(values.seed))) throw new Error("invalid soak seed");
  if (values.workers !== undefined && (!Number.isSafeInteger(values.workers) || values.workers < 20 || values.workers > 40)) {
    throw new Error("soak workers must be between 20 and 40");
  }
  if (!path.isAbsolute(values.signingKey) || !existsSync(values.signingKey) ||
    realpathSync.native(values.signingKey) !== path.normalize(values.signingKey)) throw new Error("signing key must be a canonical absolute file");
  if (!/^[a-f0-9]{64}$/.test(values.trustedPublicKeySha256)) throw new Error("trusted public-key digest must be lowercase SHA-256");
  return values;
}
