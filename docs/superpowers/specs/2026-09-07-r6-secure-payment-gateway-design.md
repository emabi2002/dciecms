# R6 Secure Payment Gateway Integration Design

## Purpose

R6 adds a provider-neutral, fail-closed payment-gateway integration boundary to DCIECMS. The objective is to allow external payment providers to confirm court payments without permitting browser clients, unverified callback payloads, duplicated callbacks, amount mismatches, or provider retry behaviour to corrupt the authoritative financial ledger.

R6 is a repository capability only. It does not select a production payment provider, register a merchant account, commit provider secrets, activate live callbacks, apply live database migrations, or deploy production infrastructure.

## Security objectives

1. A browser or ordinary authenticated user cannot mark a gateway payment successful by presenting provider-like fields.
2. Callback authenticity is verified before any payment mutation.
3. Provider event identity is durable and replay-safe.
4. Payment amount, currency and gateway reference are matched against server-authoritative payment intent data.
5. Duplicate delivery of the same valid callback returns the canonical prior outcome without repeating business mutations, receipt creation, audit evidence, or outbox publication.
6. Conflicting reuse of an event identity fails closed.
7. Invalid signatures, stale timestamps, malformed payloads, unsupported event types and mismatched payment evidence do not change financial state.
8. Payment confirmation, callback-event completion, audit evidence and domain-event enqueue occur in one PostgreSQL transaction.
9. Provider secrets, raw signatures and unrestricted provider payloads are not persisted in application audit evidence or generic outbox events.
10. Production mode cannot silently fall back to development callback verification.

## Scope

### Included

- provider-neutral callback verifier contract;
- deterministic development/test verifier;
- explicit production capability/configuration gate;
- durable payment callback inbox;
- replay/conflict detection;
- canonical callback normalization;
- exact amount/currency/reference validation;
- gateway-confirmed payment transition;
- transactionally coupled audit and outbox evidence;
- HTTP callback endpoint that uses the raw request body for signature verification;
- sanitized callback error mapping;
- migration and isolated Supabase test-profile migration;
- unit, security, repository, HTTP, transaction and runtime regressions;
- architecture/status/configuration documentation.

### Excluded

- selection of a named bank, card processor, mobile-money provider or government payment platform;
- live merchant credentials, HMAC keys, public keys, certificates or provider endpoints;
- outbound payment-session creation against a real provider;
- refunds, chargebacks, settlement-file ingestion or bank reconciliation automation;
- live migration execution;
- production callback DNS/TLS/WAF changes;
- production deployment.

## Existing DCIECMS boundaries reused

R6 extends rather than replaces the existing finance, transaction, audit and outbox architecture. The existing PostgreSQL transaction manager remains the outer mutation boundary. Existing payment records remain authoritative for expected amount, currency, court and filing context. The existing outbox continues to provide at-least-once downstream delivery and must not contain provider secrets.

## Architecture

### 1. Callback verification boundary

Create `services/api/src/payment-gateway-verifier.js`.

The contract is:

```js
assertPaymentGatewayVerifier(verifier, { production })
normalizeVerifiedPaymentCallback(result)
```

A verifier must expose:

```js
await verifier.verify({
  rawBody,
  headers,
  receivedAt
})
```

The verifier returns only normalized, security-reviewed evidence:

```js
{
  provider: 'TEST',
  eventId: 'evt_123',
  eventType: 'PAYMENT_SUCCEEDED',
  paymentReference: 'PAY-...',
  providerPaymentReference: 'gw_...',
  amountMinor: 12500,
  currency: 'PGK',
  occurredAt: '2026-09-07T02:00:00.000Z'
}
```

Allowed canonical event types in R6 are `PAYMENT_SUCCEEDED` and `PAYMENT_FAILED`. Unknown or malformed verifier output fails closed.

The verifier owns provider-specific signature/timestamp parsing. Application services never parse provider signatures themselves.

Production verifier capability must attest that authenticity and replay-time validation are enforced. Development verifier implementations are explicitly marked `developmentOnly:true` and cannot satisfy production mode.

### 2. Durable callback inbox

Migration `0014_payment_gateway_callbacks.sql` creates `finance.payment_gateway_callbacks`.

Required fields:

- callback UUID primary key;
- provider;
- provider event ID;
- canonical event type;
- server payment reference;
- provider payment reference;
- amount in integer minor units;
- ISO-style currency code;
- event occurrence time;
- processing status;
- normalized outcome code;
- linked payment ID when resolved;
- received/processed timestamps;
- sanitized failure code;
- payload digest SHA-256, never the unrestricted raw callback payload;
- unique `(provider, provider_event_id)` identity.

Statuses: `RECEIVED`, `PROCESSING`, `APPLIED`, `IGNORED`, `REJECTED`.

The same `(provider,eventId)` plus the same normalized security evidence is replay-safe. Reuse of the same identity with different canonical evidence is a conflict and fails closed.

### 3. Callback processing service

Create `services/api/src/payment-gateway-service.js`.

Primary operation:

```js
processVerifiedCallback({
  verifiedCallback,
  payloadDigestSha256,
  receivedAt
})
```

The service executes under the existing PostgreSQL transaction manager and uses a dedicated system actor identity for callback-originated audit evidence. It does not accept browser/user identity as callback authority.

For `PAYMENT_SUCCEEDED`, processing must:

1. claim/replay the durable callback event;
2. resolve the payment by the DCIECMS server payment reference;
3. require payment status `PENDING`, unless replay resolves an already-applied callback;
4. compare exact integer `amountMinor`;
5. compare normalized currency exactly;
6. enforce provider payment-reference consistency;
7. confirm the payment through a repository method dedicated to verified gateway confirmation;
8. persist callback `APPLIED` outcome;
9. append sanitized audit evidence;
10. enqueue the existing `payment.confirmed` domain event using a stable deduplication key derived from the authoritative payment, not the raw provider payload.

For `PAYMENT_FAILED`, R6 records the verified callback outcome but does not automatically mutate a previously confirmed payment. A pending payment may remain pending so that provider retry or another payment attempt can proceed under later product rules. No refund/reversal semantics are introduced by R6.

### 4. Repository operations

Extend `services/api/src/postgres-repository.js` with a method dedicated to verified gateway payment confirmation. It must not be interchangeable with an ordinary finance-user confirmation path.

Create `services/api/src/postgres-payment-callback-store.js` for inbox identity, claim, replay, conflict and completion semantics.

All SQL is parameterized. Callback identity claim uses database uniqueness and row locking so concurrent duplicate deliveries cannot double-apply a payment.

### 5. HTTP boundary

Add a provider-neutral route:

```text
POST /api/integrations/payments/callback
```

This route is not authenticated by normal OIDC user identity. Its trust boundary is the payment-gateway verifier.

The HTTP layer must preserve the exact raw request bytes required by the verifier. It passes only raw body, approved headers and server receive time to the verifier. After verification, application processing receives only the canonical normalized callback plus a SHA-256 digest of the raw body.

Responses:

- valid newly applied callback: `200`;
- valid duplicate replay: `200` with canonical replay outcome;
- malformed/invalid callback: sanitized `400` or `401` according to verifier classification;
- valid callback whose canonical evidence conflicts with an existing event identity: `409`;
- payment amount/currency/reference conflict: `409` or `422` according to existing API conventions;
- temporary verifier infrastructure failure: sanitized `503`;
- unexpected error: sanitized `500`.

No response echoes secrets, signatures, provider diagnostics or unrestricted raw callback fields.

### 6. Runtime configuration

Add explicit payment callback mode:

```text
DCIECMS_PAYMENT_GATEWAY_MODE=disabled|development|enabled
```

Rules:

- production defaults/fails to `disabled` unless explicitly enabled;
- production rejects `development`;
- `enabled` requires an injected production-capable verifier;
- development mode may use the deterministic test verifier;
- no production secret names or provider-specific endpoints are committed by R6.

### 7. Audit and outbox evidence

Audit evidence records normalized identifiers and outcome codes only. Raw request bytes, callback signatures, authorization headers, provider secrets and unrestricted diagnostics are prohibited.

`payment.confirmed` outbox payload remains minimal and provider-neutral. Provider payment references are not added to the generic event payload.

Callback application, payment confirmation, audit append and outbox enqueue are one atomic transaction. Failure of any element rolls back the full mutation.

## Data integrity rules

- Amounts are integers in minor units; no floating-point payment comparison.
- Currency is normalized uppercase and compared exactly.
- Provider/event IDs have bounded lengths and are non-empty.
- Callback occurrence time must be a valid timestamp.
- Payload digest is 64 lowercase hexadecimal SHA-256.
- A provider event identity cannot be reinterpreted with different canonical evidence.
- An already-confirmed payment cannot be silently changed by a later callback.
- No callback path can create a receipt twice.
- No callback path can open a case directly; existing downstream finance/case rules remain authoritative.

## Testing strategy

R6 follows RED/GREEN TDD and adds:

- verifier contract tests;
- normalization tests;
- production fail-closed configuration tests;
- migration-contract tests;
- callback-store replay/conflict/concurrency SQL tests;
- repository exact-amount/currency/reference tests;
- service duplicate/replay tests;
- forged-signature and stale-callback security tests using deterministic fixtures;
- HTTP raw-body preservation and sanitized-error tests;
- transaction tests proving callback + payment + audit + outbox commit together;
- rollback tests proving audit or outbox failure rolls back payment confirmation;
- regression proving provider references/raw payload/signatures are absent from generic outbox and audit evidence;
- full backend regression, Court Workspace regression and production frontend build.

## Release boundary

Completion of R6 means repository code, migrations, tests and documentation are ready for integration review. It does not mean a production payment provider has been selected, configured or activated. Production provider onboarding remains a separate governance/security gate requiring approved credentials, secret management, callback endpoint registration, TLS/WAF controls, controlled migration execution and deployment approval.
