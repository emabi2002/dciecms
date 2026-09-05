# DCIECMS

District Courts Integrated Electronic Content Management System (DCIECMS) for PNG Magisterial Services.

## First Vertical Slice v0.1

This branch contains the first executable implementation slice:

- identity claim normalization
- deny-by-default RBAC and court scope
- party creation
- filing draft creation
- document registration with SHA-256 validation and quarantine status
- idempotent filing submission
- court-scoped registry queue
- append-only audit evidence
- runnable HTTP adapter
- PostgreSQL baseline migration
- automated unit, API and security tests

The development HTTP identity headers in this slice are non-production scaffolding only. Production authentication must be integrated with the approved identity provider and token validation model.
