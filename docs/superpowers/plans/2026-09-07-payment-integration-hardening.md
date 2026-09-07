# Payment Integration Hardening — Implementation Plan

Date: 2026-09-07
Branch: `feat/payment-integration-hardening`
Design: `docs/superpowers/specs/2026-09-07-payment-integration-hardening-design.md`

## Execution rules

- Execute with strict RED -> GREEN TDD for behavior/security changes.
- Every RED commit must fail for the intended missing behavior only before implementation.
- Every task must return to exact-head GREEN before advancing.
- No real payment provider, merchant credential, webhook secret, live migration or production deployment.
- Provider-specific behavior remains behind injected adapter contracts.
- Any Critical/Important finding in final review receives a regression test before its fix.
- Merge only an exact reviewed PR head with successful PR-triggered CI, followed by successful post-merge `main` CI on the exact merge SHA.

## Task 1 — Payment provider contract and runtime fail-closed selection

### Files

Create:
- `services/api/src/payment-provider.js`
- `services/api/src/payment-runtime.js`
- `tests/unit/payment-provider-contract.test.js`
- `tests/unit/payment-runtime.test.js`

### RED

Define tests proving:

1. provider contract requires `capabilities()`, `createPaymentSession()` and `verifyWebhook()`;
2. production provider capability requires a stable provider code, webhook verification and not `developmentOnly`;
3. deterministic development provider is explicitly development-only;
4. payment runtime mode is only `disabled|development|enabled`;
5. production defaults safely to `disabled`;
6. production rejects `development` mode;
7. `enabled` requires an injected production-capable provider;
8. unknown mode fails rather than falling back;
9. development mode returns deterministic injected/default development adapter.

Commit RED and prove exact intended CI failure.

### GREEN

Implement provider contract assertions and runtime selection only. Do not implement external network calls.

## Task 2 — Migration 0014 and isolated Supabase mapping

### Files

Create:
- `db/migrations/0014_payment_integration_hardening.sql`
- `db/supabase/20260907_dciecms_test_0014.sql`
- `tests/unit/payment-integration-migration-contract.test.js`

Modify:
- `services/api/src/postgres-schema-mapping.js`

### RED

Tests require:

- provider binding/evidence fields on `finance.payments`;
- immutable/bounded provider reference semantics where applicable;
- `finance.payment_provider_events` durable inbox;
- unique `(provider_code, provider_event_id)`;
- normalized event/status constraints;
- lease/retry fields or an equivalent safe idempotent processing contract;
- indexes for due events and payment/provider lookup;
- no raw secrets/signature columns;
- isolated `dciecms_test` translation;
- logical schema mapping for the new event table.

### GREEN

Add additive migration and isolated test profile. Repository-delivered only; do not execute against live DB.

## Task 3 — PostgreSQL payment integration repository

### Files

Create:
- `services/api/src/postgres-payment-integration-repository.js`
- `tests/unit/postgres-payment-integration-repository.test.js`

Modify:
- `services/api/src/postgres-repository.js`

### RED

Define repository contracts for:

- binding one provider/session to an eligible payment using server values;
- retrieving canonical provider binding;
- inserting verified provider event idempotently;
- duplicate provider event returns canonical existing record rather than creating a second event;
- claim/process ownership if durable asynchronous processing is used;
- exact `PENDING -> CONFIRMED` conditional update with provider/reference/amount/currency guards;
- failure/cancel/refund/reversal normalized updates that preserve history;
- no API to arbitrarily overwrite provider reference after binding.

### GREEN

Implement parameterized SQL and stable conflict codes.

## Task 4 — Payment integration service: session creation

### Files

Create:
- `services/api/src/payment-integration-service.js`
- `tests/unit/payment-integration-service.test.js`

### RED

Tests prove:

- payment must exist and actor must have `finance.payment.create` in court scope;
- canonical payment amount/currency/payment ID are passed to provider;
- caller amount/currency/provider/reference overrides are rejected/ignored fail-closed;
- only eligible payment state may create a session;
- provider session creation uses stable server idempotency key;
- provider code/reference binding is persisted;
- malformed provider session response fails closed;
- checkout URL/token is returned ephemerally and never included in audit/outbox or persisted input;
- repeated request reuses canonical binding where possible.

### GREEN

Implement provider-neutral service. No HTTP yet.

## Task 5 — Verified webhook boundary and durable inbox

### Files

Create:
- `services/api/src/payment-webhook-service.js`
- `tests/security/payment-webhook-security.test.js`

Modify as needed:
- `services/api/src/payment-provider.js`

### RED

Tests prove:

- provider verification receives original raw bytes before JSON trust;
- invalid signature/authentication fails with no business/inbox mutation;
- stale verified-provider timestamp fails closed when adapter reports invalidity;
- callback body is bounded;
- provider-specific raw payload/signature/token never enters audit/outbox/business rows;
- verified normalized event requires provider event ID, event type, correlation, provider reference and appropriate amount/currency evidence;
- duplicate provider event is idempotent;
- unknown/malformed normalized event cannot confirm.

### GREEN

Implement verification-first ingestion and normalized durable inbox interface.

## Task 6 — Canonical provider-event processing

### Files

Create:
- `services/api/src/payment-event-processor.js`
- `tests/unit/payment-event-processor.test.js`
- `tests/security/payment-confirmation-integrity.test.js`

### RED

Tests prove:

- success requires exact provider code;
- exact provider payment reference;
- exact internal payment correlation;
- exact amount minor units;
- exact currency;
- eligible payment state;
- duplicate success does not duplicate mutation/audit/outbox;
- amount/currency/reference/correlation mismatch leaves payment unconfirmed;
- failure/cancel does not confirm;
- refund/reversal preserves original confirmation evidence and does not delete receipt/case history;
- unknown event fails closed;
- provider event transition + payment mutation + audit + `payment.confirmed` outbox are one outer transaction in persistent runtime.

### GREEN

Implement normalized event processor and repository integration.

## Task 7 — Runtime/service/transaction composition

### Files

Modify:
- `services/api/src/runtime-service.js`
- `services/api/src/persistent-dciecms-service.js` and/or facade module as appropriate
- `services/api/src/dciecms-service.js` and/or facade module as appropriate
- `services/api/src/transactional-service.js`

Create tests:
- `tests/unit/runtime-payment-integration.test.js`
- extend `tests/unit/runtime-transactional-audit.test.js`
- extend `tests/unit/transactional-service.test.js`

### RED

Prove:

- one payment integration service is injected into runtime;
- production disabled mode exposes no provider processing fallback;
- enabled mode fails without approved provider;
- PostgreSQL repository/audit/outbox use the existing shared transaction manager;
- payment event processing is transaction wrapped;
- audit/outbox failure rolls back canonical provider-success mutation;
- in-memory development path remains deterministic and non-production.

### GREEN

Wire runtime composition without live provider initialization.

## Task 8 — HTTP boundary and removal of manual provider impersonation

### Files

Modify:
- `services/api/src/http-app.js`
- `tests/api/http-app.test.js`

Create:
- `tests/api/payment-integration-http.test.js`

### RED

Prove:

- `POST /payments/:id/sessions` maps authenticated session creation and sends `Cache-Control: no-store`;
- webhook endpoint reads bounded raw body and passes raw bytes/headers to verifier;
- webhook does not require browser/OIDC actor authentication if provider authentication succeeds at its own boundary;
- invalid provider proof returns sanitized error;
- provider/internal errors never echo secrets;
- legacy `POST /payments/:id/confirm` cannot confirm an external payment when payment integration is enabled;
- browser/user cannot submit provider success fields directly;
- provider callback receives minimal response only.

### GREEN

Implement payment routes and mode-aware manual-confirm restriction.

Important: keep any offline/manual payment behavior explicitly separate from provider callback confirmation. Do not model cash/EFT as a fake gateway callback.

## Task 9 — Court Workspace API boundary

### Files

Modify:
- `apps/court-workspace/src/api/types.ts`
- `apps/court-workspace/src/api/client.ts`
- frontend tests that cover payment API methods.

### RED

Prove:

- client can request a payment session;
- client does not send amount/currency/provider reference as confirmation evidence;
- old `confirmPayment(paymentId, providerReference)` external-gateway path is removed or unavailable from ordinary provider flow;
- session response types expose only required checkout/session metadata;
- provider secrets/raw callback data are never represented in browser config/types.

### GREEN

Implement provider-neutral client seam only. No real hosted checkout SDK or redirect provider is selected.

## Task 10 — Security regressions, docs and final delivery

### Security regression files

Create/extend:
- `tests/security/payment-webhook-security.test.js`
- `tests/security/payment-confirmation-integrity.test.js`
- `tests/security/payment-integration-boundary.test.js`

Verify:

1. FIN/FIN-MGR cannot manufacture provider success in enabled mode.
2. unsigned callback cannot mutate payment.
3. raw-body verification occurs before payload trust.
4. duplicate callback cannot apply twice.
5. exact amount/currency/reference/correlation matching.
6. provider mismatch cannot cross-bind payments.
7. unknown event cannot confirm.
8. provider outage cannot fail open.
9. callback/session body size bounded.
10. session tokens/webhook signatures/provider secrets do not persist to audit/outbox/payment rows.
11. callback cannot issue a receipt directly.
12. callback cannot open a case directly.
13. receipt/case opening still require canonical `CONFIRMED` payment.
14. refund/reversal is non-destructive historical evidence.
15. production does not use development adapter.
16. HTTP errors are sanitized.
17. transactional mutation/audit/outbox rollback preserved.

### Documentation

Modify:
- `.env.example`
- `README.md`
- `docs/runbooks/LOCAL_DEVELOPMENT.md`
- `docs/architecture/IMPLEMENTATION_STATUS.md`

Document:

- `DCIECMS_PAYMENT_INTEGRATION_MODE` safe defaults;
- no committed provider secrets;
- development adapter is test/local only;
- production provider onboarding is outstanding;
- migration 0014 is repository-delivered only;
- no real refund/settlement integration;
- webhook exposure/TLS/WAF/secret provisioning is a later production gate.

### Full verification

Require fresh exact-head:

```bash
npm test
npm run test:security
npm run test:frontend
npm run build:frontend
```

Use GitHub Actions exact-head evidence where local execution is unavailable.

### Final review

Review complete diff against `main` for:

- manual provider confirmation bypass;
- caller-controlled provider/reference/amount/currency;
- signature verification after JSON trust;
- unbounded webhook body;
- duplicate/replay application;
- cross-payment correlation;
- amount/currency mismatch acceptance;
- unknown event fail-open;
- secret/signature/session-token leakage;
- transaction/audit/outbox gaps;
- callback direct receipt/case opening;
- destructive refund/reversal behavior;
- production dev-adapter fallback.

Any Critical/Important defect: add RED regression first, prove it, fix minimally, return exact head GREEN, re-review.

### PR / merge

Open PR:

`feat: payment integration hardening`

PR body must explicitly state:

- provider-neutral only;
- no provider selected/activated;
- no merchant credentials/signing secrets;
- migration 0014 not applied live;
- no production deployment/refund/settlement operation.

Merge only exact reviewed PR head after PR-triggered CI success. Then require successful post-merge `main` CI on exact merge SHA before declaring Workstream 5 complete.
