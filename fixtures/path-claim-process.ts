import { SqliteEventJournal } from "../src/journal/sqlite-journal.js";
import { PathClaimConflictError, PathClaimService } from "../src/workspaces/path-claims.js";

const [database, claimId, ownerId, revision, candidate] = process.argv.slice(2);
if ([database, claimId, ownerId, revision, candidate].some((value) => value === undefined)) process.exit(64);

const journal = new SqliteEventJournal(database!);
try {
  const claim = new PathClaimService(journal).acquire({
    projectId: "multiprocess", claimId: claimId!, ownerId: ownerId!, revision: revision!,
    paths: [candidate!], leaseMs: 60_000, correlationId: claimId!,
  });
  process.stdout.write(`${JSON.stringify({ outcome: "acquired", claimId: claim.claimId })}\n`);
} catch (error) {
  if (!(error instanceof PathClaimConflictError)) throw error;
  process.stdout.write(`${JSON.stringify({ outcome: "denied", claimId })}\n`);
} finally {
  journal.close();
}
