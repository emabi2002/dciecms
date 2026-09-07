# Payment Callback Security Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, fail-closed inbound payment callback boundary with cryptographic-verifier injection, provider/payment binding, durable replay protection, authoritative amount/currency validation, transactional audit/outbox coupling and a dedicated pre-OIDC HTTP route.

**Architecture:** Keep provider-specific signature algorithms outside the core behind injected verifier contracts that receive exact raw bytes. Persist only normalized verified callback evidence plus a server-computed body SHA-256 digest. Process callback claim, payment confirmation, application audit, `payment.confirmed` outbox enqueue and callback completion inside the existing outer PostgreSQL transaction.

**Tech Stack:** Node.js >=20 CommonJS, `node:crypto`, PostgreSQL/`pg`, existing `PostgresTransactionManager`, existing audit/outbox layers, Node test runner, React/Vite regression suite.

**Spec:** `docs/superpowers/specs/2026-09-07-payment-callback-security-boundary-design.md`

## Global Constraints

- No production payment provider, credential, shared secret, public key, endpoint or certificate is selected or committed.
- Callback authentication operates on the exact raw request body before callback fields are trusted.
- Normal OIDC/user routes retain the existing actor resolver; only the exact payment callback route uses the separate callback trust boundary.
- New callback confirmation requires an explicit `finance.payments.provider_code` matching the verified provider.
- Callback amount and currency must exactly equal the authoritative DCIECMS payment.
- Exact replay is idempotent; conflicting reuse of provider event identity fails closed.
- Raw bodies, signatures, authorization material and provider diagnostic dumps are not persisted in callback rows, audit evidence or outbox payloads.
- Callback mutation, audit, outbox and callback-completion evidence are transactionally coupled.
- Repository migrations are not applied to a live database by this plan.
- Production callback runtime defaults to disabled and cannot start enabled without PostgreSQL plus injected verifiers.

---

### Task 1: Provider-neutral verifier contract and normalized callback evidence

**Files:**
- Create: `services/api/src/payment-callback-verifier.js`
- Test: `tests/unit/payment-callback-verifier.test.js`

**Interfaces:**
- Produces: `PaymentCallbackAuthenticationError`
- Produces: `PaymentCallbackUnavailableError`
- Produces: `PaymentCallbackValidationError`
- Produces: `normalizeProviderCode(value)`
- Produces: `normalizeVerifiedPaymentCallback(value, { receivedAt, bodySha256 })`
- Produces: `assertPaymentCallbackVerifier(verifier)`
- Produces test-only deterministic adapter: `ScriptedPaymentCallbackVerifier`

- [ ] **Step 1: Write failing verifier tests**

Create `tests/unit/payment-callback-verifier.test.js` covering provider-code normalization, required verifier shape, exact confirmed status, positive integer amount, ISO timestamp, UUID payment ID, three-letter currency and server-supplied body digest.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProviderCode,
  normalizeVerifiedPaymentCallback,
  assertPaymentCallbackVerifier,
  ScriptedPaymentCallbackVerifier
} = require('../../services/api/src/payment-callback-verifier');

test('provider codes are normalized to lower case and tightly bounded', () => {
  assert.equal(normalizeProviderCode(' Bank.PNG-1 '), 'bank.png-1');
  assert.throws(() => normalizeProviderCode('../bank'), /provider/i);
});

test('verified callbacks normalize only confirmed authoritative fields', () => {
  const callback = normalizeVerifiedPaymentCallback({
    providerCode: 'bank.png',
    providerEventId: 'evt-100',
    paymentId: '11111111-1111-4111-8111-111111111111',
    providerReference: 'TX-100',
    status: 'CONFIRMED',
    amountMinor: 12500,
    currency: 'pgk',
    occurredAt: '2026-09-07T00:00:00.000Z'
  }, {
    receivedAt: '2026-09-07T00:00:01.000Z',
    bodySha256: 'a'.repeat(64)
  });
  assert.equal(callback.currency, 'PGK');
  assert.equal(callback.bodySha256, 'a'.repeat(64));
  assert.equal(callback.status, 'CONFIRMED');
  assert(Object.isFrozen(callback));
});

test('verifier contract requires verify()', () => {
  assert.throws(() => assertPaymentCallbackVerifier({}), /verify/i);
  assert.doesNotThrow(() => assertPaymentCallbackVerifier(new ScriptedPaymentCallbackVerifier([])));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-callback-verifier.test.js`

Expected: FAIL because `payment-callback-verifier.js` does not exist.

- [ ] **Step 3: Implement minimal verifier boundary**

Use `PaymentCallbackValidationError` for malformed normalized evidence. Validate:

```text
providerCode      ^[a-z0-9][a-z0-9._-]{0,63}$ after trim/lowercase
providerEventId   non-empty, <= 180 chars
paymentId         canonical UUID syntax
providerReference non-empty, <= 160 chars
status            exactly CONFIRMED
amountMinor       positive safe integer
currency          exactly three A-Z letters after uppercase normalization
occurredAt        valid ISO timestamp
receivedAt        valid ISO timestamp supplied by DCIECMS
bodySha256        exactly 64 lower/upper hex characters supplied by DCIECMS
```

`ScriptedPaymentCallbackVerifier.verify()` shifts deterministic scripted results/errors and is marked `developmentOnly = true`; it contains no credentials or signing implementation.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/unit/payment-callback-verifier.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: define payment callback verifier contract`

---

### Task 2: Provider binding and durable callback replay schema

**Files:**
- Create: `db/migrations/0014_payment_callback_security.sql`
- Create: `db/supabase/20260907_dciecms_test_0014.sql`
- Test: `tests/unit/payment-callback-migration-contract.test.js`
- Modify: `services/api/src/postgres-schema-mapping.js`
- Test: `tests/unit/postgres-schema-mapping.test.js`

**Interfaces:**
- Adds nullable `finance.payments.provider_code`
- Creates `integration.payment_callback_events`
- Adds logical-to-test-profile mapping for callback table

- [ ] **Step 1: Write migration contract RED**

```js
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/0014_payment_callback_security.sql'), 'utf8');
assert.match(sql, /ALTER TABLE finance\.payments[\s\S]*provider_code/i);
assert.match(sql, /CREATE TABLE IF NOT EXISTS integration\.payment_callback_events/i);
assert.match(sql, /UNIQUE\s*\(provider_code,\s*provider_event_id\)/i);
assert.match(sql, /body_sha256/i);
assert.doesNotMatch(sql, /raw_body|signature_value|authorization_header/i);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-callback-migration-contract.test.js`

Expected: FAIL because migration `0014` does not exist.

- [ ] **Step 3: Implement additive transaction-wrapped migration**

Create nullable `provider_code varchar(64)` on `finance.payments` with a check allowing NULL or the provider-code regex. Create callback rows with normalized evidence only:

```sql
CREATE TABLE IF NOT EXISTS integration.payment_callback_events (
  callback_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code varchar(64) NOT NULL,
  provider_event_id varchar(180) NOT NULL,
  payment_id uuid NOT NULL REFERENCES finance.payments(payment_id),
  body_sha256 char(64) NOT NULL,
  provider_reference varchar(160) NOT NULL,
  event_status varchar(30) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  CONSTRAINT payment_callback_event_status_ck CHECK (event_status = 'CONFIRMED'),
  CONSTRAINT payment_callback_processing_status_ck CHECK (processing_status IN ('RECEIVED','PROCESSED')),
  CONSTRAINT payment_callback_body_sha_ck CHECK (body_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  UNIQUE (provider_code, provider_event_id)
);
```

Add indexes on `(payment_id, received_at)` and `(processing_status, received_at)`. Mirror the logical migration in the isolated Supabase test-profile migration.

- [ ] **Step 4: Extend schema mapping and run GREEN**

Map `integration.payment_callback_events` to `dciecms_test.payment_callback_events` in the test profile. Run:

`node --test tests/unit/payment-callback-migration-contract.test.js tests/unit/postgres-schema-mapping.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add payment callback replay schema`

---

### Task 3: PostgreSQL payment provider binding and callback claim store

**Files:**
- Modify: `services/api/src/postgres-repository-core.js`
- Test: `tests/unit/postgres-payment-callback.test.js`
- Modify: `tests/unit/postgres-finance-controls.test.js`

**Interfaces:**
- Extends `createPayment({ ..., providerCode })`
- Extends `getPayment(paymentId)` mapping with `providerCode`
- Extends `confirmPayment(...)` return mapping with `providerCode`
- Produces: `claimPaymentCallback(input)`
- Produces: `markPaymentCallbackProcessed({ callbackEventId, processedAt })`

- [ ] **Step 1: Write repository RED tests**

Use the existing recording fake queryable pattern. Assert payment creation persists optional provider code. Assert callback claim uses parameterized SQL and `ON CONFLICT (provider_code, provider_event_id) DO NOTHING`. Assert canonical replay is returned only after reading the existing row.

```js
const result = await repo.claimPaymentCallback({
  callbackEventId: '22222222-2222-4222-8222-222222222222',
  providerCode: 'bank.png',
  providerEventId: 'evt-1',
  paymentId: '11111111-1111-4111-8111-111111111111',
  bodySha256: 'a'.repeat(64),
  providerReference: 'TX-1',
  eventStatus: 'CONFIRMED',
  amountMinor: 5000,
  currency: 'PGK',
  occurredAt: '2026-09-07T00:00:00.000Z',
  receivedAt: '2026-09-07T00:00:01.000Z'
});
assert.match(db.calls[0].sql, /ON CONFLICT\s*\(provider_code,\s*provider_event_id\)\s*DO NOTHING/i);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/postgres-payment-callback.test.js tests/unit/postgres-finance-controls.test.js`

Expected: FAIL because callback repository methods/provider mapping are absent.

- [ ] **Step 3: Implement repository methods**

`claimPaymentCallback()` returns a frozen object:

```js
{ claimed: true, event: mappedEvent }
```

for a new row. On conflict, read the canonical existing row and return:

```js
{ claimed: false, event: mappedEvent }
```

The service layer, not SQL, compares canonical replay fields and decides exact replay versus conflict. `markPaymentCallbackProcessed()` updates only a `RECEIVED` row and throws `PAYMENT_CALLBACK_STATE_CONFLICT` when it cannot transition.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/unit/postgres-payment-callback.test.js tests/unit/postgres-finance-controls.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: persist payment callback claims`

---

### Task 4: Transactional verified-callback confirmation service

**Files:**
- Modify: `services/api/src/persistent-dciecms-service-core.js`
- Modify: `services/api/src/transactional-service.js`
- Test: `tests/unit/payment-callback-service.test.js`
- Test: `tests/unit/transactional-service.test.js`
- Test: `tests/unit/runtime-transactional-payment-callback.test.js`

**Interfaces:**
- Extends `createPayment(actor, assessmentId, input = {})` with optional `providerCode`
- Produces: `confirmPaymentFromCallback(verifiedCallback)`
- Registers `confirmPaymentFromCallback` as mutating/transactional

- [ ] **Step 1: Write service RED tests**

Cover:

- payment/provider exact match confirms successfully;
- null/mismatched provider binding rejects;
- amount mismatch rejects;
- currency mismatch rejects;
- new callback against non-`PENDING` payment rejects;
- exact processed replay returns canonical payment without duplicate audit/outbox;
- same provider event ID with changed body digest/payment/reference rejects;
- system subject equals `payment-callback:<providerCode>` and is server generated.

Representative expectation:

```js
await assert.rejects(
  service.confirmPaymentFromCallback({
    providerCode:'bank.png', providerEventId:'evt-1',
    paymentId:payment.paymentId, providerReference:'TX-1',
    status:'CONFIRMED', amountMinor:4999, currency:'PGK',
    occurredAt:'2026-09-07T00:00:00.000Z',
    receivedAt:'2026-09-07T00:00:01.000Z', bodySha256:'a'.repeat(64)
  }),
  /amount/i
);
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-callback-service.test.js tests/unit/transactional-service.test.js`

Expected: FAIL because callback service method and transaction registration are absent.

- [ ] **Step 3: Implement service flow**

For new events:

1. `claimPaymentCallback()`.
2. If replayed, compare provider/payment/body/reference/status/amount/currency. If event is `PROCESSED` and all fields match, return the authoritative payment only when it is `CONFIRMED` with the same provider reference; do not emit new audit/outbox evidence.
3. For a new claim, load payment and validate provider binding, amount, currency and `PENDING` state.
4. Call existing `repository.confirmPayment()` with `actorSubject = payment-callback:<providerCode>`.
5. Audit `finance.payment.confirm.callback` with `courtId`, `providerCode` and `providerEventId`; do not include raw body/signature/provider diagnostics.
6. Emit the existing minimized `payment.confirmed` event.
7. Mark the callback row `PROCESSED`.
8. Return confirmed payment.

Catch repository `PAYMENT_STATE_CONFLICT`/`PAYMENT_CALLBACK_STATE_CONFLICT` and map them to existing `ConflictError` without exposing SQL/provider diagnostics.

- [ ] **Step 4: Prove transaction coupling**

Add a recording transaction-manager regression proving callback claim, payment update, audit insert, outbox insert and callback `PROCESSED` update share the same physical database client. Add rollback regression where outbox/audit failure rolls back preceding callback/payment SQL.

Run:

`node --test tests/unit/payment-callback-service.test.js tests/unit/transactional-service.test.js tests/unit/runtime-transactional-payment-callback.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: confirm verified payment callbacks transactionally`

---

### Task 5: Raw-body callback handler and pre-OIDC HTTP route

**Files:**
- Create: `services/api/src/payment-callback-handler.js`
- Modify: `services/api/src/http-app.js`
- Test: `tests/api/payment-callback-http.test.js`
- Test: `tests/security/payment-callback-boundary.test.js`

**Interfaces:**
- Produces: `createPaymentCallbackHandler({ service, verifiers, clock })`
- Handler method: `handle({ providerCode, headers, rawBody, receivedAt })`
- Extends `createHttpApp(service, actorResolver, { paymentCallbackHandler, callbackMaxBodyBytes })`

- [ ] **Step 1: Write HTTP/security RED tests**

Prove:

- callback route is evaluated before `actorResolver` and never invokes it;
- unrelated routes still invoke actor resolution;
- exact raw Buffer is delivered to verifier unchanged;
- core computes SHA-256 from raw bytes;
- route provider must equal verified provider;
- body larger than 1 MiB is rejected before verifier/service execution;
- invalid callback authentication returns sanitized 401 without `WWW-Authenticate: Bearer`;
- verifier unavailability maps to sanitized 503;
- callback response uses `Cache-Control: no-store`;
- no raw body/signature appears in service input except the computed digest and normalized evidence.

- [ ] **Step 2: Run RED**

Run: `node --test tests/api/payment-callback-http.test.js tests/security/payment-callback-boundary.test.js`

Expected: FAIL because callback handler/HTTP boundary does not exist.

- [ ] **Step 3: Implement handler**

Select verifier from an immutable server-controlled map by normalized route provider. Call:

```js
await verifier.verify({ headers, rawBody, receivedAt })
```

Then compute:

```js
const bodySha256 = createHash('sha256').update(rawBody).digest('hex');
```

Normalize verified evidence, require provider equality and call `service.confirmPaymentFromCallback()`.

- [ ] **Step 4: Implement dedicated raw-body route**

In `createHttpApp`, parse URL before actor resolution. For only:

```text
POST /integrations/payments/:provider/callback
```

read a bounded raw Buffer and dispatch to the callback handler. All other routes continue to resolve `actorResolver(req)` before service calls.

- [ ] **Step 5: Run GREEN and commit**

Run: `node --test tests/api/payment-callback-http.test.js tests/security/payment-callback-boundary.test.js tests/api/http-app.test.js`

Expected: PASS.

Commit: `feat: add isolated payment callback http boundary`

---

### Task 6: Fail-closed runtime composition, docs and complete regression gate

**Files:**
- Create: `services/api/src/payment-callback-runtime.js`
- Modify: `services/api/src/server.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`
- Modify: `docs/runbooks/LOCAL_DEVELOPMENT.md`
- Test: `tests/unit/payment-callback-runtime.test.js`
- Test: `tests/api/server-startup.test.js`

**Interfaces:**
- Produces: `createPaymentCallbackRuntime({ env, service, verifiers })`
- Config: `DCIECMS_PAYMENT_CALLBACK_MODE=disabled|enabled`

- [ ] **Step 1: Write runtime RED tests**

Assert:

- mode defaults to `disabled`;
- unknown mode throws;
- enabled mode without `DATABASE_URL` throws before HTTP startup;
- enabled mode without non-empty verifier registry throws;
- disabled mode returns no handler;
- enabled mode with durable database configuration plus injected verifier returns a handler;
- no committed default secret/provider endpoint is required.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-callback-runtime.test.js tests/api/server-startup.test.js`

Expected: FAIL because runtime module/config does not exist.

- [ ] **Step 3: Implement runtime and startup gate**

`server.js` creates callback runtime before `listen()`. Repository default remains disabled. With no injected provider-specific verifier, setting `DCIECMS_PAYMENT_CALLBACK_MODE=enabled` must fail startup rather than silently accepting unsigned callbacks.

- [ ] **Step 4: Update documentation**

Document:

- callback repository capability and migration `0014`;
- callback mode remains disabled until provider onboarding;
- exact production prerequisites: approved provider, signature-verifier adapter, secret/key injection, public endpoint/WAF controls, migration execution, operational monitoring and rollback plan;
- no live callback activation performed by this workstream.

- [ ] **Step 5: Run focused GREEN**

Run: `node --test tests/unit/payment-callback-runtime.test.js tests/api/server-startup.test.js`

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm test
npm run test:frontend
npm run build:frontend
```

Expected: all backend tests PASS, all Court Workspace tests PASS, production frontend build PASS.

- [ ] **Step 7: Security review**

Search the branch diff for:

```text
raw_body
signature
secret
authorization
provider diagnostic
```

Verify no secret/raw callback material is persisted or returned, and verify the callback route is the only path that bypasses OIDC actor resolution.

- [ ] **Step 8: Commit**

Commit: `docs: complete payment callback security boundary`

- [ ] **Step 9: Open pull request only after exact-head CI is green**

PR title: `feat: payment callback security boundary`

PR body must explicitly state that no production provider, credential, endpoint, migration execution or deployment is included.