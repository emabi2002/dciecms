# DCIECMS Implementation Status - First Vertical Slice v0.1

## Implemented

1. Identity-claim normalization boundary.
2. Deny-by-default role/permission and court-scope authorization.
3. Party creation within court scope.
4. Filing draft creation and retrieval.
5. Document metadata registration in quarantine with SHA-256 validation.
6. Idempotent filing submission.
7. Registry queue restricted by role and court scope.
8. Append-only executable audit store.
9. Minimal dependency-free HTTP adapter.
10. PostgreSQL DDL subset for the vertical slice.
11. Automated unit/API/security/migration contract tests.

## Deliberately Deferred Adapter Boundaries

- Production Identity Provider / SSO / MFA integration.
- PostgreSQL runtime repository implementation and transaction layer.
- Private object storage and malware scanning service.
- Payment gateway and receipt/reconciliation adapters.
- SMS/email service.
- Government Service Bus and agency integrations.
- Full Court Workspace / Practitioner / Public / Administration UIs.

These items remain governed by the approved engineering blueprint and require their corresponding environment/API contracts rather than invented endpoints.

## Next Implementation Slice

Persist the R0/R1 service against PostgreSQL; add court/case-type configuration; implement registry validation and workflow tasks; replace the development identity adapter with an approved OIDC/OAuth2 adapter when the IdP contract is available; then introduce the Court Workspace UI against the tested API contracts.
