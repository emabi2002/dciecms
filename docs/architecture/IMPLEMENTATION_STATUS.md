# DCIECMS Implementation Status

## Baseline branch
`main`

## Integration status

The implementation is organized as R0/R1 court-management capabilities, R2 judicial operations, R3 durable reliability controls, R4 transactional audit coupling, R5 durable event/outbox infrastructure, a provider-neutral production OIDC/JWT authentication boundary, and a provider-neutral secure document pipeline. The authentication boundary verifies signed bearer credentials and fails closed. The secure document boundary enforces private-object lifecycle, authoritative integrity evidence, malware-scan gating, record/classification authorization and immutable document history. Neither boundary registers or activates a real government/provider integration, deploys production credentials, executes a live database migration or changes production infrastructure.

## Delivered capabilities

### R0/R1 — Registry, finance and case opening
- development identity claim normalization
- deny-by-default RBAC and court scoping
- party creation and filing draft creation
- controlled case-type validation
- legacy document metadata registration in quarantine with SHA-256 checksum validation
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
- immutable reviewed transaction registry covers the current Registry, filing, document, finance, case-opening, judicial, hearing, proceeding and judgment mutation methods
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

### Production authentication boundary
- explicit `DCIECMS_AUTH_MODE=development|oidc`; the server does not silently select an authentication mode
- `NODE_ENV=production` rejects development authentication before the HTTP server can listen
- OIDC mode requires HTTPS issuer and JWKS URLs, API audience and an explicit asymmetric signing-algorithm allow-list
- JOSE/JWKS verification validates bearer-token signature, exact issuer, audience, expiry, not-before time, allowed signing algorithm and subject
- verified `sub`, `roles`, `court_ids` and `explicit_grants` are type-checked before canonical actor normalization
- unverified HTTP headers, usernames, email addresses, frontend state and token payload data are not accepted as authorization evidence
- OIDC authentication is asynchronous and completes before application service methods execute
- invalid/missing credentials return sanitized 401 with `WWW-Authenticate: Bearer`
- valid identity that fails RBAC/court-scope authorization remains a 403 without an authentication challenge
- temporary JWKS verification infrastructure failures fail closed with sanitized 503; unexpected authentication-boundary errors are sanitized as 500
- raw bearer material and verifier internals do not propagate into the canonical application actor or HTTP error payloads
- remote JWKS construction is reused with bounded cache/cooldown/timeout settings rather than recreated for each request
- Court Workspace supports a provider-neutral runtime access-token provider and sends `Authorization: Bearer <token>` when supplied
- Court Workspace suppresses all development identity headers whenever the token-provider boundary is configured, including when that provider temporarily returns no token
- browser login/PKCE, approved government IdP registration, live issuer/JWKS configuration, production credentials and production activation remain outside this delivered boundary

### Secure document pipeline
- migration `0013_secure_document_pipeline.sql` extends `documents.documents` with server-owned private object identity, expected/authoritative integrity evidence, detected MIME type, scan/release evidence, immutable version lineage, withdrawal evidence, legal-hold fields and governed-disposition eligibility
- `documents.scan_jobs` provides a dedicated durable malware-scan queue with bounded attempts, due times, worker leases, stale-lease recovery, sanitized result/error codes and terminal/dead-letter state
- isolated Supabase test-profile migration `db/supabase/20260907_dciecms_test_0013.sql` mirrors the secure-document schema changes without implying live execution
- API-created upload intents generate the document ID and quarantine object key on the server; callers cannot supply an object key, storage URL, upload URL or download URL
- storage is represented by a provider-neutral adapter contract that must support private object upload grants, authoritative metadata reads, download grants and production capability attestation
- finalization trusts storage-adapter evidence, not caller-supplied checksum or MIME evidence; expected size, SHA-256 and detected MIME type must match policy before a scan job is created
- finalization, authoritative document mutation and scan-job creation are transactionally coupled in PostgreSQL and roll back together on failure
- documents remain `QUARANTINED` while scanning; only a normalized `CLEAN` result for the exact quarantined record may set `ACTIVE` and `released_at`
- infected, unsupported, malformed or scanner-error outcomes fail closed and cannot release a document
- scan worker claims bounded due/stale jobs using lease ownership and persists only normalized/sanitized scanner evidence; raw provider diagnostics are excluded from audit evidence
- download authorization requires base `document.view`, court scope, filing-record relationship, classification authority and `ACTIVE`/released lifecycle state before a short-lived provider-neutral grant is returned
- `PUBLIC` actors may access only documents belonging to filings created by their verified subject, even when another filing shares the same court
- `RESTRICTED` and `SEALED` documents require corresponding explicit grants in addition to base permission and court scope
- signed upload/download grants remain ephemeral response material and are not persisted in document rows or application audit evidence
- classification changes, replacements, superseding, withdrawal and scan retry are explicit controlled service operations with application audit evidence
- replacement creates a new document/version rather than mutating finalized content; superseded and withdrawn records remain historical evidence
- no normal service/repository hard-delete operation exists for secure documents
- legal hold is a fail-closed veto on governed-disposition eligibility; the repository work does not add a direct destructive disposal endpoint
- secure document service mutations that persist application audit evidence are registered in the shared outer transaction boundary
- `DCIECMS_DOCUMENT_PIPELINE_MODE` is fail closed: non-production may use `development`, production defaults to `disabled`, production forbids `development`, and production `enabled` requires approved injected storage and scanner adapters
- production storage must attest private-object controls and encryption at rest; development memory storage cannot satisfy the production contract
- no real production storage provider, bucket, KMS configuration, malware-scanner provider, provider credential, permanent worker schedule, live migration or production activation has been performed

## Verification controls present in the repository
- GitHub Actions CI using Node.js 20 for the application test/build runtime
- backend regression test execution
- Court Workspace test execution
- production frontend build verification
- live Supabase smoke-test workflow
- Supabase test migration bundle covering R0-R2 (`0001` through `0010`)
- incremental Supabase isolated-test migrations for R3 (`0011`), R5 (`0012`) and secure documents (`0013`)
- R4 transaction-manager regressions for commit, rollback and nested repository transaction handling
- R4 runtime regressions proving business SQL and audit SQL use one client and that audit failure rolls back business mutation
- R5 outbox regressions for idempotent enqueue, bounded/stale claims, worker ownership, retry/dead-letter transitions and dispatcher behavior
- R5 domain-event regressions covering seven lifecycle transitions and sensitive-payload minimization
- R5 runtime regression proving business mutation, audit evidence and outbox enqueue share one transaction/client and roll back together when the outbox write fails
- production-authentication configuration regressions for mandatory mode selection, production/development separation, HTTPS metadata and asymmetric algorithm allow-listing
- cryptographic authentication regressions for valid JWT mapping, invalid signature, issuer, audience, expiry, `nbf`, subject/claim-shape, disallowed algorithm and unknown key handling
- JWKS failure-isolation regressions for timeout, transport/non-2xx failures and bounded resolver reuse
- HTTP authentication regressions for asynchronous actor resolution and sanitized 401/403/503/500 separation
- startup regression proving production cannot listen with development authentication mode
- Court Workspace regressions proving runtime Bearer injection and no fallback to development identity when the token provider is configured
- token non-propagation and response-sanitization regressions proving raw bearer material/verifier internals are not exposed
- secure-document policy tests for supported type/size/classification enforcement and authoritative size/checksum/detected-MIME validation
- secure storage contract tests for private/encrypted production capability requirements and exact-object short-lived development grants
- secure-document repository tests for upload intent, idempotent/conflicting finalization, state-conditional classification/supersede/withdraw transitions and absence of hard delete
- scan-store/worker tests for lease ownership, CLEAN/INFECTED handling, retry/backoff, permanent failure, dead-letter recovery and fail-closed malformed/scanner-exception handling
- HTTP secure-document tests for lifecycle route mapping, client integrity-evidence rejection and sanitized policy/access/conflict/provider failures
- runtime tests proving development adapter composition, persistent shared repository/audit/scan-store composition, production default-disabled behavior and production refusal without approved adapters
- transactional regressions proving secure-document mutation plus audit rollback and finalization plus scan-job rollback
- centralized security regression gate proving signed-grant non-persistence, caller-controlled key rejection, quarantined/superseded/withdrawn denial, RESTRICTED grant enforcement, same-court cross-filer denial for `PUBLIC`, legal-hold disposition veto and provider/scanner diagnostic sanitization

These controls do not by themselves constitute production deployment approval or evidence that production infrastructure has been changed. The R3, R5 and secure-document `0013` Supabase test-profile migrations are repository-delivered but have not been represented as executed against a live database by this implementation work. Likewise, the authentication verifier and secure-document provider contracts are repository-delivered but no real identity platform, storage provider or malware scanner has been registered or activated.

## Intentionally outstanding / environment-dependent work
- approved government IdP selection/registration, browser login/PKCE integration and live issuer/audience/JWKS configuration
- approved permanent outbox worker scheduling/runtime and real idempotent provider handlers
- approved production PostgreSQL/Supabase environment and controlled live migration execution, including secure-document migration `0013`
- approved production private-object storage provider/bucket, encryption/KMS policy, storage credentials and secret injection
- approved production malware-scanner provider, endpoint/security contract, credentials and permanent scan-worker scheduling
- production payment-gateway callback/integration
- email/SMS notification providers
- government-agency adapters and external integration credentials
- production hosting, WAF, secrets-vault configuration and observability stack
- production backup/restore, disaster-recovery and operational support procedures
- formal UAT, performance/load testing, penetration testing and production go-live approval

## Security boundary

`x-dev-*` request headers are development-only scaffolding. They must never be accepted as production identity evidence. The production runtime enforces OIDC bearer verification before actor construction and preserves server-side permission, court, record-relationship and confidentiality enforcement.

`DCIECMS_DOCUMENT_PIPELINE_MODE=development` is also non-production scaffolding. Production document handling defaults to disabled and cannot silently use memory storage or the scripted scanner. Production activation requires explicitly approved private/encrypted storage and malware-scanner adapters, external credentials supplied through approved secret management, controlled migration execution and an authorized deployment.

The browser is not an authorization boundary. Registry workflow, request replay, document access/classification, judicial assignment, hearing/judgment authority, finance controls, case-number allocation and case-opening eligibility continue to be enforced by the API and database layers.
