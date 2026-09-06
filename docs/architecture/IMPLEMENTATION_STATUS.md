# DCIECMS Implementation Status

## Baseline branch
`main`

## Integration status

The implementation is organized as R0/R1 court-management capabilities, R2 judicial operations, and R3 reliability hardening. R3 adds durable restart-sensitive controls but does not perform any production deployment or live database migration.

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

R3 currently makes audit persistence durable and observable before service success is returned. It does **not** yet claim that every business mutation and corresponding audit event share the same physical database transaction. That stronger transactional coupling remains a later reliability milestone.

## Verification controls present in the repository
- GitHub Actions CI using Node.js 20
- backend regression test execution
- Court Workspace test execution
- production frontend build verification
- live Supabase smoke-test workflow
- Supabase test migration bundle covering R0-R2 (`0001` through `0010`)
- incremental Supabase isolated-test migration for R3 (`0011`)

These controls do not by themselves constitute production deployment approval or evidence that production infrastructure has been changed. The R3 Supabase test-profile migration is repository-delivered but has not been represented as executed against a live database by this implementation work.

## Intentionally outstanding / environment-dependent work
- full mutation+audit transaction coupling across all PostgreSQL business operations
- durable notification/event outbox and provider delivery semantics
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