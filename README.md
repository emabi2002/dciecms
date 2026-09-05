# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current implementation status

PR #1 contains the executable R0/R1 vertical slice and remains pre-merge.

Implemented on `feat/first-vertical-slice`:
- normalized development identity claims and deny-by-default RBAC/court scope
- party creation and filing drafts
- controlled case-type validation
- secure document registration in `QUARANTINED` state with SHA-256 validation
- idempotent filing submission
- court-scoped Registry queue
- Registry validation workflow task creation/completion
- Registry validate / return / reject / accept decisions with persisted evidence
- PostgreSQL-backed service, repository, runtime pool and migrations
- finance fee assessment and controlled payment confirmation
- receipt issuance and maker/checker reconciliation controls
- transactional case numbering and controlled case opening after confirmed payment
- React + TypeScript + Vite Court Workspace frontend
- Court Workspace My Work dashboard, Registry queue, Filing Review, finance controls and case opening
- typed frontend API client with explicit HTTP error mapping and development-only identity scaffolding
- keyboard-accessible navigation, skip link and responsive table/form baseline
- GitHub Actions CI covering backend tests, Court Workspace tests and production frontend build

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

The `x-dev-*` request headers are development-only scaffolding. They are **not production authentication**. Production must use validated identity claims from the approved IdP/API gateway and must preserve the RBAC, scope, record and confidentiality checks defined in the DCIECMS security baseline.

The browser is not an authorization boundary. Court scope, workflow transitions, finance authority, receipt/reconciliation controls, case-number generation and case-opening eligibility remain enforced by the API and database layers.

Real object storage, malware scanning, external payment-gateway callbacks, notifications, government-agency integrations and production hosting credentials are intentionally not fabricated.
