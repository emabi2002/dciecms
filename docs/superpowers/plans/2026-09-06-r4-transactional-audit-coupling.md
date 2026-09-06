# DCIECMS R4 Transactional Audit Coupling Implementation Plan

**Goal:** Ensure each PostgreSQL-backed mutating DCIECMS service operation and its awaited audit event commit or roll back together.

**Design:** `docs/superpowers/specs/2026-09-06-r4-transactional-audit-coupling-design.md`

## Task 1 — Transaction manager RED/GREEN

- Add a failing unit test for a missing `PostgresTransactionManager`.
- Verify RED in CI.
- Implement transaction-aware query routing with `AsyncLocalStorage`.
- Prove success commit, failure rollback and nested transaction-control suppression.

## Task 2 — Transactional service boundary RED/GREEN

- Add tests for the reviewed mutating-method registry and service proxy.
- Prove mutating methods use `withTransaction` while reads do not.
- Implement the service proxy.

## Task 3 — Runtime wiring RED/GREEN

- Add runtime regression showing repository and audit store share the transaction manager.
- Update PostgreSQL runtime to construct the manager after schema mapping, inject repository/audit through it, and return the transactional service proxy.
- Preserve the in-memory runtime unchanged.

## Task 4 — Atomic mutation+audit regression

- Add a representative service regression where business SQL succeeds but audit insert fails.
- Verify the outer transaction issues `ROLLBACK`, not `COMMIT`, on the same client.
- Add a success regression proving business SQL and audit SQL commit together.

## Task 5 — Full regression and documentation

- Run backend tests.
- Run Court Workspace tests.
- Run production frontend build.
- Update README and implementation status to record R4 and remove full mutation+audit coupling from the outstanding list.
- Open PR for review only after fresh CI is green.
