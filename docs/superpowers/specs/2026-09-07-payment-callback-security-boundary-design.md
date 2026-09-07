# Payment Callback Security Boundary Design

## Purpose

Add a provider-neutral, fail-closed inbound payment callback boundary to DCIECMS without selecting or activating a production payment gateway. A verified callback may confirm an existing pending payment only when the callback is cryptographically authenticated by an injected provider adapter, is bound to the same configured provider as the payment, exactly matches the authoritative amount/currency, and has not already been processed under a conflicting payload.

This design preserves the existing staff-driven `confirmPayment()` flow and the existing `payment.confirmed` domain event. It introduces a separate machine-to-machine trust boundary rather than weakening OIDC or creating an authentication bypass inside the normal user route path.

## Scope

Delivered in this workstream:

- provider-neutral verifier contract operating on the exact raw request body;
- explicit provider code binding on payments intended for gateway settlement;
- durable callback-event evidence and replay protection;
- callback confirmation that reuses the authoritative payment transition, application audit and outbox infrastructure;
- a dedicated pre-OIDC HTTP callback route with bounded raw-body ingestion;
- sanitized authentication, validation, conflict and availability errors;
- fail-closed runtime configuration;
- isolated logical/Supabase-test migration assets and automated regressions.

Excluded:

- choosing a bank, card processor, mobile-money provider or payment aggregator;
- committing shared secrets, public keys, certificates, API keys or provider endpoints;
- implementing a provider-specific HMAC/RSA/JWS scheme;
- opening an internet-facing production webhook endpoint;
- executing migration `0014` against a live database;
- refunds, chargebacks, reversals, settlement files and reconciliation automation;
- production deployment or provider onboarding.

## Existing Baseline

DCIECMS already has:

- `finance.payments` with `PENDING`, `CONFIRMED`, `FAILED`, `CANCELLED` and `REFUNDED` states;
- staff-authorized `confirmPayment(actor, paymentId, providerReference)`;
- unique non-null `provider_reference` values;
- application audit persistence;
- transactional audit coupling;
- durable `payment.confirmed` outbox emission;
- the shared `PostgresTransactionManager` transaction boundary.

The callback design must extend these controls instead of creating a parallel payment ledger.

## Trust Model

### Normal user traffic

Normal API routes continue to resolve an OIDC/development actor through `actorResolver` before service execution. Nothing in this workstream accepts callback headers as a user identity.

### Callback traffic

`POST /integrations/payments/:provider/callback` is handled before OIDC actor resolution because a payment provider is not a human OIDC principal. This is not a generic authentication bypass: only that exact route shape is eligible, it is inactive unless a callback runtime is explicitly configured, and the request must pass the injected provider verifier before any JSON/body field is trusted.

Provider-specific verification stays outside the provider-neutral core. The adapter receives:

```js
verify({ headers, rawBody, receivedAt })
```

and returns verified normalized evidence:

```js
{
  providerCode,
  providerEventId,
  paymentId,
  providerReference,
  status: 'CONFIRMED',
  amountMinor,
  currency,
  occurredAt
}
```

The core computes its own SHA-256 digest of the exact raw body for replay evidence. Raw signatures, authorization headers, shared secrets and raw callback bodies are never persisted in the application database or audit payload.

## Provider Binding

Migration `0014` adds nullable `finance.payments.provider_code varchar(64)`.

Existing/manual payments remain valid with `provider_code IS NULL`. Callback confirmation is stricter: it is permitted only when `payment.provider_code` is non-null and exactly equals the verified `providerCode`.

`createPayment()` accepts an optional provider code. The code is normalized to lower case and must match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

This prevents a valid callback from one configured provider from confirming a payment assigned to another provider.

## Durable Replay Evidence

Migration `0014` creates `integration.payment_callback_events` with:

- `callback_event_id uuid` primary key;
- `provider_code varchar(64)`;
- `provider_event_id varchar(180)`;
- `payment_id uuid` referencing `finance.payments`;
- `body_sha256 char(64)`;
- `provider_reference varchar(160)`;
- `event_status varchar(30)` restricted to `CONFIRMED` for this milestone;
- `amount_minor bigint > 0`;
- `currency char(3)`;
- `occurred_at`, `received_at`, `processed_at` timestamps;
- `processing_status` restricted to `RECEIVED` or `PROCESSED`;
- unique `(provider_code, provider_event_id)`.

The table stores normalized verified evidence only. No raw body, signature, bearer token, secret, provider diagnostic dump or cardholder/payment-instrument data is stored.

Replay rules:

1. First occurrence claims `(provider_code, provider_event_id)`.
2. A later occurrence with the same provider/event ID and identical body digest may return the already-confirmed canonical payment without producing another audit row or outbox event.
3. Reuse of a provider/event ID with a different body digest, payment ID or provider reference is a security conflict and fails closed.
4. Callback-event insertion, payment mutation, audit evidence, outbox enqueue and callback `PROCESSED` transition commit in one outer PostgreSQL transaction.

## Authoritative Payment Validation

After cryptographic verification and replay claim, the service loads the authoritative DCIECMS payment and requires all of the following:

- payment exists;
- payment status is `PENDING` for a new callback event;
- payment has a non-null provider binding;
- payment provider code exactly matches the verified provider code;
- callback status is exactly `CONFIRMED`;
- callback `amountMinor` exactly equals the payment amount;
- callback currency exactly equals the authoritative three-letter payment currency;
- provider reference is non-empty and within the existing 160-character database boundary.

Only then may the repository execute the existing `PENDING -> CONFIRMED` transition.

A system subject of the form `payment-callback:<providerCode>` is used for `confirmed_by_subject`, application audit actor evidence and outbox actor evidence. It is generated by DCIECMS from the verified provider code and cannot be supplied by the remote caller.

## Service Boundary

`PersistentDciecmsService.confirmPaymentFromCallback(verifiedCallback)` is the single callback mutation entry point. It does not accept an arbitrary user actor and is not exposed on normal authenticated routes.

The method:

1. claims/validates durable callback event identity;
2. handles exact processed replay idempotently;
3. loads and validates the authoritative payment;
4. confirms it using the existing repository transition;
5. writes `finance.payment.confirm.callback` audit evidence containing only safe identifiers/metadata;
6. emits the existing `payment.confirmed` domain event with the existing minimized payload;
7. marks the callback event `PROCESSED`;
8. returns the canonical confirmed payment.

`confirmPaymentFromCallback` is added to the immutable mutating-service registry so the whole operation uses `PostgresTransactionManager`.

## HTTP Boundary

`createHttpApp` gains an optional `paymentCallbackHandler` dependency.

For the exact callback route, the app:

1. does not invoke the OIDC actor resolver;
2. reads a bounded raw request body (default maximum 1 MiB);
3. passes the route provider, headers and exact raw bytes to the callback handler;
4. sends the handler result;
5. uses `Cache-Control: no-store`.

All other routes continue through the existing actor resolver exactly as today.

The callback handler selects the verifier only from a server-controlled registry. Caller headers or JSON cannot select an arbitrary verifier. The route provider must exactly match the provider returned by the successful verifier.

## Error Model

Remote responses are deliberately generic:

- invalid/missing callback authentication: `401 {"error":"callback_unauthorized"}` with no Bearer challenge;
- unsupported/unconfigured provider or disabled callback runtime: `404` or startup refusal depending on configuration path;
- malformed/bounded-body/normalized-field validation failure: `422 {"error":"callback_validation_error"}`;
- replay/body/provider/payment-state/amount/currency conflict: `409 {"error":"callback_conflict"}`;
- temporary verifier infrastructure failure: `503 {"error":"callback_unavailable"}`;
- unexpected failure: existing sanitized `500 {"error":"internal_error"}`.

Provider exception text, expected signatures, key IDs, raw body content and secret material must not be reflected to clients.

## Runtime Configuration

`DCIECMS_PAYMENT_CALLBACK_MODE` accepts only `disabled` or `enabled` and defaults to `disabled`.

Rules:

- `disabled`: no callback handler is registered;
- `enabled`: requires `DATABASE_URL` and a non-empty injected server-side verifier registry;
- startup fails before `listen()` if callback mode is enabled without the durable PostgreSQL path or without verifier adapters;
- no development fake verifier is implicitly enabled in production;
- no verifier secret is read from committed repository configuration by this workstream.

## Database and Migration Boundary

Repository migration: `db/migrations/0014_payment_callback_security.sql`.

Isolated Supabase test-profile translation: `db/supabase/20260907_dciecms_test_0014.sql`.

Both are repository assets only. This workstream does not apply them to a live environment.

## Security Invariants

- callback bytes are untrusted until cryptographic verification succeeds;
- parsing JSON before provider verification must not be required by the provider-neutral HTTP boundary;
- payment provider binding, amount and currency are authoritative server checks, not verifier-only checks;
- a callback cannot supply an application user identity, court scope or RBAC role;
- a valid callback from provider A cannot confirm provider B's payment;
- exact replay does not duplicate payment mutation, audit evidence or outbox delivery intent;
- conflicting replay fails closed;
- raw signatures/bodies/secrets are never persisted;
- provider diagnostics are never reflected to the remote caller;
- no production gateway is activated by repository delivery.

## Verification Strategy

TDD coverage will include:

- verifier contract and normalization tests;
- provider-code validation;
- migration/schema contract tests;
- repository callback claim/replay/conflict tests;
- service amount/currency/provider/status validation;
- exact replay idempotency;
- transaction rollback when audit/outbox/callback-finalization fails;
- HTTP proof that callback route executes before OIDC actor resolution while unrelated routes still require it;
- raw-body byte preservation and maximum-body enforcement;
- sanitized callback error responses;
- runtime default-disabled and fail-closed enabled-mode tests;
- centralized security regression proving no raw body/signature persistence and no cross-provider confirmation.

Every branch head must pass the backend regression suite, Court Workspace tests and production frontend build before PR review.