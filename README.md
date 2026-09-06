# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current implementation status

PR #1 has been merged into `main`. The repository now contains the executable R0/R1 court-management vertical slice together with the first R2 judicial-operations implementation.

### R0/R1 capabilities now on `main`
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

### R2 judicial-operations capabilities now on `main`
- judicial case assignment and assigned-case work queues
- hearing scheduling, daily lists and adjournment workflows
- hearing-mode controls and proceeding-state capture
- judgment/order lifecycle support through draft, review, signing and issuance controls
- Judicial Workbench UI including My Cases, Daily Hearings, Case Workspace, Hearing Mode, Pending Decisions and Judgment/Order workspace
- migrations `0007` through `0010`
- PostgreSQL repositories and HTTP routes for judicial operations
- backend, frontend and regression tests covering judicial operations

### Verification and delivery controls
- GitHub Actions CI covers backend tests, Court Workspace tests and production frontend build
- live Supabase smoke-test workflow and migration bundle exist for controlled verification
- production deployment is not implied by the presence of deployment or smoke-test tooling

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

The browser is not an authorization boundary. Court scope, workflow transitions, judicial assignment, hearing and judgment authority, finance authority, receipt/reconciliation controls, case-number generation and case-opening eligibility remain enforced by API/database layers.

Real private object storage, malware scanning, external payment-gateway callbacks, production IdP integration, email/SMS providers, government-agency integrations, production hosting credentials, WAF/secrets-vault configuration and the production observability stack remain intentionally outside the current repository baseline until those external environments and credentials are approved.