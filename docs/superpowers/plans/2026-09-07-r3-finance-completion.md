# Blueprint R3 Finance Completion — Implementation Plan

Branch: `feat/r3-finance-completion`
Baseline: `f749761a609c2ac49d477e051497dd3963a20bfd`
Design: `docs/superpowers/specs/2026-09-07-r3-finance-completion-design.md`

## Task 1 — RBAC and contract RED/GREEN

Add tests for:
- FIN request/view authority only;
- FIN-MGR approval/completion authority;
- no self-approval of refunds or sensitive adjustments;
- SEC-ADMIN/ICT-ADMIN receive no implicit finance authority.

Implement only the required permission additions after a verified RED run.

## Task 2 — Migration 0016 and repository persistence

TDD the additive schema for:
- `finance.fee_schedules`;
- `finance.payment_adjustments`;
- `finance.refund_requests`;
- reconciliation exception/finalization support;
- database immutability for finalized reconciliation evidence.

Repository operations must use conditional SQL transitions, locks for competing refund requests/decisions, integer minor units and court identifiers from authoritative rows.

## Task 3 — Finance completion service/facade

Implement governed service methods for:
- fee schedule create/activate/retire/list;
- adjustment request/get/approve/reject;
- refund request/get/approve/reject/complete;
- reconciliation reject and exception list.

Enforce maker/checker, court scope, cumulative refund ceiling, validation and minimized outbox payloads.

## Task 4 — Transaction coupling

Register every mutation and audit-writing read operation with the outer PostgreSQL transaction boundary as required. Add rollback regressions for audit and outbox failures.

## Task 5 — HTTP API

Add only the routes defined in the design. Add negative API tests proving there are no destructive payment/receipt/refund/adjustment/reconciliation DELETE endpoints and no endpoint that invokes a live provider refund operation.

## Task 6 — Concurrency and security hardening

Tests must cover:
- cross-court direct-ID attacks;
- same-user maker/checker denial;
- two competing refunds cannot exceed the confirmed payment amount;
- concurrent approve/complete state safety;
- finalized reconciliation cannot be UPDATEd/DELETEd;
- sensitive reason/provider material excluded from outbox;
- original confirmed payment and issued receipt monetary evidence remains unchanged.

## Task 7 — Isolated Supabase test mapping

Create isolated `dciecms_test` migration equivalent to logical `0016`. Update schema mapping and regression tests. Do not apply either migration to a live database.

## Task 8 — Court Workspace finance workbench

Complete role-scoped finance UI for:
- collections/payment status;
- refund request/approval queue;
- reconciliation exception queue;
- high-risk confirmation/reason dialogs;
- maker/checker state visibility.

UI authority is advisory only; APIs remain authoritative.

## Task 9 — Documentation and full verification

Update:
- `docs/architecture/IMPLEMENTATION_STATUS.md` to record PR #13 merged and finance candidate status;
- README finance scope;
- migration mapping notes.

Run exact-head CI:
- complete backend test suite;
- Court Workspace tests;
- production frontend build.

Perform final security/diff review, open PR to `main`, re-run PR CI, merge only when exact head is green, then verify post-merge main CI.

## Explicit non-goals / separate production gates

- no live migration execution;
- no real refund gateway API activation;
- no merchant/bank credential configuration;
- no production deployment;
- no operational fee schedule values invented by engineering.
