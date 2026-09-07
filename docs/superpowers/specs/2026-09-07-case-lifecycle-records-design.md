# DCIECMS Case Lifecycle & Records Governance — Design

Date: 2026-09-07
Branch: `feat/case-lifecycle-records`
Blueprint alignment: Step 8 Epics 06/08/17 and Step 9 Release R3 / Increment 4

## 1. Purpose

Close the remaining DCIECMS case-lifecycle and records-governance gap without weakening the existing judicial, audit, document, transaction or provider-neutral security boundaries.

This increment covers:

- judicial case disposition;
- controlled case closure;
- controlled case reopening;
- retention-class assignment;
- records archival;
- legal-hold control at the case-record level;
- maker/checker disposal request and approval;
- immutable lifecycle evidence;
- API and audit/outbox integration;
- negative authorization and state-transition tests.

It does **not** physically delete court records, documents or objects. Disposal approval records an authorization decision only. A future, separately approved disposal executor may act on approved requests after policy, legal, security and operational gates are defined.

## 2. Design principles

1. **Judicial decisions remain judicial.** A Records Officer cannot determine judicial disposition or close/reopen a matter.
2. **Records administration remains separate from judicial content authority.** The RECORDS role receives only records-governance permissions, not unrestricted document or judgment access.
3. **No destructive shortcut.** There is no service/repository/HTTP hard-delete path for a case, case record or secure document.
4. **Legal hold is a fail-closed veto.** A held record cannot become disposal-eligible or receive disposal approval.
5. **Maker/checker disposal.** The requester cannot approve the same disposal request.
6. **Immutable history.** Current state is queryable on the case/control row, while lifecycle events and disposal decisions are append-only evidence.
7. **Transactional coupling.** Business mutation, application audit and any domain-event enqueue execute through the existing outer PostgreSQL transaction boundary.
8. **Court scope is enforced server-side.** Every operation re-loads authoritative case/control state and checks actor permission plus case court scope.
9. **Sensitive reasons stay out of generic integration events.** Free-text disposition/closure/reopen/hold/disposal reasons remain authoritative application/audit evidence but are not copied into generic outbox payloads.
10. **Repository-delivered migration only.** Migration `0015` and its isolated Supabase test-profile mapping are committed but not applied to any live database in this increment.

## 3. Authorization model

### 3.1 New role

Add `RECORDS` with narrowly scoped permissions:

- `case.view`
- `records.view`
- `records.retention.assign`
- `records.archive`
- `records.legal_hold.manage`
- `records.disposal.request`

The role does not gain `judgment.*`, `hearing.*`, `document.view`, `case.disposition`, `case.close`, `case.reopen`, or `records.disposal.approve` by default.

### 3.2 Judicial / registry control permissions

- `MAG`: add `case.disposition`; existing assigned-case restriction continues to apply.
- `CMAG`: add `case.disposition`, `case.close`, `case.reopen`, `records.disposal.approve`, `records.view`.
- `REG-MGR`: add `case.close`, `case.reopen`, `records.disposal.approve`, `records.view`.

This keeps disposition with judicial actors while allowing controlled administrative closure/reopening under senior court/registry authority.

### 3.3 Segregation of duties

A disposal request may be approved only when:

- request status is `REQUESTED`;
- the record is still eligible at approval time;
- no legal hold exists;
- approving actor has `records.disposal.approve` in the same court scope;
- approving actor subject differs from `requested_by_subject`.

## 4. Case lifecycle state model

Existing operational states remain authoritative: `AWAITING_ASSIGNMENT`, `ASSIGNED`, and any existing hearing-related compatible state values.

New controlled transitions:

1. **Disposition**
   - allowed from an assigned judicial matter;
   - performed by the assigned MAG or CMAG;
   - requires a normalized `dispositionCode` and a non-empty `reason`;
   - requires no active hearing (`SCHEDULED` or `IN_PROGRESS`);
   - records optional `judgmentId`; when supplied, it must belong to the case and be `ISSUED`;
   - sets current case status to `DISPOSED` and appends lifecycle evidence.

2. **Closure**
   - allowed only from `DISPOSED`;
   - performed by CMAG or REG-MGR with `case.close`;
   - requires a normalized `closureCode` and non-empty reason;
   - sets status `CLOSED` and appends lifecycle evidence;
   - creates or activates a case record-control row if one does not already exist.

3. **Reopen**
   - allowed only from `CLOSED`;
   - performed by CMAG or REG-MGR with `case.reopen`;
   - requires a non-empty reason;
   - returns the case to `AWAITING_ASSIGNMENT` and clears the current assignment fields so the existing assignment workflow is reused;
   - appends lifecycle evidence;
   - invalidates any pending disposal request and makes the case record non-disposable until it is closed again.

Reopening does not erase prior disposition, closure, archival or disposal-request history.

## 5. Records data model

Migration `0015_case_lifecycle_records.sql` will create schema objects additively.

### 5.1 Case current-state fields

Extend `case_mgmt.cases` with server-controlled fields:

- `disposition_code`
- `disposed_by_subject`
- `disposed_at`
- `closure_code`
- `closed_by_subject`
- `closed_at`
- `reopened_by_subject`
- `reopened_at`

Current-state columns support operational queries. Immutable history lives separately.

### 5.2 `case_mgmt.case_lifecycle_events`

Append-only rows:

- `lifecycle_event_id`
- `case_id`
- `court_id`
- `event_type` (`DISPOSED`, `CLOSED`, `REOPENED`)
- `event_code`
- `reason`
- `judgment_id` nullable
- `actor_subject`
- `occurred_at`

Normal application roles receive no DELETE privilege.

### 5.3 `records.case_record_controls`

One current control row per case:

- `case_record_control_id`
- `case_id` unique
- `court_id`
- `status` (`ACTIVE`, `ARCHIVED`, `DISPOSAL_REQUESTED`, `DISPOSAL_APPROVED`)
- `retention_class_code`
- `retention_trigger_at`
- `disposition_eligible_at`
- `archived_at`, `archived_by_subject`
- `legal_hold`
- `legal_hold_reference`
- `legal_hold_reason`
- `legal_hold_set_at`, `legal_hold_set_by_subject`
- `legal_hold_released_at`, `legal_hold_released_by_subject`
- timestamps

Retention eligibility is server-derived from the explicit eligibility date; callers cannot bypass legal hold or case state.

### 5.4 `records.disposal_requests`

Append-only decision trail:

- `disposal_request_id`
- `case_record_control_id`
- `case_id`
- `court_id`
- `status` (`REQUESTED`, `APPROVED`, `REJECTED`, `CANCELLED`)
- `reason`
- `requested_by_subject`, `requested_at`
- `decided_by_subject`, `decided_at`
- `decision_reason`

A partial unique index prevents more than one active `REQUESTED` request for the same case record.

## 6. Service and repository boundaries

Add a focused `case-lifecycle-records-service.js` facade/service rather than expanding the already large persistent/judicial core files.

The service exposes:

- `disposeCase(actor, caseId, input)`
- `closeCase(actor, caseId, input)`
- `reopenCase(actor, caseId, input)`
- `getCaseRecordControl(actor, caseId)`
- `assignRetention(actor, caseId, input)`
- `archiveCaseRecord(actor, caseId)`
- `setCaseLegalHold(actor, caseId, input)`
- `releaseCaseLegalHold(actor, caseId, input)`
- `requestCaseRecordDisposal(actor, caseId, input)`
- `approveCaseRecordDisposal(actor, disposalRequestId, input)`
- `rejectCaseRecordDisposal(actor, disposalRequestId, input)`

Repository implementation is installed as an extension on the existing PostgresRepository, matching secure-document/payment integration composition.

All authoritative transition methods use conditional SQL updates and/or row locks so stale concurrent requests fail with a conflict rather than overwriting state.

## 7. HTTP API

Add authenticated routes:

- `POST /cases/:caseId/disposition`
- `POST /cases/:caseId/close`
- `POST /cases/:caseId/reopen`
- `GET /cases/:caseId/records-control`
- `POST /cases/:caseId/records-control/retention`
- `POST /cases/:caseId/records-control/archive`
- `POST /cases/:caseId/records-control/legal-hold`
- `POST /cases/:caseId/records-control/legal-hold/release`
- `POST /cases/:caseId/records-control/disposal-requests`
- `POST /records/disposal-requests/:requestId/approve`
- `POST /records/disposal-requests/:requestId/reject`

No delete/dispose-execution endpoint is added.

All errors continue to use sanitized 403/404/409/422 mappings and must not disclose cross-court resource existence through a privileged bypass.

## 8. Audit and domain events

Application audit actions:

- `case.dispose`
- `case.close`
- `case.reopen`
- `records.retention.assign`
- `records.archive`
- `records.legal_hold.set`
- `records.legal_hold.release`
- `records.disposal.request`
- `records.disposal.approve`
- `records.disposal.reject`

Generic outbox events:

- `case.disposed`
- `case.closed`
- `case.reopened`
- `records.archived`
- `records.disposal.approved`

Payloads contain identifiers, court ID, state and normalized codes only. Free-text reasons, legal-hold narratives and judicial content are excluded.

## 9. Transaction and failure behavior

Every mutating service method is registered in `MUTATING_SERVICE_METHODS`.

For PostgreSQL runtime:

- transition SQL;
- lifecycle/control/disposal evidence;
- application audit append; and
- outbox enqueue (when emitted)

share the existing request-scoped transaction manager.

If audit or outbox persistence fails, the business transition must roll back. Repository-local transactional helpers must compose with the existing outer transaction rather than commit independently.

## 10. Interaction with secure documents

Case-level records governance does not mutate finalized document bytes or remove secure-document history.

When determining disposal eligibility, the records service must fail closed if any document belonging to the case is under document-level legal hold. Case-level legal hold is an additional veto, not a replacement for document-level hold.

Physical object deletion remains out of scope.

## 11. Test strategy

Implementation follows TDD.

Required test groups:

1. RBAC permission matrix and cross-court denials.
2. Assigned-MAG disposition and unassigned-MAG denial.
3. Active-hearing disposition denial.
4. Optional judgment linkage requires same-case `ISSUED` judgment.
5. `DISPOSED -> CLOSED -> AWAITING_ASSIGNMENT` transition rules.
6. Reopen clears current assignment but preserves lifecycle history.
7. Retention assignment validation and server-derived eligibility.
8. Archive requires closed case.
9. Case and document legal-hold disposal vetoes.
10. Disposal maker/checker enforcement.
11. Duplicate active disposal-request rejection/idempotent conflict behavior.
12. No hard-delete repository/service/HTTP path.
13. Transaction rollback on audit failure.
14. Transaction rollback on outbox failure.
15. Outbox payload minimization.
16. HTTP route/status/error regressions.
17. PostgreSQL repository SQL/state conflict tests.
18. Isolated Supabase test migration/mapping verification.
19. Existing backend, Court Workspace and production frontend build regression.

## 12. Delivery sequence

1. Add failing service/RBAC tests.
2. Add `0015` migration and isolated Supabase test migration.
3. Add repository extension and mapping.
4. Add lifecycle/records service and facade composition.
5. Register mutation methods in transaction wrapper.
6. Add HTTP routes.
7. Add domain-event/audit tests and rollback tests.
8. Update architecture/status/readme documentation.
9. Run full backend + frontend regressions and production build.
10. Open a pull request for review.

## 13. Explicit non-goals / separate gates

This increment does not:

- execute migration `0015` against a live Supabase/database environment;
- configure a production retention schedule without approved PNGMS policy;
- physically destroy or purge any case/document/object;
- deploy to production;
- change government IdP/payment/storage/scanner provider configuration;
- create a permanent records-disposal worker;
- bypass UAT/security/pilot gates in the Steps 1–10 blueprint.
