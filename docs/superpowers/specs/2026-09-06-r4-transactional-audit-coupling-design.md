# DCIECMS R4 Transactional Audit Coupling Design

## Objective

Close the R3 reliability gap where a PostgreSQL business mutation can commit before its application audit record is persisted. R4 makes each mutating service operation and its corresponding audit evidence share one physical PostgreSQL transaction when `DATABASE_URL` is configured.

## Scope

R4 covers all current mutating Registry, filing, document-registration, finance, case-opening, judicial, hearing, proceeding and judgment service operations. Read-only audit evidence remains durable but does not require a business-mutation transaction because no business state is changed.

R4 does not introduce production identity, live migrations, storage providers, payment gateways, notifications or agency integrations.

## Architecture

### Transaction-aware database wrapper

Add `PostgresTransactionManager` around the already schema-mapped PostgreSQL database.

It exposes:

- `query(...)` — routes to the active transaction client when one exists; otherwise to the underlying database.
- `connect()` — outside a transaction delegates normally; inside a transaction returns a scoped client facade using the already-active client.
- `withTransaction(work)` — starts the outer transaction, runs `work`, commits only after the whole service operation completes, rolls back on any error, and releases exactly once.

Node `AsyncLocalStorage` keeps concurrent request transaction contexts isolated.

### Existing repository transaction compatibility

Some repository methods already call `connect()`, `BEGIN`, `COMMIT`, `ROLLBACK` and `release()` internally. When such a method executes inside an R4 outer transaction, the scoped client facade:

- routes SQL to the existing outer client;
- treats nested `BEGIN`, `COMMIT` and `ROLLBACK` control statements as no-ops;
- treats nested `release()` as a no-op.

The real commit/rollback is therefore controlled only by the outer service transaction. An inner error still propagates so the outer transaction rolls back.

### Service transaction boundary

Add a transactional service proxy for the PostgreSQL runtime. A fixed, reviewed set of mutating public service methods is executed through `withTransaction(...)`. Existing service code remains responsible for authorization, validation, business mutation and awaited audit append.

Because both the repository and `PostgresAuditStore` use the same `PostgresTransactionManager`, their queries are automatically routed to the same transaction client.

The no-database/in-memory runtime is unchanged.

## Current mutating service methods

Registry/finance/case:

- `createParty`
- `createFilingDraft`
- `registerDocument`
- `submitFiling`
- `validateFiling`
- `returnFiling`
- `rejectFiling`
- `acceptFiling`
- `assessFilingFee`
- `createPayment`
- `confirmPayment`
- `issueReceipt`
- `createReconciliation`
- `certifyReconciliation`
- `openCase`

Judicial:

- `assignCase`
- `scheduleHearing`
- `adjournHearing`
- `startHearing`
- `recordAppearance`
- `recordProceeding`
- `completeHearing`
- `createJudgment`
- `updateJudgmentDraft`
- `reviewJudgment`
- `signJudgment`
- `issueJudgment`

## Failure semantics

1. If the business mutation fails, the transaction rolls back and no audit record commits.
2. If the audit append fails after the business SQL succeeds, the transaction rolls back the business mutation as well.
3. Existing state-conflict translation remains unchanged.
4. Read-only operations remain outside the mutation transaction wrapper.

## Verification

R4 must prove:

1. successful transaction performs one real `BEGIN` and one real `COMMIT`;
2. failure performs one real `ROLLBACK` and no real `COMMIT`;
3. nested repository transaction controls do not prematurely commit an outer transaction;
4. repository mutation SQL and audit SQL use the same physical client;
5. an audit failure rolls back the preceding business mutation;
6. all current mutating service methods are included in the transactional method registry;
7. in-memory runtime behavior remains unchanged;
8. full backend, Court Workspace and production frontend build regressions pass.
