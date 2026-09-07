# Blueprint R3 Notifications & Enforcement/Follow-up Design

Date: 2026-09-08
Baseline: verified `main` merge commit `0a0be832a6e1c0a31c34dd5d0a35aace6cc05f2f`
Branch: `feat/r3-notifications-enforcement`

## Purpose

Complete the remaining functional Blueprint R3 notification and enforcement/follow-up repository scope without activating a real SMS/email provider or a production scheduler.

The increment must preserve DCIECMS principles already established in earlier releases: deny-by-default RBAC, server-side court scope, segregation of duties where decisions are sensitive, immutable history, transaction-coupled audit/outbox evidence, provider-neutral boundaries and fail-closed production integration.

## Scope

### In scope

1. Governed email/SMS notification templates.
2. Durable case-scoped notification intents.
3. Recipient references rather than raw destination addresses/numbers in the core notification queue.
4. Provider-neutral notification-delivery adapter seam.
5. Retry/lease/dead-letter persistence for notification delivery.
6. Append-only delivery-attempt evidence.
7. Case enforcement/follow-up tasks.
8. Reminder and escalation timing.
9. Overdue follow-up queue.
10. Append-only follow-up history.
11. Internal scheduler/worker seams that can process reminder/escalation and notification delivery when explicitly hosted.
12. Court Workspace review/management surfaces.
13. HTTP APIs, RBAC, audit, outbox and isolated Supabase test mapping.

### Explicitly out of scope

- real SMTP/SMS credentials or provider activation;
- production recipient directory/contact-resolution integration;
- automatic permanent worker scheduling in production;
- browser-controlled provider success/failure results;
- storing provider secrets or raw message destination endpoints in generic outbox payloads;
- destructive deletion of notification or follow-up evidence;
- production deployment or live Supabase migration.

## Security model

### Recipient privacy

A notification intent stores a stable `recipient_type` and `recipient_ref` (for example `PARTY`, `USER`, or `ROLE`) rather than a raw email address or mobile number. A future approved contact-resolution adapter resolves the reference at delivery time. This avoids duplicating sensitive contact data in queue/outbox records and keeps provider routing external to the domain model.

### Message content

Templates contain approved reusable content. Per-intent payload is a bounded JSON object of rendering variables; generic outbox events contain only normalized identifiers/state, never rendered body text, raw destinations or provider secrets.

### Court scope

Every case-linked notification and follow-up task obtains court scope from the canonical case record. Client-supplied court IDs are ignored or rejected. Direct identifiers are re-authorized before data is returned or mutated.

## RBAC

New permissions:

- `notification.view`
- `notification.create`
- `notification.template.manage`
- `followup.view`
- `followup.create`
- `followup.complete`
- `followup.cancel`
- `followup.escalate`

Role allocation:

- `REG`: notification view/create; follow-up view/create/complete.
- `REG-MGR`: all REG permissions plus template management, follow-up cancel/escalate.
- `CMAG`: notification view/create; follow-up view/create/complete/cancel/escalate.
- `MAG`: notification/follow-up view for assigned matters and follow-up completion where the service confirms current assignment.
- `SEC`, `ICT-ADMIN`, `RECORDS`, finance roles: no implicit notification-content or follow-up authority unless an existing business role also grants it.

## Persistence

Migration `0017_r3_notifications_enforcement.sql` adds schema `notifications` and follow-up structures under `case_mgmt`.

### `notifications.templates`

Fields include:

- `template_id`
- `template_code`
- `channel` (`EMAIL`, `SMS`)
- `locale`
- optional subject template
- body template
- status (`DRAFT`, `ACTIVE`, `RETIRED`)
- creator/activation/retirement subjects and timestamps

Only one ACTIVE template may exist for the same code/channel/locale. Activation is state conditional and overlap-safe.

### `notifications.intents`

Fields include:

- `intent_id`
- `court_id`
- optional `case_id`
- `template_id`
- `recipient_type`
- `recipient_ref`
- channel
- bounded JSON render variables
- status (`QUEUED`, `LEASED`, `SENT`, `FAILED`, `DEAD`, `CANCELLED`)
- scheduled/available time
- attempt count / lease fields
- creator/timestamps
- final delivery timestamp and normalized last error code

No raw destination address/phone is required in this table.

### `notifications.delivery_attempts`

Append-only evidence:

- attempt ID
- intent ID
- attempt number
- adapter/provider code
- normalized status/error code
- attempted timestamp

No message body, raw destination or secret is recorded.

### `case_mgmt.follow_up_tasks`

Fields include:

- task ID
- court ID and case ID
- stable task type
- priority
- due timestamp
- optional reminder timestamp
- optional escalation timestamp
- status (`OPEN`, `COMPLETED`, `CANCELLED`)
- escalation level
- optional assigned subject or assigned role
- bounded operational note
- creator/completer/canceller subjects and timestamps

### `case_mgmt.follow_up_events`

Append-only history for creation, reminder, escalation, completion and cancellation. Generic outbox payloads do not include the free-text operational note.

## Domain behavior

### Template lifecycle

`DRAFT -> ACTIVE -> RETIRED`; retired templates cannot be reactivated in place. A new version is created instead.

### Notification creation

An authorized actor selects an ACTIVE template and a stable recipient reference for a case. Service derives court scope from the case, validates channel/template match, bounds rendering variables, persists a QUEUED intent, audit evidence and a minimized outbox event transactionally.

### Notification delivery worker

A worker claims due intents with bounded leasing and `SKIP LOCKED`, calls an injected provider-neutral adapter, and records an append-only attempt. Success transitions to SENT; retryable failure increments attempts and reschedules; terminal failure transitions to DEAD. Production runtime fails closed if no approved adapter is injected.

There is no public HTTP endpoint that asserts provider delivery success.

### Follow-up creation

Authorized users create a stable task type against a canonical case. Due/reminder/escalation timestamps are validated and court scope is derived server side. Creation records an append-only event and audit/outbox evidence.

### Completion/cancellation

Only OPEN tasks transition. Completion/cancellation records actor/time and append-only history. Cancellation requires manager-level authority. Repeated terminal transitions return conflict rather than rewriting history.

### Reminder/escalation worker

A scheduler seam finds OPEN tasks whose reminder/escalation timestamps are due. It records an idempotent event and may create a notification intent targeted at the assigned subject/role using configured internal templates. Escalation increments level and records evidence. No permanent production schedule is enabled by source code alone.

## HTTP API

Template routes:

- `POST /notifications/templates`
- `GET /notifications/templates`
- `GET /notifications/templates/:templateId`
- `POST /notifications/templates/:templateId/activate`
- `POST /notifications/templates/:templateId/retire`

Notification routes:

- `POST /cases/:caseId/notifications`
- `GET /cases/:caseId/notifications`
- `GET /notifications/queue`

Follow-up routes:

- `POST /cases/:caseId/follow-ups`
- `GET /cases/:caseId/follow-ups`
- `GET /follow-ups/overdue`
- `POST /follow-ups/:taskId/complete`
- `POST /follow-ups/:taskId/cancel`
- `POST /follow-ups/:taskId/escalate`

No destructive DELETE routes and no route for browser/provider delivery confirmation.

## Audit and outbox

Audit actions include:

- `notification.template.create|activate|retire`
- `notification.intent.create|queue.view`
- `notification.delivery.sent|failed|dead`
- `case.follow_up.create|view|complete|cancel|escalate|remind`

Outbox event types include normalized identifiers/state only:

- `notification.intent.queued`
- `notification.intent.sent`
- `notification.intent.dead`
- `case.follow_up.created`
- `case.follow_up.completed`
- `case.follow_up.cancelled`
- `case.follow_up.escalated`

Rendered message content, contact endpoints, operational notes and provider errors beyond stable codes are excluded from generic outbox payloads.

## Court Workspace

Add an operations surface that allows authorized users to:

- review case notification history/status;
- create a notification intent from an ACTIVE template and recipient reference;
- review open/overdue follow-up tasks;
- create, complete, cancel or escalate tasks according to role;
- see reminder/escalation state without presenting provider delivery controls.

The UI never becomes the authority boundary.

## Transaction guarantees

All API mutations and audited queue reads use the shared outer PostgreSQL transaction manager. Business state, audit and outbox commit together where an outbox event is emitted. Worker state transitions and their delivery/follow-up evidence also use one transaction.

## Migration / deployment boundary

Migration `0017` and its `dciecms_test` Supabase translation are repository-delivered only. No live migration, provider credential activation, worker scheduling or production deployment is performed under this increment.

## Verification

TDD must prove:

- role permissions and assigned-MAG restrictions;
- court-scope denial for direct identifiers and queues;
- active-template and channel validation;
- no raw destination/provider secret in intent/outbox models;
- idempotent worker leasing/retry/dead-letter behavior;
- append-only attempt/follow-up history;
- OPEN-only follow-up completion/cancellation/escalation;
- reminder/escalation idempotency;
- audit/outbox transaction rollback;
- no destructive/delivery-confirmation HTTP routes;
- isolated Supabase `0017` mapping;
- Court Workspace authorized controls and absence of provider-delivery controls;
- exact-head backend/frontend/build CI before merge and exact merge-commit CI after merge.
