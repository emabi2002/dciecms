# DCIECMS R3 Finance, Notifications & Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the verified R2 baseline into operational finance, notification and records-management capability without weakening court scope, segregation of duties, immutable evidence or the existing judicial workflows.

**Architecture:** R3 builds on the existing PostgreSQL-backed finance primitives already present in R0/R1 rather than replacing them. New finance read models, notification outbox/delivery state and records lifecycle are implemented as server-authoritative services backed by PostgreSQL repositories, then surfaced through the Court Workspace. External SMS/email providers and production archive infrastructure remain adapters behind internal contracts; R3 verifies the internal workflow without requiring production integrations.

**Tech Stack:** Node.js 20 runtime baseline, PostgreSQL/Supabase test profile, React/Vite Court Workspace, GitHub Actions, `node:test`, Vitest/Testing Library.

**Spec:** Existing DCIECMS architecture/requirements baseline and the implemented R0-R2 repository contracts on `main`; this plan does not expand production integration scope beyond the previously agreed roadmap.

## Global Constraints

- Preserve court-scoped RBAC and server-authoritative lifecycle transitions.
- Preserve FIN/FIN-MGR maker-checker segregation for reconciliation and controlled payment confirmation.
- Monetary values remain integer minor units with explicit ISO-style 3-letter currency codes; current baseline default is PGK.
- Notifications are persisted before dispatch and delivery attempts are auditable; no client may self-declare delivery success.
- Records closure/archive actions are reversible only through controlled workflow evidence; no ordinary hard-delete path is introduced.
- Existing signed/issued judgments, receipts, reconciliations, audit evidence and hearing records remain immutable according to their current controls.
- Supabase testing continues in the isolated `dciecms_test` mapping; existing NJSS/public structures are not modified.
- No production deployment or external SMS/email provider activation is part of R3 implementation.
- Every behavioral change follows RED -> verify RED -> minimal GREEN -> full CI regression.

---

### Task 1: Finance Operations Read Model and Queues

**Files:**
- Create: `services/api/src/finance-operations-service.js`
- Modify: `services/api/src/postgres-repository.js`
- Modify: `services/api/src/runtime-service.js`
- Modify: `services/api/src/http-app.js`
- Modify: `packages/rbac/index.js` only if a missing explicit read permission is proven by a RED test.
- Test: `tests/unit/finance-operations.test.js`
- Test: `tests/db/finance-operations-postgres.test.js`
- Test: `tests/api/finance-operations-http.test.js`

**Interfaces:**
- Consumes: existing fee assessments, payments, receipts and reconciliations.
- Produces: `listFinanceQueue(actor, filters)`, `getPaymentDetail(actor, paymentId)`, `listReceipts(actor, filters)`, `listReconciliations(actor, filters)`.

- [ ] **Step 1: Write failing service tests** proving FIN/FIN-MGR see only finance records in actor court scope; filters cannot broaden court scope; payment detail includes assessment and receipt/reconciliation evidence; non-finance roles are denied.
- [ ] **Step 2: Run `node --test tests/unit/finance-operations.test.js`** and verify RED because the R3 read service does not exist.
- [ ] **Step 3: Add repository queries** using parameterized SQL and `court_id = ANY($1::uuid[])` constraints for each queue/read model.
- [ ] **Step 4: Implement `FinanceOperationsService`** with explicit `authorize()` calls and append-only queue/detail audit evidence.
- [ ] **Step 5: Add HTTP routes** `GET /finance/queue`, `GET /finance/payments/:id`, `GET /finance/receipts`, `GET /finance/reconciliations` with validated query parameters.
- [ ] **Step 6: Run unit, DB and HTTP tests** and verify GREEN.
- [ ] **Step 7: Run full CI** and commit only after backend, frontend and build remain green.

### Task 2: Finance Exception and Reconciliation Control

**Files:**
- Modify: `services/api/src/finance-operations-service.js`
- Modify: `services/api/src/postgres-repository.js`
- Create: `db/migrations/0011_finance_operations.sql`
- Test: `tests/unit/finance-exceptions.test.js`
- Test: `tests/db/finance-exceptions-postgres.test.js`

**Interfaces:**
- Consumes: confirmed payments and existing maker-checker reconciliations.
- Produces: finance exception evidence and controlled resolution state; no external payment callback integration.

- [ ] **Step 1: Write failing tests** for duplicate provider reference protection, amount/currency mismatch detection, unresolved exception visibility, and same-actor maker/checker denial.
- [ ] **Step 2: Verify RED** against current database/service behavior.
- [ ] **Step 3: Add migration controls** for provider-reference uniqueness where applicable and an append-oriented `finance.payment_exceptions` structure carrying court, payment, reason code, evidence, state and actor timestamps.
- [ ] **Step 4: Implement exception creation/list/resolution methods** with FIN-MGR resolution authority and immutable resolution evidence.
- [ ] **Step 5: Verify targeted tests GREEN**, then full regression GREEN.

### Task 3: Notification Outbox and Delivery Lifecycle

**Files:**
- Create: `db/migrations/0012_notifications.sql`
- Create: `services/api/src/notification-service.js`
- Create: `services/api/src/notification-postgres-repository.js`
- Modify: `services/api/src/runtime-service.js`
- Modify: `services/api/src/http-app.js`
- Modify: `services/api/src/postgres-schema-mapping.js`
- Test: `tests/unit/notifications.test.js`
- Test: `tests/db/notifications-postgres.test.js`
- Test: `tests/api/notifications-http.test.js`

**Interfaces:**
- Produces: `queueNotification(actor, input)`, `listNotifications(actor, filters)`, `recordDeliveryAttempt(systemActor, notificationId, result)`.
- Lifecycle: `QUEUED -> SENDING -> DELIVERED` or `FAILED`; retries append delivery-attempt evidence instead of overwriting history.

- [ ] **Step 1: Write RED tests** showing a court-scoped notification can be queued only for a valid channel (`EMAIL` or `SMS`), recipient and template/event reference; clients cannot mark a notification DELIVERED.
- [ ] **Step 2: Add migration** for `notifications.notifications` and `notifications.delivery_attempts`, including status checks, court indexes and revoked ordinary update/delete on delivery-attempt evidence.
- [ ] **Step 3: Implement repository/service methods** that persist outbox state before any dispatch attempt and maintain append-only attempt history.
- [ ] **Step 4: Add internal/test dispatch adapter** that records deterministic success/failure without contacting external providers.
- [ ] **Step 5: Add read HTTP endpoints** for authorized notification history; do not expose internal delivery mutation endpoint to ordinary users.
- [ ] **Step 6: Verify targeted tests and full CI GREEN**.

### Task 4: Workflow-Driven Notifications

**Files:**
- Modify: `services/api/src/persistent-dciecms-service.js`
- Modify: `services/api/src/judicial-operations-service.js`
- Modify: `services/api/src/notification-service.js`
- Test: `tests/unit/workflow-notifications.test.js`

**Interfaces:**
- Consumes: existing filing, payment, hearing and judgment lifecycle events.
- Produces: deduplicated internal notification intents for selected high-value events.

- [ ] **Step 1: Write RED tests** for at least filing acceptance/return, payment confirmation/receipt issuance, hearing scheduling/adjournment and judgment issuance notification intents.
- [ ] **Step 2: Add deterministic notification idempotency key** derived from event type, resource id, recipient and channel so retrying a business transition cannot duplicate a notification.
- [ ] **Step 3: Wire notification creation after authoritative state changes** while keeping business state authoritative even when an external delivery attempt later fails.
- [ ] **Step 4: Verify duplicate transition retries produce one notification intent**, then full regression GREEN.

### Task 5: Records Closure and Archive Eligibility

**Files:**
- Create: `db/migrations/0013_records_lifecycle.sql`
- Create: `services/api/src/records-service.js`
- Create: `services/api/src/records-postgres-repository.js`
- Modify: `services/api/src/runtime-service.js`
- Modify: `services/api/src/http-app.js`
- Modify: `services/api/src/postgres-schema-mapping.js`
- Modify: `packages/rbac/index.js`
- Test: `tests/unit/records-lifecycle.test.js`
- Test: `tests/db/records-postgres.test.js`
- Test: `tests/api/records-http.test.js`

**Interfaces:**
- Produces: `requestCaseClosure(actor, caseId, reason)`, `approveCaseClosure(actor, caseId)`, `markArchiveEligible(actor, caseId)`, `listRecordsQueue(actor, filters)`.
- Lifecycle: operational case -> `CLOSURE_REVIEW` -> `CLOSED` -> `ARCHIVE_ELIGIBLE`; physical archival/export remains outside R3 production integration scope.

- [ ] **Step 1: Write RED tests** requiring court scope, a reason for closure review, independent approval where maker-checker policy applies, and denial when active hearings or non-final judicial work remain.
- [ ] **Step 2: Add records lifecycle tables/evidence** rather than destructive deletion of case content.
- [ ] **Step 3: Implement repository/service transitions** with conditional SQL updates to prevent stale-state races.
- [ ] **Step 4: Add court-scoped records queue HTTP endpoints** and audit every transition/read.
- [ ] **Step 5: Verify targeted tests and full CI GREEN**.

### Task 6: Finance, Notification and Records Workspace UI

**Files:**
- Create: `apps/court-workspace/src/pages/FinanceQueuePage.tsx`
- Create: `apps/court-workspace/src/pages/PaymentDetailPage.tsx`
- Create: `apps/court-workspace/src/pages/NotificationHistoryPage.tsx`
- Create: `apps/court-workspace/src/pages/RecordsQueuePage.tsx`
- Modify: `apps/court-workspace/src/api/client.ts`
- Modify: `apps/court-workspace/src/api/types.ts`
- Modify: Court Workspace router/navigation files.
- Test: page and API client Vitest/Testing Library suites colocated with existing frontend patterns.

**Interfaces:**
- Consumes: R3 read/action HTTP endpoints.
- Produces: server-state-driven operational views; no client-authoritative lifecycle state.

- [ ] **Step 1: Add RED UI tests** for loading/error/empty/success states, court-scoped finance queues, payment evidence, notification status history and records queue actions.
- [ ] **Step 2: Implement typed API client functions** before page components depend on them.
- [ ] **Step 3: Implement pages and navigation** with accessible labels, keyboard-operable controls and disabled/hidden actions derived from server state.
- [ ] **Step 4: Verify frontend tests GREEN** and production build GREEN.

### Task 7: Supabase Test Profile and Transactional R3 Smoke

**Files:**
- Modify: `db/supabase/20260906_dciecms_test_0001_0010.sql` only by creating a new additive R3 Supabase migration file rather than rewriting applied history.
- Create: `db/supabase/20260906_dciecms_test_r3_0011_0013.sql`
- Modify: `services/api/src/postgres-schema-mapping.js`
- Modify: `scripts/live-smoke.js`
- Modify: `.github/workflows/live-supabase-smoke.yml`
- Test: schema mapping and live-smoke configuration tests.

**Interfaces:**
- Maps new logical finance/notifications/records tables to isolated physical `dciecms_test` table names.

- [ ] **Step 1: Write RED schema-mapping tests** for every new R3 table.
- [ ] **Step 2: Add additive Supabase migration** with explicit `dciecms_test` names and browser-role privilege revocation consistent with the existing isolation model.
- [ ] **Step 3: Extend transactional smoke** to verify finance queue/evidence, one internal notification lifecycle, records closure eligibility preconditions, and final `ROLLBACK`.
- [ ] **Step 4: Run live Supabase smoke** only after standard CI is GREEN; diagnose any failure before proceeding.

### Task 8: R3 Final Security, Regression and Release Readiness

**Files:**
- Modify only files proven necessary by RED regression/security tests.
- Update: this plan and PR description with verified evidence.

**Interfaces:**
- Produces: merge candidate only; no deployment.

- [ ] **Step 1: Review complete R3 diff** for cross-court leakage, FIN/FIN-MGR SoD bypass, notification spoofing/delivery self-attestation, mutable delivery history, destructive records behavior, stale-state races and unsafe SQL.
- [ ] **Step 2: Add a failing regression for each confirmed defect** before fixing it.
- [ ] **Step 3: Run full backend suite, Court Workspace suite and production build** on the final feature-branch head.
- [ ] **Step 4: Run the R3 live Supabase transactional smoke** and require GREEN.
- [ ] **Step 5: Open/update the R3 PR as draft** with current evidence and deferred production integrations.
- [ ] **Step 6: Stop at the explicit merge gate.** Do not merge to `main` until the user explicitly approves the R3 PR merge.
