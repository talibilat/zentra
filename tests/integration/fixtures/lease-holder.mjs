// Test helper: a real, separate OS process that acquires the durable
// cross-process integration lease against a shared SQLite database file and
// exact lease key, holds it for a fixed duration, then releases it. Used to
// prove that two independent Zentra processes never hold the same lease key
// concurrently (issue 014, required two-process end-to-end test).
//
// Argv: <databasePath> <commonDirectory> <integrationRef> <holdMs> <resultsPath>
import { appendFileSync } from "node:fs";
import { IntegrationLeaseStore } from "../../../dist/src/integration/integration-lease.js";

const [databasePath, commonDirectory, integrationRef, holdMsRaw, resultsPath] =
  process.argv.slice(2);

if (
  databasePath === undefined ||
  commonDirectory === undefined ||
  integrationRef === undefined ||
  holdMsRaw === undefined ||
  resultsPath === undefined
) {
  console.error("lease-holder: missing required arguments");
  process.exit(1);
}

const holdMs = Number(holdMsRaw);
const key = { commonDirectory, integrationRef };
const acquireTimeoutMs = 10_000;
const acquireDeadline = Date.now() + acquireTimeoutMs;

const store = new IntegrationLeaseStore(databasePath);
try {
  let lease = store.acquire(key, Math.max(holdMs + 2_000, 1_000));
  while (lease === null) {
    if (Date.now() >= acquireDeadline) {
      console.error("lease-holder: timed out waiting to acquire the lease");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease = store.acquire(key, Math.max(holdMs + 2_000, 1_000));
  }

  const acquiredAt = Date.now();
  appendFileSync(
    resultsPath,
    `${JSON.stringify({ pid: process.pid, event: "acquired", at: acquiredAt })}\n`,
    "utf8",
  );

  await new Promise((resolve) => setTimeout(resolve, holdMs));

  const releasedAt = Date.now();
  const released = store.release(lease);
  appendFileSync(
    resultsPath,
    `${JSON.stringify({ pid: process.pid, event: "released", at: releasedAt, released })}\n`,
    "utf8",
  );
} finally {
  store.close();
}
