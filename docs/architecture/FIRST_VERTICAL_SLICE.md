# DCIECMS First Vertical Slice

## Purpose

The first executable slice proves the security and workflow spine for R0/R1 before broad feature development.

## Implemented flow

1. Resolve development identity claims into effective roles and court scopes.
2. Authorize every protected operation with deny-by-default RBAC and court scoping.
3. Create a party inside an authorized court.
4. Create a filing draft against a controlled case type.
5. Register filing document metadata in `QUARANTINED` state with SHA-256 validation.
6. Submit the filing using an idempotency key.
7. Create exactly one active `REGISTRY_VALIDATE_FILING` workflow task.
8. Display the submitted filing and validation task only to Registry users within the appropriate court scope.
9. Validate the filing from `SUBMITTED` to `VALIDATED` and complete the workflow task.
10. Record audit evidence for filing submission, task access and validation.

## PostgreSQL direction

`0001_baseline.sql` establishes the core R0/R1 schemas and tables. `0002_config_workflow.sql` adds controlled case types, validation evidence and Registry workflow tasks. `PostgresRepository` defines parameterized persistence operations and transaction semantics for validation/task completion. `postgres-runtime.js` provides bounded pool configuration through `DATABASE_URL`.

The current `DciecmsService` still uses in-memory maps for the executable application flow. The PostgreSQL repository exists as a tested persistence boundary but has not yet replaced every in-memory operation. Live database deployment and credentials are intentionally not assumed.

## Authentication boundary

The HTTP adapter currently supports `x-dev-*` identity headers for development tests only. They are not a production authentication design. Production traffic must use validated claims from the approved identity provider/API gateway.

## Next slice

Continue replacing in-memory persistence with PostgreSQL-backed transactions, implement controlled Registry return/reject/accept transitions, then introduce fee assessment/payment state and the first Court Workspace UI against the stabilized APIs.
