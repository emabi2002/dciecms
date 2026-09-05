# Local Development Runbook

## Preconditions

- Node.js 22 or later.
- No external npm dependencies are required for this baseline.
- PostgreSQL is not required to run the in-memory executable tests. `db/migrations/0001_baseline.sql` is the persistence contract subset and must be applied only in a controlled database environment after review.

## Verification

```bash
npm test
```

## Start development API

```bash
PORT=3000 npm start
```

The server binds to `127.0.0.1` and uses development-only claim headers. Production must replace this resolver with validated OIDC/OAuth2 claims from the approved IdP/gateway.

## Example: create party

```bash
curl -s http://127.0.0.1:3000/parties \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-dev-sub: reg-a' \
  -H 'x-dev-roles: REG' \
  -H 'x-dev-courts: COURT-A' \
  -d '{"courtId":"COURT-A","partyType":"PERSON","displayName":"Jane Doe"}'
```

Use the returned `partyId` to create a filing:

```bash
curl -s http://127.0.0.1:3000/filings \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-dev-sub: reg-a' \
  -H 'x-dev-roles: REG' \
  -H 'x-dev-courts: COURT-A' \
  -d '{"courtId":"COURT-A","caseTypeCode":"CIVIL","filerPartyId":"<partyId>"}'
```

## Current adapter boundaries

The following are deliberately not faked as production integrations: government IdP, object storage, malware scanner, payment provider, SMS/email provider, Government Service Bus and external agency APIs. They remain explicit adapter boundaries until approved endpoint/security contracts are available.
