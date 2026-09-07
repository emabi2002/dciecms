# DCIECMS Implementation Status

## Baseline and current candidate

- Baseline branch: `main`
- Current implementation candidate: `feat/case-lifecycle-records`
- Current candidate migration ceiling: logical `0015_case_lifecycle_records.sql`
- No migration in this document is represented as applied to a live PNG Magisterial Services database unless separately recorded as production deployment evidence.

## Numbering note

Two release vocabularies exist in the project history and must not be conflated:

1. Engineering reliability labels R3/R4/R5 refer to durable idempotency/audit, transactional audit coupling and the durable outbox.
2. The Steps 1–10 programme blueprint uses functional release numbering. The Case Lifecycle & Records Governance work in this branch is part of the blueprint's functional R3 / Increment 4 scope.

## Delivered baseline on `main`

### R0/R1 — Registry, finance and case opening

- deny-by-default RBAC and server-side court scoping
- party and filing creation
- case-type validation
- filing submission and Registry validation workflow
- Registry validate / return / reject / accept transitions
- fee assessment and controlled payment confirmation
- receipt issuance and maker/checker reconciliation
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
- no schema migration required by R4

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

## Current candidate — Blueprint R3 Case Lifecycle & Records Governance

The `feat/case-lifecycle-records` branch closes the case-lifecycle/records-governance gap identified in Step 8/Step 9 of the Steps 1–10 blueprint.

### Case lifecycle

- migration `0015_case_lifecycle_records.sql`
- controlled `ASSIGNED -> DISPOSED -> CLOSED` lifecycle
- controlled reopen from `CLOSED` to `AWAITING_ASSIGNMENT`
- reopen clears the active assignment but preserves lifecycle history
- immutable `case_mgmt.case_lifecycle_events` evidence
- normalized disposition and closure codes plus authoritative free-text reasons
- optional judgment linkage only to an `ISSUED` judgment for the same case
- disposition denied while a hearing is `SCHEDULED` or `IN_PROGRESS`
- assigned-MAG restriction for ordinary magistrate disposition
- CMAG supervisory disposition authority
- CMAG / REG-MGR close and reopen authority

### Records governance

- dedicated `RECORDS` role with narrowly scoped records authority
- `records.case_record_controls` for retention, archive, legal hold and disposal state
- `records.disposal_requests` for non-destructive disposal review evidence
- retention class, trigger date and disposition-eligibility date controls
- archive requires a closed case and configured retention state
- case-level legal hold is a fail-closed veto
- document-level legal hold remains an independent veto
- disposal-request and approval SQL lock/re-check relevant document state so a concurrent legal hold cannot race the decision
- maker/checker segregation: requester cannot approve or reject the same disposal request
- direct cross-court records access is denied server-side before records data is read or mutated

### Non-destructive disposal boundary

This increment does **not** physically dispose of court records.

There is no:

- physical case delete operation
- physical secure-document delete operation
- records-disposal execution endpoint
- disposal execution worker
- production retention scheduler

A disposal `APPROVED` state records the governance decision only. Any future physical destruction mechanism requires separately approved PNG Magisterial Services retention policy, legal authority, security design, audit controls, operational runbooks and an explicit production gate.

### HTTP API delivered by the candidate

- `POST /cases/:caseId/disposition`
- `POST /cases/:caseId/close`
- `POST /cases/:caseId/reopen`
- `GET /cases/:caseId/records-control`
- `POST /cases/:caseId/records-control/retention`
- `POST /cases/:caseId/records-control/archive`
- `POST /cases/:caseId/records-control/legal-hold`
- `POST /cases/:caseId/records-control/legal-hold/release`
- `POST /cases/:caseId/records-control/disposal-requests`
- `POST /records/disposal-requests/:requestId/approve`
- `POST /records/disposal-requests/:requestId/reject`

No destructive disposal-execution route is present.

### Audit and domain events

Candidate audit actions include:

- `case.dispose`
- `case.close`
- `case.reopen`
- `records.retention.assign`
- `records.archive`
- `records.legal_hold.set`
- `records.legal_hold.release`
- `records.disposal.request`
- `records.disposal.approve`
- `records.disposal.reject`

Candidate generic outbox events include:

- `case.disposed`
- `case.closed`
- `case.reopened`
- `records.archived`
- `records.disposal.approved`

Generic outbox payloads contain identifiers, normalized codes and state only. Free-text judicial/records reasons are excluded from generic integration events.

### Transaction guarantees

All lifecycle/records operations that mutate state or persist audit evidence are registered in the shared outer PostgreSQL transaction boundary.

Regression coverage proves:

- case closure mutation, audit and outbox use one physical PostgreSQL client
- audit persistence failure rolls back the completed case-closure SQL
- outbox persistence failure rolls back both lifecycle mutation and audit work
- successful lifecycle mutation/audit/outbox commit together

### Supabase isolated-test profile

- `db/supabase/20260907_dciecms_test_0015.sql` mirrors the logical `0015` schema only inside `dciecms_test`
- schema mapping rewrites:
  - `case_mgmt.case_lifecycle_events` -> `dciecms_test.case_lifecycle_events`
  - `records.case_record_controls` -> `dciecms_test.case_record_controls`
  - `records.disposal_requests` -> `dciecms_test.records_disposal_requests`
- the isolated test migration contains no physical record deletion
- the isolated asset's presence does **not** mean `0015` has been applied to a live Supabase/database environment

## Verification controls

Repository CI covers:

- backend unit/API/security/regression tests
- Court Workspace frontend tests
- production frontend build
- PostgreSQL transaction-manager regressions
- audit rollback regressions
- outbox rollback regressions
- OIDC/JWT authentication regressions
- secure-document lifecycle/security regressions
- payment integration security regressions
- case lifecycle / records RBAC and court-scope regressions
- assigned-MAG and hearing/judgment prerequisite regressions
- retention/archive/legal-hold/disposal state regressions
- atomic document legal-hold veto regressions
- maker/checker disposal regressions
- no-delete/no-disposal-execution regressions
- lifecycle-specific audit/outbox rollback regressions
- isolated Supabase `0015` migration and schema-mapping regressions

## External / production gates still outstanding

Repository completion is not production activation. The following remain separate gates:

- live database/Supabase migration execution, including `0015`
- production OIDC/government IdP registration and credentials
- production object storage/KMS and malware scanner
- production payment gateway and settlement/refund integrations
- email/SMS provider integration
- permanent outbox/scan/notification worker scheduling
- approved records retention schedule and any physical disposal executor
- production hosting, WAF, secret-vault and observability configuration
- backup/restore and disaster-recovery activation
- UAT/pilot/go-live authorization

## Functional blueprint work remaining after this increment

After this candidate is merged, the remaining blueprint R3 work continues with the outstanding finance, notification and enforcement/follow-up capabilities. Blueprint R4 then covers reporting, E-Library and approved external integrations. Final programme gates remain full end-to-end regression, security/performance verification, UAT, migration rehearsal, pilot readiness and production-readiness approval.
