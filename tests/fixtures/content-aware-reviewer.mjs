#!/usr/bin/env node

import { createHash } from "node:crypto";

if (process.argv.length !== 2) {
  throw new Error("review evidence must be provided only through stdin");
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);
const validation = request.validation;
const argvSha256 = createHash("sha256")
  .update(JSON.stringify(validation.command), "utf8")
  .digest("hex");
const outputSha256 = createHash("sha256")
  .update(JSON.stringify({ stdout: validation.stdout, stderr: validation.stderr }), "utf8")
  .digest("hex");
const validationSha256 = createHash("sha256")
  .update(JSON.stringify({
    name: validation.name,
    outcome: validation.outcome,
    exitCode: validation.exitCode,
    startedAt: validation.startedAt,
    finishedAt: validation.finishedAt,
    command: validation.command,
    stdout: validation.stdout,
    stderr: validation.stderr,
    argvSha256,
    outputSha256,
    provenance: validation.provenance,
  }), "utf8")
  .digest("hex");
const dangerous = request.diff.includes("requireAuthentication = false");
const decision = {
  reviewerId: request.reviewerId,
  decision: dangerous ? "deny" : "approve",
  requestSha256: createHash("sha256").update(input, "utf8").digest("hex"),
  diffSha256: createHash("sha256").update(request.diff, "utf8").digest("hex"),
  validationSha256,
  decidedAt: new Date().toISOString(),
  reason: dangerous
    ? "Denied dangerous authentication bypass in the reviewed diff"
    : `Reviewed exact diff and validation output: ${request.validation.stdout}`,
};

process.stdout.write(`${JSON.stringify(decision)}\n`);
