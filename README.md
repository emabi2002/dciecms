# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## Current implementation status

PR #1 contains the first executable R0/R1 vertical slice and remains pre-merge.

Implemented on `feat/first-vertical-slice`:
- normalized development identity claims and deny-by-default RBAC/court scope
- party creation and filing drafts
- controlled case-type validation
- secure document registration in `QUARANTINED` state with SHA-256 validation
- idempotent filing submission
- court-scoped Registry queue
- Registry validation workflow task creation/completion
- HTTP endpoints for Registry tasks and filing validation
- append-only application audit evidence
- PostgreSQL baseline/config/workflow migrations
- parameterized PostgreSQL repository contract
- bounded PostgreSQL pool runtime configuration through `DATABASE_URL`
- GitHub Actions CI on Node.js 20 with runtime dependency installation and full test execution

## Important security boundary

The `x-dev-*` request headers are development-only scaffolding. They are **not production authentication**. Production must use validated identity claims from the approved IdP/API gateway and must preserve the RBAC, scope, record and confidentiality checks defined in the DCIECMS security baseline.

Real object storage, malware scanning, payment, notifications, government-agency integrations and production hosting credentials are intentionally not fabricated.
