# DCIECMS R5 Durable Event/Notification Outbox Design

## Objective

Add a durable PostgreSQL outbox so DCIECMS can record externally deliverable domain events inside the same business transaction, then deliver them later with bounded retries, crash-safe leases and dead-letter handling. R5 provides delivery infrastructure only; it does not connect a real email, SMS, payment, storage or government-agency provider.

## Reliability contract

1. Domain-state mutation, application audit evidence and outbox enqueue commit together when PostgreSQL runtime is active.
2. No network/provider call occurs inside that business transaction.
3. Event enqueue is idempotent by event type plus server-generated deduplication key.
4. Workers claim due events with database locking so two workers cannot intentionally own the same row at the same time.
5. A crashed worker's stale lease can be reclaimed after the configured lease period.
6. Successful delivery is recorded durably.
7. Failed delivery is returned to `PENDING` with a future retry time until the maximum attempts are reached, then becomes `DEAD_LETTER`.
8. No outbox row is deleted by normal application delivery flow.
9. Delivery semantics are **at least once**: a handler may be invoked again if its external side effect succeeds but durable delivery acknowledgement cannot be recorded before the worker loses its lease or crashes.
10. Every downstream/provider handler must therefore be **idempotent**, using `outbox_event_id`, the stable domain-event deduplication key, or an equivalent provider-side idempotency mechanism before performing a non-repeatable external side effect.

## Schema

Migration `0012_event_outbox.sql` creates schema `integration` and table `integration.outbox_events`.

Fields:

- `outbox_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `event_type varchar(120) NOT NULL`
- `aggregate_type varchar(80) NOT NULL`
- `aggregate_id text NOT NULL`
- `court_id uuid`
- `actor_subject text`
- `correlation_id varchar(120)`
- `deduplication_key varchar(240) NOT NULL`
- `payload jsonb NOT NULL`
- `headers jsonb NOT NULL DEFAULT '{}'::jsonb`
- `status varchar(24) NOT NULL DEFAULT 'PENDING'`
- `attempt_count integer NOT NULL DEFAULT 0`
- `next_attempt_at timestamptz NOT NULL DEFAULT now()`
- `locked_at timestamptz`
- `locked_by varchar(160)`
- `last_attempt_at timestamptz`
- `last_error text`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `delivered_at timestamptz`

Constraints:

- unique `(event_type, deduplication_key)`
- status in `PENDING`, `PROCESSING`, `DELIVERED`, `DEAD_LETTER`
- non-negative `attempt_count`

Indexes support due-event claims and aggregate history. Ordinary DELETE is revoked from PUBLIC; UPDATE remains required for controlled delivery-state transitions.

The isolated Supabase test profile receives `db/supabase/20260906_dciecms_test_0012.sql` and logical mapping `integration.outbox_events -> dciecms_test.integration_outbox_events`. Repository delivery of these files does not imply execution against a live database.

## PostgresOutboxStore

`PostgresOutboxStore` uses parameterized SQL and exposes:

- `enqueue(event)` — insert an event; on duplicate event type + deduplication key return the canonical existing row without duplicating it.
- `claimBatch({ workerId, limit, now, leaseTimeoutMs })` — atomically claim due `PENDING` events plus stale `PROCESSING` leases using `FOR UPDATE SKIP LOCKED` semantics and return claimed rows.
- `markDelivered({ eventId, workerId, deliveredAt })` — transition only a row currently owned by that worker from `PROCESSING` to `DELIVERED`.
- `markFailed({ eventId, workerId, attemptedAt, error, nextAttemptAt, maxAttempts })` — increment attempts and either return to `PENDING` for retry or move to `DEAD_LETTER`; clear the lease in either case.
- `list(filter)` — exact-match administrative/test reads; no delete API.

The claim query aliases the CTE candidate identifier before `UPDATE ... FROM` so the returned outbox columns cannot collide with an identically named candidate column in PostgreSQL scope.

## OutboxDispatcher

`OutboxDispatcher` performs one bounded `runOnce()` cycle:

1. claim a batch;
2. resolve the handler for each `eventType`;
3. invoke the handler outside the originating business transaction;
4. mark delivery success or failure durably;
5. calculate deterministic capped exponential retry delay for failures.

R5 does not create a permanent scheduler/daemon. A later deployment layer can call `runOnce()` on an approved schedule or worker runtime. Because the handler runs before `markDelivered`, downstream handlers must be safe under duplicate invocation.

## Domain events emitted in R5

R5 records these externally meaningful lifecycle events:

- `filing.submitted`
- `payment.confirmed`
- `case.opened`
- `hearing.scheduled`
- `hearing.adjourned`
- `hearing.completed`
- `judgment.issued`

Each event uses a server-generated stable deduplication key tied to the mutation identity. Payloads contain only necessary workflow identifiers/status/court context and exclude document contents, credentials and secrets. Payment events exclude the provider reference. Hearing-adjournment events exclude the free-text judicial adjournment reason; that reason remains in the authoritative hearing/audit evidence but is not copied into the generic integration payload.

The service layer receives an event store with a no-op default. PostgreSQL runtime injects `PostgresOutboxStore` over the same R4 `PostgresTransactionManager`. Because event enqueue is awaited before the transaction returns, enqueue failure rolls back business mutation and audit evidence as one unit.

## Security boundaries

- No client-provided delivery status is trusted.
- Outbox payloads are server-generated.
- SQL remains parameterized.
- Worker ownership is checked before delivery-state transitions.
- Provider credentials are not stored in outbox payloads or headers.
- Free-text judicial reasons are not copied into generic outbox payloads.
- R5 does not send network requests to external providers.

## Verification

R5 proves:

1. migration/schema constraints and Supabase isolated mapping exist;
2. enqueue is idempotent and parameterized;
3. claim uses due-time filtering, stale-lease recovery and `SKIP LOCKED` semantics;
4. the claim candidate ID is disambiguated from returned outbox columns;
5. only the owning worker can mark delivery or failure;
6. retries increment attempts and dead-letter at the configured limit;
7. dispatcher success/failure/no-handler paths are deterministic;
8. the seven selected domain mutations enqueue the correct event and await it;
9. payment provider references and free-text adjournment reasons are excluded from generic event payloads;
10. PostgreSQL runtime injects the outbox store over the same transaction manager as repository/audit;
11. outbox enqueue failure causes the enclosing business transaction to roll back;
12. backend, Court Workspace and production frontend build regressions pass.

## Non-goals

- live database migration
- production deployment
- real email/SMS provider integration
- payment gateway callbacks
- object storage/malware scanning
- government-agency network integration
- production credentials or secrets
- permanent worker scheduling
