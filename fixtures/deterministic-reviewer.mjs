#!/usr/bin/env node
// Deterministic reviewer fixture for independent review decisions.
// Accepts only: --diff-sha256, --validation-sha256, --worker-id, --reviewer-id
// Emits one JSON line with review decision and exits 0.

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
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i];
  if (!allowedFlags.has(flag)) {
    fail(`unknown flag: ${flag}`);
  }
  if (values.has(flag)) {
    fail(`duplicate flag: ${flag}`);
  }
  const value = argv[i + 1];
  if (value === undefined) {
    fail(`missing value for flag: ${flag}`);
  }
  values.set(flag, value);
}

for (const flag of allowedFlags) {
  if (!values.has(flag)) {
    fail(`missing required flag: ${flag}`);
  }
}

const diffSha256 = values.get("--diff-sha256");
const validationSha256 = values.get("--validation-sha256");
const workerId = values.get("--worker-id");
const reviewerId = values.get("--reviewer-id");

// Validate that digests are 64-character hex strings
if (!/^[a-f0-9]{64}$/.test(diffSha256)) {
  fail(`--diff-sha256 must be 64-character hex: ${diffSha256}`);
}
if (!/^[a-f0-9]{64}$/.test(validationSha256)) {
  fail(`--validation-sha256 must be 64-character hex: ${validationSha256}`);
}

// Approval logic: approve if worker != reviewer and both digests are valid hex
const approved = workerId !== reviewerId;

const decision = {
  reviewerId,
  approved,
  diffSha256,
  validationSha256,
  decidedAt: new Date().toISOString(),
  reason: approved ? "deterministic approval" : "worker and reviewer are the same identity",
};

process.stdout.write(`${JSON.stringify(decision)}\n`);
process.exit(0);
