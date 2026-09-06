# DCIECMS R3 Durable Audit and Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace restart-sensitive filing-submission idempotency and application audit evidence with PostgreSQL-backed controls while preserving the existing no-database development runtime.

**Architecture:** Migration `0011_durable_controls.sql` adds a database idempotency record and actor-subject-compatible audit column. Filing submission uses a single PostgreSQL transaction to claim an idempotency key, mutate the filing, create its validation task, persist the canonical response and commit atomically. A separate `PostgresAuditStore` persists awaited audit records and is injected only into PostgreSQL-backed runtime services.

**Tech Stack:** Node.js 20, CommonJS, node:test, PostgreSQL/pg-compatible queryables, React/Vite regression build.

**Spec:** `docs/superpowers/specs/2026-09-06-r3-durable-audit-idempotency-design.md`

## Global Constraints

- Preserve deny-by-default RBAC and court scoping.
- No production deployment or production credential changes.
- SQL must remain parameterized.
- Every behavior change follows RED -> verify RED -> GREEN -> full regression.
- Keep the no-`DATABASE_URL` runtime on the existing in-memory service.

---

### Task 1: Durable-control migration

**Files:**
- Create: `db/migrations/0011_durable_controls.sql`
- Modify: `tests/unit/migration-contract.test.js`

**Interfaces:**
- Produces: `workflow.idempotency_records` and `audit.audit_events.actor_subject`.

- [ ] **Step 1: Write the failing migration contract test**

Add a test that reads `0011_durable_controls.sql` and asserts it contains `CREATE TABLE IF NOT EXISTS workflow.idempotency_records`, the four-column unique constraint `(actor_subject, operation, resource_id, idempotency_key)`, `response_payload jsonb`, and `ALTER TABLE audit.audit_events ADD COLUMN IF NOT EXISTS actor_subject text`.

- [ ] **Step 2: Run the migration contract test and verify RED**

Run: `node --test tests/unit/migration-contract.test.js`
Expected: FAIL because `0011_durable_controls.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create:

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS workflow.idempotency_records (
  idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_subject text NOT NULL,
  operation varchar(80) NOT NULL,
  resource_id text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_scope_key UNIQUE (actor_subject, operation, resource_id, idempotency_key)
);

ALTER TABLE audit.audit_events
  ADD COLUMN IF NOT EXISTS actor_subject text;

REVOKE UPDATE, DELETE ON workflow.idempotency_records FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit.audit_events FROM PUBLIC;

COMMIT;
```

- [ ] **Step 4: Run the migration contract test and verify GREEN**

Run: `node --test tests/unit/migration-contract.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add durable control schema`.

---

### Task 2: Atomic filing submission idempotency

**Files:**
- Modify: `tests/unit/postgres-repository.test.js`
- Modify: `services/api/src/postgres-repository.js`
- Modify: `services/api/src/persistent-dciecms-service.js`

**Interfaces:**
- Produces repository method:

```js
submitFilingIdempotent({ filingId, taskId, actorSubject, submittedAt, idempotencyKey }) -> Promise<filing>
```

- [ ] **Step 1: Write the failing repository tests**

Add one test where the idempotency claim insert returns a row and assert the transaction performs: `BEGIN`, claim insert, filing update, workflow task insert, idempotency response update, `COMMIT`, `RELEASE`.

Add a second test where the claim insert returns no row and the subsequent select returns a stored response; assert no filing update and no workflow task insert occur.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/unit/postgres-repository.test.js`
Expected: FAIL because `submitFilingIdempotent` is not defined.

- [ ] **Step 3: Implement `submitFilingIdempotent`**

Use a pool client transaction. Claim with:

```sql
INSERT INTO workflow.idempotency_records
(actor_subject, operation, resource_id, idempotency_key)
VALUES ($1, 'filing.submit', $2, $3)
ON CONFLICT (actor_subject, operation, resource_id, idempotency_key)
DO NOTHING
RETURNING idempotency_record_id
```

If no claim row is returned, read:

```sql
SELECT response_payload
FROM workflow.idempotency_records
WHERE actor_subject=$1
  AND operation='filing.submit'
  AND resource_id=$2
  AND idempotency_key=$3
```

Return `mapFiling`-compatible JSON from `response_payload` and commit without business mutation.

If the claim succeeds, perform the existing `DRAFT -> SUBMITTED` update and task insert, then persist `JSON.stringify(mappedFiling)` as the response payload before commit.

- [ ] **Step 4: Route service submission through the durable method**

In `PersistentDciecmsService.submitFiling`, when `repository.submitFilingIdempotent` exists, call it with `filingId`, generated `taskId`, `actor.userId`, current timestamp and the caller idempotency key. Keep the existing `Map` path only for repositories that do not implement the durable method.

- [ ] **Step 5: Verify GREEN and regression**

Run:
- `node --test tests/unit/postgres-repository.test.js`
- `node --test tests/unit/persistent-service.test.js`
- `npm test`

Expected: all PASS.

- [ ] **Step 6: Commit**

Commit message: `feat: make filing submission idempotency durable`.

---

### Task 3: PostgreSQL audit store

**Files:**
- Create: `services/api/src/postgres-audit-store.js`
- Create: `tests/unit/postgres-audit-store.test.js`

**Interfaces:**
- Produces:

```js
class PostgresAuditStore {
  constructor(queryable)
  async append(event)
  async list(filter = {})
}
```

- [ ] **Step 1: Write the failing audit-store tests**

Test `append` rejects missing `actorUserId`, `action` or `resourceType`; inserts using parameters into `audit.audit_events`; maps `actorUserId` to `actor_subject`; and returns an immutable application-shaped record.

Test `list({ actorUserId, action, resourceType, resourceId, courtId })` builds exact-match parameterized predicates only for supplied filters.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/unit/postgres-audit-store.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the store**

Use `randomUUID()` for `audit_event_id`, `new Date().toISOString()` for `event_time`, JSON-serialize `effectiveRoles` and `details`, and insert into `actor_subject`, `action`, `resource_type`, `resource_id`, `court_id`, `correlation_id`, `reason`, `approval_reference`, and `details`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/unit/postgres-audit-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add postgres audit store`.

---

### Task 4: Await durable audit writes in persistent/judicial services

**Files:**
- Modify: `services/api/src/persistent-dciecms-service.js`
- Modify: `services/api/src/judicial-operations-service.js`
- Modify: `services/api/src/judicial-workbench-service.js`
- Modify relevant tests under `tests/unit` and `tests/api`

**Interfaces:**
- `_audit(actor, action, resourceType, resourceId, details)` becomes async-compatible and every service call awaits it before returning success.

- [ ] **Step 1: Write a failing service test**

Inject an audit store whose `append()` returns a controllable Promise. Assert a mutating service operation does not resolve before the audit Promise resolves and propagates an audit persistence rejection.

- [ ] **Step 2: Verify RED**

Run the targeted service test. Expected: FAIL because existing calls do not await audit persistence.

- [ ] **Step 3: Await audit calls**

Change `_audit` to `async` and replace service call sites with `await this._audit(...)` inside already-async methods.

- [ ] **Step 4: Verify GREEN and full backend regression**

Run `npm test`.
Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: await persistent audit evidence`.

---

### Task 5: Runtime injection and release verification

**Files:**
- Modify: `services/api/src/runtime-service.js`
- Modify: `tests/unit/runtime-service.test.js`
- Update: `README.md`
- Update: `docs/architecture/IMPLEMENTATION_STATUS.md`

**Interfaces:**
- PostgreSQL runtime constructs `PostgresAuditStore(database)` and passes it into `JudicialWorkbenchService({ repository, auditStore })`.

- [ ] **Step 1: Write the failing runtime test**

With `DATABASE_URL` set and a fake PoolClass, assert the PostgreSQL runtime service uses a durable audit store rather than the default in-memory `AuditStore`.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/unit/runtime-service.test.js`
Expected: FAIL because runtime does not inject `PostgresAuditStore`.

- [ ] **Step 3: Implement runtime injection**

Require `PostgresAuditStore`, construct it with the mapped database, and pass it as `auditStore` when constructing `JudicialWorkbenchService`.

- [ ] **Step 4: Run release verification**

Run:
- `npm test`
- `npm run test:frontend`
- `npm run build:frontend`

Expected: all PASS.

- [ ] **Step 5: Update documentation and commit**

Record migration `0011`, restart-safe filing idempotency and durable PostgreSQL audit persistence. Explicitly state that full mutation+audit transaction coupling remains a later R3 control.

Commit message: `docs: record R3 durable controls`.
