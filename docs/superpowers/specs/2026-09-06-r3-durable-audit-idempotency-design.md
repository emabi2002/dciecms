# DCIECMS R3 Durable Audit and Idempotency Design

## Objective

Harden the merged R0-R2 baseline so restart-sensitive control evidence is no longer held only in process memory. R3 is deliberately split into independently reviewable slices. This design covers durable filing-submission idempotency first and durable application audit persistence second. Notification outbox, production SSO, object storage/malware scanning, external payment callbacks and production infrastructure remain separate milestones.

## Current risk

The PostgreSQL schema already contains `audit.audit_events`, but `PersistentDciecmsService` still defaults to the in-memory `AuditStore`. Filing submission idempotency is also stored in `this.idempotency = new Map()`. A process restart therefore loses both the in-memory audit view and the idempotency replay cache. The business state in PostgreSQL survives, so restart behaviour can diverge from the original request-control evidence.

## Design principles

1. Preserve deny-by-default RBAC, court scope and server-authoritative workflow state.
2. Do not make the browser an authorization or idempotency boundary.
3. Do not fabricate production credentials, external providers or deployment state.
4. Prefer PostgreSQL transactions and unique constraints over process-local coordination.
5. Keep the no-`DATABASE_URL` development runtime functional with the existing in-memory service.
6. Use RED -> GREEN -> regression verification for every behavioral change.

## Slice A — Durable filing-submission idempotency

### Data model

Add migration `0011_durable_controls.sql` with `workflow.idempotency_records`:

- `idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `actor_subject text NOT NULL`
- `operation varchar(80) NOT NULL`
- `resource_id text NOT NULL`
- `idempotency_key varchar(200) NOT NULL`
- `response_payload jsonb`
- `created_at timestamptz NOT NULL DEFAULT now()`
- unique key on `(actor_subject, operation, resource_id, idempotency_key)`

The operation for filing submission is exactly `filing.submit`.

### Transaction contract

Replace the process-local replay cache for PostgreSQL-backed filing submission with a repository transaction that:

1. begins a transaction;
2. attempts to insert an idempotency claim row using `ON CONFLICT DO NOTHING`;
3. if the claim already exists, reads and returns the previously persisted `response_payload` without creating another workflow task or changing filing state;
4. if the caller owns the claim, transitions the filing from `DRAFT` to `SUBMITTED`;
5. creates exactly one Registry validation task;
6. stores the canonical submitted-filing response in the idempotency row;
7. commits;
8. rolls back the claim, filing mutation and task creation together on any failure.

A duplicate request after restart must therefore return the same stored response rather than a conflict merely because the filing is already submitted.

### Concurrency behaviour

The database unique constraint is the serialization boundary. Two concurrent requests using the same actor, operation, filing and idempotency key may not both own the claim. The loser reads the committed response. A rollback by the first request removes its claim because the claim is created inside the same transaction.

### Service contract

`PersistentDciecmsService.submitFiling()` continues to require an idempotency key and returns the same filing representation. For repositories implementing `submitFilingIdempotent`, the service delegates durable replay to the repository. The existing in-memory fallback remains for non-PostgreSQL development/test services until all callers are migrated.

## Slice B — Durable application audit persistence

### Schema compatibility

The baseline `audit.audit_events.actor_user_id` is UUID-typed while application actor subjects are not guaranteed to be UUIDs. Migration `0011_durable_controls.sql` therefore adds `actor_subject text` and preserves `actor_user_id` for backward compatibility. New application audit writes use `actor_subject`.

### Audit adapter

Add `PostgresAuditStore` with the same conceptual append/list contract as `AuditStore`, backed by `audit.audit_events`. Runtime construction with `DATABASE_URL` injects this store into the persistent/judicial service chain.

### Awaited writes

Application audit writes in persistent/judicial services become awaited so an audit persistence failure is observable rather than silently detached. This slice establishes durable evidence but does not yet claim that every business mutation and audit event are committed in one physical database transaction. Transactionally coupled audit/outbox hardening is a later R3 slice.

### Read access

`PostgresAuditStore.list()` supports exact-match filters required by tests and administration tooling while preserving parameterized SQL. No update/delete API is exposed.

## Security and integrity constraints

- Idempotency payloads are server-produced canonical responses only; client-provided response bodies are never persisted.
- Idempotency keys are scoped by actor, operation and resource.
- SQL remains parameterized.
- Audit events require actor subject, action and resource type.
- Audit rows remain append-only from the application contract; migration retains/reinforces update/delete restrictions.
- No production auth identity is derived from `x-dev-*` headers.

## Verification

R3 must add regressions proving:

1. migration `0011` creates the durable-control schema and uniqueness constraint;
2. first filing submission claims idempotency, mutates filing and creates one task in one transaction;
3. replay returns the persisted response and does not mutate the filing or create another task;
4. rollback leaves no durable claim when the filing transition fails;
5. `PostgresAuditStore` inserts parameterized append-only audit rows and maps reads;
6. PostgreSQL runtime injects durable audit storage;
7. all existing backend tests, Court Workspace tests and production frontend build remain green.

## Non-goals

- production deployment or live migration execution
- production SSO/OIDC/OAuth2 integration
- private object storage or malware scanning
- payment-gateway callback verification
- notification/event outbox
- full transactional coupling of every business mutation and audit record
- production WAF, vault, backup/DR or observability configuration