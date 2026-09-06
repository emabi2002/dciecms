# DCIECMS Implementation Status

## Baseline branch
`main`

## Integration status

The implementation is organized as R0/R1 court-management capabilities, R2 judicial operations, R3 durable reliability controls, R4 transactional audit coupling, and R5 durable event/outbox infrastructure. R5 extends the PostgreSQL transaction boundary to durable domain-event enqueue but does not perform any production deployment, live database migration or external provider delivery.

## Delivered capabilities

### R0/R1 — Registry, finance and case opening
- development identity claim normalization
- deny-by-default RBAC and court scoping
- party creation and filing draft creation
- controlled case-type validation
- secure document registration in quarantine with SHA-256 checksum validation
- idempotent filing submission
- court-scoped Registry queue
- Registry workflow task creation/completion
- Registry validate / return / reject / accept transitions with persisted evidence
- append-only application audit evidence
- PostgreSQL-backed repositories and bounded runtime pool configuration
- migrations `0001` through `0006`
- fee assessment and controlled payment confirmation
- receipt issuance and maker/checker reconciliation controls
- transactional case-number allocation and controlled case opening
- React + TypeScript + Vite Court Workspace frontend
- My Work, Registry Filing Queue, Filing Review, Payments and Cases flows

### R2 — Judicial operations
- case assignment to judicial officers under court scope and permission controls
- assigned-case judicial work queue
- hearing scheduling, daily-list retrieval and adjournment workflows
- hearing-mode start/completion and proceeding-state handling
- judgment/order lifecycle controls including draft, review, signing and issuance
- Judicial Workbench UI: My Cases, Daily Hearings, Case Workspace, Hearing Mode, Pending Decisions and Judgment/Order workspace
- PostgreSQL judicial repositories and HTTP routes
- migrations `0007` through `0010`
- backend, HTTP, PostgreSQL, frontend and regression tests for judicial operations

### R3 — Durable audit and filing-submission idempotency
- migration `0011_durable_controls.sql`
- `workflow.idempotency_records` with uniqueness scoped by actor subject, operation, resource and idempotency key
- atomic PostgreSQL filing submission that claims idempotency, performs `DRAFT -> SUBMITTED`, creates the Registry validation task and persists the canonical response in one transaction
- duplicate/restarted filing-submission replay that returns the persisted response without repeating business mutations
- rollback regression proving a failed filing transition rolls back the transaction before task/response persistence
- `audit.audit_events.actor_subject` support for application identity subjects that are not guaranteed to be UUIDs
- `PostgresAuditStore` parameterized append/read implementation
- awaited audit writes across persistent Registry/finance/case-opening services and all judicial/Workbench service paths
- PostgreSQL runtime injection of the durable audit store when `DATABASE_URL` is configured
- Supabase `supabase_test` SQL mapping for `workflow.idempotency_records`
- incremental isolated test-profile migration `db/supabase/20260906_dciecms_test_0011.sql`

### R4 — Transactional audit coupling
- `PostgresTransactionManager` provides one request-scoped outer PostgreSQL transaction for mutating runtime service operations
- `AsyncLocalStorage` isolates concurrent transaction contexts
- repository SQL and `PostgresAuditStore` SQL share the same active physical client during a mutating service operation
- existing repository-local transaction blocks are contained inside the outer service transaction and cannot prematurely commit or release it
- immutable reviewed transaction registry covers the current Registry, filing, document-registration, finance, case-opening, judicial, hearing, proceeding and judgment mutation methods
- successful business mutation and awaited application audit evidence commit together
- audit insert failure rolls back the preceding business mutation
- read-only operations remain outside the mutation transaction wrapper
- in-memory/no-`DATABASE_URL` runtime remains unchanged
- R4 introduces no schema migration and has not executed any live database or production deployment action

### R5 — Durable domain-event outbox
- migration `0012_event_outbox.sql` creates `integration.outbox_events` with event identity, aggregate/court context, payload/headers, delivery state, attempts, lease ownership, error evidence and timestamps
- unique event-type/deduplication-key contract makes repeated enqueue return the canonical event rather than creating a duplicate row
- due/stale event claiming uses `FOR UPDATE SKIP LOCKED`, bounded batches, worker leases and stale-lease reclamation
- delivery/failure transitions require the owning worker lease
- failed deliveries receive deterministic capped exponential retry timing and transition to `DEAD_LETTER` at the configured attempt limit
- `OutboxDispatcher.runOnce()` provides one bounded delivery cycle; no permanent scheduler or provider integration is added in R5
- durable domain events are emitted for `filing.submitted`, `payment.confirmed`, `case.opened`, `hearing.scheduled`, `hearing.adjourned`, `hearing.completed` and `judgment.issued`
- payment provider references are excluded from generic outbox payloads
- free-text hearing-adjournment reasons remain in authoritative court/audit evidence but are excluded from the generic integration event payload
- PostgreSQL runtime injects `PostgresOutboxStore` over the same `PostgresTransactionManager` used by repositories and `PostgresAuditStore`
- representative runtime regression proves payment mutation, application audit evidence and outbox enqueue use the same physical PostgreSQL client and commit together
- outbox insert failure rolls back business mutation and audit work
- delivery contract is **at least once**; future downstream/provider handlers must be idempotent using `outbox_event_id`, the domain-event deduplication key or an equivalent provider-side mechanism
- isolated Supabase test-profile migration `db/supabase/20260906_dciecms_test_0012.sql` and logical outbox table mapping are repository-delivered only and have not been represented as applied to a live environment

## Verification controls present in the repository
- GitHub Actions CI using Node.js 20 for the application test/build runtime
- backend regression test execution
- Court Workspace test execution
- production frontend build verification
- live Supabase smoke-test workflow
- Supabase test migration bundle covering R0-R2 (`0001` through `0010`)
- incremental Supabase isolated-test migrations for R3 (`0011`) and R5 (`0012`)
- R4 transaction-manager regressions for commit, rollback and nested repository transaction handling
- R4 runtime regressions proving business SQL and audit SQL use one client and that audit failure rolls back business mutation
- R5 outbox regressions for idempotent enqueue, bounded/stale claims, worker ownership, retry/dead-letter transitions and dispatcher behavior
- R5 domain-event regressions covering seven lifecycle transitions and sensitive-payload minimization
- R5 runtime regression proving business mutation, audit evidence and outbox enqueue share one transaction/client and roll back together when the outbox write fails

These controls do not by themselves constitute production deployment approval or evidence that production infrastructure has been changed. The R3 and R5 Supabase test-profile migrations are repository-delivered but have not been represented as executed against a live database by this implementation work.

## Intentionally outstanding / environment-dependent work
- approved permanent outbox worker scheduling/runtime and real idempotent provider handlers
- production IdP/OIDC/OAuth2 gateway integration and signed-claim validation
- approved production PostgreSQL/Supabase environment and controlled live migration execution
- private object storage and malware scanning pipeline
- production payment-gateway callback/integration
- email/SMS notification providers
- government-agency adapters and external integration credentials
- production hosting, WAF, secrets-vault configuration and observability stack
- production backup/restore, disaster-recovery and operational support procedures
- formal UAT, performance/load testing, penetration testing and production go-live approval

## Security boundary

`x-dev-*` request headers are development-only scaffolding. They must never be accepted as production identity evidence. Production authentication must resolve signed, validated claims from the approved identity platform/API gateway and retain server-side permission, court, record-relationship and confidentiality enforcement.

The browser is not an authorization boundary. Registry workflow, request replay, judicial assignment, hearing/judgment authority, finance controls, case-number allocation and case-opening eligibility must continue to be enforced by the API and database layers.
