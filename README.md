# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current repository state

DCIECMS contains the executable R0/R1 court-management slice, R2 judicial operations, engineering R3/R4/R5 reliability controls, production-grade provider-neutral authentication/document/payment boundaries, Blueprint R3 Case Lifecycle & Records Governance, and the Blueprint R3 **Finance Completion** increment.

The engineering labels R3/R4/R5 used for durable controls, transactional audit coupling and the outbox are distinct from the functional release numbering in the Steps 1–10 programme blueprint.

The current logical migration ceiling is `0016_r3_finance_completion.sql`. The repository does **not** imply that migration `0016` has been applied to a live PNG Magisterial Services database.

No real government IdP, production storage/scanner provider, production payment/refund gateway, production credential, physical records disposal or production deployment is activated by this repository state.

## Delivered capabilities

### R0/R1 — Registry, initial finance and case opening

- deny-by-default RBAC and server-side court scope
- party and filing creation
- controlled case-type validation
- filing submission and Registry validation workflow
- Registry validate / return / reject / accept decisions
- fee assessment and canonical payment state
- receipt issuance and reconciliation baseline
- transactional case-number allocation and controlled case opening
- PostgreSQL repositories, durable application audit and bounded runtime pool
- Court Workspace Registry, Filing Review, Payments and Cases flows
- migrations `0001`–`0006`

### R2 — Judicial operations

- case assignment and assigned-magistrate queues
- hearing scheduling, daily lists, start, adjournment and completion
- appearances and proceeding records
- judgment/order lifecycle through draft, review, signing and issuance
- Judicial Workbench UI
- migrations `0007`–`0010`

### Engineering R3/R4/R5 reliability controls

- `0011_durable_controls.sql` for durable idempotency and actor-subject audit controls
- restart-safe filing-submission replay without duplicate mutation
- `PostgresTransactionManager` with request-scoped transaction context
- business mutation and application audit on one physical PostgreSQL client
- audit failure rolls back the business mutation
- `0012_event_outbox.sql` for durable integration events
- idempotent outbox enqueue, bounded claiming, retry and dead-letter handling
- business mutation, audit and outbox commit or roll back together

### Production authentication boundary

- explicit `DCIECMS_AUTH_MODE=development|oidc`
- development authentication is rejected in production
- provider-neutral OIDC/JWT verification of signature, issuer, audience, time validity, algorithm and subject
- verified claims only are mapped into the canonical actor used by RBAC/court-scope controls
- sanitized 401/403/503/500 behavior
- Court Workspace bearer-token provider seam
- no real government IdP registration or credential activation in source control

### Secure document pipeline

- `0013_secure_document_pipeline.sql`
- private server-controlled object identity and quarantine
- authoritative size, SHA-256 and MIME validation
- durable malware-scan queue with retry/dead-letter behavior
- CLEAN-only release
- court, filing relationship and classification authorization
- RESTRICTED/SEALED explicit-grant enforcement
- immutable replacement/supersede/withdraw history
- document legal holds and governed-disposition eligibility
- no normal hard-delete operation
- production storage/scanner integration remains disabled unless approved adapters are explicitly injected

### Payment integration hardening

- `0014_payment_integration_hardening.sql`
- server-controlled provider binding
- provider-neutral payment-session creation from canonical server amount/currency
- authenticated raw-body provider callbacks with bounded bodies
- durable normalized provider-event inbox
- duplicate-event idempotency
- exact payment/provider/reference/amount/currency matching before canonical confirmation
- manual external-provider confirmation blocked when gateway mode is enabled
- provider callback processing cannot directly issue receipts or open cases
- provider-success mutation, audit, outbox and provider-event state share one transaction
- no real gateway, merchant account, webhook secret, settlement feed or refund API activated

### Blueprint R3 — Case Lifecycle & Records Governance

- `0015_case_lifecycle_records.sql`
- controlled `ASSIGNED -> DISPOSED -> CLOSED` lifecycle
- controlled reopen to `AWAITING_ASSIGNMENT`
- assigned-MAG disposition restriction plus hearing/judgment prerequisites
- dedicated `RECORDS` role
- retention, archive and legal-hold controls
- case and document legal holds as fail-closed disposal vetoes
- maker/checker disposal request decisions
- court-scoped lifecycle/records API
- transaction-coupled audit/outbox evidence
- no physical record deletion or disposal executor

## Blueprint R3 — Finance Completion

Finance Completion expands the earlier finance baseline into governed, court-scoped financial control.

### Finance RBAC and segregation of duties

- `FIN` has ordinary assessment, payment/refund view and request capabilities.
- `FIN-MGR` has governed fee-schedule management and finance decision/completion capabilities.
- security and ICT administrator roles gain no implicit finance authority.
- payment-adjustment and refund decisions use maker/checker segregation.
- a requester cannot approve or reject their own adjustment/refund request.
- direct identifiers are court scoped before finance data is returned or mutated.

### Fee schedules and authoritative assessment

Migration `0016_r3_finance_completion.sql` adds governed fee schedules with optional national/global or explicit court scope, case type/fee code, integer minor-unit amount, currency, effective dates and `DRAFT`/`ACTIVE`/`RETIRED` lifecycle states.

Schedule-based assessment uses the persisted ACTIVE schedule amount/currency and stores `feeScheduleId` provenance; browser-controlled amount/currency cannot override an authoritative schedule. Global schedules can apply to an in-scope filing, while activation prevents conflicting ACTIVE global/court schedules for the same fee/case type/effective period. Controlled manual assessment compatibility remains available only when no schedule ID is supplied.

No fee-schedule delete endpoint is exposed.

### Finance workbench queues

- `GET /finance/payments` returns a court-scoped collections/payment-status queue with optional governed status filtering.
- the payment queue excludes `provider_reference` from the repository read model.
- `GET /finance/refunds` returns a court-scoped refund review queue and supports the persisted refund-state vocabulary, including `CANCELLED`.
- payment/refund/reconciliation-exception queue reads are audited and share the transaction boundary used for persisted audit evidence.

### Payment adjustments

`finance.payment_adjustments` records controlled waiver, exemption, correction and other adjustment requests while preserving original amount, delta, resulting amount, currency, identities, timestamps and reasons. Approved adjustments cannot rewrite confirmed-payment evidence.

### Refund governance

`finance.refund_requests` supports request, lookup, approve, reject and completion-evidence recording.

Safeguards include:

- confirmed canonical source-payment requirement
- positive integer minor-unit validation
- canonical payment row locking
- cumulative refund ceiling across `REQUESTED`, `APPROVED` and `COMPLETED`
- maker/checker approval/rejection
- court-scope enforcement
- APPROVED refund and CONFIRMED payment locking during completion
- atomic refunded-total update with rechecked ceiling
- audit evidence and minimized durable outbox events

**Important:** refund completion records an independently obtained external/provider refund reference as evidence only. DCIECMS does not execute a refund at the payment provider in this increment. There is no provider-refund execution endpoint, repository operation, worker or Court Workspace action.

### Reconciliation exceptions and immutable evidence

- reconciliation rejection records normalized exception evidence and reasoned decision evidence
- finance users can review court-scoped reconciliation exceptions
- certified and rejected reconciliations are protected by database `BEFORE UPDATE OR DELETE` immutability controls
- issued receipts are protected by database `BEFORE UPDATE OR DELETE` immutability controls
- PUBLIC delete privileges are revoked for governed finance evidence tables

### Transaction guarantees

Finance mutations, application audit and durable outbox persistence share the existing outer PostgreSQL transaction where applicable. Regression coverage proves rollback on audit/outbox failure and commit of the complete evidence chain on success.

### Governed HTTP routes

Finance Completion includes:

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

There are no destructive delete routes for fee schedules, adjustments or refunds, and no provider-refund execution route.

### Court Workspace finance UI

The `/payments` workspace supports:

- configured fee-schedule assessment using schedule identity rather than browser-controlled money
- controlled manual assessment compatibility
- collections/payment-status queue
- payment/session progression
- receipt issuance
- reconciliation preparation/certification
- governed refund request using PGK-to-minor-unit conversion
- refund approval queue and direct lookup
- visible maker/checker identities
- approve/reject controls with required decision reason and explicit independent-review confirmation
- external refund-completion evidence recording only after explicit confirmation that the external refund actually occurred
- reconciliation exception review

UI authority is advisory; server RBAC, court scope, workflow state and maker/checker controls remain authoritative.

## Database migrations and isolated Supabase profile

Logical migrations:

- `0001`–`0010`: court-management and judicial baseline
- `0011_durable_controls.sql`
- `0012_event_outbox.sql`
- `0013_secure_document_pipeline.sql`
- `0014_payment_integration_hardening.sql`
- `0015_case_lifecycle_records.sql`
- `0016_r3_finance_completion.sql`

Supabase test-profile assets are isolated under `db/supabase/` and map logical repository tables into `dciecms_test`. Finance Completion adds `db/supabase/20260907_dciecms_test_0016.sql` and mappings for fee schedules, payment adjustments and refund requests. The isolated migration mirrors receipt/reconciliation immutability controls inside the test profile.

The presence of any migration or Supabase test asset does **not** mean it has been applied to a live environment.

## Verification

GitHub Actions CI covers backend unit/API/security/regression tests, Court Workspace tests and production frontend build. Finance-specific coverage includes:

- RBAC and court scope
- maker/checker controls
- authoritative fee-schedule assessment
- global schedule support and conflicting global/court schedule prevention
- payment/refund queue validation and audited reads
- payment queue provider-reference minimization
- cumulative refund locking/ceiling and completion concurrency safety
- receipt/reconciliation immutability
- audit/outbox rollback coupling
- absence of destructive/provider-refund routes
- isolated Supabase `0016` migration/mapping
- Finance Workspace queues and explicit high-risk confirmation controls

See `docs/architecture/IMPLEMENTATION_STATUS.md` for the detailed implementation boundary and outstanding production gates.

## Court Workspace local development

```bash
npm --prefix apps/court-workspace install
npm --prefix apps/court-workspace run dev
npm run test:frontend
npm run build:frontend
npm install
npm test
```

Start the local API with explicit development-only boundaries:

```bash
DCIECMS_AUTH_MODE=development \
DCIECMS_DOCUMENT_PIPELINE_MODE=development \
DCIECMS_PAYMENT_INTEGRATION_MODE=development \
PORT=3000 npm start
```

The Court Workspace uses `VITE_DCIECMS_API_BASE_URL` when an API base URL is required. Development identity headers are emitted only when `VITE_DCIECMS_DEV_IDENTITY=true`. Production bearer tokens are supplied through the API client's runtime access-token-provider seam, not through a `VITE_*` token value.

`DCIECMS_PAYMENT_INTEGRATION_MODE=development` selects only the deterministic non-production payment adapter. It must never be represented as a real gateway, settlement or refund integration.

## Security and production boundary

The browser is not an authorization boundary. Court scope, record relationship, confidentiality, workflow state, finance authority and maker/checker controls are enforced server side.

The records-governance implementation is non-destructive. A future physical disposal mechanism requires approved PNG Magisterial Services retention policy/legal authority, security design, operational runbooks and a separate production gate.

Finance Completion is provider-neutral. Recording refund completion evidence is not provider execution. A future live refund integration requires an approved provider contract/API, credential/secret management, reconciliation rules, operational controls and explicit production authorization.

Repository completion is not production activation. Live migration, production deployment, government IdP onboarding, storage/scanner activation, payment/refund provider activation, permanent worker scheduling, UAT/pilot and go-live remain separate controlled gates.

Functional Blueprint R3 still has separately scoped notifications and enforcement/follow-up capabilities to complete where not already delivered; Blueprint R4 then covers reporting, E-Library and approved external integrations.
