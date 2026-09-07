# Case Lifecycle & Records Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure, non-destructive case disposition/closure/reopen and records-retention/archive/legal-hold/disposal-approval capabilities to DCIECMS.

**Architecture:** Add an additive PostgreSQL migration plus focused repository/service extensions composed into the existing runtime. Reuse the existing RBAC, judicial assigned-case rule, transaction manager, application audit store and durable outbox; do not add a physical deletion executor.

**Tech Stack:** Node.js >=20, CommonJS, PostgreSQL/pg, `node:test`, existing DCIECMS RBAC/audit/outbox/runtime patterns.

**Spec:** `docs/superpowers/specs/2026-09-07-case-lifecycle-records-design.md`

## Global Constraints

- No physical case/document/object deletion endpoint or worker.
- No live database migration or production deployment.
- Case/document legal holds veto disposal approval.
- Disposal request and approval must be different actor subjects.
- Free-text reasons must not enter generic outbox payloads.
- All mutation methods must use the existing transactional wrapper.
- Court scope and permission checks must be server-side.

---

### Task 1: RBAC and lifecycle contract tests

**Files:**
- Create: `tests/unit/case-lifecycle-records.test.js`
- Modify: `packages/rbac/index.js`

**Interfaces:**
- Produces permissions `case.disposition`, `case.close`, `case.reopen`, `records.view`, `records.retention.assign`, `records.archive`, `records.legal_hold.manage`, `records.disposal.request`, `records.disposal.approve`.
- Produces role code `RECORDS`.

- [ ] Write failing tests asserting MAG/CMAG/REG-MGR/RECORDS grants and prohibited grants exactly as specified in the design.
- [ ] Run `node --test tests/unit/case-lifecycle-records.test.js`; expect permission assertions to fail before RBAC changes.
- [ ] Add the minimal role-permission entries to `packages/rbac/index.js`.
- [ ] Re-run the test; expect the RBAC section to pass while service-contract tests still fail until later tasks.
- [ ] Commit as `test/feat: define case lifecycle records permissions`.

### Task 2: Additive database model and repository extension

**Files:**
- Create: `db/migrations/0015_case_lifecycle_records.sql`
- Create: `services/api/src/postgres-case-lifecycle-records-repository.js`
- Modify: `services/api/src/postgres-repository.js`
- Test: `tests/unit/case-lifecycle-records-postgres.test.js`

**Interfaces:**
- Repository methods: `getCaseRecordControl(caseId)`, `hasActiveCaseHearing(caseId)`, `getIssuedJudgmentForCase(judgmentId, caseId)`, `disposeCase(input)`, `closeCase(input)`, `reopenCase(input)`, `assignRetention(input)`, `archiveCaseRecord(input)`, `setCaseLegalHold(input)`, `releaseCaseLegalHold(input)`, `hasDocumentLegalHold(caseId)`, `createDisposalRequest(input)`, `getDisposalRequest(id)`, `approveDisposalRequest(input)`, `rejectDisposalRequest(input)`.

- [ ] Write repository tests with a pg-compatible fake queryable that assert conditional transitions, row-lock/SoD SQL, document-hold lookup and no DELETE statements.
- [ ] Run `node --test tests/unit/case-lifecycle-records-postgres.test.js`; expect missing module/method failures.
- [ ] Add migration `0015` with current case fields, append-only lifecycle events, `records.case_record_controls`, `records.disposal_requests`, constraints/indexes and revoked DELETE privileges.
- [ ] Implement the repository extension and install it from `postgres-repository.js`.
- [ ] Re-run repository tests; expect pass.
- [ ] Commit as `feat: add case lifecycle records persistence`.

### Task 3: Lifecycle and records service

**Files:**
- Create: `services/api/src/case-lifecycle-records-service.js`
- Create: `services/api/src/case-lifecycle-records-facade.js`
- Modify: `services/api/src/persistent-dciecms-service.js`
- Test: `tests/unit/case-lifecycle-records.test.js`

**Interfaces:**
- Service methods exactly match design section 6.
- `disposeCase` reuses assigned-MAG restriction for MAG actors; CMAG may supervise within court scope.
- `closeCase` requires `DISPOSED`; `reopenCase` requires `CLOSED` and returns case to `AWAITING_ASSIGNMENT`.

- [ ] Extend failing service tests for active-hearing denial, issued-judgment validation, close/reopen transitions, retention/archive rules, legal holds and disposal maker/checker.
- [ ] Run the focused test; expect missing service/facade behavior.
- [ ] Implement validation, authorization, repository calls, audit actions and minimized domain events.
- [ ] Compose the facade into `PersistentDciecmsService` without expanding the core service file.
- [ ] Re-run focused tests; expect pass.
- [ ] Commit as `feat: add case lifecycle records service`.

### Task 4: Transaction coupling

**Files:**
- Modify: `services/api/src/transactional-service.js`
- Test: `tests/unit/transactional-service.test.js`
- Test: `tests/unit/case-lifecycle-records.test.js`

**Interfaces:**
- All nine mutating case/records methods are members of `MUTATING_SERVICE_METHODS`.

- [ ] Add failing assertions that every new mutator is wrapped and that transaction failure prevents business success.
- [ ] Run `node --test tests/unit/transactional-service.test.js tests/unit/case-lifecycle-records.test.js`; expect new mutation-registration assertions to fail.
- [ ] Register every new mutator in `MUTATING_SERVICE_METHODS`.
- [ ] Re-run tests; expect pass.
- [ ] Commit as `fix: couple records mutations to transactions`.

### Task 5: HTTP API

**Files:**
- Modify: `services/api/src/http-app.js`
- Create: `tests/api/case-lifecycle-records-http.test.js`

**Interfaces:**
- Routes exactly match design section 7 and return existing sanitized 403/404/409/422 shapes.

- [ ] Write failing HTTP tests for disposition, close, reopen, records-control read/update, hold/release and disposal request/decision routes plus unknown/deletion-route denial.
- [ ] Run `node --test tests/api/case-lifecycle-records-http.test.js`; expect route failures.
- [ ] Add route dispatch only; keep authorization/business rules in the service.
- [ ] Re-run focused HTTP tests; expect pass.
- [ ] Commit as `feat: expose case lifecycle records API`.

### Task 6: Audit/outbox security regression

**Files:**
- Modify: `tests/unit/domain-event-integration.test.js`
- Modify: `tests/security/rbac-negative.test.js` if present; otherwise create `tests/security/case-lifecycle-records-security.test.js`

**Interfaces:**
- Outbox payloads may contain IDs, court ID, status and normalized codes; must not contain `reason`, `legalHoldReason`, judgment content or document bytes/object keys.

- [ ] Add failing tests for outbox minimization, cross-court denial, records-role non-judicial access, audit failure rollback and outbox failure rollback.
- [ ] Run `node --test tests/unit/domain-event-integration.test.js tests/security`; expect any uncovered control to fail.
- [ ] Make only minimal service/repository corrections required by the tests.
- [ ] Re-run tests; expect pass.
- [ ] Commit as `test: harden case lifecycle records boundaries`.

### Task 7: Documentation, migration mapping and full verification

**Files:**
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`
- Modify: `README.md`
- Modify: existing isolated Supabase migration mapping/profile documentation under `db/` or `docs/` discovered in the repository.

**Interfaces:**
- Documentation must say migration `0015` is repository-delivered and not live-applied.
- Documentation must distinguish blueprint R3 from prior engineering reliability labels.

- [ ] Update implementation status and README with exact delivered scope/non-goals.
- [ ] Add migration `0015` to the existing isolated Supabase test mapping mechanism without applying it to a live project.
- [ ] Run `npm test`.
- [ ] Run `npm run test:frontend`.
- [ ] Run `npm run build:frontend`.
- [ ] Verify CI for the exact feature-branch head is green.
- [ ] Open a pull request to `main` with test evidence and explicit production/live-migration gates.
