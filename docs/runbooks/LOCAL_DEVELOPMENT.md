# Local Development Runbook

## Preconditions

- Node.js 20 or later.
- Run `npm install` at the repository root before starting the API. The backend uses `pg` for PostgreSQL access and `jose` for production JWT/JWKS verification.
- PostgreSQL is not required to run the in-memory executable tests. Database migrations must be applied only in a controlled database environment after review and separate authorization.

## Verification

```bash
npm test
```

## Start development API

Authentication mode is mandatory. For local development, explicitly select the development resolver:

```bash
DCIECMS_AUTH_MODE=development PORT=3000 npm start
```

The server binds to `127.0.0.1`. In `development` authentication mode only, the API accepts the `x-dev-sub`, `x-dev-roles`, `x-dev-courts` and `x-dev-grants` claim headers as local scaffolding. `NODE_ENV=production` cannot start with `DCIECMS_AUTH_MODE=development`.

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

## Production OIDC boundary

The repository now contains a provider-neutral production authentication boundary, but no real government identity provider has been activated by this work. `DCIECMS_AUTH_MODE=oidc` requires all of the following metadata before the server can listen:

```dotenv
DCIECMS_AUTH_MODE=oidc
DCIECMS_OIDC_ISSUER=https://identity.example.gov.pg
DCIECMS_OIDC_AUDIENCE=dciecms-api
DCIECMS_OIDC_JWKS_URI=https://identity.example.gov.pg/.well-known/jwks.json
DCIECMS_OIDC_ALLOWED_ALGS=RS256
```

The values above are placeholders only. Do not commit live IdP credentials, bearer tokens or environment-specific secrets.

In OIDC mode, requests authenticate with `Authorization: Bearer <access-token>`. The API verifies the JWT signature through the configured JWKS, exact issuer and audience, token time validity and the configured asymmetric signing-algorithm allow-list before mapping `sub`, `roles`, `court_ids` and `explicit_grants` into the canonical application actor. Development identity headers are not a production fallback.

Authentication failures return a sanitized 401 Bearer challenge; authenticated actors who fail RBAC/court-scope authorization receive 403; temporary JWKS verification infrastructure failures fail closed with sanitized 503 responses.

## Court Workspace boundary

The Court Workspace API client supports a provider-neutral runtime access-token provider. When configured, it sends `Authorization: Bearer <token>` and suppresses development identity headers even if the provider temporarily has no token. The current workstream does not implement browser OIDC login, PKCE, redirect handling or a government IdP SDK.

## Current adapter boundaries

The following are deliberately not faked as production integrations: government IdP registration/login, private object storage, malware scanner, payment provider, SMS/email provider, Government Service Bus and external agency APIs. They remain explicit adapter boundaries until approved endpoint/security contracts and production credentials are available.
