# Issue 010 Implementation Report

## Implementation

`IntegrationQueue` calls the existing `assertNoGitObjectSubstitution` guard under the durable integration lease before reading the source commit identity.

The queue calls the guard again under the same lease immediately before the expected-old `update-ref` compare-and-swap.

Initial guard failures remain typed as `IntegrationExecutionError` failures.

Final guard failures remain typed as `IntegrationPreparationError` failures, so no untyped error path reaches the ref update.

The existing atomic expected-old `update-ref` operation and late receipt validation remain unchanged.

## Test Evidence

Real-Git tests cover replacement refs and a nonempty graft file present before integration begins.

Both initial cases prove no source read, candidate creation, merge, full validation, prepared callback, or ref update occurs.

A real-Git race test writes a graft file after candidate validation and prepared-journal persistence but before `update-ref`.

Every adversarial case compares the integration ref, a recursive byte snapshot of the ticket worktree, and serialized `task.completed` evidence before and after rejection.

Implementation commit: `6bd915f`.
