# R6 Secure Payment Gateway Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, fail-closed, replay-safe payment-gateway callback boundary that confirms DCIECMS payments only after verified callback evidence matches server-authoritative financial data.

**Architecture:** External callbacks terminate at a verifier contract that authenticates raw request bytes and emits a canonical callback. Canonical callbacks are claimed in a durable PostgreSQL inbox and processed under the existing outer transaction boundary so payment confirmation, callback outcome, audit evidence and outbox publication commit atomically. Production activation remains disabled unless an approved production-capable verifier is injected.

**Tech Stack:** Node.js >=20, CommonJS backend, PostgreSQL/`pg`, existing `PostgresTransactionManager`, `PostgresAuditStore`, `PostgresOutboxStore`, Node test runner, React/Vite regression suite.

**Spec:** `docs/superpowers/specs/2026-09-07-r6-secure-payment-gateway-design.md`

## Global Constraints

- No live payment provider, merchant credential, callback secret, certificate or production endpoint is selected or committed.
- No browser/user path may treat provider-like fields as authority to confirm a gateway payment.
- Callback authenticity is verified from the exact raw request body before financial mutation.
- Amounts use integer minor units; currencies compare in normalized uppercase form.
- `(provider, providerEventId)` is the durable callback identity and cannot be reinterpreted with different canonical evidence.
- Duplicate valid callbacks must return the canonical prior outcome without repeating business mutation, audit evidence or outbox publication.
- Payment confirmation, callback completion, application audit and outbox enqueue must commit or roll back together.
- Raw callback bodies, signatures, provider secrets and unrestricted provider diagnostics must not enter audit or generic outbox evidence.
- Production mode must fail closed and must never fall back to a development verifier.
- Live database migration and production deployment are excluded.

---

### Task 1: Payment gateway verifier contract and canonical callback model

**Files:**
- Create: `services/api/src/payment-gateway-verifier.js`
- Test: `tests/unit/payment-gateway-verifier.test.js`
- Test: `tests/security/payment-gateway-verifier-security.test.js`

**Interfaces:**
- Produces: `assertPaymentGatewayVerifier(verifier, { production })`
- Produces: `normalizeVerifiedPaymentCallback(input)`
- Produces: `ScriptedPaymentGatewayVerifier`
- Canonical callback fields: `provider`, `eventId`, `eventType`, `paymentReference`, `providerPaymentReference`, `amountMinor`, `currency`, `occurredAt`

- [ ] **Step 1: Write failing verifier contract tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPaymentGatewayVerifier,
  normalizeVerifiedPaymentCallback,
  ScriptedPaymentGatewayVerifier
} = require('../../services/api/src/payment-gateway-verifier');

test('canonical callback normalizes supported payment success evidence', () => {
  const value = normalizeVerifiedPaymentCallback({
    provider: ' test ', eventId: ' evt-1 ', eventType: 'payment_succeeded',
    paymentReference: ' PAY-1 ', providerPaymentReference: ' gw-1 ',
    amountMinor: 12500, currency: 'pgk', occurredAt: '2026-09-07T02:00:00Z'
  });
  assert.equal(value.provider, 'TEST');
  assert.equal(value.eventId, 'evt-1');
  assert.equal(value.eventType, 'PAYMENT_SUCCEEDED');
  assert.equal(value.amountMinor, 12500);
  assert.equal(value.currency, 'PGK');
});

test('canonical callback rejects floating, negative and unsupported evidence', () => {
  assert.throws(() => normalizeVerifiedPaymentCallback({provider:'T',eventId:'e',eventType:'PAYMENT_SUCCEEDED',paymentReference:'P',providerPaymentReference:'G',amountMinor:12.5,currency:'PGK',occurredAt:new Date().toISOString()}), /amount/i);
  assert.throws(() => normalizeVerifiedPaymentCallback({provider:'T',eventId:'e',eventType:'REFUND',paymentReference:'P',providerPaymentReference:'G',amountMinor:1,currency:'PGK',occurredAt:new Date().toISOString()}), /event type/i);
});

test('production verifier must attest authenticity and replay-time validation', () => {
  assert.throws(() => assertPaymentGatewayVerifier(new ScriptedPaymentGatewayVerifier([]), {production:true}), /production/i);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test tests/unit/payment-gateway-verifier.test.js tests/security/payment-gateway-verifier-security.test.js`

Expected: FAIL because `payment-gateway-verifier.js` does not exist.

- [ ] **Step 3: Implement strict verifier contract**

Implement:

```js
const PAYMENT_EVENT_TYPES = Object.freeze(['PAYMENT_SUCCEEDED', 'PAYMENT_FAILED']);

function normalizeVerifiedPaymentCallback(input) {
  // bounded non-empty provider/event/reference strings
  // safe integer amountMinor >= 0
  // 3-letter uppercase currency
  // valid ISO timestamp
  // return Object.freeze(normalized)
}

function assertPaymentGatewayVerifier(verifier, { production = false } = {}) {
  if (!verifier || typeof verifier.verify !== 'function') throw new Error('Payment gateway verifier must implement verify');
  if (typeof verifier.capabilities !== 'function') throw new Error('Payment gateway verifier must expose capabilities');
  const caps = verifier.capabilities();
  if (production && (!caps || caps.developmentOnly || !caps.authenticityVerified || !caps.replayTimeValidated)) {
    throw new Error('Production payment gateway verifier does not satisfy required security capabilities');
  }
  return verifier;
}
```

`ScriptedPaymentGatewayVerifier` is deterministic/test-only, returns scripted normalized results, exposes `{developmentOnly:true, authenticityVerified:true, replayTimeValidated:true}`, and never contains real credentials.

- [ ] **Step 4: Add security regressions**

Test malformed verifier results, overlong IDs, invalid currencies, invalid timestamps, unknown event types, and ensure `rawBody`, `signature`, `secret`, and provider diagnostics cannot appear in the canonical result.

- [ ] **Step 5: Run Task 1 tests GREEN**

Run: `node --test tests/unit/payment-gateway-verifier.test.js tests/security/payment-gateway-verifier-security.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/payment-gateway-verifier.js tests/unit/payment-gateway-verifier.test.js tests/security/payment-gateway-verifier-security.test.js
git commit -m "feat: define secure payment callback verifier"
```

---

### Task 2: Add durable payment callback inbox migration

**Files:**
- Create: `db/migrations/0014_payment_gateway_callbacks.sql`
- Create: `db/supabase/20260907_dciecms_test_0014.sql`
- Test: `tests/unit/payment-gateway-migration-contract.test.js`

**Interfaces:**
- Produces table: `finance.payment_gateway_callbacks`
- Durable identity: unique `(provider, provider_event_id)`
- Statuses: `RECEIVED`, `PROCESSING`, `APPLIED`, `IGNORED`, `REJECTED`

- [ ] **Step 1: Write migration contract test RED**

```js
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const sql = fs.readFileSync(path.join(root, 'db/migrations/0014_payment_gateway_callbacks.sql'), 'utf8');

test('R6 migration creates durable payment callback inbox', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS finance\.payment_gateway_callbacks/i);
  assert.match(sql, /provider_event_id/i);
  assert.match(sql, /payload_digest_sha256/i);
  assert.match(sql, /UNIQUE\s*\(provider\s*,\s*provider_event_id\)/i);
  assert.match(sql, /APPLIED/);
  assert.doesNotMatch(sql, /raw_payload|raw_body|signature_value/i);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-gateway-migration-contract.test.js`

Expected: FAIL because migration does not exist.

- [ ] **Step 3: Implement additive transaction-wrapped migration**

Create table equivalent to:

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS finance.payment_gateway_callbacks (
  callback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(80) NOT NULL,
  provider_event_id varchar(180) NOT NULL,
  event_type varchar(40) NOT NULL,
  payment_reference varchar(120) NOT NULL,
  provider_payment_reference varchar(180) NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  occurred_at timestamptz NOT NULL,
  processing_status varchar(30) NOT NULL DEFAULT 'RECEIVED',
  outcome_code varchar(80),
  payment_id uuid REFERENCES finance.payments(payment_id),
  payload_digest_sha256 char(64) NOT NULL,
  failure_code varchar(80),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_event_id),
  CHECK (amount_minor >= 0),
  CHECK (currency = upper(currency)),
  CHECK (event_type IN ('PAYMENT_SUCCEEDED','PAYMENT_FAILED')),
  CHECK (processing_status IN ('RECEIVED','PROCESSING','APPLIED','IGNORED','REJECTED')),
  CHECK (payload_digest_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_payment_gateway_callbacks_payment_reference
  ON finance.payment_gateway_callbacks(payment_reference, received_at DESC);

COMMIT;
```

Mirror the logical schema in the isolated Supabase test-profile migration without applying it live.

- [ ] **Step 4: Run migration contracts GREEN**

Run: `node --test tests/unit/payment-gateway-migration-contract.test.js tests/unit/migration-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0014_payment_gateway_callbacks.sql db/supabase/20260907_dciecms_test_0014.sql tests/unit/payment-gateway-migration-contract.test.js
git commit -m "feat: add durable payment callback inbox"
```

---

### Task 3: PostgreSQL callback store with replay and conflict semantics

**Files:**
- Create: `services/api/src/postgres-payment-callback-store.js`
- Test: `tests/unit/postgres-payment-callback-store.test.js`

**Interfaces:**
- Produces class: `PostgresPaymentCallbackStore`
- Produces: `claim(callback, { payloadDigestSha256, receivedAt })`
- Produces: `markApplied({ callbackId, paymentId, outcomeCode, processedAt })`
- Produces: `markIgnored({ callbackId, outcomeCode, processedAt })`
- Produces: `markRejected({ callbackId, failureCode, processedAt })`

- [ ] **Step 1: Write RED tests for first claim, replay and conflict**

Use a recording queryable. Assert all SQL is parameterized and first claim uses `INSERT ... ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING ...` followed by a locked read when the insert loses the race.

Replay is accepted only if stored `event_type`, `payment_reference`, `provider_payment_reference`, `amount_minor`, `currency`, `occurred_at`, and `payload_digest_sha256` exactly match canonical evidence. Otherwise throw `ConflictError('Payment callback event identity conflicts with previously received evidence')`.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/postgres-payment-callback-store.test.js`

Expected: FAIL because store does not exist.

- [ ] **Step 3: Implement callback store**

The store receives a transaction-aware queryable. `claim()` returns one of:

```js
{ kind: 'NEW', callback: row }
{ kind: 'REPLAY', callback: row }
```

Do not store raw payload, raw headers or raw signature.

State updates require the callback ID and expected current state so stale/concurrent transitions fail rather than silently overwrite.

- [ ] **Step 4: Run GREEN**

Run: `node --test tests/unit/postgres-payment-callback-store.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/postgres-payment-callback-store.js tests/unit/postgres-payment-callback-store.test.js
git commit -m "feat: add replay-safe payment callback store"
```

---

### Task 4: Dedicated verified-gateway payment confirmation repository operation

**Files:**
- Modify: `services/api/src/postgres-repository.js`
- Test: `tests/unit/postgres-payment-gateway-repository.test.js`

**Interfaces:**
- Produces: `PostgresRepository.confirmPaymentFromVerifiedGateway(input)`
- Input: `{ paymentReference, providerPaymentReference, amountMinor, currency, confirmedAt }`

- [ ] **Step 1: Write RED repository tests**

Tests must prove:

- payment is selected/locked by authoritative DCIECMS payment reference;
- payment must be `PENDING` for first application;
- exact integer amount and currency must match stored payment;
- a stored provider reference, when already present, must match exactly;
- provider reference is persisted only from the verified canonical callback;
- update is conditional and parameterized;
- no receipt is duplicated by this method;
- already-confirmed state is not treated as a fresh confirmation.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/postgres-payment-gateway-repository.test.js`

Expected: FAIL because method does not exist.

- [ ] **Step 3: Implement minimal repository operation**

Use the existing payment mapper and finance schema names. Lock the payment row, validate authoritative amount/currency, then conditionally update `PENDING -> CONFIRMED` and persist `provider_payment_reference`/`confirmed_at` using the existing column names. Reuse existing `NotFoundError`, `ConflictError`, and `ValidationError` conventions.

- [ ] **Step 4: Run repository regressions GREEN**

Run: `node --test tests/unit/postgres-payment-gateway-repository.test.js tests/unit/postgres-repository.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/postgres-repository.js tests/unit/postgres-payment-gateway-repository.test.js
git commit -m "feat: confirm payments from verified gateway evidence"
```

---

### Task 5: Transactional callback application service

**Files:**
- Create: `services/api/src/payment-gateway-service.js`
- Modify: transaction mutation registry file used by R4 (use the repository's existing registry location)
- Test: `tests/unit/payment-gateway-service.test.js`
- Test: `tests/unit/payment-gateway-transaction.test.js`
- Test: `tests/security/payment-gateway-evidence-minimization.test.js`

**Interfaces:**
- Produces class: `PaymentGatewayService`
- Produces: `processVerifiedCallback({ verifiedCallback, payloadDigestSha256, receivedAt })`

- [ ] **Step 1: Write RED service tests**

Construct service with `repository`, `callbackStore`, `auditStore`, and `outboxStore` fakes.

Success expectations:

```js
assert.equal(result.status, 'APPLIED');
assert.equal(repository.confirmCalls.length, 1);
assert.equal(callbackStore.appliedCalls.length, 1);
assert.equal(audit.events[0].action, 'payment.gateway.confirmed');
assert.equal(outbox.events[0].eventType, 'payment.confirmed');
```

Replay expectations: a callback already marked `APPLIED` returns the canonical outcome and performs zero new payment/audit/outbox mutations.

`PAYMENT_FAILED` expectation: durable callback outcome becomes `IGNORED` with a bounded normalized code; no confirmed payment is reversed.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-gateway-service.test.js tests/unit/payment-gateway-transaction.test.js tests/security/payment-gateway-evidence-minimization.test.js`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement service and system actor**

Use an internal callback actor such as:

```js
const PAYMENT_GATEWAY_SYSTEM_ACTOR = Object.freeze({
  userId: 'system:payment-gateway',
  subject: 'system:payment-gateway',
  roles: Object.freeze(['SYSTEM']),
  courtIds: Object.freeze([]),
  explicitGrants: Object.freeze([])
});
```

Do not grant this actor ordinary user RBAC. The callback service is invoked only after verifier success and calls the dedicated repository operation directly.

Audit details may include `provider`, `providerEventId`, `paymentReference`, `callbackId`, `courtId`, and normalized outcome. They must not include raw body, signature, authorization header, provider secret, or unrestricted diagnostics.

Outbox event uses the existing provider-neutral `payment.confirmed` event shape and stable deduplication identity. Do not add `providerPaymentReference` to generic payload.

- [ ] **Step 4: Register mutation in the existing R4 transaction registry**

Add `processVerifiedCallback` only if the runtime proxy wraps this service through that registry; otherwise compose it explicitly under `PostgresTransactionManager.run()` following existing secure-document service precedent. Tests must prove one physical client/transaction.

- [ ] **Step 5: Add rollback tests**

Prove audit failure and outbox enqueue failure each roll back the preceding payment confirmation and callback-state update.

- [ ] **Step 6: Run GREEN**

Run: `node --test tests/unit/payment-gateway-service.test.js tests/unit/payment-gateway-transaction.test.js tests/security/payment-gateway-evidence-minimization.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/api/src/payment-gateway-service.js tests/unit/payment-gateway-service.test.js tests/unit/payment-gateway-transaction.test.js tests/security/payment-gateway-evidence-minimization.test.js
git add <existing-transaction-registry-file>
git commit -m "feat: process payment callbacks atomically"
```

---

### Task 6: HTTP callback endpoint with raw-body preservation and sanitized failures

**Files:**
- Modify: `services/api/src/http-app.js`
- Test: `tests/unit/http-payment-gateway.test.js`
- Test: `tests/security/payment-gateway-http-security.test.js`

**Interfaces:**
- Route: `POST /api/integrations/payments/callback`
- Consumes injected `paymentGatewayVerifier` and `paymentGatewayService`

- [ ] **Step 1: Write RED HTTP tests**

Prove:

- ordinary OIDC actor headers/token are not used as callback authority;
- verifier receives exact raw body bytes and request headers;
- raw body SHA-256 is calculated server-side;
- only normalized verifier output reaches service;
- valid callback returns `200`;
- replay returns `200`;
- invalid authenticity returns sanitized `401`;
- malformed callback returns sanitized `400`;
- verifier infrastructure failure returns sanitized `503`;
- canonical evidence conflict returns `409`;
- response does not echo signature/header/raw body/provider diagnostics.

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/http-payment-gateway.test.js tests/security/payment-gateway-http-security.test.js`

Expected: FAIL because route is missing.

- [ ] **Step 3: Implement route before ordinary actor resolution**

Detect the exact callback path/method before normal OIDC actor construction. Read raw bytes once with a bounded body-size limit. Pass `{ rawBody, headers, receivedAt }` to verifier. Hash raw body using `createHash('sha256')` and pass only digest + canonical callback to service.

Do not JSON-parse before verifier execution unless a provider-specific verifier itself chooses to parse the raw bytes after authenticity validation.

- [ ] **Step 4: Add sanitized error mapping**

Introduce bounded payment-verifier error classes if needed: authentication failure `401`, malformed verified request `400`, verifier availability `503`. Existing `ConflictError`/`ValidationError` retain their current mappings.

- [ ] **Step 5: Run GREEN**

Run: `node --test tests/unit/http-payment-gateway.test.js tests/security/payment-gateway-http-security.test.js tests/unit/http-app.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/http-app.js tests/unit/http-payment-gateway.test.js tests/security/payment-gateway-http-security.test.js
git commit -m "feat: add verified payment callback endpoint"
```

---

### Task 7: Runtime mode, production gate and persistent composition

**Files:**
- Create: `services/api/src/payment-gateway-runtime.js`
- Modify: existing runtime composition file(s)
- Modify: `.env.example`
- Test: `tests/unit/payment-gateway-runtime.test.js`
- Test: `tests/security/payment-gateway-production-gate.test.js`

**Interfaces:**
- Mode: `DCIECMS_PAYMENT_GATEWAY_MODE=disabled|development|enabled`
- Produces runtime object with `verifier`, `callbackStore`, `service`, or disabled boundary

- [ ] **Step 1: Write RED configuration/runtime tests**

Required cases:

```js
// production + omitted/disabled => callback route unavailable
// production + development => throws before listen
// production + enabled + missing verifier => throws before listen
// production + enabled + developmentOnly verifier => throws before listen
// development + development => deterministic verifier allowed
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/unit/payment-gateway-runtime.test.js tests/security/payment-gateway-production-gate.test.js`

Expected: FAIL because runtime module does not exist.

- [ ] **Step 3: Implement fail-closed runtime composition**

Persistent mode must reuse the existing PostgreSQL pool/transaction manager, repository, audit store and outbox store. Instantiate `PostgresPaymentCallbackStore` over the transaction-aware database wrapper. Inject only an explicitly supplied production verifier when mode is `enabled`.

- [ ] **Step 4: Update `.env.example` without secrets**

Add documented mode only:

```text
DCIECMS_PAYMENT_GATEWAY_MODE=disabled
```

Do not add fake production secret names or provider-specific URLs.

- [ ] **Step 5: Run GREEN**

Run: `node --test tests/unit/payment-gateway-runtime.test.js tests/security/payment-gateway-production-gate.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/payment-gateway-runtime.js .env.example tests/unit/payment-gateway-runtime.test.js tests/security/payment-gateway-production-gate.test.js
git add <existing-runtime-composition-files>
git commit -m "feat: gate payment gateway runtime activation"
```

---

### Task 8: Security gate, documentation and release verification

**Files:**
- Modify: `docs/architecture/IMPLEMENTATION_STATUS.md`
- Modify: `README.md`
- Create or modify: relevant operations/configuration runbook under `docs/`
- Test: `tests/security/payment-gateway-regression.test.js`

**Interfaces:**
- Central R6 security regression gate
- Documents migration `0014` as repository-delivered, not live-applied

- [ ] **Step 1: Write centralized security regression RED where gaps remain**

Cover at minimum:

- forged/unverified callback cannot reach payment mutation;
- stale/replay-invalid verifier result fails closed;
- same event ID with different canonical evidence conflicts;
- amount mismatch cannot confirm;
- currency mismatch cannot confirm;
- provider reference mismatch cannot confirm;
- valid duplicate callback is replay-safe;
- raw body/signature/provider diagnostic leakage is absent;
- production cannot use development verifier;
- callback audit/outbox failure rolls back payment mutation;
- callback cannot directly open a case or create duplicate receipt.

- [ ] **Step 2: Run focused R6 suite**

Run all R6 tests. Expected: PASS.

- [ ] **Step 3: Update implementation status and README**

Record R6 as repository capability only. Explicitly retain outstanding production provider selection/merchant onboarding, live callback registration, secret-management, migration execution and production deployment gates.

- [ ] **Step 4: Run full backend regression**

Run: repository's existing backend test command / `node --test` suite.

Expected: PASS with zero failures.

- [ ] **Step 5: Run Court Workspace tests**

Run from `apps/court-workspace`: `npm test -- --run`

Expected: PASS.

- [ ] **Step 6: Run production frontend build**

Run from `apps/court-workspace`: `npm run build`

Expected: PASS.

- [ ] **Step 7: Review diff for payment/security hazards**

Check specifically for committed secrets, provider-specific credentials, raw callback persistence, signature leakage, direct browser confirmation authority, floating-point money, missing transaction coupling, unrestricted payloads, live migration/deployment claims and accidental provider-reference propagation into generic outbox payloads.

- [ ] **Step 8: Commit release documentation**

```bash
git add README.md docs/architecture/IMPLEMENTATION_STATUS.md docs tests/security/payment-gateway-regression.test.js
git commit -m "docs: record R6 payment gateway security boundary"
```

- [ ] **Step 9: Push branch and require GitHub Actions GREEN on the exact head**

Because the current execution environment may not have direct network access to run the repository locally, GitHub Actions is authoritative when local execution is unavailable. Do not claim tests passed until the exact committed head has a successful CI run.

- [ ] **Step 10: Open PR for integration review**

Title:

```text
feat: R6 secure payment gateway integration boundary
```

PR body must state that no live provider, production credential, live migration or production deployment is included.
