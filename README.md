# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current implementation status

The repository baseline now covers the executable R0/R1 court-management slice, R2 judicial operations, R3 durable controls, and R4 transactional audit coupling for PostgreSQL-backed mutations.

### R0/R1 capabilities
- normalized development identity claims and deny-by-default RBAC/court scope
- party creation and filing drafts
- controlled case-type validation
- secure document registration in `QUARANTINED` state with SHA-256 validation
- idempotent filing submission
- court-scoped Registry queue
- Registry validation workflow task creation/completion
- Registry validate / return / reject / accept decisions with persisted evidence
- PostgreSQL-backed service, repository and bounded runtime pool
- migrations `0001` through `0006`
- fee assessment and controlled payment confirmation
- receipt issuance and maker/checker reconciliation controls
- transactional case-number allocation and controlled case opening after confirmed payment
- React + TypeScript + Vite Court Workspace frontend
- My Work, Registry queue, Filing Review, finance controls and case opening
- typed frontend API client with explicit HTTP error mapping
- keyboard-accessible navigation, skip link and responsive table/form baseline

### R2 judicial-operations capabilities
- judicial case assignment and assigned-case work queues
- hearing scheduling, daily lists and adjournment workflows
- hearing-mode controls and proceeding-state capture
- judgment/order lifecycle support through draft, review, signing and issuance controls
- Judicial Workbench UI including My Cases, Daily Hearings, Case Workspace, Hearing Mode, Pending Decisions and Judgment/Order workspace
- migrations `0007` through `0010`
- PostgreSQL repositories and HTTP routes for judicial operations
- backend, frontend and regression tests covering judicial operations

### R3 reliability-hardening capabilities
- migration `0011_durable_controls.sql` for durable request-control state
- PostgreSQL-backed filing-submission idempotency scoped by actor, operation, filing and idempotency key
- atomic first-submission transaction covering idempotency claim, `DRAFT -> SUBMITTED`, Registry task creation and canonical response persistence
- restart-safe replay of the original filing-submission response without repeating the filing mutation or workflow-task creation
- rollback of the idempotency claim when the business transition fails
- PostgreSQL-backed application audit store using `audit.audit_events.actor_subject`
- awaited audit persistence across Registry, finance, case-opening, judicial, hearing, proceeding and judgment/Workbench service paths
- PostgreSQL runtime injection of the durable audit store when `DATABASE_URL` is configured
- Supabase isolated-test profile mapping and incremental `dciecms_test` migration for R3 durable controls

### R4 transactional audit coupling
- `PostgresTransactionManager` using request-scoped `AsyncLocalStorage` transaction context
- one shared PostgreSQL transaction manager for repositories and `PostgresAuditStore`
- immutable reviewed registry of the current mutating service operations that require an outer transaction boundary
- compatibility with repository methods that already use internal `BEGIN` / `COMMIT` / `ROLLBACK` blocks, without allowing nested commits to escape the outer service transaction
- business mutation SQL and its awaited application audit insert routed through the same physical PostgreSQL client
- audit-write failure rolls back the preceding business mutation instead of leaving committed state without its application audit evidence
- successful mutation and audit persistence commit together before the service call returns
- read-only operations remain outside the mutation transaction boundary
- no-database/in-memory runtime remains unchanged
- no schema migration or live database execution is required by R4 itself

The next reliability control after R4 is a durable notification/event outbox so external delivery can be retried safely without weakening the transactional business-state boundary.

### Verification and delivery controls
- GitHub Actions CI covers backend tests, Court Workspace tests and production frontend build
- live Supabase smoke-test workflow and isolated test-profile migration assets exist for controlled verification
- the Supabase R3 migration is provided as `db/supabase/20260906_dciecms_test_0011.sql`; its presence does not mean it has been executed against any live environment
- production deployment is not implied by the presence of deployment, migration or smoke-test tooling

## Court Workspace local development

Install frontend dependencies:

```bash
npm --prefix apps/court-workspace install
```

Start the Court Workspace development server:

```bash
npm --prefix apps/court-workspace run dev
```

Run the frontend test suite:

```bash
npm run test:frontend
```

Build the production frontend bundle:

```bash
npm run build:frontend
```

Run the backend tests:

```bash
npm test
```

The Court Workspace uses `VITE_DCIECMS_API_BASE_URL` when an API base URL is required. Development identity headers are emitted only when `VITE_DCIECMS_DEV_IDENTITY=true`; that mechanism is development scaffolding and is not production authentication.

## Important security boundary

The `x-dev-*` request headers are development-only scaffolding. They are **not production authentication**. Production must use validated identity claims from the approved IdP/API gateway and must preserve the RBAC, scope, record-relationship and confidentiality checks defined in the DCIECMS security baseline.

The browser is not an authorization boundary. Court scope, workflow transitions, durable request replay, judicial assignment, hearing and judgment authority, finance authority, receipt/reconciliation controls, case-number generation and case-opening eligibility remain enforced by API/database layers.

Real private object storage, malware scanning, external payment-gateway callbacks, production IdP integration, email/SMS providers, government-agency integrations, production hosting credentials, WAF/secrets-vault configuration and the production observability stack remain intentionally outside the current repository baseline until those external environments and credentials are approved.