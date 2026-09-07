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

Authentication mode is mandatory. For local development, explicitly select the development resolver, secure-document adapters and deterministic payment adapter:

```bash
DCIECMS_AUTH_MODE=development DCIECMS_DOCUMENT_PIPELINE_MODE=development DCIECMS_PAYMENT_INTEGRATION_MODE=development PORT=3000 npm start
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

## Payment integration boundary

The repository now contains a provider-neutral payment-integration boundary, not a selected or activated production payment gateway. The safest default is `disabled`. For deterministic local/testing behavior only, explicitly use:

```dotenv
DCIECMS_PAYMENT_INTEGRATION_MODE=development
```

The development provider is test/local scaffolding only. Production cannot select it. `DCIECMS_PAYMENT_INTEGRATION_MODE=enabled` is accepted only when runtime composition is given an explicitly injected production-capable provider adapter that supports verified provider callbacks. No real provider adapter or gateway credential is constructed from `.env` by this repository work.

The implemented gateway flow is:

1. an authenticated user requests `POST /payments/:paymentId/sessions`;
2. the server loads the canonical pending payment and uses its server-owned payment ID, amount and currency;
3. the provider adapter creates a checkout session under a stable server idempotency key;
4. the server binds the returned provider code/reference to that payment without allowing caller overrides;
5. the HTTP response exposes only `checkoutUrl` and `expiresAt`, uses `Cache-Control: no-store`, and the session request body is bounded before service invocation;
6. the provider callback posts to `/payment-provider/webhook`; browser/OIDC actor authentication is not used for this callback boundary;
7. the callback body is size-bounded as raw bytes before provider verification, and only normalized verified event evidence is stored;
8. a success event can confirm only when provider code, provider reference, payment correlation, amount and currency exactly match the canonical server-bound payment;
9. duplicate provider events reuse the canonical durable inbox record and cannot apply the success transition twice;
10. callback processing cannot issue a receipt or open a case directly; existing receipt/case-opening controls remain separate and depend on canonical `CONFIRMED` payment state.

When payment integration is enabled, the legacy manual external-provider confirmation route is blocked. This prevents FIN/FIN-MGR users or browser code from manufacturing gateway success by supplying a provider reference. The Court Workspace therefore requests checkout sessions and does not use the former browser `confirmPayment(paymentId, providerReference)` flow for ordinary gateway processing.

Provider failure, cancellation, refund and reversal are represented as durable provider outcome evidence. Refund/reversal does not destructively erase the original payment confirmation, receipt or case history. This repository does **not** implement real settlement reconciliation, provider refund API calls, chargeback handling or payout ingestion.

Migration `db/migrations/0014_payment_integration_hardening.sql` and its isolated Supabase test-profile counterpart are repository-delivered artifacts only. They have **not** been applied to a live database by this work.

Production gateway onboarding remains a separate gate requiring at minimum: approved provider selection/contract, merchant configuration, callback URL exposure, TLS termination, WAF/rate-limit policy, webhook signature/verification secret provisioning, provider credentials/certificates in approved secret management, controlled execution of migration `0014`, and authorized deployment. None of those actions are performed by the repository implementation.

Raw callback bodies, webhook signatures, provider authorization headers, provider secrets, checkout tokens/session internals and provider diagnostic text must not be persisted in payment rows, audit events, outbox events or source control, and must not be reflected in browser-facing HTTP errors.

## Court Workspace boundary

The Court Workspace API client supports a provider-neutral runtime access-token provider. When configured, it sends `Authorization: Bearer <token>` and suppresses development identity headers even if the provider temporarily has no token. The current workstream does not implement browser OIDC login, PKCE, redirect handling or a government IdP SDK.

For gateway flow, the Court Workspace requests only provider-neutral payment checkout sessions. It receives only the checkout URL and expiry and does not receive or manufacture provider callback evidence.

## Current adapter boundaries

Provider-neutral contracts now exist for production authentication, private document storage, secure upload/download grants, malware scanning, durable scan-job execution and payment-provider session/callback processing. No real government IdP, production object-storage provider, production KMS configuration, production malware scanner, production payment gateway, SMS/email provider, Government Service Bus or external agency API has been activated. Those environment-specific choices remain gated on approved endpoint/security contracts, credentials, secret-management configuration, controlled migration execution and production deployment authorization.
