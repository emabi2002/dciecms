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
DCIECMS_AUTH_MODE=development DCIECMS_DOCUMENT_PIPELINE_MODE=development PORT=3000 npm start
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

## Secure document pipeline boundary

The repository contains a provider-neutral secure-document lifecycle, not a live production storage or malware-scanning integration. For development and automated tests, explicitly use:

```dotenv
DCIECMS_DOCUMENT_PIPELINE_MODE=development
```

Development mode uses in-memory private-object metadata and scripted scanner adapters so the security and lifecycle contracts can be tested without an external provider. These adapters must never be treated as production storage or a production malware scanner.

The implemented lifecycle is:

1. the API creates a server-owned document identity and quarantine object key;
2. the storage adapter returns a short-lived upload grant for that exact private object;
3. finalization reads authoritative object metadata from the storage adapter and validates size, SHA-256 and detected MIME type rather than trusting caller-supplied integrity evidence;
4. the document remains `QUARANTINED` while a durable leased scan job is processed;
5. only a normalized `CLEAN` verdict for that exact quarantined record may transition it to `ACTIVE`;
6. download authorization is issued only after RBAC, court scope, record relationship, classification and active/released-state checks;
7. download grants are short-lived and are not stored in document metadata or application audit evidence.

`PUBLIC` users are additionally restricted to the filing relationship that belongs to their verified subject; sharing a court scope does not authorize access to another filer's document. `RESTRICTED` and `SEALED` documents require the corresponding explicit document grant in addition to base `document.view` authority and court scope.

Production behavior is fail closed. When `NODE_ENV=production`, an omitted document-pipeline mode resolves to `disabled`, `development` mode is forbidden, and `DCIECMS_DOCUMENT_PIPELINE_MODE=enabled` requires approved injected storage and scanner adapters. The production storage adapter must attest private objects and encryption at rest. No storage provider, bucket, KMS key, scanner provider, provider endpoint, credential or secret is selected by this repository work.

Migration `db/migrations/0013_secure_document_pipeline.sql` and the isolated Supabase test-profile migration are repository-delivered artifacts only. They have **not** been applied to a live database by this work. Applying `0013`, provisioning private storage/KMS, selecting and credentialing a malware scanner, scheduling the scan worker, and activating the pipeline in a production deployment remain separate production gates.

Signed upload/download grants, provider credentials, scanner credentials and raw scanner/provider diagnostics must not be persisted in document metadata, audit records, outbox events, source control or HTTP error responses.

## Court Workspace boundary

The Court Workspace API client supports a provider-neutral runtime access-token provider. When configured, it sends `Authorization: Bearer <token>` and suppresses development identity headers even if the provider temporarily has no token. The current workstream does not implement browser OIDC login, PKCE, redirect handling or a government IdP SDK.

## Current adapter boundaries

Provider-neutral contracts now exist for production authentication, private document storage, secure upload/download grants, malware scanning and durable scan-job execution. No real government IdP, production object-storage provider, production KMS configuration, production malware scanner, payment provider, SMS/email provider, Government Service Bus or external agency API has been activated. Those environment-specific choices remain gated on approved endpoint/security contracts, credentials, secret-management configuration and production deployment authorization.
