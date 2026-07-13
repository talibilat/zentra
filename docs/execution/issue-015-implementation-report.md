# Issue 015 Implementation Report

## Implementation

Validation invocation IDs now represent active in-process executions rather than process-lifetime history.

The runner rejects an invocation ID while another validation with that ID is active.

A `finally` block removes the ID after success, cancellation, timeout, spawn failure, or any thrown error.

Completed IDs can be reused without an unbounded registry.

## Test Evidence

Tests prove duplicate IDs are rejected across runner instances while active and accepted after completion.

A 100-iteration alternating success and failure test checks that the active registry returns to zero after every execution.

Implementation commit: `2d9ed73`.
