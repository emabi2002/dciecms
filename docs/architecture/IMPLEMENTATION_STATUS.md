# DCIECMS Implementation Status

## Baseline and current candidate

- Baseline branch: `main`
- Current implementation candidate: `feat/r3-finance-completion`
- Current candidate migration ceiling: logical `0016_r3_finance_completion.sql`
- The isolated Supabase test-profile translation is `db/supabase/20260907_dciecms_test_0016.sql`.
- No migration in this document is represented as applied to a live PNG Magisterial Services database unless separately recorded as production deployment evidence.

## Numbering note

Two release vocabularies exist in the project history and must not be conflated:

1. Engineering reliability labels R3/R4/R5 refer to durable idempotency/audit, transactional audit coupling and the durable outbox.
2. The Steps 1–10 programme blueprint uses functional release numbering. Case Lifecycle & Records Governance and this Finance Completion candidate are part of the blueprint functional R3 programme scope.

## Delivered baseline on `main`

### R0/R1 — Registry, initial finance and case opening

- deny-by-default RBAC and server-side court scoping
- party and filing creation
- case-type validation
- filing submission and Registry validation workflow
- Registry validate / return / reject / accept transitions
- fee assessment and controlled payment confirmation
- receipt issuance and maker/checker reconciliation baseline
- transactional case-number generation and case opening
- application audit evidence
- PostgreSQL repositories and bounded runtime pool
- Court Workspace Registry, Filing Review, Payments and Cases flows
- migrations `0001`–`0006`

### R2 — Judicial operations

- controlled case assignment
- assigned-magistrate work queues
- hearing scheduling, daily lists and adjournments
- hearing-mode start/completion and proceeding capture
- judgment/order draft, review, signing and issuance
- Judicial Workbench UI
- migrations `0007`–`0010`

### Engineering R3 — Durable controls

- migration `0011_durable_controls.sql`
- durable filing-submission idempotency
- canonical replay without duplicate business mutation
- PostgreSQL application audit store
- awaited audit persistence through Registry, finance, case-opening and judicial operations
- isolated Supabase `dciecms_test` migration/mapping for `0011`

### Engineering R4 — Transactional audit coupling

- request-scoped `PostgresTransactionManager`
- `AsyncLocalStorage` transaction context
- repository and audit writes routed through one physical PostgreSQL client
- business mutation rollback when audit persistence fails
- reviewed mutation registry
- no schema migration required by engineering R4

### Engineering R5 — Durable domain-event outbox

- migration `0012_event_outbox.sql`
- durable `integration.outbox_events`
- idempotent enqueue and bounded worker leasing
- retry/dead-letter handling
- minimized domain-event payloads
- mutation, audit and outbox coupling in one transaction
- isolated Supabase `dciecms_test` migration/mapping for `0012`

### Production authentication boundary

- explicit `development|oidc` authentication mode
- production rejection of development authentication
- signed JWT/JWKS verification with issuer, audience, expiry, not-before and algorithm controls
- canonical actor mapping from verified claims only
- sanitized 401/403/503/500 separation
- provider-neutral Court Workspace Bearer-token seam
- no real government IdP registration, client credential or production activation delivered

### Secure document pipeline

- migration `0013_secure_document_pipeline.sql`
- private server-owned object identity and upload finalization
- authoritative size/checksum/MIME validation
- durable malware-scan queue
- CLEAN-only release
- court/record/classification authorization
- immutable replacement/supersede/withdraw history
- document legal holds and governed-disposition eligibility
- no normal hard-delete path
- isolated Supabase `dciecms_test` migration/mapping for `0013`
- no real production storage/KMS/scanner provider activated

### Payment integration hardening

- migration `0014_payment_integration_hardening.sql`
- server-controlled provider binding
- authenticated raw-body provider callbacks
- durable verified provider-event inbox
- duplicate-event idempotency
- exact canonical payment/provider/amount/currency matching
- provider-success mutation, audit, outbox and provider-event status in one transaction
- manual provider impersonation blocked while gateway mode is enabled
- isolated Supabase `dciecms_test` migration/mapping for `0014`
- no production gateway, merchant account, webhook secret or settlement integration activated

### Blueprint R3 — Case Lifecycle & Records Governance

- migration `0015_case_lifecycle_records.sql`
- controlled `ASSIGNED -> DISPOSED -> CLOSED` lifecycle and governed reopen
- immutable lifecycle evidence
- assigned-MAG disposition restrictions and hearing/judgment prerequisites
- dedicated `RECORDS` role
- retention, archive and case-level legal-hold controls
- document and case legal holds as fail-closed disposal vetoes
- maker/checker disposal-request approval/rejection
- no physical case/document deletion or disposal executor
- court-scoped HTTP service and transaction-coupled audit/outbox evidence
- isolated Supabase `dciecms_test` migration/mapping for `0015`

## Current candidate — Blueprint R3 Finance Completion

The `feat/r3-finance-completion` branch closes the remaining governed finance-control gap identified for the functional R3 release without activating a real payment/refund provider or applying a live database migration.

### RBAC and segregation of duties

- `FIN` receives the finance view/request authorities required to operate fee schedules, adjustment requests, refund requests and reconciliation exception review.
- `FIN-MGR` receives the corresponding governed decision/completion authorities.
- security and ICT administration roles receive no implicit finance authority.
- approval/rejection of payment adjustments and refunds uses maker/checker segregation; a requester cannot approve or reject their own request.
- direct identifiers remain server-side court scoped before finance state is returned or mutated.

### Fee schedule governance

- migration `0016_r3_finance_completion.sql` adds `finance.fee_schedules`.
- schedules carry court scope, case type, fee code, description, PGK-compatible minor-unit amount, effective dates and governed lifecycle state.
- schedules support create, list, get, activate and retire operations.
- no fee-schedule delete route is exposed.

### Payment adjustments

- `finance.payment_adjustments` records waiver, exemption, correction and other governed adjustment requests.
- original amount, delta and resulting amount are preserved as evidence.
- adjustment approval is state conditional and maker/checker controlled.
- an approved adjustment cannot rewrite immutable confirmed-payment evidence.
- request and decision reasons remain evidentiary/audit content and are not published into generic integration events.

### Refund governance

- `finance.refund_requests` records refund request, approval/rejection and completion evidence.
- refund requests require a confirmed canonical source payment and positive integer minor-unit amount.
- refund-request SQL locks the canonical payment row and enforces the cumulative refund ceiling across `REQUESTED`, `APPROVED` and `COMPLETED` refund state, preventing concurrent over-refund.
- refund approval/rejection is maker/checker controlled.
- completion records an independently obtained external/provider refund reference as evidence only.
- no HTTP route, repository operation, worker or Court Workspace control executes a refund at a payment provider.
- the repository therefore remains provider neutral and does not contain a provider refund API integration.

### Reconciliation exceptions and immutable finance evidence

- reconciliations support reasoned rejection plus normalized exception code/note evidence.
- court-scoped reconciliation exceptions can be listed for finance review.
- certified and rejected reconciliation rows are protected by a database `BEFORE UPDATE OR DELETE` trigger.
- issued receipts are protected by a database `BEFORE UPDATE OR DELETE` trigger; an already-issued receipt cannot be rewritten or deleted in place.
- delete privileges are revoked from PUBLIC for the new finance-control tables, receipts and reconciliations.

### HTTP API delivered by the candidate

Governed endpoints include:

- `POST /finance/fee-schedules`
- `GET /finance/fee-schedules`
- `GET /finance/fee-schedules/:feeScheduleId`
- `POST /finance/fee-schedules/:feeScheduleId/activate`
- `POST /finance/fee-schedules/:feeScheduleId/retire`
- `POST /fee-assessments/:assessmentId/adjustments`
- `GET /finance/adjustments/:adjustmentId`
- `POST /finance/adjustments/:adjustmentId/approve`
- `POST /finance/adjustments/:adjustmentId/reject`
- `POST /payments/:paymentId/refunds`
- `GET /finance/refunds/:refundRequestId`
- `POST /finance/refunds/:refundRequestId/approve`
- `POST /finance/refunds/:refundRequestId/reject`
- `POST /finance/refunds/:refundRequestId/complete`
- `POST /reconciliations/:reconciliationId/reject`
- `GET /finance/reconciliation-exceptions`

There is no provider-refund execution endpoint and there are no destructive delete endpoints for fee schedules, adjustments or refunds.

### Audit, outbox and transaction guarantees

Finance-completion mutations are registered in the shared outer PostgreSQL transaction boundary.

Regression coverage proves for refund approval that:

- business mutation, application audit evidence and durable outbox enqueue use one physical PostgreSQL client;
- audit persistence failure rolls back the refund approval and prevents the outbox write;
- outbox persistence failure rolls back both refund approval and preceding audit work;
- success commits the finance mutation, audit and outbox together.

Generic finance-completion outbox events contain normalized identifiers/state and exclude free-text request/decision reasons. External provider references are treated as controlled finance evidence and are not used as permission or provider-execution instructions.

### Supabase isolated-test profile

- `db/supabase/20260907_dciecms_test_0016.sql` mirrors logical migration `0016` only inside `dciecms_test`.
- schema mapping includes:
  - `finance.fee_schedules` -> `dciecms_test.finance_fee_schedules`
  - `finance.payment_adjustments` -> `dciecms_test.finance_payment_adjustments`
  - `finance.refund_requests` -> `dciecms_test.finance_refund_requests`
- existing finance assessments, payments, receipts and reconciliations continue to map into their isolated `dciecms_test` tables.
- the isolated migration includes the issued-receipt and finalized-reconciliation immutability triggers.
- the asset's presence does **not** mean migration `0016` has been applied to a live Supabase/database environment.

### Court Workspace finance controls

The `/payments` workspace now covers:

- fee assessment and canonical payment/session progression;
- receipt issuance and reconciliation preparation/certification;
- governed refund request with PGK-to-minor-unit conversion and required reason;
- refund request lookup;
- maker/checker refund approve/reject actions with decision reason;
- recording external refund-completion evidence after approval;
- court-scoped reconciliation exception display.

The UI explicitly states that refund request/completion controls do not execute a provider refund, and no provider-refund execution button or client function is exposed.

## Verification controls

Repository CI covers:

- backend unit/API/security/regression tests
- Court Workspace frontend tests
- production frontend build
- PostgreSQL transaction-manager regressions
- audit and outbox rollback regressions
- OIDC/JWT authentication regressions
- secure-document lifecycle/security regressions
- payment-integration security regressions
- case lifecycle / records RBAC, scope and non-destructive disposal regressions
- R3 finance RBAC and maker/checker regressions
- fee-schedule, adjustment, refund and reconciliation persistence regressions
- cumulative refund ceiling / row-locking regression
- issued-receipt and finalized-reconciliation immutability regression
- refund mutation/audit/outbox transaction rollback regression
- absence of provider-refund execution and destructive finance HTTP routes
- isolated Supabase `0016` migration and schema-mapping regressions
- Court Workspace governed refund and reconciliation-exception regressions

## External / production gates still outstanding

Repository completion is not production activation. The following remain separate gates:

- live database/Supabase migration execution, including `0016`
- production OIDC/government IdP registration and credentials
- production object storage/KMS and malware scanner
- production payment gateway, merchant settlement and provider refund API integration
- email/SMS provider integration
- permanent outbox/scan/notification worker scheduling
- approved records retention schedule and any physical disposal executor
- production hosting, WAF, secret-vault and observability configuration
- backup/restore and disaster-recovery activation
- UAT/pilot/go-live authorization

## Functional blueprint work remaining after this candidate

After this Finance Completion candidate is merged, functional R3 still requires the separately scoped notifications and enforcement/follow-up capabilities where not already delivered. Blueprint R4 then covers reporting, E-Library and approved external integrations. Final programme gates remain full end-to-end regression, security/performance verification, UAT, migration rehearsal, pilot readiness and production-readiness approval.
