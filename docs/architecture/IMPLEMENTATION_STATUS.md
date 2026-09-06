# DCIECMS Implementation Status

## Baseline branch
`main`

## Integration status

The implementation is organized as R0/R1 court-management capabilities, R2 judicial operations, R3 durable reliability controls, R4 transactional audit coupling, R5 durable event/outbox infrastructure, and a provider-neutral production OIDC/JWT authentication boundary. The authentication boundary verifies signed bearer credentials and fails closed, but it does not register or activate a real government IdP, perform browser login, deploy production configuration, execute a live database migration or change production infrastructure.

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
- production-authentication configuration regressions for mandatory mode selection, production/development separation, HTTPS metadata and asymmetric algorithm allow-listing
- cryptographic authentication regressions for valid JWT mapping, invalid signature, issuer, audience, expiry, `nbf`, subject/claim-shape, disallowed algorithm and unknown key handling
- JWKS failure-isolation regressions for timeout, transport/non-2xx failures and bounded resolver reuse
- HTTP authentication regressions for asynchronous actor resolution and sanitized 401/403/503/500 separation
- startup regression proving production cannot listen with development authentication mode
- Court Workspace regressions proving runtime Bearer injection and no fallback to development identity when the token provider is configured
- token non-propagation and response-sanitization regressions proving raw bearer material/verifier internals are not exposed

These controls do not by themselves constitute production deployment approval or evidence that production infrastructure has been changed. The R3 and R5 Supabase test-profile migrations are repository-delivered but have not been represented as executed against a live database by this implementation work. Likewise, the production authentication verifier is repository-delivered but no real identity platform has been registered or activated.

## Intentionally outstanding / environment-dependent work
- approved government IdP selection/registration, browser login/PKCE integration and live issuer/audience/JWKS configuration
- approved permanent outbox worker scheduling/runtime and real idempotent provider handlers
- approved production PostgreSQL/Supabase environment and controlled live migration execution
- private object storage and malware scanning pipeline
- production payment-gateway callback/integration
- email/SMS notification providers
- government-agency adapters and external integration credentials
- production hosting, WAF, secrets-vault configuration and observability stack
- production backup/restore, disaster-recovery and operational support procedures
- formal UAT, performance/load testing, penetration testing and production go-live approval

## Security boundary

`x-dev-*` request headers are development-only scaffolding. They must never be accepted as production identity evidence. The production runtime now enforces OIDC bearer verification before actor construction and preserves server-side permission, court, record-relationship and confidentiality enforcement.

The browser is not an authorization boundary. Registry workflow, request replay, judicial assignment, hearing/judgment authority, finance controls, case-number allocation and case-opening eligibility continue to be enforced by the API and database layers.
