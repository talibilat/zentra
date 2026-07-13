# Validation Invocation ID Lifetime Design

Date: 2026-07-13

Status: Approved

## Decision

Validation invocation IDs are unique only while an invocation is active in the current process.

Zentra rejects a duplicate ID while the first invocation is active and permits the ID to be reused after that invocation settles.

Invocation ID provenance remains durable in each validation report, but Zentra does not persist a registry of completed IDs.

## Implementation

The validation runner keeps one module-level set of active invocation IDs so duplicate protection applies across all `ValidationRunner` instances in the process.

The runner validates the ID before registration, adds it immediately before the first asynchronous operation, and wraps every subsequent operation in `try/finally`.

The `finally` block removes the ID after successful completion, cancellation, timeout, supervisor rejection, spawn failure, filesystem failure, executable identity failure, report parsing failure, or any other thrown exception.

The duplicate error describes active uniqueness rather than single-use uniqueness.

A narrow read-only active-count function exposes the registry size for bounded-lifetime verification without exposing or mutating the IDs.

## Data Flow

1. Validate the timeout, command, invocation ID, and subject digest.
2. Reject the invocation if its ID is already active.
3. Add the ID to the process-wide active set.
4. Resolve the working directory, verify the executable identity, execute the validation, and construct the report.
5. Remove the ID in `finally` before the returned promise settles.

## Tests

Focused tests will prove that concurrent duplicate IDs are rejected across separate runner instances while the first supervisor call is pending.

Sequential stress tests will run many successful and failed validations and assert that the active count returns to zero after each settled invocation.

Failure coverage will include a rejected supervisor call so thrown errors exercise the same cleanup path as returned terminal outcomes.

A completed invocation ID will be reused to prove that active-only semantics are observable to callers.

The final gate will run `pnpm test`, `pnpm check`, and `pnpm build`.

A long-loop verification will record stable zero registry counts and compare bounded heap usage before and after forced garbage collection when the runtime exposes it.

## Non-Goals

This change does not add durable uniqueness, restart retention, a retention window, bounded persistence, or collision storage.

This change does not alter durable validation report provenance.

This change does not handle integration cleanup-failure retention from issue 028 or create a general metrics system.
