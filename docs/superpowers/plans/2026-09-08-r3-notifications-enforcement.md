# Blueprint R3 Notifications & Enforcement/Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver governed provider-neutral email/SMS notification intents plus durable case enforcement/follow-up, reminder and escalation workflows without activating live providers or production scheduling.

**Architecture:** Add migration `0017` with a notification schema and case follow-up tables, then layer focused PostgreSQL repositories, domain services/facades, shared transaction wrappers, governed HTTP routes and worker seams. Notification records use recipient references rather than raw contact endpoints; workers are adapter-driven and fail closed in production when no approved adapter is configured.

**Tech Stack:** Node.js CommonJS backend, PostgreSQL, existing DCIECMS RBAC/audit/outbox/transaction infrastructure, Node test runner, React/TypeScript Court Workspace, isolated `dciecms_test` Supabase profile.

**Spec:** `docs/superpowers/specs/2026-09-08-r3-notifications-enforcement-design.md`

## Global Constraints

- No live SMTP/SMS credentials, provider activation, production worker scheduling or production deployment.
- Court scope is derived from canonical records and enforced server side.
- Notification intents store recipient references, not raw phone/email destinations.
- Rendered message text, destinations, provider secrets and free-text follow-up notes must not appear in generic outbox payloads.
- No destructive delete routes or browser/provider delivery-confirmation endpoint.
- Migration `0017` is repository-delivered only and must not be live-applied.
- Use TDD RED → GREEN for every implementation task.

---

### Task 1: RBAC contracts

**Files:**
- Modify: `packages/rbac/index.js`
- Create: `tests/unit/r3-notifications-enforcement-rbac.test.js`

**Interfaces:**
- Produces permissions `notification.view`, `notification.create`, `notification.template.manage`, `followup.view`, `followup.create`, `followup.complete`, `followup.cancel`, `followup.escalate`.

- [ ] **Step 1: Write failing role-contract tests**

Test that `REG` can view/create notifications and view/create/complete follow-ups; `REG-MGR` additionally manages templates and can cancel/escalate; `CMAG` receives governed notification/follow-up authorities; `SEC`, `ICT-ADMIN`, `RECORDS` and standalone finance roles do not receive them implicitly.

```js
assert.equal(hasPermission(reg,'notification.create'), true);
assert.equal(hasPermission(regMgr,'notification.template.manage'), true);
assert.equal(hasPermission(sec,'notification.create'), false);
```

- [ ] **Step 2: Run `npm test -- tests/unit/r3-notifications-enforcement-rbac.test.js` and verify RED.**
- [ ] **Step 3: Add only the required permission grants to `packages/rbac/index.js`.**
- [ ] **Step 4: Run the targeted test and full backend suite; verify GREEN.**
- [ ] **Step 5: Commit `feat: add R3 notification and follow-up RBAC`.**

### Task 2: Migration and PostgreSQL persistence

**Files:**
- Create: `db/migrations/0017_r3_notifications_enforcement.sql`
- Create: `services/api/src/postgres-notifications-enforcement-repository.js`
- Modify: `services/api/src/postgres-repository.js`
- Create: `tests/unit/r3-notifications-enforcement-postgres.test.js`

**Interfaces:**
- Produces repository methods:
  - `createNotificationTemplate`, `listNotificationTemplates`, `getNotificationTemplate`, `activateNotificationTemplate`, `retireNotificationTemplate`
  - `createNotificationIntent`, `listCaseNotificationIntents`, `listNotificationQueue`, `claimNotificationIntents`, `recordNotificationDeliverySuccess`, `recordNotificationDeliveryFailure`
  - `createFollowUpTask`, `listCaseFollowUps`, `listOverdueFollowUps`, `getFollowUpTask`, `completeFollowUpTask`, `cancelFollowUpTask`, `escalateFollowUpTask`, `recordFollowUpReminder`

- [ ] **Step 1: Write RED persistence tests** proving required tables/constraints, append-only attempt/event evidence, `SKIP LOCKED` claims, state-conditional transitions and absence of `DROP TABLE`/`DELETE FROM`.
- [ ] **Step 2: Run targeted tests and verify missing migration/repository methods fail.**
- [ ] **Step 3: Add migration `0017` with `notifications.templates`, `notifications.intents`, `notifications.delivery_attempts`, `case_mgmt.follow_up_tasks`, `case_mgmt.follow_up_events`, indexes and immutability/revoke controls.**
- [ ] **Step 4: Implement parameterized repository SQL and install it from `postgres-repository.js`.**
- [ ] **Step 5: Verify targeted persistence tests and full backend suite GREEN.**
- [ ] **Step 6: Commit `feat: add notification and follow-up persistence`.**

### Task 3: Domain services and facades

**Files:**
- Create: `services/api/src/notifications-enforcement-service.js`
- Create: `services/api/src/notifications-enforcement-facade.js`
- Modify: `services/api/src/persistent-dciecms-service.js`
- Modify: `services/api/src/runtime-service.js`
- Create: `tests/unit/r3-notifications-enforcement-service.test.js`

**Interfaces:**
- Service methods:
  - `createNotificationTemplate(actor,input)`
  - `listNotificationTemplates(actor,input)`
  - `getNotificationTemplate(actor,id)`
  - `activateNotificationTemplate(actor,id)`
  - `retireNotificationTemplate(actor,id)`
  - `createCaseNotification(actor,caseId,input)`
  - `listCaseNotifications(actor,caseId)`
  - `listNotificationQueue(actor,input)`
  - `createFollowUp(actor,caseId,input)`
  - `listCaseFollowUps(actor,caseId)`
  - `listOverdueFollowUps(actor,input)`
  - `completeFollowUp(actor,taskId,input)`
  - `cancelFollowUp(actor,taskId,input)`
  - `escalateFollowUp(actor,taskId,input)`

- [ ] **Step 1: Write RED service tests** for validation, active-template/channel checks, recipient-reference bounds, case-derived court scope, assigned-MAG restrictions, OPEN-only follow-up transitions and minimized outbox payloads.
- [ ] **Step 2: Run targeted tests and verify RED.**
- [ ] **Step 3: Implement service with existing `authorize`, `ValidationError`, `ConflictError`, `NotFoundError` and audit/outbox patterns.**
- [ ] **Step 4: Install facade and instantiate the service only at PostgreSQL runtime, following the case-lifecycle/finance pattern.**
- [ ] **Step 5: Verify targeted and full backend suites GREEN.**
- [ ] **Step 6: Commit `feat: add notification and follow-up services`.**

### Task 4: Transaction boundary and HTTP API

**Files:**
- Modify: `services/api/src/transactional-service.js`
- Modify: `services/api/src/http-app.js`
- Create: `tests/api/r3-notifications-enforcement-http.test.js`
- Modify: transaction-regression tests as required by the existing method registry.

**Interfaces:**
- HTTP routes exactly as specified in the design; no DELETE routes and no delivery-confirmation route.

- [ ] **Step 1: Add RED HTTP tests for all template, case-notification and follow-up routes plus negative destructive/provider-confirmation routes.**
- [ ] **Step 2: Add RED transaction-registry tests for every mutation and audited queue read.**
- [ ] **Step 3: Register service methods in the shared outer transaction wrapper.**
- [ ] **Step 4: Wire routes using existing actor resolution/error mapping and status conventions (`201` for creation, `200` for reads/transitions).**
- [ ] **Step 5: Run targeted HTTP/transaction tests and full backend suite GREEN.**
- [ ] **Step 6: Commit `feat: expose governed notification and follow-up API`.**

### Task 5: Provider-neutral workers and reminder/escalation scheduler seams

**Files:**
- Create: `services/api/src/notification-delivery-worker.js`
- Create: `services/api/src/follow-up-scheduler-worker.js`
- Create: `tests/unit/r3-notification-worker.test.js`
- Create: `tests/unit/r3-follow-up-scheduler.test.js`

**Interfaces:**
- `NotificationDeliveryWorker.runBatch({ limit })`
- Adapter contract `deliver({ intent, template, recipientRef, recipientType, renderVariables }) -> { providerCode, outcome, errorCode? }`
- `FollowUpSchedulerWorker.runBatch({ limit })`

- [ ] **Step 1: Write RED tests** for bounded leases, retry rescheduling, dead-letter transition, append-only attempts, missing production adapter fail-closed behavior and no raw provider destination persisted.
- [ ] **Step 2: Write RED reminder/escalation tests** proving idempotent reminder events and one-level-at-a-time escalation for due OPEN tasks.
- [ ] **Step 3: Implement delivery worker with injected adapter only; no embedded provider credentials.**
- [ ] **Step 4: Implement follow-up scheduler that calls repository/service seams and creates internal notification intents only through the domain service/repository boundary.**
- [ ] **Step 5: Run targeted and full backend suites GREEN.**
- [ ] **Step 6: Commit `feat: add notification and follow-up worker seams`.**

### Task 6: Court Workspace operations UI

**Files:**
- Modify: `apps/court-workspace/src/api/types.ts`
- Modify: `apps/court-workspace/src/api/client.ts`
- Create: `apps/court-workspace/src/pages/OperationsPage.tsx`
- Modify application navigation/routing file(s) discovered from current main.
- Create/modify Court Workspace tests under `apps/court-workspace/src`.

**Interfaces:**
- typed clients for template listing, case notification history/create, follow-up history/create/complete/cancel/escalate and overdue queue.

- [ ] **Step 1: Write RED client tests** proving payloads contain recipient references and stable template IDs but no provider delivery result/destination field.
- [ ] **Step 2: Write RED page tests** for notification history, follow-up/overdue queues, manager-only controls and absence of provider-send/delivery-confirm buttons.
- [ ] **Step 3: Implement typed client methods.**
- [ ] **Step 4: Implement `OperationsPage` and route/navigation entry following existing accessibility/status patterns.**
- [ ] **Step 5: Run Court Workspace tests and production build GREEN.**
- [ ] **Step 6: Commit `feat: add notifications and follow-up workspace`.**

### Task 7: Isolated Supabase mapping and security regressions

**Files:**
- Create: `db/supabase/20260908_dciecms_test_0017.sql`
- Modify Supabase migration mapping/profile files discovered from current main.
- Create/modify security/domain-event/transaction tests.

**Interfaces:**
- logical `0017` tables mapped into `dciecms_test`; no live apply.

- [ ] **Step 1: Write RED isolated-migration mapping test for every new logical table and immutability control.**
- [ ] **Step 2: Add RED security regressions** for cross-court identifiers, forbidden roles, outbox content minimization, audit/outbox rollback and no hard-delete/provider-delivery-confirmation path.
- [ ] **Step 3: Add isolated test-profile migration only; do not execute against live Supabase.**
- [ ] **Step 4: Correct any security regressions using minimal code changes.**
- [ ] **Step 5: Run full backend/frontend/build verification GREEN.**
- [ ] **Step 6: Commit `test: harden R3 notifications and follow-up`.**

### Task 8: Documentation, PR, merge and post-merge verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`

- [ ] **Step 1: Document delivered R3 notification/follow-up boundary and migration `0017`, explicitly retaining provider/live-migration exclusions.**
- [ ] **Step 2: Run exact-head full CI and confirm backend, Court Workspace tests and production build all pass.**
- [ ] **Step 3: Perform final PR diff/security review for RBAC, court scope, PII leakage, provider impersonation, transaction/audit/outbox coupling, worker leasing and destructive routes.**
- [ ] **Step 4: Open PR against `main` with exact-head evidence and explicit non-actions.**
- [ ] **Step 5: Merge only if exact head is green and review finds no blocker.**
- [ ] **Step 6: Verify the exact merge commit on `main` through GitHub Actions before declaring the increment complete.**
