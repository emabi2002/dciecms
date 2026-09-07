# Blueprint R3 Finance Completion — Design

Date: 2026-09-07
Branch: `feat/r3-finance-completion`
Baseline: `main` merge commit `f749761a609c2ac49d477e051497dd3963a20bfd`

## 1. Purpose

Complete the remaining functional Blueprint R3 finance capability without activating a live payment/refund provider.

The existing baseline already delivers fee assessment, payment creation/confirmation, receipt issuance, maker/checker reconciliation, provider callback hardening and payment integration controls. The remaining blueprint finance gap is:

- configurable fee schedules and controlled exemption/waiver decisions;
- governed payment/fee adjustments;
- refund request, independent approval/rejection and provider-neutral completion evidence;
- reconciliation exceptions and controlled rejection/remediation;
- immutable finalized financial evidence;
- finance workbench read models needed for collections, pending/failed payments, refunds and reconciliation exceptions.

## 2. Governing principles

1. **Money is never silently rewritten.** Financial corrections are linked adjustment/refund records, not destructive edits.
2. **Maker/checker is mandatory.** A requester/initiator cannot approve the same sensitive adjustment or refund.
3. **Court scope is server-side.** Every read and mutation derives and enforces the authoritative court from persisted data.
4. **Provider execution is separated from governance approval.** Repository code can record an approved refund and a provider-neutral completion reference, but this increment does not activate a real merchant/gateway refund API.
5. **Receipts and finalized reconciliations remain immutable evidence.** Corrections are separate linked records/events.
6. **Audit and outbox are transaction-coupled.** Financial mutation, audit and domain-event persistence commit or roll back together.
7. **Free-text reasons are evidentiary audit data, not generic integration payload data.**
8. **All monetary values are integer minor units plus ISO-style 3-letter currency codes.** No floating-point money.
9. **No production migration execution.** New migration(s) are repository-delivered and isolated-test mapped only until a separate live gate.

## 3. Roles and permissions

### FIN
Existing ordinary finance operations remain. Add:

- `finance.adjustment.request`
- `finance.refund.request`
- `finance.refund.view`
- `finance.reconciliation.exception.view`

FIN does **not** approve its own adjustment/refund.

### FIN-MGR
Add:

- `finance.fee_schedule.manage`
- `finance.adjustment.request`
- `finance.adjustment.approve`
- `finance.refund.request`
- `finance.refund.approve`
- `finance.refund.complete`
- `finance.refund.view`
- `finance.reconciliation.reject`
- `finance.reconciliation.exception.view`

FIN-MGR remains subject to maker/checker: initiating a sensitive adjustment or refund removes authority to decide that same item.

### SEC-ADMIN / ICT-ADMIN
No finance authority is added by default.

## 4. Fee schedules and waivers

### 4.1 Fee schedule

Add `finance.fee_schedules` with:

- `fee_schedule_id`
- `court_id` nullable only where a nationally applicable schedule is explicitly supported
- `case_type_code`
- `fee_code`
- `description`
- `amount_minor`
- `currency`
- `effective_from`
- `effective_to`
- `status` (`DRAFT`, `ACTIVE`, `RETIRED`)
- creator/publisher evidence

Only one applicable ACTIVE schedule row may govern the same court/case type/fee code/effective period.

### 4.2 Assessment source

New assessments should be able to reference a fee schedule row. Existing manually-entered assessment compatibility remains for migration/backward compatibility, but governed API/UI paths should prefer configured schedules.

### 4.3 Exemption/waiver

Do not mutate an assessed amount to zero without evidence. Add a financial adjustment decision with type:

- `WAIVER`
- `EXEMPTION`
- `CORRECTION`
- `OTHER_ADJUSTMENT`

A waiver/exemption/correction contains original amount, proposed delta/new amount, reason, requester, decision evidence and timestamps.

## 5. Payment adjustments

Add `finance.payment_adjustments` as the authoritative linked correction ledger.

Representative fields:

- `adjustment_id`
- `assessment_id`
- optional `payment_id`
- `court_id`
- `adjustment_type`
- `amount_delta_minor`
- `currency`
- `status` (`REQUESTED`, `APPROVED`, `REJECTED`, `APPLIED`, `CANCELLED`)
- `reason`
- `requested_by_subject`, `requested_at`
- `decided_by_subject`, `decided_at`, `decision_reason`
- `applied_at`

Controls:

- requester cannot approve/reject same adjustment;
- currency must match affected assessment/payment;
- resulting payable amount cannot be negative;
- a confirmed/refunded payment is not retrospectively rewritten;
- adjustments after confirmed payment normally lead to refund/additional-payment workflow rather than changing historical payment evidence.

## 6. Refund workflow

Add `finance.refund_requests`.

States:

`REQUESTED -> APPROVED -> COMPLETED`

or

`REQUESTED -> REJECTED`

with controlled cancellation only before approval where justified.

Representative fields:

- `refund_request_id`
- `payment_id`
- `court_id`
- `amount_minor`
- `currency`
- `reason`
- `status`
- requester/decision evidence
- `provider_reference` / `provider_refund_reference` only when completion is recorded
- `completed_by_subject`, `completed_at`

Rules:

- source payment must be `CONFIRMED`;
- requested cumulative refunds must never exceed confirmed payment amount;
- requester cannot approve/reject same request;
- approved amount is immutable;
- completion requires APPROVED state and a provider-neutral external/refund reference;
- when cumulative completed refund equals the confirmed payment amount, payment status may transition to `REFUNDED`; partial refunds retain confirmed-payment history and are derived from refund ledger totals rather than overwriting the original amount;
- no live provider API call is implemented in this increment.

## 7. Reconciliation completion

The current baseline supports PREPARED -> CERTIFIED maker/checker. Complete the blueprint by adding:

- manager rejection with reason (`PREPARED -> REJECTED`);
- exception classification and exception notes/evidence;
- controlled re-preparation via a new linked reconciliation record rather than rewriting a finalized one;
- finalized (`CERTIFIED`/`REJECTED`) rows protected against UPDATE/DELETE by database trigger;
- query/read model for outstanding reconciliation exceptions.

## 8. HTTP API

Proposed governed endpoints:

### Fee schedules
- `GET /finance/fee-schedules`
- `POST /finance/fee-schedules`
- `POST /finance/fee-schedules/:id/activate`
- `POST /finance/fee-schedules/:id/retire`

### Adjustments
- `POST /finance/assessments/:assessmentId/adjustments`
- `GET /finance/adjustments/:adjustmentId`
- `POST /finance/adjustments/:adjustmentId/approve`
- `POST /finance/adjustments/:adjustmentId/reject`

### Refunds
- `POST /finance/payments/:paymentId/refunds`
- `GET /finance/refunds/:refundRequestId`
- `POST /finance/refunds/:refundRequestId/approve`
- `POST /finance/refunds/:refundRequestId/reject`
- `POST /finance/refunds/:refundRequestId/complete`

### Reconciliation
- `POST /finance/reconciliations/:reconciliationId/reject`
- `GET /finance/reconciliation-exceptions`

No endpoint directly deletes a receipt, payment, refund, adjustment or finalized reconciliation.

## 9. Audit actions

- `finance.fee_schedule.create`
- `finance.fee_schedule.activate`
- `finance.fee_schedule.retire`
- `finance.adjustment.request`
- `finance.adjustment.approve`
- `finance.adjustment.reject`
- `finance.refund.request`
- `finance.refund.approve`
- `finance.refund.reject`
- `finance.refund.complete`
- `finance.reconciliation.reject`
- `finance.reconciliation.exception.view`

Audit may include free-text reasons because it is authoritative evidence.

## 10. Domain events

Minimized events may include:

- `finance.adjustment.approved`
- `finance.refund.approved`
- `finance.refund.completed`
- `finance.reconciliation.rejected`

Payloads contain identifiers, court, normalized type/status, monetary minor units and currency only. They exclude free-text reasons, provider secrets and raw callback bodies.

## 11. Database migration

Use logical migration `0016_r3_finance_completion.sql` and an isolated `dciecms_test` translation.

The migration must be additive/backward-compatible and must not be represented as live-applied.

## 12. Security/TDD acceptance

Tests must prove at minimum:

- cross-court denial before finance data exposure;
- FIN cannot approve/refuse its own refund or sensitive adjustment;
- FIN-MGR requester cannot decide same item;
- over-refund is impossible, including concurrent competing requests;
- payment/receipt original amounts are not destructively changed;
- finalized reconciliation immutability is database-enforced;
- audit failure rolls back finance mutation;
- outbox failure rolls back finance mutation/audit;
- free-text reasons never leak to generic outbox;
- all money validation is integer minor units and currency-safe;
- isolated Supabase mapping never touches live schemas;
- no delete route or live provider refund execution is present.

## 13. Production exclusions

Separate explicit gates remain required for:

- applying migration `0016` to any live Supabase/PostgreSQL environment;
- real payment-gateway refund API credentials and merchant configuration;
- settlement/bank reconciliation integrations;
- real production deployment;
- operational finance policy values such as approved fee schedules, waiver authority thresholds and refund limits.
