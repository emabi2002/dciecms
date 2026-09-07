# Payment Integration Hardening — Design Specification

Date: 2026-09-07
Status: Approved under the standing DCIECMS Step 1–Step 10 development authorization for repository-level design, planning, TDD implementation, review, PR and verified merge. Live provider credentials, production endpoints, live database migration and production deployment remain separate gates.

## 1. Purpose

DCIECMS already supports fee assessment, a canonical `PENDING` payment record, finance-manager confirmation, receipt issuance, maker/checker reconciliation, case opening after confirmed payment, transactional audit coupling and a generic `payment.confirmed` outbox event.

The current confirmation boundary is intentionally incomplete: an authorized finance manager can supply a provider reference and directly confirm a payment. That is adequate as an early vertical-slice placeholder but is not a production payment trust model.

This workstream replaces that placeholder with a provider-neutral payment integration boundary in which externally collected payments become `CONFIRMED` only from authenticated, integrity-checked and replay-safe provider evidence whose payment identity, amount and currency match the canonical DCIECMS payment.

## 2. Scope

This workstream delivers repository-level architecture and application behavior for:

- provider-neutral payment-gateway adapter contract;
- explicit payment-integration runtime modes that fail closed in production;
- external payment-session creation from an existing canonical DCIECMS payment;
- server-owned provider metadata and provider payment references;
- authenticated provider callback/webhook ingestion;
- durable callback/event inbox with idempotency and replay protection;
- exact payment identity, amount and currency validation;
- canonical provider-event processing and state transitions;
- controlled success, failure, cancellation, reversal/refund evidence;
- removal of manual provider impersonation from the ordinary production confirmation path;
- transactional payment mutation, audit evidence and outbox coupling;
- safe receipt and case-opening dependence on canonical confirmed state;
- sanitized provider errors and secret minimization;
- security and concurrency regression coverage.

Out of scope:

- selecting a production payment provider;
- supplying merchant secrets, API keys, signing keys or production callback URLs;
- calling a real payment provider in CI;
- production refund execution;
- settlement-file ingestion from a real bank/provider;
- live production database migration;
- production deployment.

## 3. Existing baseline and problem statement

The current payment record contains `payment_id`, `assessment_id`, `court_id`, `amount_minor`, `currency`, `status`, `provider_reference`, creator and confirmation evidence. `provider_reference` is unique when present.

The application currently exposes `POST /payments/:id/confirm`; a `FIN-MGR` may supply `providerReference` and move `PENDING -> CONFIRMED`. This trusts a human-provided string rather than provider-authenticated evidence.

The hardened design must preserve finance authorization for administrative workflows without allowing a human role, browser client, arbitrary HTTP caller or unsigned callback to manufacture successful external-payment evidence.

## 4. Architectural model

The trust flow is:

1. DCIECMS creates a canonical `PENDING` payment from an `ASSESSED` fee assessment.
2. An authorized actor requests a payment session for that payment.
3. DCIECMS validates payment state and invokes one configured provider adapter.
4. The adapter creates a provider-side payment/session using server-controlled payment ID, amount, currency and callback metadata.
5. DCIECMS persists only normalized provider identifiers and session evidence required for correlation; provider secrets or raw authorization tokens are never stored in business/audit rows.
6. The client receives only the minimum short-lived/redirect/session material needed to continue payment, marked non-cacheable.
7. The provider sends an asynchronous callback/webhook.
8. A provider-specific verification boundary authenticates callback integrity before any business payload is trusted.
9. The verified callback is durably recorded in an idempotent inbox using provider + provider event ID.
10. Processing loads the canonical payment and compares provider payment reference, internal payment correlation, amount and currency.
11. Only a normalized terminal-success event with exact matching evidence may transition `PENDING`/eligible state to `CONFIRMED`.
12. Audit and `payment.confirmed` outbox enqueue occur in the same outer database transaction as the canonical payment transition.
13. Receipt issuance and case opening continue to require canonical `CONFIRMED` state.

## 5. Provider adapter contract

A `PaymentProvider` contract exposes behavior equivalent to:

- `capabilities()`;
- `createPaymentSession({ paymentId, amountMinor, currency, idempotencyKey, returnContext })`;
- `verifyWebhook({ headers, rawBody })` returning authenticated normalized provider evidence or a verification failure;
- optional future provider-query/refund methods, not required for the first implementation.

Production adapters must identify themselves with a stable provider code and declare that webhook verification is supported. Development test adapters may be deterministic but must be explicitly development-only.

The application never accepts provider identity from the caller for a payment already bound to a configured provider.

## 6. Runtime configuration and fail-closed behavior

Introduce explicit payment integration modes:

- `disabled` — no external payment-session or callback processing;
- `development` — deterministic local adapter for tests/local development only;
- `enabled` — requires an injected approved production provider adapter.

Suggested environment contract:

```dotenv
DCIECMS_PAYMENT_INTEGRATION_MODE=disabled
DCIECMS_PAYMENT_PROVIDER=<deployment-selected-provider-code>
DCIECMS_PAYMENT_SESSION_TTL_SECONDS=900
```

Provider secrets are adapter/deployment concerns and are never represented by committed example values.

Production rules:

- `development` mode is forbidden when `NODE_ENV=production`;
- `enabled` fails startup if no production-capable provider adapter is injected;
- no automatic fallback to development/manual confirmation;
- `disabled` remains the safe production default until a real provider is approved.

## 7. Durable data model

Migration `0014_payment_integration_hardening.sql` should add provider-neutral tables/columns without rewriting prior migrations.

### 7.1 Payment integration evidence

Extend `finance.payments` with normalized fields as needed, such as:

- `provider_code`;
- `provider_payment_reference` (or safely migrate/retain existing `provider_reference` semantics);
- `provider_status`;
- `session_created_at`;
- `provider_confirmed_at`;
- `failure_code`;
- `cancelled_at`;
- `refunded_at` / `reversed_at` where applicable.

Provider references remain server-controlled after provider session binding and must not be arbitrarily rewritten.

### 7.2 Provider callback inbox

Create `finance.payment_provider_events` (or equivalent) with:

- internal event record ID;
- provider code;
- provider event ID;
- provider payment reference;
- correlated DCIECMS payment ID;
- normalized event type;
- normalized amount/currency where present;
- receipt/authentication timestamp;
- processing status (`RECEIVED`, `PROCESSING`, `PROCESSED`, `REJECTED`, `DEAD_LETTER` or equivalent);
- attempt count / next attempt / lease owner / lease expiry if asynchronous processing is used;
- sanitized error/result code;
- created/processed timestamps.

Unique `(provider_code, provider_event_id)` prevents duplicate callback application.

Raw secrets, signatures and full unbounded provider payloads are not stored in business rows. If a future compliance requirement needs raw callback retention, it must use a separately approved encrypted evidence store with explicit retention rules.

## 8. Session creation

An authorized finance/payment actor may request an external payment session only for a canonical payment in an eligible state.

Rules:

- payment must exist and be within actor court scope;
- payment amount/currency come only from the canonical payment record;
- caller cannot override amount, currency, provider code or callback correlation ID;
- a stable server-generated idempotency key prevents duplicate provider-side payment creation;
- repeated session creation returns/reuses canonical binding where provider semantics allow;
- provider reference returned by the adapter is persisted server-side before being trusted for callback correlation;
- ephemeral checkout URL/session token is returned with `Cache-Control: no-store` and is never persisted to audit/outbox/logs.

## 9. Callback/webhook authentication boundary

Webhook HTTP processing must preserve raw request bytes until provider verification. JSON parsing before signature verification is prohibited for providers whose signature covers raw bytes.

Flow:

1. route selects the deployment-configured provider boundary, not a caller-selected arbitrary implementation;
2. bounded raw body is read;
3. provider adapter verifies signature/MAC/asymmetric proof, timestamp freshness and provider-specific replay controls;
4. verification failure returns a sanitized 401/400-style response and creates no payment mutation;
5. verified normalized evidence enters the durable inbox idempotently;
6. business processing operates only on verified normalized evidence.

The application never trusts callback headers such as payment ID, success flag, amount or provider reference until the adapter has verified them.

## 10. Normalized provider events

The first normalized event vocabulary should include at least:

- `PAYMENT_SUCCEEDED`;
- `PAYMENT_FAILED`;
- `PAYMENT_CANCELLED`;
- `PAYMENT_REFUNDED` or `PAYMENT_REVERSED` where provider evidence supports it;
- `UNKNOWN` must fail closed and never confirm.

A provider adapter may map provider-specific event names into this vocabulary only after authentication.

## 11. Confirmation semantics

`PAYMENT_SUCCEEDED` may confirm a payment only when all required evidence matches:

- internal payment correlation resolves exactly one payment;
- provider code equals the provider bound to the payment;
- provider payment reference equals the bound reference;
- provider amount equals `payment.amountMinor` exactly;
- provider currency equals canonical ISO currency exactly;
- current payment state is eligible for success;
- event has not already been processed under another identity.

Mismatch is a security/integrity failure, not a partial success. The payment remains unconfirmed and the event is rejected/quarantined for investigation.

No `FIN-MGR`, UI field or ordinary API call may synthesize provider success in `enabled` mode.

## 12. Manual/offline payment boundary

If Magisterial Services later requires cash, EFT, bank deposit or other offline/manual payment channels, they must be modeled as explicit payment methods with their own evidence and maker/checker workflow. They must not reuse a fake provider reference or the external-provider callback path.

This workstream may preserve a development/test manual confirmation seam only behind explicit non-production mode for existing tests, while production provider mode removes or rejects that route.

## 13. Failure, cancellation, reversal and refund

Provider failure/cancellation events record normalized evidence without creating a receipt or opening a case.

Refund/reversal is not equivalent to simply deleting or reopening history. A confirmed payment that is later refunded/reversed must preserve the original confirmation and add a controlled subsequent state/evidence transition. Existing receipt/case implications are policy-sensitive; the first implementation records the reversal/refund state and prevents new downstream issuance where applicable, but does not destructively undo a previously opened court case.

Actual refund initiation remains out of scope until provider and finance policy are approved.

## 14. Receipts and case opening

Receipt issuance continues to require canonical `CONFIRMED` payment state. Receipt amount/currency must match the payment.

Case opening continues to require a confirmed payment belonging to the same filing assessment. Provider callback code never opens a case directly; it only establishes canonical payment state and emits the existing domain event.

This separation prevents provider callbacks from bypassing Registry/case-opening authority.

## 15. Reconciliation

Existing maker/checker reconciliation remains. Hardened provider metadata improves reconciliation evidence but provider webhook success is not itself settlement certification.

Future settlement reports/bank statements may be added as a separate reconciliation input. This workstream must not conflate authorization/capture notification with bank settlement.

## 16. Audit and outbox evidence

Required audit actions include at minimum:

- `finance.payment.session.create`;
- `finance.payment.provider_event.receive` where safe/appropriate;
- `finance.payment.provider_event.reject`;
- `finance.payment.confirm` (provider-derived canonical transition);
- `finance.payment.fail` / `cancel` / `refund` / `reverse` where implemented;
- administrative retry/review actions if exposed.

Audit payloads contain normalized identifiers/result codes, not webhook signatures, API keys, checkout tokens or raw provider payloads.

The existing `payment.confirmed` outbox event remains provider-neutral and excludes provider secrets/reference details unless a future downstream contract explicitly requires them.

Canonical payment transition + audit + outbox must remain transactionally coupled under the existing R4/R5 runtime boundary.

## 17. HTTP/API boundary

Provider-neutral application endpoints should include:

- `POST /payments/:paymentId/sessions` — authenticated user/payment session creation;
- one deployment/provider callback endpoint such as `POST /payment-provider/webhook`, wired to the configured adapter and raw-body verifier;
- read/status APIs only if required by the existing Court Workspace.

The existing `POST /payments/:paymentId/confirm` must not remain a production external-payment confirmation bypass. It may either be removed from the production HTTP boundary or made explicitly unavailable whenever payment integration is enabled.

Callback responses are intentionally minimal and sanitized. They do not return payment, filing, party or court metadata to the provider beyond what is required by the protocol.

## 18. Error semantics

Examples:

- invalid/missing provider signature -> sanitized authentication failure; no inbox/business mutation;
- stale callback timestamp -> reject; no confirmation;
- duplicate provider event -> idempotent acknowledgement; no duplicate audit/outbox/business mutation;
- unknown provider event -> reject/fail closed;
- payment/provider-reference mismatch -> integrity conflict; payment remains unchanged;
- amount/currency mismatch -> integrity conflict; payment remains unchanged;
- provider API unavailable during session creation -> retryable 503-style service error; payment remains pending;
- callback processing transient database error -> event remains retryable/unprocessed, never assumed successful;
- provider returns malformed session data -> fail closed and do not bind arbitrary identifiers.

Provider internals and raw error messages are not echoed to clients.

## 19. Security invariants

The implementation/review must prove:

1. Browser or finance role cannot manufacture provider success in production mode.
2. Provider callbacks are authenticated before business payload trust.
3. Callback raw bytes are available to signature verification.
4. Duplicate provider event cannot apply twice.
5. Callback event identity is unique per provider.
6. Amount and currency must exactly match canonical payment.
7. Provider payment reference/correlation must exactly match the payment binding.
8. Unknown/malformed provider events cannot confirm.
9. Provider outage cannot fail open.
10. Checkout/session tokens, signing secrets and raw signatures are not persisted to audit/outbox/business records.
11. Provider reference cannot be caller-controlled after binding.
12. Payment confirmation, audit and outbox remain one transaction in persistent runtime.
13. Receipt issuance remains downstream of canonical confirmed payment.
14. Provider callback cannot directly open a court case.
15. Refund/reversal preserves historical evidence rather than deleting confirmation history.
16. Production runtime does not silently use deterministic development provider adapters.
17. Callback body size is bounded to prevent unbounded memory/DoS exposure.
18. HTTP/provider errors are sanitized.

## 20. Testing strategy

Use deterministic fake provider adapters and PostgreSQL query fakes. No external provider or internet access is required.

Coverage must include:

- runtime disabled/development/enabled fail-closed selection;
- session creation from canonical amount/currency only;
- caller cannot override provider/payment identity/amount/currency;
- session idempotency and provider binding;
- ephemeral checkout material not persisted to audit/outbox;
- valid signed/verified callback normalization fixture;
- invalid signature/stale callback rejection;
- raw-body verification ordering;
- duplicate event idempotency;
- amount mismatch;
- currency mismatch;
- provider-reference mismatch;
- wrong internal payment correlation;
- unknown/malformed event;
- successful confirmation transaction + audit + outbox;
- provider failure/cancellation does not confirm;
- refund/reversal evidence where implemented;
- manual confirm unavailable in enabled/production mode;
- receipt/case opening regressions;
- sanitized HTTP/provider errors;
- migration and Supabase isolated-test mapping contract;
- final exact-head CI, security diff review, PR CI, merge and post-merge main CI.

## 21. Delivery and production gates

Repository completion of this workstream does not activate a live payment provider.

Separate authorization/configuration is required for:

- provider selection and commercial onboarding;
- merchant/account credentials;
- signing/webhook secrets or certificates;
- callback DNS/TLS/WAF exposure;
- production database migration;
- production payment/refund/settlement operations;
- production deployment and go-live.
