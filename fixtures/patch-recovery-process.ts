import { SqliteEventJournal } from "../src/journal/sqlite-journal.js";
import { PathClaimService } from "../src/workspaces/path-claims.js";
import { TrustedPatchApplier } from "../src/workspaces/trusted-patch-applier.js";
import type { RoleCapabilityBinding } from "../src/workers/role-capability-envelope.js";

const [database, encoded] = process.argv.slice(2);
if (database === undefined || encoded === undefined) process.exit(64);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
  projectId: string; correlationId: string;
  lease: { taskId: string; branch: string; path: string };
  binding: RoleCapabilityBinding;
};
const journal = new SqliteEventJournal(database);
try {
  const claims = new PathClaimService(journal);
  const claim = claims.inspect(input.projectId).active[0];
  if (claim === undefined) throw new Error("prepared claim is unavailable");
  try {
    new TrustedPatchApplier(claims).recover({ ...input, claim });
    process.stdout.write(`${JSON.stringify({ outcome: "applied" })}\n`);
  } catch (error) {
    if (!(error instanceof Error) || !/optimistic intent CAS|expected version|not safely recoverable/i.test(error.message)) throw error;
    process.stdout.write(`${JSON.stringify({ outcome: "lost" })}\n`);
  }
} finally {
  journal.close();
}
