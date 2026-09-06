# DCIECMS R5 Durable Event/Notification Outbox Implementation Plan

**Goal:** Persist externally deliverable lifecycle events inside the R4 business transaction and deliver them later through a crash-safe retryable outbox worker contract.

**Design:** `docs/superpowers/specs/2026-09-06-r5-durable-event-outbox-design.md`

## Task 1 — Outbox schema and Supabase test mapping

- Add RED migration-contract tests for `0012_event_outbox.sql` and the isolated Supabase test migration.
- Verify the expected missing-file failure.
- Add logical and Supabase test migrations plus `integration.outbox_events` schema mapping.
- Verify migration and mapping tests GREEN.

## Task 2 — PostgreSQL outbox store

- Add RED tests for idempotent enqueue, due/stale claim, worker-owned delivery transition, retry and dead-letter behavior.
- Implement `PostgresOutboxStore` with parameterized SQL and immutable mapped records.
- Verify targeted and backend regressions GREEN.

## Task 3 — Dispatcher

- Add RED tests for handler success, handler failure with deterministic backoff, missing handler, and bounded batch processing.
- Implement one-shot `OutboxDispatcher.runOnce()`; do not add an infinite loop or external provider.
- Verify targeted and backend regressions GREEN.

## Task 4 — Domain-event service integration

- Add RED tests for the selected events: filing accepted, payment confirmed, case opened, hearing scheduled/adjourned and judgment issued.
- Add an event-store dependency with a no-op default and await server-generated outbox events after successful domain mutation/audit.
- Preserve all existing authorization and state-transition contracts.

## Task 5 — PostgreSQL runtime and transaction atomicity

- Add RED runtime test showing repository, audit store and outbox store share the same `PostgresTransactionManager`.
- Inject `PostgresOutboxStore` in the PostgreSQL runtime.
- Add a representative rollback regression proving an outbox enqueue failure rolls back business mutation and audit evidence.

## Task 6 — Full regression, review and documentation

- Run backend tests.
- Run Court Workspace tests.
- Run production frontend build.
- Review the exact PR diff and correct Critical/Important findings.
- Update README and implementation status to record R5 while leaving real provider integrations outstanding.
- Merge only after a fresh final CI run is completely green.
