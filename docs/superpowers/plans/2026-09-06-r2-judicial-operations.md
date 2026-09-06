# DCIECMS R2 Judicial Operations Implementation Plan

## Objective
Extend the verified R0/R1 baseline into the first judicial operations release without weakening court scope, RBAC, auditability, concurrency controls or server-authoritative workflow state.

## Delivery order
1. Case assignment and judicial work queue
2. Hearing scheduling, rescheduling and adjournment
3. Daily list and hearing-mode workflow
4. Proceeding record and outcome capture
5. Judgment/order drafting, review, signing and issuance
6. Judicial Workbench UI
7. Regression, security and accessibility hardening

## Task 1 — Case assignment and judicial work queue
### RED
- CMAG may assign an opened case to a MAG within the same court scope.
- MAG may not assign cases.
- Cross-court assignment is denied.
- Duplicate/stale assignment returns a conflict rather than silently overwriting judicial responsibility.
- Assigned MAG can list only cases assigned to that subject and within court scope.

### GREEN
- Add repository contract for `getCase`, `assignCase` and `listAssignedCases`.
- Add persistent service methods `assignCase` and `listMyCases`.
- Add permissions `case.assign` for CMAG and `case.view` for judicial roles only as already defined.
- Add HTTP routes `POST /cases/:id/assign` and `GET /judicial/my-cases`.
- Add migration for assignment metadata only if the existing case table does not already contain the required columns.
- Write append-only audit evidence for assignment and judicial queue access.

## Task 2 — Hearing scheduling and adjournment
- Introduce hearing entity, courtroom/court scope, scheduled start/end, hearing type and status.
- CMAG/MAG scheduling authority governed by explicit permission.
- Prevent cross-court scheduling and invalid case state transitions.
- Adjournment requires reason, next-date handling and immutable history.
- HTTP: create hearing, list daily list, adjourn hearing.

## Task 3 — Hearing mode and proceeding record
- Hearing start/complete controls.
- Participants, appearances and proceeding notes/record references.
- Server timestamps and actor identity.
- No client-created judicial outcome state.

## Task 4 — Judgment and order lifecycle
- Draft -> review -> signed -> issued.
- Signed/issued records immutable; corrections use controlled superseding version/evidence.
- MAG signs own judicial decision; administrative users cannot sign.
- Court scope and assigned-case access enforced.

## Task 5 — Judicial Workbench UI
- My Cases
- Daily Hearings
- Case Workspace judicial panel
- Hearing Mode
- Pending Decisions
- Judgment/Order workspace
- Accessible keyboard-first interaction and server-derived state.

## Verification gates
Every behavioral change follows RED -> verify RED -> GREEN -> full regression. GitHub Actions must pass backend tests, Court Workspace tests and production build before each milestone is considered complete. No production deployment is part of R2 implementation.