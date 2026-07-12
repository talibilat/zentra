#!/usr/bin/env node

function fail(message) {
  process.stderr.write(`deterministic-reviewer: ${message}\n`);
  process.exit(1);
}

const allowedFlags = new Set([
  "--diff-sha256",
  "--validation-sha256",
  "--worker-id",
  "--reviewer-id",
]);
const values = new Map();
const argv = process.argv.slice(2);

for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index];
  if (!allowedFlags.has(flag)) fail(`unknown flag: ${flag}`);
  if (values.has(flag)) fail(`duplicate flag: ${flag}`);
  const value = argv[index + 1];
  if (value === undefined) fail(`missing value for flag: ${flag}`);
  values.set(flag, value);
}

for (const flag of allowedFlags) {
  if (!values.has(flag)) fail(`missing required flag: ${flag}`);
}

const diffSha256 = values.get("--diff-sha256");
const validationSha256 = values.get("--validation-sha256");
const workerId = values.get("--worker-id");
const reviewerId = values.get("--reviewer-id");
if (!/^[a-f0-9]{64}$/.test(diffSha256)) fail("invalid diff digest");
if (!/^[a-f0-9]{64}$/.test(validationSha256)) fail("invalid validation digest");

process.stdout.write(`${JSON.stringify({
  reviewerId,
  approved: workerId !== reviewerId,
  diffSha256,
  validationSha256,
  decidedAt: new Date().toISOString(),
  reason: workerId === reviewerId ? "matching identities" : "deterministic approval",
})}\n`);
