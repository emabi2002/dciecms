# DCIECMS Implementation Status

## Repository release boundary

DCIECMS currently contains the executable R0/R1 court-management slice, R2 judicial operations, engineering R3/R4/R5 reliability controls, production-grade provider-neutral authentication/document/payment boundaries, Blueprint R3 Case Lifecycle & Records Governance, and the Blueprint R3 Finance Completion increment.

The current logical migration ceiling is `0016_r3_finance_completion.sql`. The isolated Supabase test-profile translation is `db/supabase/20260907_dciecms_test_0016.sql`.

No migration described here is represented as applied to a live PNG Magisterial Services database unless separately recorded as production deployment evidence.

## Numbering note

Two release vocabularies exist in project history and must not be conflated:

1. Engineering R3/R4/R5 refer to durable idempotency/audit, transactional audit coupling and the durable outbox.
2. The Steps 1–10 programme blueprint uses functional release numbering. Case Lifecycle & Records Governance and Finance Completion are part of functional Blueprint R3.

## Delivered baseline

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

### Engineering R3/R4/R5 — Reliability controls

- `0011_durable_controls.sql` for durable idempotency and actor-subject audit
- request-scoped `PostgresTransactionManager` and shared physical PostgreSQL client
- business mutation rollback when audit persistence fails
- `0012_event_outbox.sql` for durable domain events
- idempotent enqueue, bounded worker leasing, retry and dead-letter handling
- mutation, audit and outbox commit/rollback coupling
- isolated Supabase test mappings for engineering migrations

### Production authentication boundary

- explicit `development|oidc` authentication mode
- production rejection of development authentication
- signed JWT/JWKS verification with issuer, audience, expiry, not-before and algorithm controls
- canonical actor mapping from verified claims only
- sanitized authentication/authorization failure responses
- provider-neutral Court Workspace bearer-token seam
- no live government IdP registration or credential activation

### Secure document pipeline

- `0013_secure_document_pipeline.sql`
- private server-owned object identity and quarantine
- authoritative size/checksum/MIME validation
- durable malware-scan queue
- CLEAN-only release
- court/record/classification authorization
- immutable replacement/supersede/withdraw history
- document legal holds and governed-disposition eligibility
- no normal hard-delete path
- no production storage/KMS/scanner provider activated

### Payment integration hardening

- `0014_payment_integration_hardening.sql`
- server-controlled provider binding
- authenticated raw-body callbacks
- durable verified provider-event inbox
- duplicate-event idempotency
- exact canonical payment/provider/reference/amount/currency matching
- provider-success mutation, audit, outbox and provider-event state in one transaction
- manual provider impersonation blocked while gateway mode is enabled
- no production gateway, merchant account, webhook secret or settlement integration activated

### Blueprint R3 — Case Lifecycle & Records Governance

- `0015_case_lifecycle_records.sql`
- controlled `ASSIGNED -> DISPOSED -> CLOSED` lifecycle and governed reopen
- immutable lifecycle evidence
- assigned-MAG disposition restrictions and hearing/judgment prerequisites
- dedicated `RECORDS` role
- retention, archive and case-level legal-hold controls
- document and case legal holds as fail-closed disposal vetoes
- maker/checker disposal-request approval/rejection
- court-scoped HTTP service and transaction-coupled audit/outbox evidence
- no physical case/document deletion or disposal executor

## Blueprint R3 — Finance Completion

Finance Completion closes the governed finance-control gap identified for this increment without activating a live refund/payment provider or applying a live database migration.

### RBAC and segregation of duties

- `FIN` has the assessment, payment/refund view and request authorities required for ordinary finance operations.
- `FIN-MGR` has governed fee-schedule management, adjustment/refund decision/completion and reconciliation-rejection authorities.
- security and ICT administration roles receive no implicit finance authority.
- adjustment and refund approval/rejection enforce maker/checker segregation: the requester cannot decide the same item.
- direct identifiers are server-side court scoped before finance state is returned or mutated.

### Fee schedule governance

- `0016_r3_finance_completion.sql` adds `finance.fee_schedules`.
- schedules carry optional national/global or explicit court scope, case type, fee code, description, integer minor-unit amount, currency, effective dates and governed lifecycle state.
- assessment by schedule uses the persisted ACTIVE schedule amount/currency and records `feeScheduleId` provenance; browser-supplied money cannot override it.
- global schedules apply to an otherwise in-scope filing when case type/effective dates match.
- activation prevents overlapping ACTIVE schedules where a national/global schedule would conflict with any court schedule, or where two schedules would conflict within the same court for the same case type/fee/effective period.
- legacy manual assessment remains only as a controlled compatibility path when no schedule ID is supplied.
- schedules support create, list, get, activate and retire; no delete route is exposed.

### Finance workbench read models

- `GET /finance/payments` provides a court-scoped payment/collections queue with optional governed status filtering.
- the payment queue deliberately excludes `provider_reference` from its SQL read model.
- `GET /finance/refunds` provides the court-scoped refund review queue and supports the persisted refund-state vocabulary, including `CANCELLED`.
- payment, refund and reconciliation-exception queue reads persist audit evidence and therefore participate in the shared transaction boundary.

### Payment adjustments

- `finance.payment_adjustments` records waiver, exemption, correction and other governed adjustment requests.
- original amount, delta and resulting amount remain evidence rather than destructive rewrites.
- approval/rejection is state conditional and maker/checker controlled.
- approved adjustments cannot rewrite confirmed-payment monetary evidence.
- free-text request/decision reasons remain evidentiary/audit content and are excluded from generic outbox payloads.

### Refund governance

- `finance.refund_requests` records request, approval/rejection and completion evidence.
- requests require a confirmed canonical payment and positive integer minor-unit amount.
- request SQL locks the canonical payment and enforces the cumulative ceiling across `REQUESTED`, `APPROVED` and `COMPLETED` refunds.
- approval/rejection is maker/checker controlled and state conditional.
- completion locks the APPROVED refund and CONFIRMED payment, rechecks the cumulative ceiling, then records the independently obtained external refund reference and updates the derived refunded total atomically.
- a fully refunded payment may transition to `REFUNDED` without rewriting its original confirmed amount.
- no HTTP route, repository operation, worker or Court Workspace control executes a refund at a provider.

### Reconciliation and immutable evidence

- reconciliations support reasoned rejection plus normalized exception evidence.
- court-scoped reconciliation exceptions can be listed for review.
- certified/rejected reconciliation rows are protected by database `BEFORE UPDATE OR DELETE` immutability controls.
- issued receipts are protected by database `BEFORE UPDATE OR DELETE` immutability controls.
- delete privileges are revoked from PUBLIC for new governed finance tables, receipts and reconciliations.

### Governed HTTP API

- `POST /finance/fee-schedules`
- `GET /finance/fee-schedules`
- `GET /finance/fee-schedules/:feeScheduleId`
- `POST /finance/fee-schedules/:feeScheduleId/activate`
- `POST /finance/fee-schedules/:feeScheduleId/retire`
- `GET /finance/payments`
- `POST /fee-assessments/:assessmentId/adjustments`
- `GET /finance/adjustments/:adjustmentId`
- `POST /finance/adjustments/:adjustmentId/approve`
- `POST /finance/adjustments/:adjustmentId/reject`
- `POST /payments/:paymentId/refunds`
- `GET /finance/refunds`
- `GET /finance/refunds/:refundRequestId`
- `POST /finance/refunds/:refundRequestId/approve`
- `POST /finance/refunds/:refundRequestId/reject`
- `POST /finance/refunds/:refundRequestId/complete`
- `POST /reconciliations/:reconciliationId/reject`
- `GET /finance/reconciliation-exceptions`

There is no provider-refund execution endpoint and no destructive delete endpoint for fee schedules, adjustments or refunds.

### Court Workspace finance controls

The `/payments` workspace now covers:

- configured fee-schedule assessment using schedule identity rather than browser-controlled money;
- controlled manual assessment compatibility;
- collections/payment-status queue;
- canonical payment/session progression;
- receipt issuance and reconciliation preparation/certification;
- governed refund request with PGK-to-minor-unit conversion and required reason;
- refund approval queue and direct request lookup;
- visible maker/checker identities;
- approve/reject decisions with required reason and explicit independent-review confirmation;
- completion-evidence recording only after explicit confirmation that an external refund has actually occurred;
- court-scoped reconciliation-exception display.

UI authority is advisory; server RBAC, court scope, state and maker/checker controls remain authoritative.

### Audit, outbox and transaction guarantees

Regression coverage establishes that sensitive finance mutation, application audit and durable outbox persistence share one outer PostgreSQL transaction where applicable. Audit failure rolls back the business transition; outbox failure rolls back both transition and preceding audit work. Generic outbox payloads contain normalized identifiers/state and exclude free-text reasons and external refund references.

### Supabase isolated-test profile

- `db/supabase/20260907_dciecms_test_0016.sql` mirrors logical migration `0016` only inside `dciecms_test`.
- schema mappings include fee schedules, payment adjustments and refund requests plus existing finance structures.
- the isolated migration mirrors issued-receipt and finalized-reconciliation immutability controls.
- presence of the asset does **not** mean migration `0016` has been applied to a live Supabase/database environment.

## Verification coverage

Repository CI covers backend unit/API/security/regression tests, Court Workspace tests and production frontend build. Finance-specific regressions include:

- RBAC and court-scope denial
- maker/checker enforcement
- authoritative schedule assessment and global-schedule handling
- prevention of conflicting global/court ACTIVE schedule overlap
- payment/refund queue status validation and audited reads
- payment queue provider-reference minimization
- cumulative refund ceiling and canonical row locking
- refund completion concurrency/state safety
- immutable receipt/reconciliation evidence
- audit/outbox rollback coupling
- minimized outbox payloads
- absence of destructive/provider-refund execution routes
- isolated Supabase `0016` mapping
- Court Workspace queues and high-risk confirmation controls

## External / production gates still outstanding

Repository completion is not production activation. These remain separate explicit gates:

- live database/Supabase migration execution, including `0016`
- production OIDC/government IdP registration and credentials
- production object storage/KMS and malware scanner
- production payment gateway, merchant settlement and provider refund API integration
- email/SMS provider integration
- permanent outbox/scan/notification worker scheduling
- approved records-retention schedule and any physical disposal executor
- production hosting, WAF, secret-vault and observability configuration
- backup/restore and disaster-recovery activation
- UAT/pilot/go-live authorization

## Functional blueprint work remaining

After Finance Completion, functional Blueprint R3 still requires the separately scoped notifications and enforcement/follow-up capabilities where not already delivered. Blueprint R4 then covers reporting, E-Library and approved external integrations. Final programme gates remain full end-to-end regression, security/performance verification, UAT, migration rehearsal, pilot readiness and production-readiness approval.
