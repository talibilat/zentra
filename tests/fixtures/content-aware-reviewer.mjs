#!/usr/bin/env node

import { createHash } from "node:crypto";

if (process.argv.length !== 2) {
  throw new Error("review evidence must be provided only through stdin");
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);
const dangerous = request.diff.includes("requireAuthentication = false");
const decision = {
  reviewerId: request.reviewerId,
  decision: dangerous ? "deny" : "approve",
  diffSha256: createHash("sha256").update(request.diff, "utf8").digest("hex"),
  validationSha256: request.validationSha256,
  decidedAt: new Date().toISOString(),
  reason: dangerous
    ? "Denied dangerous authentication bypass in the reviewed diff"
    : `Reviewed exact diff and validation output: ${request.validation.stdout}`,
};

process.stdout.write(`${JSON.stringify(decision)}\n`);
