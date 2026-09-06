# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current implementation status

The repository baseline now covers the executable R0/R1 court-management slice, R2 judicial operations, R3 durable controls, R4 transactional audit coupling, R5 durable event/outbox infrastructure for PostgreSQL-backed mutations, a provider-neutral production OIDC/JWT authentication boundary, and a provider-neutral secure document pipeline. No real government IdP, production storage/scanner provider, production credential, live database migration or production deployment is implied by this repository state.

### R0/R1 capabilities
- normalized development identity claims and deny-by-default RBAC/court scope
- party creation and filing drafts
- controlled case-type validation
- legacy document metadata registration in `QUARANTINED` state with SHA-256 validation
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

### R5 durable event/outbox capabilities
- migration `0012_event_outbox.sql` for durable `integration.outbox_events`
- isolated Supabase test-profile migration and logical table mapping for the R5 outbox
- idempotent event enqueue by event type plus stable server-generated deduplication key
- bounded due-event claiming with `FOR UPDATE SKIP LOCKED`, worker leases and stale-lease recovery
- worker-owned delivery/failure transitions, deterministic exponential retry and dead-letter handling
- one-shot `OutboxDispatcher.runOnce()` contract without a permanent scheduler or external provider dependency
- durable lifecycle events for `filing.submitted`, `payment.confirmed`, `case.opened`, `hearing.scheduled`, `hearing.adjourned`, `hearing.completed` and `judgment.issued`
- generic payment event payloads exclude provider references; hearing-adjournment event payloads exclude free-text judicial reasons
- repository, application audit store and outbox store share the same `PostgresTransactionManager` in the PostgreSQL runtime
- representative regression proving payment mutation, audit evidence and outbox enqueue commit on one physical PostgreSQL client
- outbox enqueue failure rolls back preceding business mutation and audit work
- delivery semantics are **at least once**; every eventual downstream/provider handler must be idempotent using the outbox event ID, deduplication key or an equivalent provider-side mechanism

### Production authentication boundary capabilities
- explicit `DCIECMS_AUTH_MODE=development|oidc`; authentication mode is mandatory
- development authentication is rejected when `NODE_ENV=production`
- production OIDC mode requires HTTPS issuer/JWKS metadata, API audience and an explicit asymmetric signing-algorithm allow-list
- JOSE/JWKS bearer-token verification validates signature, exact issuer, audience, `exp`, `nbf`, signing algorithm and subject before authorization claims are used
- verified `sub`, `roles`, `court_ids` and `explicit_grants` are strictly type-checked and mapped into the canonical actor used by existing RBAC/court-scope controls
- invalid credentials return sanitized 401 responses with `WWW-Authenticate: Bearer`; authenticated authorization failures remain 403; temporary JWKS verification infrastructure failures fail closed as sanitized 503
- bearer tokens and verifier internals are excluded from application actors and authentication error responses
- authentication construction completes before the HTTP server can listen; invalid configuration cannot silently fall back to development identity
- Court Workspace supports an injected runtime access-token provider and sends `Authorization: Bearer <token>` without decoding JWTs or making frontend authorization decisions
- when a Court Workspace token provider is configured, development identity headers are suppressed even when no token is temporarily available
- no browser login/PKCE flow, real government IdP registration, live issuer/JWKS metadata, client credentials or production activation is included in this repository baseline

### Secure document pipeline capabilities
- migration `0013_secure_document_pipeline.sql` extends document lifecycle evidence for private storage, upload finalization, malware scanning, immutable version lineage, withdrawal, legal hold and governed disposition eligibility
- server-generated document IDs and quarantine object keys; callers cannot choose storage keys, storage URLs or signed grant URLs
- provider-neutral short-lived upload grants bound to one exact private quarantine object
- authoritative finalization reads storage metadata and validates exact expected size, SHA-256 checksum and detected MIME type; caller-supplied finalization integrity evidence is not trusted
- durable malware-scan jobs use bounded attempts, leases, stale-lease recovery, deterministic retry and dead-letter handling
- only a normalized `CLEAN` scan result for the exact `QUARANTINED` record can transition the document to `ACTIVE`
- infected, unsupported, scanner-error and malformed scanner outcomes fail closed and never make a document downloadable
- active-document downloads require base RBAC/court scope, filing-record relationship, document classification authority and a released `ACTIVE` lifecycle state
- `PUBLIC` actors are restricted to their own filing relationship even when another filer's document is in the same court
- `RESTRICTED` and `SEALED` documents require their corresponding explicit document grants in addition to base `document.view` authority and court scope
- provider-neutral short-lived download grants are returned only after authorization and are never persisted in document metadata or audit evidence
- replacement creates a new immutable version; supersede and withdraw preserve prior history; the normal document service exposes no hard-delete operation
- legal hold is a fail-closed veto on governed disposition eligibility
- document mutations and application audit evidence share the outer PostgreSQL transaction; finalization and scan-job creation also roll back together on failure
- production defaults the document pipeline to disabled; production cannot select development adapters; enabled production mode requires approved injected private/encrypted storage and malware-scanner adapters
- repository code does **not** select or activate a real storage provider, bucket, KMS key, malware-scanner provider, provider credential, permanent scan-worker schedule or production deployment

### Verification and delivery controls
- GitHub Actions CI covers backend tests, Court Workspace tests and production frontend build
- live Supabase smoke-test workflow and isolated test-profile migration assets exist for controlled verification
- Supabase incremental test-profile migrations are provided for R3 (`db/supabase/20260906_dciecms_test_0011.sql`), R5 (`db/supabase/20260906_dciecms_test_0012.sql`) and the secure document pipeline (`db/supabase/20260907_dciecms_test_0013.sql`); their presence does not mean they have been executed against any live environment
- production-authentication regressions cover invalid signature, issuer, audience, time validity, subject/claim shape, signing algorithm, unknown keys, JWKS failure isolation, startup fail-closed behavior, token non-propagation, sanitized 401/503/500 behavior and 401/403 separation
- secure-document regressions cover caller-controlled object-key rejection, authoritative integrity validation, CLEAN-only release, cross-court and cross-filer isolation, RESTRICTED/SEALED grant enforcement, signed-grant non-persistence, scan failure isolation, immutable versioning, no hard-delete path, legal-hold veto and provider/scanner diagnostic sanitization
- production deployment is not implied by the presence of deployment, migration, authentication, document-storage, scanner, outbox or smoke-test tooling

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

Install root dependencies and run the backend tests:

```bash
npm install
npm test
```

Start the local API with the authentication and secure-document development modes explicitly selected:

```bash
DCIECMS_AUTH_MODE=development DCIECMS_DOCUMENT_PIPELINE_MODE=development PORT=3000 npm start
```

The Court Workspace uses `VITE_DCIECMS_API_BASE_URL` when an API base URL is required. Development identity headers are emitted only when `VITE_DCIECMS_DEV_IDENTITY=true`; that mechanism remains development scaffolding and is not production authentication. Production bearer tokens are supplied at runtime through the API client's access-token-provider seam, not through a `VITE_*` token value.

## Important security boundary

The `x-dev-*` request headers are development-only scaffolding. They are **not production authentication**, and production runtime configuration cannot select development authentication mode. OIDC mode accepts bearer credentials only after signature, issuer, audience, time-validity, subject and allowed-algorithm verification through the configured JWKS boundary.

The secure document development adapters are also development/test scaffolding. Production defaults the pipeline to disabled and must fail closed unless explicitly enabled with approved private encrypted storage and malware-scanner adapters. Signed upload/download grants, storage/scanner credentials and raw provider diagnostics must not be persisted in document metadata, audit/outbox evidence, source control or HTTP errors.

The browser is not an authorization boundary. Court scope, record relationship, document confidentiality, workflow transitions, durable request replay, judicial assignment, hearing and judgment authority, finance authority, receipt/reconciliation controls, case-number generation and case-opening eligibility remain enforced by API/database layers.

Real government IdP registration/browser login, production object-storage/KMS selection and provisioning, production malware-scanner integration, external payment-gateway callbacks, email/SMS providers, government-agency integrations, permanent outbox/scan-worker scheduling, production hosting credentials, WAF/secrets-vault configuration, production observability, live migration execution, backup/restore and disaster-recovery activation remain intentionally outside the current repository baseline until those external environments and credentials are approved.
