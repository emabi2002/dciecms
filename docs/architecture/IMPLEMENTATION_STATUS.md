# DCIECMS Implementation Status

## Branch
`feat/first-vertical-slice`

## Delivered in PR #1

The first executable R0/R1 slice now covers:

- development identity claim normalization
- deny-by-default RBAC and court scoping
- party creation
- filing draft creation
- controlled case-type validation
- secure document registration in quarantine with SHA-256 checksum validation
- idempotent filing submission
- court-scoped Registry queue
- Registry validation workflow task creation and completion
- filing transition from `SUBMITTED` to `VALIDATED`
- persisted validation evidence fields in PostgreSQL schema
- HTTP endpoints for workflow task listing and filing validation
- append-only application audit evidence
- PostgreSQL baseline and R0/R1 configuration/workflow migrations
- parameterized `PostgresRepository` contract
- bounded PostgreSQL pool configuration via `DATABASE_URL`
- GitHub Actions CI with Node.js 20, dependency installation and full test suite execution

## Still intentionally outside this slice

- production IdP/OIDC/OAuth2 gateway integration
- production PostgreSQL deployment/credentials and live migration execution
- replacing every in-memory service operation with database-backed repositories
- private object storage and malware scanning
- fee assessment/payment gateway and reconciliation
- email/SMS notification providers
- government-agency adapters
- production hosting, WAF, secrets vault and observability stack
- Court Workspace frontend

## Security boundary

`x-dev-*` request headers are development-only scaffolding. They must never be accepted as production identity evidence. Production authentication must resolve signed, validated claims from the approved identity platform/API gateway and must retain server-side permission, court, record relationship and confidentiality enforcement.
